import { isProfileAccess, type ProfileAccess, type ProfileBinding } from "../service/access.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CodexError, assert, checkKeys, record, string } from "../core/errors.js";
import { throwIfAborted, waitForSignal } from "../core/http.js";
import {
  CODEX_CLIENT_ID,
  PROVIDER,
  type Binding,
  type Identity,
  type Profile,
  type Session,
  type TokenSet,
} from "../core/types.js";
import { tokenResponse, type AuthProvider } from "./provider.js";
import { verifyDelivery, type DurableBinding } from "./connection.js";
import { ProfileStore, bindingHash } from "./store.js";

function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.issuer === b.issuer &&
    a.subject === b.subject &&
    a.accountId === b.accountId &&
    a.clientId === b.clientId
  );
}

function unchangedMaterial(received: TokenSet, verified: TokenSet): void {
  assert(["accessToken", "refreshToken", "idToken"].every(
    (name) => received[name as keyof TokenSet] === verified[name as keyof TokenSet]),
    "Verification changed captured token material. Preserve the successful response and recover it offline.");
}

export interface PreparedNewProfile {
  readonly mode: "new";
  readonly binding: Readonly<Binding>;
}
export interface ConnectResult {
  binding: Binding;
  state: "connected" | "committed_after_cancel";
}

export class AccountSessionManager {
  private readonly flights = new Map<string, Promise<Profile>>();
  constructor(
    readonly store: ProfileStore,
    private readonly auth: AuthProvider,
    readonly refreshEnabled = true,
  ) {}

  /** Graceful ownership transfer waits for all rotating-token commits. */
  async settleRenewals(): Promise<void> {
    await Promise.allSettled([...this.flights.values()]);
  }

  /** Administrator reconnection preserves the original binding hash and identity. */
  async reconnectAuthorized(
    access: ProfileAccess,
    tokens: TokenSet,
    label: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assert(
      isProfileAccess(access) && access.authority === "administrator",
      "Administrator profile access is required for reconnection.",
    );
    const placeholder = { profileId: access.profileId, bindingSecret: "" };
    await this.activate(tokens, label, placeholder, placeholder, signal, access);
  }

  prepareNewProfile(): PreparedNewProfile {
    return Object.freeze({
      mode: "new",
      binding: Object.freeze({
        profileId: randomUUID(),
        bindingSecret: randomBytes(32).toString("base64url"),
      }),
    });
  }

  async activatePreparedProfile(
    prepared: PreparedNewProfile,
    tokens: TokenSet,
    label: string,
    options: { bindingDurable: DurableBinding; signal?: AbortSignal },
  ): Promise<ConnectResult> {
    assert(prepared.mode === "new", "A new-profile activation requires prepared mode.");
    verifyDelivery(options.bindingDurable, prepared.binding);
    const binding = await this.activate(tokens, label, undefined, prepared.binding, options.signal);
    return {
      binding,
      state: options.signal?.aborted ? "committed_after_cancel" : "connected",
    };
  }

  /** Library compatibility path; CLI uses durable prepared activation. Cancellation stops only before commit. */
  async importTokens(
    tokens: TokenSet,
    label: string,
    existing?: Binding,
    signal?: AbortSignal,
  ): Promise<Binding> {
    return this.activate(
      tokens,
      label,
      existing,
      existing ?? this.prepareNewProfile().binding,
      signal,
    );
  }

  private async activate(
    tokens: TokenSet,
    label: string,
    existing: Binding | undefined,
    selectedBinding: Binding,
    signal?: AbortSignal,
    ownerAccess?: ProfileAccess,
  ): Promise<Binding> {
    throwIfAborted(signal);
    assert(
      label.length > 0 && label.length <= 80 && !/[\x00-\x1f\x7f]/.test(label),
      "The account label must contain 1–80 characters on one line.",
    );
    // Snapshot before awaiting identity keys; callers cannot alter a validated candidate later.
    const snapshot = structuredClone(tokens);
    const binding = { ...selectedBinding };
    await this.store.rotation.initialize();
    const observed = existing ? await this.store.read(ownerAccess ?? binding) : undefined;
    const candidate = await waitForSignal(
      this.auth.verify(structuredClone(snapshot), Boolean(snapshot.refreshToken)),
      signal,
    );
    unchangedMaterial(snapshot, candidate.tokens);
    throwIfAborted(signal);
    const verifiedCandidate = structuredClone(candidate);
    await this.store.locked(binding.profileId, async () => {
      throwIfAborted(signal);
      if (existing) await this.store.rotation.recoverCommitted(binding.profileId);
      if (!existing)
        assert(
          !(await this.store.exists(binding.profileId)),
          "The prepared profile already exists. Start a new connection.",
        );
      const previous = existing ? await this.store.read(ownerAccess ?? binding) : undefined;
      throwIfAborted(signal);
      assert(
        !previous || sameIdentity(previous, verifiedCandidate.identity),
        "Reconnect belongs to a different account. Create a separate profile instead.",
      );
      assert(
        !previous || previous.generation === observed?.generation,
        "The profile changed while the import was being verified. Retry with a fresh token set.",
      );
      // A candidate sharing the managed rotating secret must not bypass a persisted renewal fence.
      assert(
        !previous ||
          previous.state === "ready" ||
          !verifiedCandidate.tokens.refreshToken ||
          previous.tokens.refreshToken !== verifiedCandidate.tokens.refreshToken,
        "This rotating token has an uncertain or revoked outcome. Reconnect using a fresh device login or independent token set.",
      );
      throwIfAborted(signal);
      // Ownership is durable before activation, including initially unexpired imports.
      const verified = verifiedCandidate;
      if (verified.tokens.expiresAt <= Date.now()) {
        assert(this.refreshEnabled && verified.tokens.refreshToken,
          "The imported access token has expired and automatic renewal is unavailable.");
        assert((verified.tokens.earliestRefreshAt ?? 0) <= Date.now(),
          "Token renewal is not permitted yet. Wait until the allowed refresh time.");
      }
      const profile: Profile = {
        ...verified.identity,
        version: 1,
        provider: PROVIDER,
        id: binding.profileId,
        label,
        bindingHash: previous?.bindingHash ?? bindingHash(binding.bindingSecret),
        generation: (previous?.generation ?? 0) + 1,
        state: "ready",
        tokens: verified.tokens,
        verifiedAt: Date.now(),
        ...(verified.display ? { display: verified.display } : {}),
      };
      if (profile.tokens.expiresAt <= Date.now()) {
        const operation = await this.store.rotation.beginBootstrap(profile, previous);
        await this.completeRotation(profile, operation, profile.generation,
          previous?.tokens.refreshToken === profile.tokens.refreshToken ? previous : undefined);
      } else await this.store.rotation.register(profile, previous);
    });
    return binding;
  }

  async session(binding: ProfileBinding, signal?: AbortSignal): Promise<Session> {
    throwIfAborted(signal);
    await this.store.rotation.initialize();
    let profile = await this.store.read(binding);
    // Another owner may replace this generation while we wait. Do not rotate
    // its replacement again merely because it has a short access-token lifetime.
    const observedGeneration = profile.generation;
    throwIfAborted(signal);
    const active = this.flights.get(profile.id);
    if (active) profile = await waitForSignal(active, signal);
    else if (profile.state === "refresh_uncertain")
      profile = await waitForSignal(
        this.store.locked(profile.id, async () => {
          await this.store.rotation.recoverCommitted(profile.id);
          return this.store.read(binding);
        }),
        signal,
      );
    if (profile.state !== "ready")
      throw new CodexError(
        "reconnect",
        profile.state === "refresh_uncertain"
          ? "The previous token renewal did not finish safely. Reconnect this profile; stored credentials were preserved."
          : "Reconnect this account profile before continuing.",
      );
    try { await this.store.rotation.assertReady(profile); }
    catch {
      profile = await this.store.locked(profile.id, async () => {
        await this.store.rotation.recoverCommitted(profile.id);
        return this.store.read(binding);
      });
      await this.store.rotation.assertReady(profile);
      if (profile.state !== "ready") throw new CodexError("reconnect", "The profile requires offline recovery or an independent login.");
    }
    const expiresSoon = profile.tokens.expiresAt <= Date.now() + 30000;
    if (
      expiresSoon &&
      this.refreshEnabled &&
      profile.tokens.refreshToken &&
      (profile.tokens.earliestRefreshAt ?? 0) <= Date.now()
    ) {
      let flight = this.flights.get(profile.id);
      if (!flight) {
        flight = this.renew(binding, observedGeneration);
        this.flights.set(profile.id, flight);
        void flight.finally(() => this.flights.delete(profile.id)).catch(() => undefined);
      }
      // Caller cancellation never cancels the shared rotating-token operation.
      profile = await waitForSignal(flight, signal);
    }
    if (profile.tokens.expiresAt <= Date.now())
      throw new CodexError(
        "reconnect",
        "The access token has expired. Automatic renewal is disabled or unavailable; reconnect this profile.",
      );
    throwIfAborted(signal);
    return this.toSession(profile);
  }

  async currentSession(binding: ProfileBinding, signal?: AbortSignal): Promise<Session> {
    throwIfAborted(signal);
    await this.store.rotation.initialize();
    const profile = await this.store.read(binding);
    await this.store.rotation.assertReady(profile);
    throwIfAborted(signal);
    if (profile.state !== "ready" || profile.tokens.expiresAt <= Date.now())
      throw new CodexError(
        "reconnect",
        "The current access session is unavailable or expired. Reconnect this profile.",
      );
    return this.toSession(profile);
  }

  private toSession(profile: Profile): Session {
    return {
      accessToken: profile.tokens.accessToken,
      accountId: profile.accountId,
      affinity: createHash("sha256")
        .update(`${profile.id}:${profile.subject}:${profile.accountId}`)
        .digest("hex"),
      generation: profile.generation,
      profileId: profile.id,
      identity: {
        issuer: profile.issuer,
        subject: profile.subject,
        accountId: profile.accountId,
        clientId: profile.clientId,
      },
    };
  }

  private async renew(binding: ProfileBinding, observedGeneration: number): Promise<Profile> {
    return this.store.locked(binding.profileId, async () => {
      await this.store.rotation.recoverCommitted(binding.profileId);
      const current = await this.store.read(binding);
      if (current.state !== "ready")
        throw new CodexError("reconnect", "The profile requires reconnection before renewal.");
      if (current.generation !== observedGeneration) return current;
      if (current.tokens.expiresAt > Date.now() + 30000) return current;
      assert(
        current.tokens.refreshToken && this.refreshEnabled,
        "Automatic renewal is unavailable.",
      );
      assert(
        (current.tokens.earliestRefreshAt ?? 0) <= Date.now(),
        "Token renewal is not permitted yet.",
      );
      return this.rotate(current);
    });
  }

  private async rotate(current: Profile): Promise<Profile> {
    const operation = await this.store.rotation.begin(current);
    return this.completeRotation(current, operation, current.generation + 1, current);
  }

  private async completeRotation(current: Profile, operation: string, generation: number, failureProfile?: Profile): Promise<Profile> {
    try {
      const renewed = await this.auth.refresh(structuredClone(current.tokens), async (bytes) => {
        await this.store.rotation.capture(operation, { kind: "http", bytes: bytes.toString("base64") });
      });
      // Custom providers may not implement raw HTTP capture. Preserve their returned bundle before verification.
      if (!await this.store.rotation.captured(operation))
        await this.store.rotation.capture(operation, { kind: "tokens", tokens: structuredClone(renewed) });
      const received = { ...renewed,
        refreshToken: renewed.refreshToken ?? current.tokens.refreshToken,
        idToken: renewed.idToken ?? current.tokens.idToken };
      const fresh = await this.auth.verify(structuredClone(received));
      unchangedMaterial(received, fresh.tokens);
      assert(sameIdentity(current, fresh.identity), "Token renewal returned a different account. Preserve the captured response and reconnect this profile.");
      const replacement: Profile = { ...current, tokens: fresh.tokens, generation,
        state: "ready", verifiedAt: Date.now(), display: fresh.display };
      await this.store.rotation.verifyReceipt(operation, replacement);
      return await this.store.rotation.promote(operation);
    } catch (error) {
      // A received response remains encrypted even when parsing, verification or promotion fails.
      // No error path reauthorizes the dispatched epoch.
      if (failureProfile && error instanceof CodexError && error.category === "reconnect")
        await this.store.write({ ...failureProfile, state: "reconnect" });
      throw error;
    }
  }

  /** Deliberate offline recovery verifies captured material, never calls the refresh endpoint. */
  async recover(binding: ProfileBinding): Promise<void> {
    await this.store.rotation.initialize();
    await this.store.locked(binding.profileId, async () => {
      if (await this.store.exists(binding.profileId)) await this.store.read(binding);
      else {
        const candidate = await this.store.rotation.recoveryBindingProfile(binding.profileId);
        assert(isProfileAccess(binding) || bindingHash(binding.bindingSecret) === candidate.bindingHash, "The recovery binding is invalid.");
      }
      await this.store.rotation.recoverCommitted(binding.profileId);
      const profile = await this.store.exists(binding.profileId) ? await this.store.read(binding) : undefined;
      if (profile?.state === "ready" && !await this.store.rotation.hasReceipt(binding.profileId)) {
        await this.store.rotation.assertReady(profile); return;
      }
      const receipt = await this.store.rotation.recoveryReceipt(binding.profileId);
      let tokens: TokenSet;
      if (receipt.capture!.kind === "http") {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(receipt.capture!.bytes, "base64").toString("utf8")); }
        catch { throw new CodexError("protocol", "The captured successful response is malformed and cannot be promoted. Preserve it and use an independent login."); }
        tokens = tokenResponse(parsed, receipt.before.tokens);
      } else tokens = receipt.capture!.tokens;
      const received = { ...tokens,
        refreshToken: tokens.refreshToken ?? receipt.before.tokens.refreshToken,
        idToken: tokens.idToken ?? receipt.before.tokens.idToken };
      const verified = await this.auth.verify(structuredClone(received));
      unchangedMaterial(received, verified.tokens);
      assert(sameIdentity(receipt.before, verified.identity), "The captured renewal belongs to a different identity and cannot be promoted.");
      await this.store.rotation.verifyReceipt(receipt.id, { ...receipt.before, tokens: verified.tokens,
        generation: receipt.before.generation + (receipt.bootstrap ? 0 : 1), state: "ready", verifiedAt: Date.now(), display: verified.display });
      await this.store.rotation.promote(receipt.id);
    });
  }

}

/** Import is explicit; no home directory discovery and no source-file mutation. */
export function parseManualTokens(
  value: unknown,
  format: "token-set" | "codex-auth-json",
): TokenSet {
  assert(
    format === "token-set" || format === "codex-auth-json",
    "Choose a supported manual import format.",
  );
  const root = record(value);
  let data: Record<string, unknown>;
  if (format === "token-set") {
    checkKeys(root, [
      "provider",
      "client_id",
      "access_token",
      "refresh_token",
      "id_token",
      "expires_at",
      "earliest_refresh_at",
      "scopes",
    ]);
    assert(
      root.provider === PROVIDER && root.client_id === CODEX_CLIENT_ID,
      "Choose the explicit Codex token-set format with the matching provider and OAuth client ID.",
    );
    data = root;
  } else {
    assert(
      root.OPENAI_API_KEY == null && (!root.auth_mode || root.auth_mode === "chatgpt"),
      "This import accepts Codex ChatGPT accounts only. API keys and other auth modes are unsupported.",
    );
    data = record(root.tokens);
  }
  for (const name of ["expires_at", "earliest_refresh_at"])
    assert(
      data[name] === undefined ||
        (typeof data[name] === "number" &&
          Number.isFinite(data[name]) &&
          Number(data[name]) >= 0 &&
          Number(data[name]) <= 8640000000000),
      "Token timestamps must be finite nonnegative Unix seconds.",
    );
  assert(
    data.scopes === undefined ||
      (Array.isArray(data.scopes) &&
        data.scopes.every((scope) => typeof scope === "string" && scope.length <= 1024)),
    "Token scopes must be an array of strings.",
  );
  return {
    accessToken: string(data.access_token, "Access token; refresh-only bootstrap is unsupported"),
    refreshToken:
      data.refresh_token == null || data.refresh_token === ""
        ? undefined
        : string(data.refresh_token, "Refresh token"),
    idToken:
      data.id_token == null || data.id_token === "" ? undefined : string(data.id_token, "ID token"),
    expiresAt: typeof data.expires_at === "number" ? data.expires_at * 1000 : 0,
    earliestRefreshAt:
      typeof data.earliest_refresh_at === "number" ? data.earliest_refresh_at * 1000 : undefined,
    scopes:
      Array.isArray(data.scopes) && data.scopes.every((s) => typeof s === "string")
        ? (data.scopes as string[])
        : [],
  };
}
