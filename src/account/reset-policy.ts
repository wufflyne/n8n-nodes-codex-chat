import { createHash } from "node:crypto";
import { assert, checkKeys, record } from "../core/errors.js";
import type { AccountSnapshot, RecoveryPolicy } from "./types.js";
export function validateRecovery(policy: RecoveryPolicy) {
  const value = record(policy);
  checkKeys(value, ["automatic", "threshold", "maxPer24Hours", "order"]);
  assert(
    typeof policy.automatic === "boolean" &&
      Number.isFinite(policy.threshold) &&
      policy.threshold >= 0 &&
      policy.threshold <= 1 &&
      Number.isInteger(policy.maxPer24Hours) &&
      policy.maxPer24Hours >= 1 &&
      policy.maxPer24Hours <= 3 &&
      ["next-first", "reset-first"].includes(policy.order),
    "The account recovery policy is invalid.",
  );
}

export interface ResetOptions {
  origin: "manual" | "automatic";
  executionKey: string;
  policy: RecoveryPolicy;
  selectedCreditId?: string;
  acknowledgement?: boolean;
  signal?: AbortSignal;
}
/** Pure validation: call before any account, admission or operation access. */
export function validateResetOptions(value: unknown, allowSignal = false): ResetOptions {
  const options = record(value);
  checkKeys(options, ["origin", "executionKey", "policy", "selectedCreditId", "acknowledgement", ...(allowSignal ? ["signal"] : [])]);
  assert(options.origin === "manual" || options.origin === "automatic", "Choose a manual or automatic reset origin.");
  validateExecutionKey(options.executionKey);
  validateRecovery(options.policy as RecoveryPolicy);
  assert(options.acknowledgement === undefined || typeof options.acknowledgement === "boolean", "Reset acknowledgement must be a boolean.");
  if (options.origin === "manual") {
    assert(options.acknowledgement === true, "Allow this step to use one earned reset credit before executing it.");
    assert(typeof options.selectedCreditId === "string" && /^[^\x00-\x20\x7f]{1,256}$/.test(options.selectedCreditId), "Select one eligible reset allocation before executing this manual action.");
  } else {
    assert(options.selectedCreditId === undefined && options.acknowledgement === undefined, "Automatic resets cannot include manual allocation or acknowledgement options.");
  }
  assert(options.signal === undefined || options.signal instanceof AbortSignal, "The reset cancellation signal is invalid.");
  return { ...options, policy: { ...(options.policy as RecoveryPolicy) } } as unknown as ResetOptions;
}
function validateExecutionKey(value: unknown): asserts value is string {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "A public workflow execution identity is required for reset coordination.");
}
export function validateReconcileOptions(value: unknown, allowSignal = false): { executionKey: string; signal?: AbortSignal } {
  const options = record(value);
  checkKeys(options, ["executionKey", ...(allowSignal ? ["signal"] : [])]);
  validateExecutionKey(options.executionKey);
  assert(options.signal === undefined || options.signal instanceof AbortSignal, "The reconciliation cancellation signal is invalid.");
  return { ...options } as { executionKey: string; signal?: AbortSignal };
}
export function lowAllowance(
  snapshot: AccountSnapshot,
  policy: RecoveryPolicy,
  now = Date.now(),
): boolean {
  return (
    snapshot.limits.freshness.state === "fresh" &&
    snapshot.limits.buckets.some(
      (b) =>
        b.scope === "ordinary" &&
        b.windows.some(
          (w) =>
            w.remainingPercent !== null &&
            w.remainingPercent <= policy.threshold &&
            w.windowSeconds !== null &&
            w.resetsAt !== null &&
            Date.parse(w.resetsAt) > now,
        ),
    )
  );
}
export function resetEligibility(
  snapshot: AccountSnapshot,
  policy: RecoveryPolicy,
  origin: "manual" | "automatic",
  selected?: string,
  now = Date.now(),
): {
  eligible: boolean;
  reason: "not_eligible" | "threshold_not_met" | "unknown_data" | null;
  creditId?: string;
  trigger?: string;
} {
  const no = (
    reason: "not_eligible" | "threshold_not_met" | "unknown_data",
  ) => ({ eligible: false, reason });
  for (const f of [snapshot.limits.freshness, snapshot.resetCredits.freshness])
    if (
      f.state !== "fresh" ||
      !f.checkedAt ||
      now - Date.parse(f.checkedAt) > 5000
    )
      return no("unknown_data");
  const ordinary = snapshot.limits.buckets.find((b) => b.scope === "ordinary");
  if (
    !ordinary ||
    (snapshot.limits.reachedType !== null &&
      snapshot.limits.reachedType !== "rate_limit_reached")
  )
    return no("unknown_data");
  const denied =
    ordinary.allowed === false &&
    ordinary.limitReached === true &&
    snapshot.limits.reachedType === "rate_limit_reached";
  if (ordinary.allowed !== true && !denied) return no("unknown_data");
  const windows = ordinary.windows.filter(
    (w) =>
      w.windowSeconds !== null &&
      w.resetsAt !== null &&
      Date.parse(w.resetsAt) > now,
  );
  if (
    !windows.length ||
    ordinary.windows.some(
      (w) =>
        w.windowSeconds === null ||
        w.resetsAt === null ||
        Date.parse(w.resetsAt) <= now ||
        w.usedPercent === null,
    )
  )
    return no("unknown_data");
  if (
    !windows.some((w) => w.usedPercent !== null && w.usedPercent > 0) &&
    !denied
  )
    return no("not_eligible");
  if (
    origin === "automatic" &&
    !windows.some(
      (w) =>
        w.remainingPercent !== null && w.remainingPercent <= policy.threshold,
    )
  )
    return no("threshold_not_met");
  if (
    snapshot.resetCredits.availableCount === null ||
    snapshot.resetCredits.availableCount <= 0
  )
    return no("not_eligible");
  const credit = snapshot.resetCredits.entries.find(
    (e) => e.eligible && (!selected || e.id === selected),
  );
  if (!credit) return no("not_eligible");
  return {
    eligible: true,
    reason: null,
    creditId: credit.id,
    trigger: createHash("sha256")
      .update(
        JSON.stringify(
          windows.map((w) => [w.kind, w.windowSeconds, w.resetsAt]).sort(),
        ),
      )
      .digest("hex"),
  };
}
