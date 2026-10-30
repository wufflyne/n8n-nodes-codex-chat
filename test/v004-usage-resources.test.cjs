const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recordInvocation,
  executionUsage,
  clearExecutionUsage,
  usageResourceCounts,
} = require("../dist/core/execution-usage.js");

const context = (executionId, nodeId = "node") => ({
  instanceId: "usage-resources",
  workflowId: "workflow",
  executionId: String(executionId),
  nodeId,
  nodeName: nodeId,
});
const start = (c, profile = "profile") =>
  recordInvocation(c, profile, "model", "responses");
const usage = {
  inputTokens: 10,
  outputTokens: 2,
  totalTokens: 12,
  cachedInputTokens: 4,
  reasoningOutputTokens: 1,
};
const finish = (r) => {
  r.attempt();
  r.admitted();
  r.complete(usage);
  r.close();
};
const counts = (executions, groups, active) =>
  assert.deepEqual(usageResourceCounts(), { executions, groups, active });
const clean = (contexts) => {
  for (const c of contexts) clearExecutionUsage(c);
  counts(0, 0, 0);
};

test("usage resources isolate cleared generations and late duplicate settlement", () => {
  const a = context("reused"), b = context("unrelated");
  try {
    const old = start(a), other = start(b);
    counts(2, 2, 2);
    clearExecutionUsage(a);
    clearExecutionUsage(a);
    counts(1, 1, 1);
    const current = start(a);
    finish(old);
    old.close();
    old.complete(usage);
    counts(2, 2, 2);
    assert.equal(executionUsage(a, "profile").totals.completedGenerations, 0);
    finish(current);
    current.close();
    counts(2, 2, 1);
    const report = executionUsage(a, "profile");
    assert.equal(report.state, "available");
    assert.equal(report.truncated, false);
    assert.equal(report.totals.logicalInvocations, 1);
    assert.equal(report.totals.completedGenerations, 1);
    assert.equal(report.totals.knownTotalTokens, 12);
    assert.equal(report.totals.cacheRatio, 0.4);
    assert.equal(executionUsage(a, "another-profile").state, "empty");
    clearExecutionUsage(b);
    finish(other);
    counts(1, 1, 0);
  } finally { clean([a, b]); }
});

test("usage execution limit remains 128 with sticky overflow until all ledgers clear", () => {
  const contexts = Array.from({ length: 129 }, (_, i) => context(`execution-${i}`));
  try {
    for (const c of contexts.slice(0, 128)) finish(start(c));
    counts(128, 128, 0);
    finish(start(contexts[128]));
    counts(128, 128, 0);
    assert.equal(executionUsage(contexts[128], "profile").state, "partial");
    assert.equal(executionUsage(contexts[128], "profile").truncated, true);
    clearExecutionUsage(contexts[0]);
    assert.equal(executionUsage(contexts[0], "profile").truncated, true);
    finish(start(contexts[128]));
    counts(128, 128, 0);
    assert.equal(executionUsage(contexts[128], "profile").state, "available");
    clean(contexts);
    assert.equal(executionUsage(contexts[0], "profile").state, "empty");
    assert.equal(executionUsage(contexts[0], "profile").truncated, false);
  } finally { clean(contexts); }
});

test("usage per-execution group limit rejects 257 but permits existing groups", () => {
  const c = context("group-limit");
  try {
    for (let i = 0; i < 256; i++) finish(start({ ...c, nodeId: String(i) }));
    counts(1, 256, 0);
    assert.equal(executionUsage(c, "profile").state, "available");
    finish(start(c));
    finish(start({ ...c, nodeId: "0" }));
    counts(1, 256, 0);
    const report = executionUsage(c, "profile");
    assert.equal(report.state, "partial");
    assert.equal(report.truncated, true);
    assert.equal(report.totals.logicalInvocations, 257);
    assert.equal(report.totals.completedGenerations, 257);
  } finally { clean([c]); }
});

test("usage global 3072 group cap releases exact capacity when a ledger clears", () => {
  const contexts = Array.from({ length: 13 }, (_, i) => context(`global-group-${i}`));
  try {
    for (const c of contexts.slice(0, 12))
      for (let i = 0; i < 256; i++) finish(start({ ...c, nodeId: String(i) }));
    counts(12, 3072, 0);
    finish(start(contexts[12]));
    counts(13, 3072, 0);
    assert.equal(executionUsage(contexts[12], "profile").truncated, true);
    finish(start({ ...contexts[0], nodeId: "0" }));
    assert.equal(executionUsage(contexts[0], "profile").totals.logicalInvocations, 257);
    clearExecutionUsage(contexts[0]);
    for (let i = 0; i < 256; i++) finish(start({ ...contexts[12], nodeId: String(i) }));
    counts(12, 3072, 0);
    assert.equal(executionUsage(contexts[12], "profile").totals.logicalInvocations, 256);
    assert.equal(executionUsage(contexts[12], "profile").truncated, true);
  } finally { clean(contexts); }
});

test("usage per-execution 4096 active limit resumes after one close", () => {
  const c = context("active-limit");
  try {
    const active = Array.from({ length: 4096 }, () => start(c));
    counts(1, 1, 4096);
    finish(start(c));
    assert.equal(executionUsage(c, "profile").totals.logicalInvocations, 4096);
    active[0].close();
    active[0].close();
    const replacement = start(c);
    counts(1, 1, 4096);
    replacement.close();
    for (const r of active) r.close();
    counts(1, 1, 0);
    assert.equal(executionUsage(c, "profile").totals.logicalInvocations, 4097);
    assert.equal(executionUsage(c, "profile").truncated, true);
  } finally { clean([c]); }
});

test("usage global 8192 active cap survives clear, same-key reuse and late closes", () => {
  const contexts = [context("global-active-a"), context("global-active-b"), context("global-active-c")];
  try {
    const old = Array.from({ length: 4096 }, () => start(contexts[0]));
    const other = Array.from({ length: 4096 }, () => start(contexts[1]));
    counts(2, 2, 8192);
    finish(start(contexts[2]));
    counts(3, 2, 8192);
    assert.equal(executionUsage(contexts[2], "profile").truncated, true);
    clearExecutionUsage(contexts[0]);
    const current = Array.from({ length: 4096 }, () => start(contexts[0]));
    for (const r of old) { finish(r); r.close(); }
    counts(3, 2, 8192);
    finish(start(contexts[2]));
    assert.equal(executionUsage(contexts[2], "profile").totals.logicalInvocations, 0);
    current[0].close();
    finish(start(contexts[2]));
    counts(3, 3, 8191);
    assert.equal(executionUsage(contexts[2], "profile").totals.completedGenerations, 1);
    for (const r of [...current, ...other]) r.close();
    counts(3, 3, 0);
  } finally { clean(contexts); }
});

test("usage without execution context remains a resource-free no-op", () => {
  finish(start(undefined));
  counts(0, 0, 0);
});
