import { createHash } from "node:crypto";
import { assert } from "../core/errors.js";
import type { AccountSnapshot, RecoveryPolicy } from "./types.js";
export function validateRecovery(policy: RecoveryPolicy) {
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
