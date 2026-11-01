import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ICredentialDataDecryptedObject } from "n8n-workflow";
import { assert, CodexError } from "../core/errors.js";
import type { Binding, TokenSet } from "../core/types.js";
import { ISSUER } from "../core/types.js";
import { credentialBinding, runtimeFromEnvironment, cachedRuntime } from "../runtime.js";
import { EmbeddedService } from "./embedded.js";
import { parseManualTokens } from "../auth/sessions.js";
import { deliverEncryptedBinding } from "../auth/connection.js";
import { tokenResponse } from "../auth/provider.js";
import { verifiedAccess } from "./access.js";
import {
  authorizedCredential,
  persistCredential,
  type CredentialContext,
} from "./credential-persistence.js";
import { managerById, type NativeManager } from "./native-manager.js";
import type { NativeAccount } from "./native-records.js";
import { retireConnectionAttempt } from "./native-records.js";
import { throwIfAborted } from "../core/http.js";

function equal(a: unknown, b: unknown) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function entry(accounts: Record<string, NativeAccount>, id: string) {
  return Object.hasOwn(accounts, id) ? accounts[id] : undefined;
}
function matches(data: ICredentialDataDecryptedObject, account: NativeAccount, managerId: string) {
  return (
    data.ownerManagerId === managerId &&
    data.deliveryId === account.deliveryId &&
    data.profileId === account.binding.profileId &&
    equal(data.bindingSecret, account.binding.bindingSecret)
  );
}
export async function managedAccount(ctx: CredentialContext) {
  const selected = await authorizedCredential(ctx, "codexAccount");
  assert(
    typeof selected.data.ownerManagerId === "string" && selected.data.ownerManagerId,
    "This account is not connected. Use Codex Account → Start Sign-in with your Manager.",
  );
  const manager = managerById(selected.data.ownerManagerId);
  const account = entry((await manager.records.read()).accounts, selected.id);
  assert(
    account?.acknowledged && matches(selected.data, account, manager.id),
    "This account credential is not the acknowledged target. Select the original credential and Manager; copied bindings cannot enroll another credential.",
  );
  return { manager, binding: { ...account.binding }, id: selected.id };
}
export async function authorizeManager(ctx: CredentialContext) {
  const selected = await authorizedCredential(ctx, "codexWireManager"),
    manager = managerById(selected.id);
  manager.authorize(selected.data.managerPassphrase, selected.data.ownerKey);
  return { manager, data: selected.data };
}
async function deliver(ctx: CredentialContext, manager: NativeManager) {
  const selected = await authorizedCredential(ctx, "codexAccount");
  if (selected.data.ownerManagerId)
    assert(
      selected.data.ownerManagerId === manager.id,
      "This account belongs to a different Manager. Select its original Manager.",
    );
  assert(
    selected.data.ownerManagerId || (!selected.data.profileId && !selected.data.bindingSecret),
    "This is a legacy binding. Use its configured legacy service; automatic adoption cannot prove safe ownership handover.",
  );
  let account = entry((await manager.records.read()).accounts, selected.id);
  if (!account) {
    assert(
      !selected.data.ownerManagerId && !selected.data.deliveryId,
      "The managed connection journal has no matching target. Preserve the credential and current store; do not reissue a binding.",
    );
    const binding = manager.resources.sessions.prepareNewProfile().binding;
    account = { binding: { ...binding }, deliveryId: randomUUID(), acknowledged: false };
    const prepared = account;
    await manager.records.update((state) => {
      assert(
        !entry(state.accounts, selected.id),
        "Another connection was prepared for this credential.",
      );
      state.accounts[selected.id] = prepared;
    });
  }
  const pending = account;
  const saved = await persistCredential(ctx, "codexAccount", async (id, current) => {
    assert(
      id === selected.id && (!current.ownerManagerId || matches(current, pending, manager.id)),
      "This credential contains a different binding. No account was reassigned.",
    );
    return {
      profileId: pending.binding.profileId,
      bindingSecret: pending.binding.bindingSecret,
      ownerManagerId: manager.id,
      deliveryId: pending.deliveryId,
    };
  });
  assert(
    matches(saved.data, pending, manager.id),
    "The exact encrypted binding delivery was not confirmed.",
  );
  await manager.records.update((state) => {
    const a = entry(state.accounts, selected.id);
    assert(a && a.deliveryId === pending.deliveryId, "The pending delivery changed.");
    a.acknowledged = true;
  });
  return { id: selected.id, account: pending, binding: { ...pending.binding } };
}
function publicAttempt(account: NativeAccount) {
  const a = account.attempt;
  if (!a) return { status: "not_started", nextStep: "Run Start Sign-in." };
  if (a.state === "connected")
    return {
      status: "connected",
      nextStep: "Use this account in Codex Chat Model, Codex Image or account operations.",
    };
  if (a.state === "waiting" && a.expiresAt! <= Date.now())
    return { status: "expired", nextStep: "Run Reconnect to begin an independent sign-in." };
  if (a.state === "waiting")
    return {
      status: "waiting",
      verificationUrl: `${ISSUER}/codex/device`,
      userCode: a.userCode,
      expiresAt: new Date(a.expiresAt!).toISOString(),
      nextStep: "Open the verification page, enter this code, then run Complete Sign-in.",
    };
  if (a.state === "cancelled" || a.state === "expired")
    return { status: a.state, nextStep: "Run Reconnect to begin an independent sign-in." };
  if (a.state === "captured")
    return {
      status: "captured",
      nextStep:
        "Run Complete Sign-in to finish the captured local activation without another token exchange.",
    };
  return {
    status: "reconnect_required",
    nextStep:
      "An earlier request has an unknown outcome and cannot be repeated. Run Reconnect for an independent sign-in.",
  };
}
async function activate(
  manager: NativeManager,
  id: string,
  account: NativeAccount,
  tokens: TokenSet,
  signal?: AbortSignal,
  beforeCommit?: () => Promise<void>,
) {
  throwIfAborted(signal);
  assert(account.acknowledged, "Complete the encrypted account binding acknowledgement first.");
  const store = manager.resources.store;
  if (await store.exists(account.binding.profileId)) {
    const current = await store.read(account.binding);
    if (
      equal(current.tokens.accessToken, tokens.accessToken) &&
      equal(current.tokens.refreshToken ?? "", tokens.refreshToken ?? "")
    ) {
      // Equality is not a commit receipt: recover/assert the authoritative family journal.
      // recover() verifies captured material locally and never sends a token POST.
      await manager.resources.sessions.recover(account.binding);
      const committed = await store.read(account.binding);
      await store.rotation.assertReady(committed);
      assert(
        committed.state === "ready",
        "The captured activation is still fenced. Preserve its journal and use independent Reconnect.",
      );
      await beforeCommit?.();
      return;
    }
    assert(
      account.attempt?.reconnect || account.importReceipt || beforeCommit,
      "The prepared account already contains a different session. Use independent Reconnect.",
    );
    await manager.resources.sessions.reconnectAuthorized(
      verifiedAccess(account.binding.profileId, "administrator"),
      tokens,
      current.label,
      signal,
      beforeCommit,
    );
  } else {
    assert(
      !account.established,
      "The established account profile is missing. Preserve current state and the original credentials; do not create a replacement profile or restore older tokens.",
    );
    const proof = await deliverEncryptedBinding(account.binding, async () => {
      const fresh = entry((await manager.records.read()).accounts, id);
      assert(
        fresh?.acknowledged && fresh.deliveryId === account.deliveryId,
        "The exact native credential ACK is missing.",
      );
    });
    await manager.resources.sessions.activatePreparedProfile(
      { mode: "new", binding: account.binding },
      tokens,
      "Codex Account",
      { bindingDurable: proof, signal, beforeCommit },
    );
  }
}

export async function connectionOperation(
  ctx: CredentialContext,
  operation: string,
  format: "token-set" | "codex-auth-json" = "codex-auth-json",
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const authorized = await authorizeManager(ctx),
    manager = authorized.manager;
  const selected = await authorizedCredential(ctx, "codexAccount");
  return manager.run(() =>
    manager.lock(`connection:${selected.id}`, async () => {
      manager.ensureOpen();
      throwIfAborted(signal);
      const delivered = await deliver(ctx, manager),
        id = delivered.id;
      throwIfAborted(signal);
      let account = entry((await manager.records.read()).accounts, id)!;
      if (operation === "startSignIn" || operation === "reconnect") {
        if (operation === "startSignIn" && account.attempt) return publicAttempt(account);
        const attempt = {
          id: randomUUID(),
          state: "starting" as const,
          reconnect: await manager.resources.store.exists(account.binding.profileId),
        };
        await manager.records.update((state) => {
          const a = state.accounts[id]!;
          retireConnectionAttempt(a);
          a.attempt = attempt;
        });
        let dispatched = false;
        try {
          throwIfAborted(signal);
          dispatched = true;
          const grant = await manager.resources.auth.startDevice();
          await manager.records.update((state) => {
            state.accounts[id]!.attempt = {
              ...attempt,
              ...grant,
              state: "waiting",
              nextPollAt: Date.now() + grant.interval,
            };
          });
        } catch (error) {
          await manager.records.update((state) => {
            state.accounts[id]!.attempt!.state = dispatched ? "uncertain" : "cancelled";
          });
          throw error;
        }
        return publicAttempt(entry((await manager.records.read()).accounts, id)!);
      }
      if (operation === "cancelSignIn") {
        if (
          account.attempt &&
          !["connected", "captured", "exchanging", "polling", "uncertain", "starting"].includes(
            account.attempt.state,
          )
        )
          await manager.records.update((state) => {
            state.accounts[id]!.attempt!.state = "cancelled";
          });
        return publicAttempt(entry((await manager.records.read()).accounts, id)!);
      }
      if (operation === "importSession") {
        const source = authorized.data.sessionImport;
        assert(
          typeof source === "string" &&
            source.length > 0 &&
            Buffer.byteLength(source) <= 256 * 1024,
          "Paste a supported session JSON into the Manager credential's Advanced Session Import field, save, then run Import Session.",
        );
        let json: unknown;
        try {
          json = JSON.parse(source);
        } catch {
          throw new CodexError("configuration", "The encrypted session input is not valid JSON.");
        }
        const tokens = parseManualTokens(json, format),
          digest = createHash("sha256").update(source).digest("hex");
        if (
          account.importReceipt?.digest === digest &&
          account.importReceipt.state === "connected"
        ) {
          const current = await manager.resources.store.read(account.binding);
          await manager.resources.store.rotation.assertReady(current);
          assert(
            current.state === "ready",
            "This import was already applied, but the current session is fenced. Use Status and independent Reconnect; the original import will not be replayed.",
          );
          return {
            status: "already_imported",
            sessionState: current.tokens.expiresAt > Date.now() ? "ready" : "expired",
            nextStep:
              "This import was already applied. Clear Advanced Session Import in the Manager credential.",
          };
        }
        assert(
          !account.importReceipt ||
            account.importReceipt.digest === digest ||
            account.importReceipt.state === "connected",
          "A different import is pending. Preserve its outcome before another import.",
        );
        await activate(manager, id, account, tokens, signal, async () => {
          await manager.records.update((state) => {
            // Both rotation and record-lock waits precede this admission boundary.
            throwIfAborted(signal);
            state.accounts[id]!.importReceipt = { digest, state: "prepared" };
          });
        });
        await manager.records.update((state) => {
          state.accounts[id]!.importReceipt!.state = "connected";
          state.accounts[id]!.established = true;
        });
        return {
          status: "connected",
          committedAfterCancel: signal?.aborted ?? false,
          nextStep:
            "Clear Advanced Session Import in the Manager credential. Use this account in your workflow.",
        };
      }
      assert(operation === "completeSignIn", "Choose a supported connection operation.");
      const attempt = account.attempt;
      if (!attempt || attempt.state === "connected") return publicAttempt(account);
      if (attempt.state === "waiting") {
        throwIfAborted(signal);
        if (Date.now() >= attempt.expiresAt!) {
          await manager.records.update((state) => {
            state.accounts[id]!.attempt!.state = "expired";
          });
          return { status: "expired", nextStep: "Run Reconnect." };
        }
        if (Date.now() < attempt.nextPollAt!) return publicAttempt(account);
        await manager.records.update((state) => {
          state.accounts[id]!.attempt!.state = "polling";
        });
        let dispatched = false;
        try {
          throwIfAborted(signal);
          dispatched = true;
          const code = await manager.resources.auth.pollDevice({
            deviceId: attempt.deviceId!,
            userCode: attempt.userCode!,
          });
          if (!code) {
            await manager.records.update((state) => {
              const a = state.accounts[id]!.attempt!;
              a.state = "waiting";
              a.nextPollAt = Date.now() + a.interval!;
            });
            return publicAttempt(entry((await manager.records.read()).accounts, id)!);
          }
          await manager.records.update((state) => {
            state.accounts[id]!.attempt!.state = "exchanging";
          });
          throwIfAborted(signal);
          await manager.resources.auth.exchangeDevice(code, async (bytes) => {
            await manager.records.update((state) => {
              const a = state.accounts[id]!.attempt!;
              a.capture = bytes.toString("base64");
              a.state = "captured";
            });
          });
        } catch (error) {
          await manager.records.update((state) => {
            const a = state.accounts[id]!.attempt!;
            if (a.state !== "captured") a.state = dispatched ? "uncertain" : "cancelled";
          });
          throw error;
        }
        account = entry((await manager.records.read()).accounts, id)!;
      }
      if (account.attempt?.state !== "captured") return publicAttempt(account);
      let tokens: TokenSet;
      try {
        tokens = tokenResponse(
          JSON.parse(Buffer.from(account.attempt.capture!, "base64").toString("utf8")),
        );
      } catch {
        throw new CodexError(
          "protocol",
          "The captured device exchange cannot be parsed. Preserve it and use independent Reconnect.",
        );
      }
      await activate(manager, id, account, tokens, signal);
      await manager.records.update((state) => {
        const account = state.accounts[id]!;
        account.established = true;
        const a = account.attempt!;
        a.state = "connected";
        delete a.capture;
        delete a.deviceId;
      });
      return {
        status: "connected",
        committedAfterCancel: signal?.aborted ?? false,
        nextStep: "Use this account in Codex Chat Model or account operations.",
      };
    }),
  );
}

/** Connection status before profile activation stays local and gives a native next action. */
export async function nativeAccountStatus(ctx: CredentialContext) {
  const data = await ctx.getCredentials("codexAccount");
  if (!data.ownerManagerId && !data.profileId && !data.bindingSecret && !data.deliveryId)
    return {
      status: "not_connected",
      nextStep:
        "Activate Codex Wire Service, select your Manager, then run Start Sign-in or Import Session.",
    };
  if (data.ownerManagerId) {
    const managed = await managedAccount(ctx);
    if (!(await managed.manager.resources.store.exists(managed.binding.profileId))) {
      const account = entry((await managed.manager.records.read()).accounts, managed.id)!;
      assert(
        !account.established,
        "The established account profile is missing. Preserve current state and original credentials; do not replace its binding or restore older tokens.",
      );
      if (account.importReceipt?.state === "prepared")
        return {
          status: "import_pending",
          nextStep:
            "Run Import Session again with the same saved Manager input. An uncertain renewal cannot be repeated.",
        };
      return publicAttempt(account);
    }
    return managed.manager.service.status(managed.binding);
  }
  const legacy = await nativeAccount(ctx, true);
  return legacy.service.status(legacy.binding);
}

/** Explicit marker wins; legacy field ABI remains unchanged and cannot be silently enrolled. */
export async function nativeAccount(ctx: CredentialContext, readOnly = false) {
  const data = await ctx.getCredentials("codexAccount");
  if (data.ownerManagerId) {
    const managed = await managedAccount(ctx);
    if (readOnly)
      assert(
        await managed.manager.resources.store.exists(managed.binding.profileId),
        "This account has not completed connection. Run Complete Sign-in or Import Session with its original Manager, then explicitly Refresh Models or Refresh Limits.",
      );
    return {
      binding: managed.binding,
      service: managed.manager.service,
      localResources: managed.manager.resources,
      editorCatalog: managed.manager.resources.catalog,
      editorAccount: managed.manager.resources.account,
    };
  }
  assert(!data.deliveryId, "The account credential has incomplete managed metadata.");
  assert(
    data.profileId && data.bindingSecret,
    "This account is not connected. Activate Codex Wire Service, then run Codex Account → Start Sign-in.",
  );
  const binding: Binding = credentialBinding(data);
  const { nativeService } = await import("./native.js");
  const service =
    readOnly && process.env.N8N_CODEX_MODE !== "gateway"
      ? new EmbeddedService(runtimeFromEnvironment({ readOnly: true }))
      : nativeService();
  return {
    binding,
    service,
    localResources: service instanceof EmbeddedService ? service.resources : undefined,
    editorCatalog: readOnly ? cachedRuntime()?.catalog : undefined,
    editorAccount: readOnly ? cachedRuntime()?.account : undefined,
  };
}
