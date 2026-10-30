import type { DisplayMetadata, Profile } from "../core/types.js";
export interface LocalAccountStatus {
  schemaVersion: 1;
  operation: "checkAccount";
  checkedAt: string;
  account: {
    label: string;
    email: string | null;
    emailSource: "verified_access_claim" | null;
    emailVerifiedAt: string | null;
    planCode: string | null;
    planLabel: string | null;
    planSource: "verified_access_claim" | "usage_endpoint" | null;
    planCheckedAt: string | null;
    state: "ready" | "expired" | "reconnect_required" | "refresh_uncertain";
    expiresAt: string;
    renewal: "enabled" | "disabled_by_instance" | "access_only" | "blocked";
  };
}
const PLAN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  plus: "Plus",
  free: "Free",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
});
export function planLabel(code: string | null): string | null {
  return code === null
    ? null
    : Object.hasOwn(PLAN_LABELS, code)
      ? PLAN_LABELS[code]!
      : `Unknown plan (${code})`;
}
export function localStatus(
  profile: Profile,
  refreshEnabled: boolean,
  now = Date.now(),
): LocalAccountStatus {
  const display = profile.display;
  const planCode = display?.plan?.value ?? null;
  return {
    schemaVersion: 1,
    operation: "checkAccount",
    checkedAt: new Date(now).toISOString(),
    account: {
      label: profile.label,
      email: display?.email?.value ?? null,
      emailSource: display?.email?.source ?? null,
      emailVerifiedAt: display?.email
        ? new Date(display.email.verifiedAt).toISOString()
        : null,
      planCode,
      planLabel: planLabel(planCode),
      planSource: display?.plan?.source ?? null,
      planCheckedAt: display?.plan
        ? new Date(display.plan.verifiedAt).toISOString()
        : null,
      state:
        profile.state === "refresh_uncertain"
          ? "refresh_uncertain"
          : profile.state === "reconnect"
            ? "reconnect_required"
            : profile.tokens.expiresAt <= now
              ? "expired"
              : "ready",
      expiresAt: new Date(profile.tokens.expiresAt).toISOString(),
      renewal:
        profile.state !== "ready"
          ? "blocked"
          : !refreshEnabled
            ? "disabled_by_instance"
            : profile.tokens.refreshToken
              ? "enabled"
              : "access_only",
    },
  };
}
/** Called only after signature, issuer, audience, client and validity checks. */
export function verifiedDisplay(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  now = Date.now(),
): DisplayMetadata | undefined {
  const profile = payload["https://api.openai.com/profile"];
  const profileEmail =
    profile && typeof profile === "object" && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).email
      : undefined;
  const email = payload.email ?? profileEmail;
  const plan = metadata.chatgpt_plan_type;
  const result: DisplayMetadata = {};
  if (
    !(
      payload.email !== undefined &&
      profileEmail !== undefined &&
      payload.email !== profileEmail
    ) &&
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(
      email,
    )
  )
    result.email = {
      value: email,
      source: "verified_access_claim",
      verifiedAt: now,
    };
  if (typeof plan === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(plan))
    result.plan = {
      value: plan,
      source: "verified_access_claim",
      verifiedAt: now,
    };
  return Object.keys(result).length ? result : undefined;
}
