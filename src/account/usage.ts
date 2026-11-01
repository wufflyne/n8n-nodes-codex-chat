import type { ProfileBinding as Binding } from "../service/access.js";
import { localStatus, planLabel } from "../auth/status.js";
import type { AccountSessionManager } from "../auth/sessions.js";
import { accountHeaders } from "../core/catalog.js";
import { assert, CodexError, record } from "../core/errors.js";
import {
  admissionError,
  readJson,
  requestScope,
  throwIfAborted,
  waitForSignal,
  type Fetch,
} from "../core/http.js";
import { count } from "../core/usage.js";
import type { Profile, Session } from "../core/types.js";
import { createHash } from "node:crypto";
import type {
  AccountSnapshot,
  Freshness,
  LimitBucket,
  LimitWindow,
  SessionAccess,
} from "./types.js";
export const USAGE_BASE = "https://chatgpt.com/backend-api/wham";
export const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const text = (v: unknown, max = 128): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max
    ? v.replace(/[\x00-\x1f\x7f]/g, "")
    : null;
export const identifier = (v: unknown, max = 256): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x20\x7f]/.test(v) ? v : null;
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
export function unixDate(v: unknown): string | null {
  const n = count(v);
  if (n === null || n > 8640000000000) return null;
  try {
    return new Date(n * 1000).toISOString();
  } catch {
    return null;
  }
}
export function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|([+-])(\d\d):(\d\d))$/.exec(
    v,
  );
  if (!m) return null;
  const year = Number(m[1]),
    month = Number(m[2]),
    day = Number(m[3]),
    days = [
      31,
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(m[4]) > 23 ||
    Number(m[5]) > 59 ||
    Number(m[6]) > 59 ||
    (m[8] !== undefined && Number(m[8]) > 23) ||
    (m[9] !== undefined && Number(m[9]) > 59) ||
    !Number.isFinite(Date.parse(v))
  )
    return null;
  return new Date(v).toISOString();
}

export const freshness = (source: Freshness["source"], now: number, ttl = 30000): Freshness => ({
  state: "fresh",
  checkedAt: new Date(now).toISOString(),
  validUntil: new Date(now + ttl).toISOString(),
  source,
  reason: null,
});
export const unavailable = (reason: Freshness["reason"] = "not_reported"): Freshness => ({
  state: "unavailable",
  checkedAt: null,
  validUntil: null,
  source: null,
  reason,
});
function window(v: unknown, kind: LimitWindow["kind"]): LimitWindow {
  const w = object(v),
    p =
      typeof w.used_percent === "number" &&
      Number.isFinite(w.used_percent) &&
      w.used_percent >= 0 &&
      w.used_percent <= 100
        ? w.used_percent
        : null;
  const seconds = count(w.limit_window_seconds);
  return {
    kind,
    usedPercent: p,
    remainingPercent: p === null ? null : 100 - p,
    windowSeconds: seconds && seconds > 0 ? seconds : null,
    resetsAt: unixDate(w.reset_at),
    resetAfterSeconds: count(w.reset_after_seconds),
  };
}
function bucket(
  v: unknown,
  id: string,
  scope: LimitBucket["scope"],
  name: string | null = null,
  slug: string | null = null,
): LimitBucket {
  const b = object(v);
  return {
    id,
    scope,
    name,
    normalModelSlug: slug,
    applicability:
      scope === "ordinary" ? "ordinary_included" : slug ? "explicit_model_match" : "unknown",
    allowed: bool(b.allowed),
    limitReached: bool(b.limit_reached),
    windows: (
      [
        ["primary_window", "primary"],
        ["secondary_window", "secondary"],
      ] as const
    )
      .filter(([key]) => b[key] != null)
      .map(([key, kind]) => window(b[key], kind)),
  };
}
export function quotaDecision(
  snapshot: AccountSnapshot,
  model: string | null,
  now = Date.now(),
): AccountSnapshot["routing"] {
  const unknown = (reason: string): AccountSnapshot["routing"] => ({
    model,
    decision: "unknown",
    reason,
    earliestResetAt: null,
  });
  if (
    snapshot.limits.freshness.state !== "fresh" ||
    !snapshot.limits.freshness.validUntil ||
    Date.parse(snapshot.limits.freshness.validUntil) <= now
  )
    return unknown("limits_not_fresh");
  const extra = snapshot.limits.buckets.filter(
    (b) => b.scope === "additional" && b.normalModelSlug === model && model !== null,
  );
  if (extra.length > 1) return unknown("conflicting_mapping");
  if (
    model !== null &&
    snapshot.limits.buckets.some((b) => b.scope === "additional" && b.applicability === "unknown")
  )
    return unknown("scope_unknown");
  const relevant = [...snapshot.limits.buckets.filter((b) => b.scope === "ordinary"), ...extra];
  if (!relevant.length) return unknown("scope_unknown");
  if (
    relevant.some((b) =>
      b.windows.some(
        (w) =>
          w.usedPercent === null ||
          w.windowSeconds === null ||
          w.resetsAt === null ||
          w.resetAfterSeconds === null,
      ),
    )
  )
    return unknown("invalid_window_data");
  if (
    relevant.some((b) =>
      b.windows.some((w) => w.resetsAt !== null && Date.parse(w.resetsAt) <= now),
    )
  )
    return unknown("window_reset_passed");
  if (snapshot.limits.reachedType !== null && snapshot.limits.reachedType !== "rate_limit_reached")
    return unknown("spending_scope_unknown");
  const times = relevant
    .flatMap((b) => b.windows.map((w) => w.resetsAt))
    .filter((v): v is string => v !== null)
    .sort();
  if (
    relevant.some((b) => b.allowed === false && b.limitReached === true) &&
    snapshot.limits.reachedType === "rate_limit_reached"
  )
    return {
      model,
      decision: "quota_exhausted",
      reason: "included_quota_denied",
      earliestResetAt: times[0] ?? null,
    };
  if (relevant.every((b) => b.allowed === true))
    return {
      model,
      decision: "allowed",
      reason: "explicit_permission",
      earliestResetAt: times[0] ?? null,
    };
  return unknown("permission_unknown");
}
export function emptySnapshot(
  status: ReturnType<typeof localStatus>,
  model: string | null = null,
): AccountSnapshot {
  return {
    ...status,
    operation: "getLimits",
    limits: { freshness: unavailable(), buckets: [], reachedType: null },
    credits: {
      freshness: unavailable(),
      hasCredits: null,
      unlimited: null,
      balance: null,
      unit: null,
    },
    resetCredits: {
      freshness: unavailable(),
      availableCount: null,
      detailsComplete: null,
      entries: [],
    },
    routing: {
      model,
      decision: "unknown",
      reason: "limits_not_fresh",
      earliestResetAt: null,
    },
  };
}
export function parseUsage(
  value: unknown,
  snapshot: AccountSnapshot,
  session: Session,
  now = Date.now(),
): AccountSnapshot {
  const body = record(value);
  assert(
    body.account_id === undefined || body.account_id === session.accountId,
    "The authenticated usage account identity does not match the selected profile.",
  );
  const extras = body.additional_rate_limits;
  assert(
    extras == null || (Array.isArray(extras) && extras.length <= 63),
    "The usage response contains too many or invalid quota buckets.",
  );
  const result = structuredClone(snapshot);
  result.limits = {
    freshness: freshness("usage_endpoint", now),
    buckets: body.rate_limit == null ? [] : [bucket(body.rate_limit, "ordinary", "ordinary")],
    reachedType: identifier(object(body.rate_limit_reached_type).type, 80),
  };
  const ids = new Set<string>();
  for (const raw of Array.isArray(extras) ? extras : []) {
    const item = record(raw),
      id = identifier(item.metered_feature);
    assert(id && !ids.has(id), "The usage response contains conflicting quota buckets.");
    ids.add(id);
    result.limits.buckets.push(
      bucket(
        item.rate_limit,
        id,
        "additional",
        text(item.limit_name, 160),
        identifier(item.normal_model_slug, 200),
      ),
    );
  }
  const plan = identifier(body.plan_type, 64);
  if (plan) {
    result.account.planCode = plan;
    result.account.planLabel = planLabel(plan);
    result.account.planSource = "usage_endpoint";
    result.account.planCheckedAt = new Date(now).toISOString();
  }
  const credits = object(body.credits);
  result.credits = {
    freshness: body.credits == null ? unavailable() : freshness("usage_endpoint", now),
    hasCredits: bool(credits.has_credits),
    unlimited: bool(credits.unlimited),
    balance:
      typeof credits.balance === "string" && /^\d{1,40}(?:\.\d{1,20})?$/.test(credits.balance)
        ? credits.balance
        : null,
    unit: null,
  };
  result.resetCredits.availableCount = count(object(body.rate_limit_reset_credits).available_count);
  if (result.resetCredits.availableCount !== null)
    result.resetCredits.freshness = freshness("usage_endpoint", now);
  result.routing = quotaDecision(result, snapshot.routing.model, now);
  return result;
}
export function parseResetCredits(
  value: unknown,
  snapshot: AccountSnapshot,
  now = Date.now(),
  session?: Session,
): AccountSnapshot {
  const body = record(value);
  assert(
    body.account_id === undefined || (session && body.account_id === session.accountId),
    "The authenticated reset allocation account identity does not match the selected profile.",
  );
  assert(
    Array.isArray(body.credits) && body.credits.length <= 128,
    "Reset allocation details are unavailable or exceed their bound.",
  );
  const result = structuredClone(snapshot),
    seen = new Map<string, string>(),
    duplicates = new Set<string>();
  const entries = body.credits.map((raw) => {
    const c = record(raw),
      id = identifier(c.id),
      type = identifier(c.reset_type, 80),
      status = identifier(c.status, 80);
    assert(id && type && status, "Reset allocation identity or type is invalid.");
    const encoded = JSON.stringify(c);
    if (seen.has(id) && seen.get(id) !== encoded) duplicates.add(id);
    seen.set(id, encoded);
    const grantedAt = isoDate(c.granted_at),
      expiresAt = c.expires_at === null ? null : isoDate(c.expires_at);
    const reason =
      count(body.available_count) === null || count(body.available_count) === 0
        ? "no_available_count"
        : type !== "codex_rate_limits"
          ? "unknown_type"
          : status !== "available"
            ? "not_available"
            : !grantedAt || Date.parse(grantedAt) > now + 30000
              ? "invalid_grant"
              : c.expires_at !== null && (!expiresAt || Date.parse(expiresAt) <= now)
                ? "expired_or_invalid"
                : null;
    return {
      id,
      resetType: type,
      status,
      grantedAt,
      expiresAt,
      title: text(c.title, 160),
      description: text(c.description, 512),
      eligible: reason === null,
      ineligibleReason: reason,
    };
  });
  for (const e of entries)
    if (duplicates.has(e.id)) {
      e.eligible = false;
      e.ineligibleReason = "conflicting_duplicate";
    }
  result.resetCredits = {
    freshness: freshness("reset_endpoint", now),
    availableCount: count(body.available_count),
    detailsComplete: null,
    entries: entries.filter((e, i) => entries.findIndex((x) => x.id === e.id) === i),
  };
  return result;
}
export class AccountReader {
  async settleReads() { await Promise.allSettled([...this.pending.values()]); }
  private cache = new Map<string, { snapshot?: AccountSnapshot }>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    readonly sessions: AccountSessionManager,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = USAGE_BASE,
    private readonly clock = Date.now,
  ) {}
  async readLocalStatus(binding: Binding) {
    return localStatus(
      await this.sessions.store.read(binding),
      this.sessions.refreshEnabled,
      this.clock(),
    );
  }
  async cachedAccount(binding: Binding) {
    return this.cachedProfile(await this.sessions.store.read(binding));
  }
  /** Pure cache lookup: editor callers must read through a read-only store first. */
  cachedProfile(p: Profile) {
    const affinity = createHash("sha256").update(`${p.id}:${p.subject}:${p.accountId}`).digest("hex");
    const snapshot = this.cache.get(`${affinity}:${p.generation}`)?.snapshot;
    return snapshot ? structuredClone(snapshot) : undefined;
  }
  /** Decision boundaries need new reads; detached older waiters keep their own result. */
  invalidateBeforeFreshRead(session: Session): void {
    const prefix = `${session.affinity}:`;
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
    for (const pendingKey of this.pending.keys())
      if (pendingKey.startsWith(prefix)) this.pending.delete(pendingKey);
  }
  async session(binding: Binding, access: SessionAccess, signal?: AbortSignal) {
    return access === "current-only"
      ? this.sessions.currentSession(binding, signal)
      : this.sessions.session(binding, signal);
  }
  async readAccount(
    binding: Binding,
    options: {
      access?: SessionAccess;
      signal?: AbortSignal;
      force?: boolean;
      afterRejection?: boolean;
      includeResetDetails?: boolean;
      model?: string;
    } = {},
  ): Promise<AccountSnapshot> {
    const session = await this.session(binding, options.access ?? "managed", options.signal);
    if (options.afterRejection) this.invalidateBeforeFreshRead(session);
    return this.readWithSession(binding, session, {
      ...options,
      force: options.afterRejection || options.force,
    });
  }
  async readWithSession(
    binding: Binding,
    session: Session,
    options: {
      signal?: AbortSignal;
      force?: boolean;
      includeResetDetails?: boolean;
      model?: string;
    } = {},
  ): Promise<AccountSnapshot> {
    throwIfAborted(options.signal);
    const now = this.clock(),
      key = `${session.affinity}:${session.generation}`;
    let entry = this.cache.get(key);
    if (!entry) {
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      entry = {};
      this.cache.set(key, entry);
    }
    const cached = entry.snapshot;
    let snapshot = emptySnapshot(await this.readLocalStatus(binding), options.model ?? null);
    const cachedValid =
      cached &&
      cached.limits.freshness.validUntil &&
      Date.parse(cached.limits.freshness.validUntil) > now &&
      !cached.limits.buckets.some((b) =>
        b.windows.some((w) => w.resetsAt && Date.parse(w.resetsAt) <= now),
      );
    if (cachedValid && !options.force) {
      snapshot = structuredClone(cached);
      snapshot.routing = quotaDecision(snapshot, options.model ?? null, now);
    } else
      try {
        snapshot = parseUsage(
          await this.get(session, "usage", options.signal, options.force),
          snapshot,
          session,
          this.clock(),
        );
        if (this.cache.get(key) === entry) entry.snapshot = structuredClone(snapshot);
      } catch (error) {
        this.checkReadError(error);
        snapshot.limits.freshness = unavailable(
          error instanceof CodexError && /identity/.test(error.message)
            ? "identity_mismatch"
            : error instanceof CodexError && ["protocol", "configuration"].includes(error.category)
              ? "invalid_data"
              : "read_failed",
        );
        snapshot.credits.freshness = unavailable("read_failed");
      }
    if (options.includeResetDetails)
      try {
        snapshot = parseResetCredits(
          await this.get(session, "rate-limit-reset-credits", options.signal, true),
          snapshot,
          this.clock(),
          session,
        );
        snapshot.operation = "listResetCredits";
      } catch (error) {
        this.checkReadError(error);
        snapshot.resetCredits.freshness = unavailable("read_failed");
        snapshot.resetCredits.entries = [];
      }
    throwIfAborted(options.signal);
    snapshot.routing = quotaDecision(snapshot, options.model ?? null, this.clock());
    if (this.cache.get(key) === entry) entry.snapshot = structuredClone(snapshot);
    return structuredClone(snapshot);
  }
  private checkReadError(error: unknown) {
    if (
      error instanceof CodexError &&
      ["authentication", "reconnect", "storage", "cancelled"].includes(error.category)
    )
      throw error;
  }
  private async get(
    session: Session,
    endpoint: string,
    signal?: AbortSignal,
    force = false,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const key = `${session.affinity}:${session.generation}:${endpoint}${force ? ":fresh" : ""}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.fetch(session, endpoint);
      this.pending.set(key, pending);
      const captured = pending;
      void pending
        .finally(() => {
          if (this.pending.get(key) === captured) this.pending.delete(key);
        })
        .catch(() => undefined);
    }
    return waitForSignal(pending, signal);
  }
  private async fetch(session: Session, endpoint: string) {
    const scope = requestScope([], 10000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
        headers: accountHeaders(session),
        redirect: "error",
        signal: scope.signal,
      });
      if (!response.ok) throw await admissionError(response);
      return await readJson(response, 256 * 1024, scope.signal);
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError("provider", "Account information could not be read.");
    } finally {
      scope.close();
    }
  }
}
