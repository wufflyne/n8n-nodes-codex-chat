import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "./affinity.js";
import type { NormalizedUsage } from "./usage.js";
export interface UsageAggregate {
  logicalInvocations: number;
  transportAttempts: number;
  httpAdmitted: number;
  httpRejected: number;
  admissionUnknown: number;
  completedGenerations: number;
  failedAfterAdmission: number;
  admissionRetries: number;
  postResetRetries: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  knownTotalTokens: number;
  knownCachedInputTokens: number;
  knownReasoningOutputTokens: number;
  coverage: {
    input: number;
    output: number;
    total: number;
    cachedInput: number;
    reasoningOutput: number;
  };
  cacheRatio: number | null;
  cacheRatioInputTokens: number;
  cacheRatioCachedTokens: number;
}
export interface UsageReport {
  schemaVersion: 1;
  operation: "getExecutionUsage";
  checkedAt: string;
  scope: "current_execution_selected_profile";
  state: "available" | "empty" | "partial";
  truncated: boolean;
  totals: UsageAggregate;
  groups: Array<
    UsageAggregate & {
      nodeName: string;
      model: string;
      wire: "responses" | "responses-lite" | "images";
    }
  >;
}
interface Group {
  profile: string;
  nodeName: string;
  model: string;
  wire: "responses" | "responses-lite" | "images";
  usage: UsageAggregate;
}
interface Ledger {
  groups: Map<string, Group>;
  active: Set<string>;
  truncated: boolean;
}
let overflowed = false;
const ledgers = new Map<string, Ledger>();
let totalGroups = 0;
let totalActive = 0;
const keyFor = (c: ExecutionContext) =>
  JSON.stringify([c.instanceId, c.workflowId, c.executionId]);
const zero = (): UsageAggregate => ({
  logicalInvocations: 0,
  transportAttempts: 0,
  httpAdmitted: 0,
  httpRejected: 0,
  admissionUnknown: 0,
  completedGenerations: 0,
  failedAfterAdmission: 0,
  admissionRetries: 0,
  postResetRetries: 0,
  knownInputTokens: 0,
  knownOutputTokens: 0,
  knownTotalTokens: 0,
  knownCachedInputTokens: 0,
  knownReasoningOutputTokens: 0,
  coverage: {
    input: 0,
    output: 0,
    total: 0,
    cachedInput: 0,
    reasoningOutput: 0,
  },
  cacheRatio: null,
  cacheRatioInputTokens: 0,
  cacheRatioCachedTokens: 0,
});
export interface CallRecorder {
  attempt(): void;
  admitted(): void;
  rejected(): void;
  ambiguous(): void;
  complete(usage?: NormalizedUsage): void;
  failed(): void;
  postReset(): void;
  close(): void;
}
const noop: CallRecorder = {
  attempt() {},
  admitted() {},
  rejected() {},
  ambiguous() {},
  complete() {},
  failed() {},
  postReset() {},
  close() {},
};
export function recordInvocation(
  context: ExecutionContext | undefined,
  profile: string,
  model: string,
  wire: Group["wire"],
): CallRecorder {
  if (!context) return noop;
  const key = keyFor(context);
  let ledger = ledgers.get(key);
  if (!ledger) {
    if (ledgers.size >= 128) {
      overflowed = true;
      return noop;
    }
    ledger = { groups: new Map(), active: new Set(), truncated: false };
    ledgers.set(key, ledger);
  }
  const groupKey = JSON.stringify([context.nodeId, profile, model, wire]);
  let group = ledger.groups.get(groupKey);
  // Global group/active-marker caps keep approximate aggregate storage below 8 MiB.
  if (
    (!group && (ledger.groups.size >= 256 || totalGroups >= 3072)) ||
    ledger.active.size >= 4096 ||
    totalActive >= 8192
  ) {
    ledger.truncated = true;
    return noop;
  }
  if (!group) {
    group = { profile, nodeName: context.nodeName, model, wire, usage: zero() };
    ledger.groups.set(groupKey, group);
    totalGroups++;
  }
  const a = group.usage,
    id = randomUUID();
  ledger.active.add(id);
  totalActive++;
  a.logicalInvocations++;
  let attempts = 0,
    accepted = false,
    terminal = false,
    closed = false,
    failure = false,
    resetNext = false;
  return {
    attempt() {
      if (closed) return;
      a.transportAttempts++;
      if (attempts++ && !resetNext) a.admissionRetries++;
      resetNext = false;
      accepted = false;
      failure = false;
    },
    admitted() {
      if (closed) return;
      a.httpAdmitted++;
      accepted = true;
    },
    rejected() {
      if (!closed) a.httpRejected++;
    },
    ambiguous() {
      if (!closed) a.admissionUnknown++;
    },
    postReset() {
      if (!closed) {
        a.postResetRetries++;
        resetNext = true;
      }
    },
    complete(u) {
      if (closed || terminal) return;
      terminal = true;
      a.completedGenerations++;
      if (!u) return;
      const fields = [
        ["inputTokens", "knownInputTokens", "input"],
        ["outputTokens", "knownOutputTokens", "output"],
        ["totalTokens", "knownTotalTokens", "total"],
        ["cachedInputTokens", "knownCachedInputTokens", "cachedInput"],
        [
          "reasoningOutputTokens",
          "knownReasoningOutputTokens",
          "reasoningOutput",
        ],
      ] as const;
      for (const [source, target, coverage] of fields) {
        const value = u[source];
        if (value !== null) {
          if (Number.isSafeInteger(a[target] + value)) {
            a[target] += value;
            a.coverage[coverage]++;
          } else ledger!.truncated = true;
        }
      }
      if (
        u.inputTokens !== null &&
        u.cachedInputTokens !== null &&
        Number.isSafeInteger(a.cacheRatioInputTokens + u.inputTokens) &&
        Number.isSafeInteger(a.cacheRatioCachedTokens + u.cachedInputTokens)
      ) {
        a.cacheRatioInputTokens += u.inputTokens;
        a.cacheRatioCachedTokens += u.cachedInputTokens;
      }
      a.cacheRatio =
        a.cacheRatioInputTokens > 0
          ? a.cacheRatioCachedTokens / a.cacheRatioInputTokens
          : null;
    },
    failed() {
      if (!closed && !terminal && accepted && !failure) {
        a.failedAfterAdmission++;
        failure = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      // A cleared ledger may still settle after the same execution key is reused.
      if (ledger!.active.delete(id) && ledgers.get(key) === ledger) totalActive--;
    },
  };
}
export function executionUsage(
  context: ExecutionContext,
  profile: string,
): UsageReport {
  const ledger = ledgers.get(keyFor(context)),
    groups: UsageReport["groups"] = [],
    totals = zero();
  for (const g of ledger?.groups.values() ?? [])
    if (g.profile === profile) {
      const a = structuredClone(g.usage);
      groups.push({ ...a, nodeName: g.nodeName, model: g.model, wire: g.wire });
      for (const field of Object.keys(totals) as Array<keyof UsageAggregate>) {
        if (field === "coverage")
          for (const k of Object.keys(totals.coverage) as Array<
            keyof UsageAggregate["coverage"]
          >)
            totals.coverage[k] += a.coverage[k];
        else if (field !== "cacheRatio") {
          const sum = (totals[field] as number) + (a[field] as number);
          if (Number.isSafeInteger(sum)) (totals[field] as number) = sum;
          else if (ledger) ledger.truncated = true;
        }
      }
    }
  totals.cacheRatio =
    totals.cacheRatioInputTokens > 0
      ? totals.cacheRatioCachedTokens / totals.cacheRatioInputTokens
      : null;
  const partial =
    (!ledger && overflowed) ||
    ledger?.truncated ||
    totals.admissionUnknown > 0 ||
    totals.failedAfterAdmission > 0 ||
    totals.completedGenerations < totals.httpAdmitted ||
    Object.values(totals.coverage).some((n) => n < totals.completedGenerations);
  return {
    schemaVersion: 1,
    operation: "getExecutionUsage",
    checkedAt: new Date().toISOString(),
    scope: "current_execution_selected_profile",
    state: groups.length
      ? partial
        ? "partial"
        : "available"
      : partial
        ? "partial"
        : "empty",
    truncated: ledger?.truncated ?? overflowed,
    totals,
    groups,
  };
}
export function clearExecutionUsage(context: ExecutionContext): void {
  const key = keyFor(context), ledger = ledgers.get(key);
  if (ledger) {
    totalGroups -= ledger.groups.size;
    totalActive -= ledger.active.size;
    ledgers.delete(key);
  }
  if (!ledgers.size) overflowed = false;
}
export function usageResourceCounts() {
  return {
    executions: ledgers.size,
    groups: totalGroups,
    active: totalActive,
  };
}
