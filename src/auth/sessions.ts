import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CodexError,
  assert,
  checkKeys,
  record,
  string,
} from "../core/errors.js";
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
import type { AuthProvider, VerifiedTokens } from "./provider.js";
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
    assert(
      prepared.mode === "new",
      "A new-profile activation requires prepared mode.",
    );
    verifyDelivery(options.bindingDurable, prepared.binding);
    const binding = await this.activate(
      tokens,
      label,
      undefined,
      prepared.binding,
      options.signal,
    );
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
  ): Promise<Binding> {
    throwIfAborted(signal);
    assert(
      label.length > 0 && label.length <= 80 && !/[\x00-\x1f\x7f]/.test(label),
      "The account label must contain 1–80 characters on one line.",
    );
    // Snapshot before awaiting identity keys; callers cannot alter a validated candidate later.
    const snapshot = structuredClone(tokens);
    const binding = { ...selectedBinding };
    const observed = existing ? await this.store.read(binding) : undefined;
    const candidate = await waitForSignal(
      this.auth.verify(snapshot, Boolean(snapshot.refreshToken)),
      signal,
    );
    throwIfAborted(signal);
    const verifiedCandidate = structuredClone(candidate);
    await this.store.locked(binding.profileId, async () => {
      throwIfAborted(signal);
      if (!existing)
        assert(
          !(await this.store.exists(binding.profileId)),
          "The prepared profile already exists. Start a new connection.",
        );
      const previous = existing ? await this.store.read(binding) : undefined;
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
          previous.tokens.refreshToken !==
            verifiedCandidate.tokens.refreshToken,
        "This rotating token has an uncertain or revoked outcome. Reconnect using a fresh device login or independent token set.",
      );
      throwIfAborted(signal);
      // Commit starts at the next profile/bootstrap-intent write. Complete it despite later caller cancellation.
      let verified = verifiedCandidate;
      if (verified.tokens.expiresAt <= Date.now()) {
        assert(
          this.refreshEnabled && verified.tokens.refreshToken,
          "The imported access token has expired and automatic renewal is unavailable.",
        );
        assert(
          (verified.tokens.earliestRefreshAt ?? 0) <= Date.now(),
          "Token renewal is not permitted yet. Wait until the allowed refresh time.",
        );
        // Preserve a working profile; a separate durable claim prevents this bootstrap token being reused.
        await this.store.claimImportRenewal(verified.tokens.refreshToken);
        if (previous?.tokens.refreshToken === verified.tokens.refreshToken)
          await this.store.write({ ...previous, state: "refresh_uncertain" });
        verified = await this.auth.verify(
          await this.auth.refresh(verified.tokens),
        );
        assert(
          sameIdentity(verifiedCandidate.identity, verified.identity),
          "Token renewal returned a different account. The profile was not replaced.",
        );
      }
      const profile: Profile = {
        ...verified.identity,
        version: 1,
        provider: PROVIDER,
        id: binding.profileId,
        label,
        bindingHash: bindingHash(binding.bindingSecret),
        generation: (previous?.generation ?? 0) + 1,
        state: "ready",
        tokens: verified.tokens,
        verifiedAt: Date.now(),
        ...(verified.display ? { display: verified.display } : {}),
      };
      await this.store.write(profile);
    });
    return binding;
  }

  async session(binding: Binding, signal?: AbortSignal): Promise<Session> {
    throwIfAborted(signal);
    let profile = await this.store.read(binding);
    throwIfAborted(signal);
    const active = this.flights.get(profile.id);
    if (active) profile = await waitForSignal(active, signal);
    else if (profile.state === "refresh_uncertain")
      profile = await waitForSignal(
        this.store.locked(profile.id, () => this.store.read(binding)),
        signal,
      );
    if (profile.state !== "ready")
      throw new CodexError(
        "reconnect",
        profile.state === "refresh_uncertain"
          ? "The previous token renewal did not finish safely. Reconnect this profile; stored credentials were preserved."
          : "Reconnect this account profile before continuing.",
      );
    const expiresSoon = profile.tokens.expiresAt <= Date.now() + 30000;
    if (
      expiresSoon &&
      this.refreshEnabled &&
      profile.tokens.refreshToken &&
      (profile.tokens.earliestRefreshAt ?? 0) <= Date.now()
    ) {
      let flight = this.flights.get(profile.id);
      if (!flight) {
        flight = this.renew(binding, profile.generation);
        this.flights.set(profile.id, flight);
        void flight
          .finally(() => this.flights.delete(profile.id))
          .catch(() => undefined);
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

  async currentSession(
    binding: Binding,
    signal?: AbortSignal,
  ): Promise<Session> {
    throwIfAborted(signal);
    const profile = await this.store.read(binding);
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

  private async renew(
    binding: Binding,
    observedGeneration: number,
  ): Promise<Profile> {
    return this.store.locked(binding.profileId, async () => {
      const current = await this.store.read(binding);
      if (current.state !== "ready")
        throw new CodexError(
          "reconnect",
          "The profile requires reconnection before renewal.",
        );
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
      // Persist an intent before using a rotating secret. A crash or ambiguous write cannot reuse it silently.
      await this.store.write({ ...current, state: "refresh_uncertain" });
      let fresh: VerifiedTokens;
      try {
        const renewed = await this.auth.refresh(current.tokens);
        fresh = await this.auth.verify(renewed);
        assert(
          sameIdentity(current, fresh.identity),
          "Token renewal returned a different account. Reconnect this profile.",
        );
      } catch (error) {
        const permanent =
          error instanceof CodexError && error.category === "reconnect";
        // Preserve tokens for recovery. Unknown outcomes deliberately remain fenced against replay.
        if (permanent)
          await this.store.write({ ...current, state: "reconnect" });
        throw error;
      }
      const replacement: Profile = {
        ...current,
        tokens: fresh.tokens,
        generation: current.generation + 1,
        state: "ready",
        verifiedAt: Date.now(),
        display: fresh.display,
      };
      await this.store.write(replacement);
      return replacement;
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
      root.OPENAI_API_KEY == null &&
        (!root.auth_mode || root.auth_mode === "chatgpt"),
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
        data.scopes.every(
          (scope) => typeof scope === "string" && scope.length <= 1024,
        )),
    "Token scopes must be an array of strings.",
  );
  return {
    accessToken: string(
      data.access_token,
      "Access token; refresh-only bootstrap is unsupported",
    ),
    refreshToken:
      data.refresh_token == null || data.refresh_token === ""
        ? undefined
        : string(data.refresh_token, "Refresh token"),
    idToken:
      data.id_token == null || data.id_token === ""
        ? undefined
        : string(data.id_token, "ID token"),
    expiresAt: typeof data.expires_at === "number" ? data.expires_at * 1000 : 0,
    earliestRefreshAt:
      typeof data.earliest_refresh_at === "number"
        ? data.earliest_refresh_at * 1000
        : undefined,
    scopes:
      Array.isArray(data.scopes) &&
      data.scopes.every((s) => typeof s === "string")
        ? (data.scopes as string[])
        : [],
  };
}
