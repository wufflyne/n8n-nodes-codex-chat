import type { LocalAccountStatus } from "../auth/status.js";
export type SessionAccess = "managed" | "current-only";
export interface Freshness {
  state: "fresh" | "stale" | "unavailable";
  checkedAt: string | null;
  validUntil: string | null;
  source:
    | "usage_endpoint"
    | "reset_endpoint"
    | "response_headers"
    | "stream_event"
    | null;
  reason:
    | "not_reported"
    | "expired_snapshot"
    | "read_failed"
    | "invalid_data"
    | "identity_mismatch"
    | null;
}
export interface LimitWindow {
  kind: "primary" | "secondary";
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetsAt: string | null;
  resetAfterSeconds: number | null;
}
export interface LimitBucket {
  id: string;
  name: string | null;
  normalModelSlug: string | null;
  scope: "ordinary" | "additional";
  applicability: "ordinary_included" | "explicit_model_match" | "unknown";
  allowed: boolean | null;
  limitReached: boolean | null;
  windows: LimitWindow[];
}
export interface AccountSnapshot extends Omit<LocalAccountStatus, "operation"> {
  operation: "getLimits" | "listResetCredits";
  limits: {
    freshness: Freshness;
    buckets: LimitBucket[];
    reachedType: string | null;
  };
  credits: {
    freshness: Freshness;
    hasCredits: boolean | null;
    unlimited: boolean | null;
    balance: string | null;
    unit: string | null;
  };
  resetCredits: {
    freshness: Freshness;
    availableCount: number | null;
    detailsComplete: boolean | null;
    entries: Array<{
      id: string;
      resetType: string;
      status: string;
      grantedAt: string | null;
      expiresAt: string | null;
      title: string | null;
      description: string | null;
      eligible: boolean;
      ineligibleReason: string | null;
    }>;
  };
  routing: {
    model: string | null;
    decision: "allowed" | "quota_exhausted" | "unknown";
    reason: string;
    earliestResetAt: string | null;
  };
}
export interface RecoveryPolicy {
  automatic: boolean;
  threshold: number;
  maxPer24Hours: number;
  order: "next-first" | "reset-first";
}
export const DEFAULT_RECOVERY: RecoveryPolicy = {
  automatic: false,
  threshold: 1,
  maxPer24Hours: 1,
  order: "next-first",
};
export type ResetOutcome =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";
export interface ResetResult
  extends Omit<AccountSnapshot, "operation" | "credits" | "routing"> {
  operation: "useResetCredit" | "resolvePendingReset";
  action: {
    state: "skipped" | "cancelled_before_send" | "terminal" | "uncertain";
    outcome: ResetOutcome | null;
    reason:
      | "policy_off"
      | "not_eligible"
      | "threshold_not_met"
      | "cap_reached"
      | "cooldown"
      | "pending_action"
      | "unknown_data"
      | "cancelled"
      | null;
    origin: "manual" | "automatic" | "reconcile";
    windowsReset: number | null;
    limitsRefreshed: boolean;
    recovery: "allowed" | "still_exhausted" | "unknown";
  };
}
