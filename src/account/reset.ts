import { createHash, randomUUID } from "node:crypto";
import { accountHeaders } from "../core/catalog.js";
import { assert, CodexError, record } from "../core/errors.js";
import {
  readJson,
  requestScope,
  throwIfAborted,
  type Fetch,
} from "../core/http.js";
import type { Binding, Session } from "../core/types.js";
import { count } from "../core/usage.js";
import { AccountReader, USAGE_BASE } from "./usage.js";
import {
  ResetStore,
  actorFingerprint,
  type ResetIntent,
} from "./reset-store.js";
import { resetEligibility, validateRecovery } from "./reset-policy.js";
import type {
  AccountSnapshot,
  RecoveryPolicy,
  ResetResult,
  ResetOutcome,
} from "./types.js";
export class ResetController {
  constructor(
    readonly reader: AccountReader,
    readonly store: ResetStore,
    private readonly fetchImpl: Fetch = fetch,
    private readonly clock = Date.now,
    private readonly uuid = randomUUID,
    private readonly baseUrl = USAGE_BASE,
  ) {}
  async consumeReset(
    binding: Binding,
    options: {
      origin: "manual" | "automatic";
      executionKey: string;
      policy: RecoveryPolicy;
      selectedCreditId?: string;
      acknowledgement?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ResetResult> {
    validateRecovery(options.policy);
    assert(
      options.origin !== "manual" || options.acknowledgement === true,
      "Allow this step to use one earned reset credit before executing it.",
    );
    assert(
      options.origin !== "manual" ||
        (typeof options.selectedCreditId === "string" &&
          /^[^\x00-\x20\x7f]{1,256}$/.test(options.selectedCreditId)),
      "Select one eligible reset allocation before executing this manual action.",
    );
    assert(
      /^[a-f0-9]{64}$/.test(options.executionKey),
      "A public workflow execution identity is required for reset coordination.",
    );
    const session = await this.reader.session(
      binding,
      "managed",
      options.signal,
    );
    assert(
      session.identity,
      "Verified account identity is required to use an earned reset.",
    );
    const scope = this.store.scope(session.identity),
      actor = actorFingerprint(session.identity);
    let snapshot = await this.reader.readWithSession(binding, session, {
      signal: options.signal,
      force: true,
      includeResetDetails:
        options.origin === "manual" || options.policy.automatic,
    });
    const result = this.result(snapshot, options.origin);
    if (options.origin === "automatic" && !options.policy.automatic) {
      result.action.reason = "policy_off";
      return result;
    }
    const initial = resetEligibility(
      snapshot,
      options.policy,
      options.origin,
      options.selectedCreditId,
      this.clock(),
    );
    if (!initial.eligible) {
      result.action.reason = initial.reason;
      return result;
    }
    throwIfAborted(options.signal);
    // Establish a readable authoritative empty account record before the cross-file reservation.
    await this.store.accountLock(
      scope,
      async () => {
        if (!(await this.store.hasLedger(scope)))
          await this.store.writeLedger(await this.store.ledger(scope));
      },
      options.signal,
    );
    const id = this.uuid();
    if (!(await this.store.reserve(options.executionKey, scope, id))) {
      result.action.reason = "cap_reached";
      return result;
    }
    let finalIntent: ResetIntent | undefined;
    try {
      await this.store.accountLock(scope, async () => {
        const current = await this.reader.sessions.currentSession(
          binding,
          options.signal,
        );
        assert(
          current.generation === session.generation &&
            current.identity &&
            actorFingerprint(current.identity) === actor,
          "The account changed before reset dispatch. Retry with a fresh execution.",
        );
        const journal = await this.store.ledger(scope),
          now = this.clock();
        const reservation = await this.store.reservation(options.executionKey);
        assert(
          reservation?.accountScope === scope &&
            reservation.redeemRequestId === id &&
            reservation.state === "reserved",
          "This reset reservation was cancelled or replaced before dispatch. Start a new execution.",
        );
        const cancelled = journal.actions.find((a) => a.redeemRequestId === id);
        if (cancelled) {
          assert(
            cancelled.executionKey === options.executionKey &&
              cancelled.state === "cancelled_before_send" &&
              cancelled.dispatchCount === 0,
            "The reset intent already exists. No new dispatch is permitted.",
          );
          finalIntent = cancelled;
          result.action.reason = "cancelled";
          return;
        }
        // Keep unresolved intents and the latest suppression history, never prune unresolved effects.
        journal.actions = journal.actions.filter(
          (a) =>
            a.state === "uncertain" ||
            a.state === "dispatching" ||
            a.state === "prepared" ||
            now - a.createdAt < 86400000 ||
            a.trigger === initial.trigger,
        );
        const prepared: ResetIntent = {
          redeemRequestId: id,
          creditId: initial.creditId!,
          actor,
          profileId: binding.profileId,
          executionKey: options.executionKey,
          origin: options.origin,
          policyHash: createHash("sha256")
            .update(JSON.stringify(["reset-policy-v1", options.policy]))
            .digest("hex"),
          trigger: initial.trigger!,
          attemptExecutions: [options.executionKey],
          createdAt: now,
          lastAttemptAt: null,
          dispatchCount: 0,
          state: "prepared",
          outcome: null,
          windowsReset: null,
        };
        journal.actions.push(prepared);
        finalIntent = prepared;
        await this.store.writeLedger(journal);
        const cancel = async (reason: ResetResult["action"]["reason"]) => {
          prepared.state = "cancelled_before_send";
          await this.store.writeLedger(journal);
          result.action.reason = reason;
        };
        if (
          journal.actions.some(
            (a) =>
              a !== prepared &&
              ["uncertain", "dispatching", "prepared"].includes(a.state),
          )
        ) {
          await cancel("pending_action");
          return;
        }
        if (
          journal.actions.filter(
            (a) =>
              a !== prepared &&
              a.dispatchCount > 0 &&
              now - a.createdAt < 86400000,
          ).length >= options.policy.maxPer24Hours
        ) {
          await cancel("cap_reached");
          return;
        }
        if (
          journal.actions.some(
            (a) =>
              a !== prepared &&
              a.dispatchCount > 0 &&
              (a.trigger === prepared.trigger ||
                now - (a.lastAttemptAt ?? a.createdAt) < 300000),
          )
        ) {
          await cancel("cooldown");
          return;
        }
        snapshot = await this.reader.readWithSession(binding, current, {
          signal: options.signal,
          force: true,
          includeResetDetails: true,
        });
        const eligibility = resetEligibility(
          snapshot,
          options.policy,
          options.origin,
          prepared.creditId,
          this.clock(),
        );
        if (!eligibility.eligible) {
          await cancel(eligibility.reason);
          return;
        }
        if (options.signal?.aborted) {
          await cancel("cancelled");
          return;
        }
        prepared.trigger = eligibility.trigger!;
        prepared.state = "dispatching";
        prepared.lastAttemptAt = this.clock();
        prepared.dispatchCount = 1;
        await this.store.writeLedger(journal);
        // Cancellation after durable dispatch is an uncertain external effect; persist its fence.
        try {
          const response = await this.consume(
            current,
            prepared,
            options.signal,
          );
          prepared.outcome = response.outcome;
          prepared.windowsReset = response.windowsReset;
          prepared.state = "terminal";
          await this.store.writeLedger(journal);
        } catch {
          prepared.state = "uncertain";
          try {
            await this.store.writeLedger(journal);
          } catch {
            /* Durable dispatching already fences re-use. */
          }
        }
      });
    } catch (error) {
      if (!finalIntent) throw error;
      if (finalIntent.state === "prepared") {
        finalIntent.state = "cancelled_before_send";
        await this.store.accountLock(scope, async () => {
          const ledger = await this.store.ledger(scope);
          const a = ledger.actions.find((a) => a.redeemRequestId === id);
          if (a?.state === "prepared") {
            a.state = "cancelled_before_send";
            await this.store.writeLedger(ledger);
          }
        });
      } else if (
        finalIntent.state !== "terminal" &&
        finalIntent.state !== "cancelled_before_send"
      )
        finalIntent.state = "uncertain";
    }
    if (finalIntent)
      await this.store.updateReservation(
        options.executionKey,
        scope,
        id,
        finalIntent.state === "cancelled_before_send"
          ? "cancelled_before_send"
          : finalIntent.state === "terminal"
            ? "terminal"
            : "dispatched",
      );
    return this.finish(binding, session, snapshot, result, finalIntent);
  }
  async resolvePendingReset(
    binding: Binding,
    options: { executionKey: string; signal?: AbortSignal },
  ): Promise<ResetResult> {
    assert(
      /^[a-f0-9]{64}$/.test(options.executionKey),
      "A public workflow execution identity is required for reset reconciliation.",
    );
    const session = await this.reader.session(
      binding,
      "managed",
      options.signal,
    );
    assert(
      session.identity,
      "Verified account identity is required to resolve a reset.",
    );
    const scope = this.store.scope(session.identity),
      actor = actorFingerprint(session.identity);
    let snapshot = await this.reader.readWithSession(binding, session, {
      force: true,
      signal: options.signal,
    });
    const result = this.result(snapshot, "reconcile");
    let intent: ResetIntent | undefined;
    // A reconciliation reuses the original action, and reserves the current execution too.
    // Reserve outside the account lock: no global/account lock cycle is permitted.
    const observed = (await this.store.ledger(scope)).actions.find((a) =>
      ["uncertain", "dispatching", "prepared"].includes(a.state),
    );
    let currentExecutionReserved = false;
    if (observed && observed.state !== "prepared") {
      assert(
        observed.actor === actor,
        "Pending reset belongs to a different authenticated actor.",
      );
      if (observed.attemptExecutions?.includes(options.executionKey)) {
        result.action.reason = "cooldown";
        return this.finish(binding, session, snapshot, result, observed);
      }
      if (observed.dispatchCount >= 3) {
        result.action.reason = "pending_action";
        return this.finish(binding, session, snapshot, result, observed);
      }
      if (
        this.clock() - (observed.lastAttemptAt ?? observed.createdAt) <
        30000
      ) {
        result.action.reason = "cooldown";
        return this.finish(binding, session, snapshot, result, observed);
      }
      if (
        !(await this.store.reserve(
          options.executionKey,
          scope,
          observed.redeemRequestId,
        ))
      ) {
        result.action.reason = "cap_reached";
        return this.finish(binding, session, snapshot, result, observed);
      }
      currentExecutionReserved = true;
    }
    await this.store.accountLock(scope, async () => {
      const ledger = await this.store.ledger(scope);
      intent = ledger.actions.find((a) =>
        ["uncertain", "dispatching", "prepared"].includes(a.state),
      );
      if (!intent) {
        result.action.reason = "not_eligible";
        return;
      }
      assert(
        !observed || observed.redeemRequestId === intent.redeemRequestId,
        "The pending reset changed before reconciliation. Start a new execution.",
      );
      assert(
        intent.actor === actor,
        "Pending reset belongs to a different authenticated actor.",
      );
      const reservation = await this.store.reservation(intent.executionKey);
      assert(
        reservation &&
          reservation.accountScope === scope &&
          reservation.redeemRequestId === intent.redeemRequestId,
        "The pending reset reservation cannot be established.",
      );
      if (intent.state === "prepared") {
        intent.state = "cancelled_before_send";
        await this.store.writeLedger(ledger);
        return;
      }
      if (intent.attemptExecutions?.includes(options.executionKey)) {
        result.action.reason = "cooldown";
        return;
      }
      if (intent.dispatchCount >= 3) {
        result.action.reason = "pending_action";
        return;
      }
      if (this.clock() - (intent.lastAttemptAt ?? intent.createdAt) < 30000) {
        result.action.reason = "cooldown";
        return;
      }
      const current = await this.reader.sessions.currentSession(
        binding,
        options.signal,
      );
      assert(
        current.identity && actorFingerprint(current.identity) === actor,
        "The authenticated actor changed before reconciliation.",
      );
      throwIfAborted(options.signal);
      intent.state = "dispatching";
      intent.attemptExecutions = [
        ...(intent.attemptExecutions ?? [intent.executionKey]),
        options.executionKey,
      ];
      intent.dispatchCount++;
      intent.lastAttemptAt = this.clock();
      await this.store.writeLedger(ledger);
      try {
        const response = await this.consume(current, intent, options.signal);
        intent.outcome = response.outcome;
        intent.windowsReset = response.windowsReset;
        intent.state = "terminal";
        await this.store.writeLedger(ledger);
      } catch {
        intent.state = "uncertain";
        try {
          await this.store.writeLedger(ledger);
        } catch {
          /* Existing dispatch fence is authoritative. */
        }
      }
    });
    if (!intent) {
      // Only explicit recovery may cancel the exact orphan reservation after an existing valid account ledger proves no dispatch intent exists.
      const orphaned = await this.store.reservationsFor(scope);
      for (const reservation of orphaned) {
        let proven = false;
        await this.store.accountLock(scope, async () => {
          assert(
            await this.store.hasLedger(scope),
            "A missing account journal cannot release a reset reservation.",
          );
          const ledger = await this.store.ledger(scope);
          const existing = ledger.actions.find(
            (a) => a.redeemRequestId === reservation.value.redeemRequestId,
          );
          if (!existing) {
            // Invalidate a concurrently paused original writer while holding its account lock.
            // The reservation is released only after this durable dispatch-blocking tombstone.
            ledger.actions.push({
              redeemRequestId: reservation.value.redeemRequestId,
              creditId: "cancelled-before-send",
              actor,
              profileId: binding.profileId,
              executionKey: reservation.key,
              origin: "automatic",
              policyHash: createHash("sha256")
                .update("orphan-recovery-v1")
                .digest("hex"),
              trigger: createHash("sha256")
                .update("never-dispatched")
                .digest("hex"),
              createdAt: this.clock(),
              lastAttemptAt: null,
              dispatchCount: 0,
              state: "cancelled_before_send",
              outcome: null,
              windowsReset: null,
            });
            await this.store.writeLedger(ledger);
            proven = true;
          } else {
            assert(
              existing.actor === actor,
              "Pending reset belongs to a different authenticated actor.",
            );
            proven =
              existing.executionKey === reservation.key &&
              existing.state === "cancelled_before_send" &&
              existing.dispatchCount === 0;
          }
        });
        if (proven)
          await this.store.updateReservation(
            reservation.key,
            scope,
            reservation.value.redeemRequestId,
            "cancelled_before_send",
          );
      }
      if (orphaned.length) result.action.state = "cancelled_before_send";
    }
    if (intent)
      await this.store.updateReservation(
        intent.executionKey,
        scope,
        intent.redeemRequestId,
        intent.state === "terminal"
          ? "terminal"
          : intent.state === "cancelled_before_send"
            ? "cancelled_before_send"
            : "dispatched",
      );
    if (currentExecutionReserved && observed) {
      const dispatched =
        intent?.attemptExecutions?.includes(options.executionKey) ?? false;
      await this.store.updateReservation(
        options.executionKey,
        scope,
        observed.redeemRequestId,
        dispatched
          ? intent?.state === "terminal"
            ? "terminal"
            : "dispatched"
          : "cancelled_before_send",
      );
    }
    return this.finish(binding, session, snapshot, result, intent);
  }
  private async consume(
    session: Session,
    intent: ResetIntent,
    signal?: AbortSignal,
  ): Promise<{ outcome: ResetOutcome; windowsReset: number | null }> {
    const scope = requestScope([signal], 10000);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/rate-limit-reset-credits/consume`,
        {
          method: "POST",
          redirect: "error",
          signal: scope.signal,
          headers: {
            ...accountHeaders(session),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            redeem_request_id: intent.redeemRequestId,
            credit_id: intent.creditId,
          }),
        },
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new CodexError(
          "provider",
          "The reset outcome could not be established.",
        );
      }
      const data = record(await readJson(response, 256 * 1024, scope.signal));
      assert(
        ["reset", "nothing_to_reset", "no_credit", "already_redeemed"].includes(
          String(data.code),
        ),
        "The reset response has an unknown outcome.",
      );
      assert(
        data.windows_reset === undefined ||
          data.windows_reset === null ||
          count(data.windows_reset) !== null,
        "The reset response has an invalid window count.",
      );
      return {
        outcome: data.code as ResetOutcome,
        windowsReset: count(data.windows_reset),
      };
    } finally {
      scope.close();
    }
  }
  private result(
    s: AccountSnapshot,
    origin: ResetResult["action"]["origin"],
  ): ResetResult {
    return {
      schemaVersion: 1,
      operation:
        origin === "reconcile" ? "resolvePendingReset" : "useResetCredit",
      checkedAt: new Date(this.clock()).toISOString(),
      account: s.account,
      limits: s.limits,
      resetCredits: s.resetCredits,
      action: {
        state: "skipped",
        outcome: null,
        reason: null,
        origin,
        windowsReset: null,
        limitsRefreshed: false,
        recovery: "unknown",
      },
    };
  }
  private async finish(
    binding: Binding,
    session: Session,
    snapshot: AccountSnapshot,
    result: ResetResult,
    intent?: ResetIntent,
  ): Promise<ResetResult> {
    if (!intent) return result;
    if (intent.state === "terminal") {
      result.action.state = "terminal";
      result.action.outcome = intent.outcome;
      result.action.windowsReset = intent.windowsReset;
      try {
        this.reader.invalidateBeforeFreshRead(session);
        snapshot = await this.reader.readWithSession(binding, session, {
          force: true,
          includeResetDetails: true,
        });
        result.action.limitsRefreshed =
          snapshot.limits.freshness.state === "fresh";
      } catch {
        /* A definite action remains definite even if its refresh fails. */
        snapshot = structuredClone(snapshot);
        snapshot.limits.freshness = {
          ...snapshot.limits.freshness,
          state: "stale",
          reason: "read_failed",
        };
        snapshot.resetCredits.freshness = {
          ...snapshot.resetCredits.freshness,
          state: "stale",
          reason: "read_failed",
        };
      }
      result.action.recovery = !result.action.limitsRefreshed
        ? "unknown"
        : snapshot.routing.decision === "allowed"
          ? "allowed"
          : snapshot.routing.decision === "quota_exhausted"
            ? "still_exhausted"
            : "unknown";
    } else if (intent.state === "cancelled_before_send") {
      result.action.state = "cancelled_before_send";
      result.action.reason ??= "cancelled";
    } else {
      result.action.state = "uncertain";
      result.action.reason ??= "pending_action";
    }
    return {
      ...result,
      checkedAt: new Date(this.clock()).toISOString(),
      limits: snapshot.limits,
      resetCredits: snapshot.resetCredits,
    };
  }
}
