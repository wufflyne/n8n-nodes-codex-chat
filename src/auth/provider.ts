import { CodexError, assert, record, string } from "../core/errors.js";
import {
  admissionError,
  delay,
  readJson,
  readBytes,
  requestScope,
  type Fetch,
} from "../core/http.js";
import {
  CODEX_CLIENT_ID,
  ISSUER,
  type DisplayMetadata,
  type Identity,
  type TokenSet,
} from "../core/types.js";

import { verifiedDisplay } from "./status.js";
export interface VerifiedTokens {
  identity: Identity;
  tokens: TokenSet;
  display?: DisplayMetadata;
}
export interface AuthProvider {
  verify(tokens: TokenSet, allowExpired?: boolean): Promise<VerifiedTokens>;
  refresh(tokens: TokenSet, capture?: (bytes: Buffer) => Promise<void>): Promise<TokenSet>;
}
export interface DeviceGrant { deviceId: string; userCode: string; expiresAt: number; interval: number }

const AUTH_METADATA = "https://api.openai.com/auth";

/** The Codex client contract is intentionally separate from SIWC dynamic registrations. */
export class CodexAuthProvider implements AuthProvider {
  private jwks?: ReturnType<
    typeof import("jose", {
      with: { "resolution-mode": "import" }
    }).createRemoteJWKSet
  >;
  constructor(private readonly fetchImpl: Fetch = fetch) {}

  private async devicePost(endpoint: string, body: Record<string, string>, form = false) {
    const scope = requestScope([], 30000);
    try {
      const response = await this.fetchImpl(`${ISSUER}${endpoint}`, {
        method: "POST", redirect: "error", signal: scope.signal,
        headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      });
      const bytes = await readBytes(response, 256 * 1024, scope.signal);
      return { status: response.status, ok: response.ok, bytes };
    } catch { throw new CodexError("authentication", "The device sign-in request has an unknown outcome. Use an independent Reconnect; this request will not be repeated."); }
    finally { scope.close(); }
  }
  async startDevice(): Promise<DeviceGrant> {
    const response = await this.devicePost("/api/accounts/deviceauth/usercode", { client_id: CODEX_CLIENT_ID });
    assert(response.ok, "Device-code login was rejected. Enable device code login in ChatGPT security settings or ask your workspace administrator, then use Reconnect.");
    let p: Record<string, unknown>;
    try { p = record(JSON.parse(response.bytes.toString("utf8"))); } catch { throw new CodexError("protocol", "The device service returned an invalid response. Use Reconnect."); }
    const userCode = string(p.user_code ?? p.usercode, "One-time code", 64);
    assert(/^[A-Za-z0-9_-]{1,64}$/.test(userCode), "The device service returned an invalid one-time code.");
    const seconds = Number(p.interval ?? 5), lifetime = Number(p.expires_in ?? 900);
    assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 900 && Number.isFinite(lifetime) && lifetime > 0 && lifetime <= 900, "The device service returned invalid timing metadata.");
    return { deviceId: string(p.device_auth_id, "Device authorization identifier"), userCode, interval: Math.max(1, seconds) * 1000, expiresAt: Date.now() + lifetime * 1000 };
  }
  async pollDevice(grant: Pick<DeviceGrant, "deviceId" | "userCode">) {
    const r = await this.devicePost("/api/accounts/deviceauth/token", { device_auth_id: grant.deviceId, user_code: grant.userCode });
    if ([403, 404].includes(r.status)) return undefined;
    assert(r.ok, "Device authorization was rejected. Use Reconnect with an independent sign-in.");
    let p: Record<string, unknown>;
    try { p = record(JSON.parse(r.bytes.toString("utf8"))); } catch { throw new CodexError("protocol", "The device authorization response is invalid. Use Reconnect."); }
    return { code: string(p.authorization_code, "Authorization code"), verifier: string(p.code_verifier, "PKCE verifier") };
  }
  async exchangeDevice(code: { code: string; verifier: string }, capture: (bytes: Buffer) => Promise<void>) {
    const r = await this.devicePost("/oauth/token", { grant_type: "authorization_code", client_id: CODEX_CLIENT_ID, code: code.code, code_verifier: code.verifier, redirect_uri: `${ISSUER}/deviceauth/callback` }, true);
    assert(r.ok, "The device token exchange was rejected. Use an independent Reconnect.");
    await capture(r.bytes);
    try { return tokenResponse(JSON.parse(r.bytes.toString("utf8"))); }
    catch { throw new CodexError("protocol", "The successful device response was captured but could not be parsed. Preserve it and use independent Reconnect."); }
  }

  async verify(
    tokens: TokenSet,
    allowExpired = false,
  ): Promise<VerifiedTokens> {
    try {
      const jose = await import("jose");
      this.jwks ??= jose.createRemoteJWKSet(
        new URL(`${ISSUER}/.well-known/jwks.json`),
        { timeoutDuration: 10000, [jose.customFetch]: this.fetchImpl },
      );
      const verified = await jose.compactVerify(tokens.accessToken, this.jwks, {
        algorithms: ["RS256"],
      });
      const payload = record(
        JSON.parse(new TextDecoder().decode(verified.payload)),
      );
      assert(
        payload.iss === ISSUER,
        "The token issuer does not match the Codex provider.",
      );
      const audiences = Array.isArray(payload.aud)
        ? payload.aud
        : [payload.aud];
      assert(
        audiences.includes("https://api.openai.com/v1"),
        "The token audience is not valid for Codex inference.",
      );
      assert(
        payload.client_id === CODEX_CLIENT_ID,
        "This token belongs to a different OAuth client. SIWC credentials are not Codex credentials.",
      );
      assert(
        typeof payload.exp === "number" &&
          Number.isFinite(payload.exp) &&
          payload.exp >= 0 &&
          payload.exp <= 8640000000000,
        "The token has no valid expiry.",
      );
      assert(
        payload.nbf === undefined ||
          (typeof payload.nbf === "number" &&
            Number.isFinite(payload.nbf) &&
            payload.nbf * 1000 <= Date.now() + 30000),
        "The token is not yet valid or has an invalid validity time.",
      );
      const expiresAt = payload.exp * 1000;
      if (!allowExpired && expiresAt <= Date.now())
        throw new CodexError(
          "reconnect",
          "The access token has expired. Reconnect this profile.",
        );
      const metadata = record(payload[AUTH_METADATA]);
      const identity: Identity = {
        issuer: ISSUER,
        subject: string(payload.sub, "Token subject", 512),
        accountId: string(
          metadata.chatgpt_account_id,
          "ChatGPT account identifier",
          512,
        ),
        clientId: CODEX_CLIENT_ID,
      };
      const scopes =
        typeof payload.scope === "string"
          ? payload.scope.split(/\s+/).filter(Boolean)
          : tokens.scopes;
      return {
        identity,
        tokens: { ...tokens, expiresAt, scopes },
        display: verifiedDisplay(payload, metadata),
      };
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "authentication",
        "The Codex access token could not be verified. Check the token set and connectivity to OpenAI identity keys.",
      );
    }
  }

  async refresh(tokens: TokenSet, capture?: (bytes: Buffer) => Promise<void>): Promise<TokenSet> {
    assert(
      tokens.refreshToken,
      "Automatic renewal is unavailable for this access-token-only session. Reconnect this profile.",
    );
    const scope = requestScope([], 30000);
    try {
      const response = await this.fetchImpl(`${ISSUER}/oauth/token`, {
        method: "POST",
        redirect: "error",
        signal: scope.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CODEX_CLIENT_ID,
          refresh_token: tokens.refreshToken,
        }),
      });
      if (!response.ok) {
        // Only classify controlled OAuth codes; an identity server can echo credentials in any other field.
        let code: unknown;
        try {
          const body = record(await readJson(response, 65536, scope.signal));
          code =
            typeof body.error === "string"
              ? body.error
              : record(body.error).code;
        } catch {
          /* The status remains useful without the body. */
        }
        if (
          response.status === 401 ||
          [
            "invalid_grant",
            "refresh_token_expired",
            "refresh_token_reused",
            "refresh_token_invalidated",
          ].includes(String(code))
        ) {
          throw new CodexError(
            "reconnect",
            "The renewable session is no longer valid. Reconnect this profile.",
            response.status,
          );
        }
        throw new CodexError(
          "provider",
          `Token renewal was rejected (HTTP ${response.status}). Credentials were preserved.`,
          response.status,
        );
      }
      const bytes = await readBytes(response, 256 * 1024, scope.signal);
      await capture?.(bytes);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); }
      catch { throw new CodexError("protocol", "The successful renewal response was not valid JSON. Captured recovery material remains fenced."); }
      return tokenResponse(parsed, tokens);
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "provider",
        "The token renewal outcome is unknown. Credentials were preserved; reconnect before retrying renewal.",
      );
    } finally {
      scope.close();
    }
  }

  async deviceLogin(
    showCode: (url: string, code: string) => void,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    const scope = requestScope([signal], 15 * 60 * 1000);
    const post = async (url: string, body: unknown, form = false) =>
      this.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: scope.signal,
        headers: {
          "Content-Type": form
            ? "application/x-www-form-urlencoded"
            : "application/json",
        },
        body: form
          ? new URLSearchParams(body as Record<string, string>).toString()
          : JSON.stringify(body),
      });
    try {
      const start = await post(`${ISSUER}/api/accounts/deviceauth/usercode`, {
        client_id: CODEX_CLIENT_ID,
      });
      if (!start.ok) throw await admissionError(start);
      const pending = record(await readJson(start, 65536, scope.signal));
      const deviceId = string(
        pending.device_auth_id,
        "Device authorization identifier",
      );
      const userCode = string(
        pending.user_code ?? pending.usercode,
        "One-time code",
        64,
      );
      assert(
        /^[A-Za-z0-9_-]{1,64}$/.test(userCode),
        "The identity service returned an invalid one-time code.",
      );
      const seconds =
        pending.interval === undefined ? 5 : Number(pending.interval);
      assert(
        Number.isFinite(seconds) && seconds >= 0 && seconds <= 900,
        "The identity service returned an invalid polling interval.",
      );
      const interval = Math.max(1, seconds) * 1000;
      showCode(`${ISSUER}/codex/device`, userCode);
      while (true) {
        const response = await post(`${ISSUER}/api/accounts/deviceauth/token`, {
          device_auth_id: deviceId,
          user_code: userCode,
        });
        if ([403, 404].includes(response.status)) {
          void response.body?.cancel().catch(() => undefined);
          await delay(interval, scope.signal);
          continue;
        }
        if (!response.ok) throw await admissionError(response);
        const result = record(await readJson(response, 65536, scope.signal));
        const exchange = await post(
          `${ISSUER}/oauth/token`,
          {
            grant_type: "authorization_code",
            client_id: CODEX_CLIENT_ID,
            code: string(result.authorization_code, "Authorization code"),
            code_verifier: string(result.code_verifier, "PKCE verifier"),
            redirect_uri: `${ISSUER}/deviceauth/callback`,
          },
          true,
        );
        if (!exchange.ok) throw await admissionError(exchange);
        return tokenResponse(
          await readJson(exchange, 256 * 1024, scope.signal),
        );
      }
    } catch (error) {
      if (scope.signal.aborted) throw scope.error();
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "authentication",
        "Device-code login could not be completed. Start a new login attempt.",
      );
    } finally {
      scope.close();
    }
  }
}

export function tokenResponse(value: unknown, previous?: TokenSet): TokenSet {
  const data = record(value);
  assert(
    data.token_type === undefined ||
      String(data.token_type).toLowerCase() === "bearer",
    "The provider returned an unsupported token type.",
  );
  assert(
    data.expires_in === undefined ||
      (typeof data.expires_in === "number" &&
        Number.isFinite(data.expires_in) &&
        data.expires_in > 0 &&
        data.expires_in <= 315360000),
    "The provider returned an invalid token lifetime.",
  );
  assert(
    data.earliest_refresh_at === undefined ||
      (typeof data.earliest_refresh_at === "number" &&
        Number.isFinite(data.earliest_refresh_at) &&
        data.earliest_refresh_at >= 0 &&
        data.earliest_refresh_at <= 8640000000000),
    "The provider returned an invalid earliest renewal time.",
  );
  const expiresIn =
    typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    accessToken: string(data.access_token, "Access token"),
    refreshToken:
      data.refresh_token === undefined
        ? previous?.refreshToken
        : string(data.refresh_token, "Refresh token"),
    idToken:
      data.id_token === undefined
        ? previous?.idToken
        : string(data.id_token, "ID token"),
    expiresAt: Date.now() + expiresIn * 1000,
    earliestRefreshAt:
      typeof data.earliest_refresh_at === "number"
        ? data.earliest_refresh_at * 1000
        : undefined,
    scopes:
      typeof data.scope === "string"
        ? data.scope.split(/\s+/).filter(Boolean)
        : (previous?.scopes ?? []),
  };
}
