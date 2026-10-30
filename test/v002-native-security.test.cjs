const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const { CodexTracing } = require("../dist/n8n/tracing");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const {
  CodexAccountRouter,
} = require("../dist/nodes/CodexAccountRouter/CodexAccountRouter.node");
const { session } = require("./helpers.cjs");
test("Public tracing uses returned indexes and projects images/replay without credential/context exposure", async () => {
  const input = [],
    output = [],
    callbacks = [];
  const secret = "SYNTHETIC_CONTEXT_SECRET";
  const ctx = {
    secret,
    getNode: () => ({ name: "Synthetic" }),
    addInputData: (_type, data) => {
      input.push(data);
      return { index: 37 };
    },
    addOutputData: (_type, index, data) => output.push({ index, data }),
    onExecutionFinish: (cb) => callbacks.push(cb),
    onExecutionCancellation: () => {},
  };
  const tracer = new CodexTracing(ctx, { model: "synthetic" });
  const model = new CodexChatModel({
    model: "synthetic",
    session: async () => ({ ...session(), accessToken: secret }),
    catalog: new ModelCatalog(),
    transport: new ResponsesTransport(),
  });
  model.callbacks = [tracer];
  assert(!inspect(model, { depth: 10 }).includes(secret));
  assert(!JSON.stringify(model).includes(secret));
  assert(!JSON.stringify(model.toJSON()).includes(secret));
  await tracer.handleChatModelStart(
    {},
    [
      [
        new HumanMessage({
          content: [
            {
              type: "image_url",
              image_url: "https://example.invalid/PRIVATE_IMAGE_PATH",
            },
          ],
        }),
      ],
    ],
    "run",
  );
  const message = new AIMessage({
    content: "Done",
    additional_kwargs: {
      codex_response: {
        items: [{ encrypted_content: "SYNTHETIC_OPAQUE_SECRET" }],
      },
    },
    response_metadata: { usage: { state: "unavailable" } },
  });
  await tracer.handleLLMEnd(
    { generations: [[{ text: "Done", message }]] },
    "run",
  );
  await tracer.handleLLMEnd({ generations: [] }, "run");
  assert.equal(output.length, 1);
  assert.equal(output[0].index, 37);
  const json = JSON.stringify({ input, output });
  assert(!json.includes("PRIVATE_IMAGE_PATH"));
  assert(!json.includes("SYNTHETIC_OPAQUE_SECRET"));
  assert(!json.includes(secret));
  callbacks.forEach((cb) => cb());
});
test("Declared router consumer must directly connect and cannot enable native fallback or memory", async () => {
  const node = new CodexAccountRouter(),
    cleanup = [];
  const context = {
    getInstanceId: () => "instance",
    getWorkflow: () => ({ id: "workflow" }),
    getExecutionId: () => "guard-exec",
    getNode: () => ({ id: "router", name: "Router" }),
    getNodeParameter: (name, _i, fallback) =>
      name === "consumerAgent" ? "AI Agent" : fallback,
    getExecutionCancelSignal: () => new AbortController().signal,
    onExecutionFinish: (cb) => cleanup.push(cb),
    onExecutionCancellation: () => {},
    getParentNodes: (_name, opts) =>
      opts.connectionType === "ai_languageModel" ? [{ name: "Router" }] : [],
    getWorkflowDataProxy: () => ({
      $node: { "AI Agent": { parameter: { needsFallback: true } } },
    }),
  };
  await assert.rejects(
    node.supplyData.call(context, 0),
    /Disable native Agent Fallback/,
  );
  context.getWorkflowDataProxy = () => ({
    $node: { "AI Agent": { parameter: { needsFallback: false } } },
  });
  context.getParentNodes = (_name, opts) =>
    opts.connectionType === "ai_languageModel"
      ? [{ name: "Router" }]
      : [{ name: "Memory" }];
  await assert.rejects(
    node.supplyData.call(context, 0),
    /without attached memory/,
  );
  cleanup.forEach((cb) => cb());
});

test("Bundled deterministic Workflow Tool preserves required fields and namespace conversion reaches nested workflows", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    { spawnSync } = require("node:child_process");
  const workflow = JSON.parse(
    await fs.readFile("examples/tools-and-structured-output.json", "utf8"),
  );
  const tool = workflow.nodes.find((n) => n.name === "calculate_order"),
    sub = JSON.parse(tool.parameters.workflowJson),
    code = sub.nodes.find((n) => n.type === "n8n-nodes-base.code").parameters
      .jsCode;
  const result = new Function(code)()[0].json;
  assert.equal(result.total, 10);
  assert.equal(result.unit, "USD");
  assert.equal(result.complete, true);
  assert.equal(result.totalRecords, 2);
  assert.equal(result.moreResults, false);
  assert(!JSON.stringify(result).includes("irrelevant"));
  await fs.mkdir(".test-state", { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.resolve(".test-state/examples-"));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const target = path.join(dir, "community.json");
  const converted = spawnSync(
    process.execPath,
    [
      "scripts/convert-examples.cjs",
      "examples/generate-image-native-binary.json",
      target,
      "community",
    ],
    { encoding: "utf8" },
  );
  assert.equal(converted.status, 0);
  const content = await fs.readFile(target, "utf8");
  assert(!content.includes("CUSTOM.codex"));
  assert(content.includes("n8n-nodes-codex-chat.codexImage"));
  const source = JSON.parse(
    await fs.readFile("examples/generate-image-native-binary.json", "utf8"),
  );
  assert(source.nodes.every((n) => !n.credentials));
});

test("Public execution finish/cancel cleanup releases repeated batches beyond 128 observed contexts", () => {
  const { nativeContext } = require("../dist/n8n/context"),
    {
      recordInvocation,
      usageResourceCounts,
    } = require("../dist/core/execution-usage");
  // Reusing the same scope IDs in later batches detects residual registration keys.
  for (let batch = 0; batch < 3; batch++) {
    const scopes = [];
    for (let i = 0; i < 129; i++) {
      const hooks = { finish: [], cancel: [] };
      const context = nativeContext({
        getInstanceId: () => "cleanup-instance",
        getWorkflow: () => ({ id: "cleanup-workflow" }),
        getExecutionId: () => `cleanup-${i}`,
        getNode: () => ({ id: "model", name: "Model" }),
        onExecutionFinish: (cb) => hooks.finish.push(cb),
        onExecutionCancellation: (cb) => hooks.cancel.push(cb),
      });
      assert.equal(hooks.finish.length, 1);
      assert.equal(hooks.cancel.length, 1);
      scopes.push({ context, hooks });
    }
    scopes
      .slice(0, 128)
      .forEach((scope, i) =>
        scope.hooks[i % 2 ? "finish" : "cancel"].forEach((cb) => cb()),
      );
    const last = scopes.at(-1),
      recorder = recordInvocation(
        last.context,
        "profile",
        "model",
        "responses",
      );
    recorder.attempt();
    recorder.admitted();
    recorder.complete();
    recorder.close();
    assert.equal(usageResourceCounts().executions, 1);
    last.hooks[batch % 2 ? "finish" : "cancel"].forEach((cb) => cb());
    assert.deepEqual(usageResourceCounts(), {
      executions: 0,
      groups: 0,
      active: 0,
    });
  }
});

test("Get Models reports local account status after managed renewal and fresh discovery", async (t) => {
  const runtimeModule = require("../dist/runtime"),
    original = runtimeModule.runtime,
    { CodexAccount } = require("../dist/nodes/CodexAccount/CodexAccount.node"),
    events = [];
  runtimeModule.runtime = () => ({
    sessions: {
      session: async () => {
        events.push("managed-session");
        return session();
      },
    },
    catalog: {
      list: async (_s, _signal, force) => {
        assert.equal(force, true);
        events.push("catalog");
        return [];
      },
    },
    account: {
      readLocalStatus: async () => {
        events.push("status");
        return { account: { state: "ready" } };
      },
    },
  });
  t.after(() => {
    runtimeModule.runtime = original;
  });
  const result = await new CodexAccount().execute.call({
    getNodeParameter: () => "getModels",
    getInputData: () => [{ json: {} }],
    getCredentials: async () => ({
      profileId: "synthetic",
      bindingSecret: "synthetic",
    }),
    getExecutionCancelSignal: () => new AbortController().signal,
  });
  assert.deepEqual(events, ["managed-session", "catalog", "status"]);
  assert.equal(result[0][0].json.account.state, "ready");
});
