const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUsage, langChainUsage } = require("../dist/core/usage");
const { approximateTextTokens } = require("../dist/core/token-estimate");
const { affinityKey } = require("../dist/core/affinity");
const { retryAt, retryWait } = require("../dist/core/transport");
const {
  recordInvocation,
  executionUsage,
  clearExecutionUsage,
  usageResourceCounts,
} = require("../dist/core/execution-usage");
const { parseModel } = require("../dist/core/catalog");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const {
  rawModel,
  session,
  output,
  complete,
  sseResponse,
  mockFetch,
} = require("./helpers.cjs");
const context = {
  instanceId: "instance",
  workflowId: "workflow",
  executionId: "exec",
  nodeId: "model",
  nodeName: "Model",
};
test("Actual usage distinguishes zero, missing, invalid, inconsistent and subset values", () => {
  assert.equal(normalizeUsage(undefined).state, "unavailable");
  assert.equal(langChainUsage(normalizeUsage(undefined)), undefined);
  assert.deepEqual(
    langChainUsage(normalizeUsage({ input_tokens: 0, output_tokens: 0 })),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
  for (const value of [-1, NaN, Infinity, "4", Number.MAX_SAFE_INTEGER + 1]) {
    const u = normalizeUsage({ input_tokens: value, output_tokens: 1 });
    assert.equal(u.inputTokens, null);
    assert(u.invalidFields.includes("input"));
    assert.equal(langChainUsage(u), undefined);
  }
  const u = normalizeUsage({
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 99,
    input_tokens_details: { cached_tokens: 11 },
    output_tokens_details: { reasoning_tokens: 3 },
  });
  assert.equal(u.totalTokens, null);
  assert.deepEqual(u.invalidFields.sort(), [
    "cachedInput",
    "reasoningOutput",
    "total",
  ]);
  assert.equal(
    normalizeUsage({ input_tokens: 10, output_tokens: 2 }).totalSource,
    "derived",
  );
});
test("Approximate UTF-8 text counter is local, ordered and rejects all nontext", async () => {
  for (const text of ["", "hello", "Привет", "雪", "🦊"])
    assert.equal(
      approximateTextTokens(text),
      Math.ceil(Buffer.byteLength(text) / 4),
    );
  assert.equal(
    approximateTextTokens([
      { type: "text", text: "abc" },
      { type: "input_text", text: "de" },
    ]),
    2,
  );
  for (const content of [
    [{ type: "image_url", image_url: "https://example.org/a.png" }],
    [{ type: "file" }],
    {},
    [{}],
  ])
    assert.throws(() => approximateTextTokens(content), /text|multimodal/);
  const m = new CodexChatModel({
    model: "x",
    session: () => {
      throw Error("No account");
    },
    catalog: new ModelCatalog(() => {
      throw Error("No network");
    }),
    transport: new ResponsesTransport(() => {
      throw Error("No inference");
    }),
  });
  assert.equal(await m.getNumTokens("abc"), 1);
});
test("Affinity is stable across generation renewal and isolated across every namespace dimension", () => {
  const key = affinityKey(context, session(), "m", "responses");
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(
    affinityKey(context, { ...session(), generation: 2 }, "m", "responses"),
    key,
  );
  for (const [c, s, m, w] of [
    [{ ...context, executionId: "other" }, session(), "m", "responses"],
    [context, session("other"), "m", "responses"],
    [context, session(), "other", "responses"],
    [context, session(), "m", "responses-lite"],
  ])
    assert.notEqual(affinityKey(c, s, m, w), key);
  assert.equal(
    affinityKey(context, session(), "m", "responses", { mode: "none" }),
    undefined,
  );
  assert.throws(
    () =>
      affinityKey(context, session(), "m", "responses", {
        mode: "conversation",
        conversationKey: "",
      }),
    /Conversation Key/,
  );
  assert.equal(
    affinityKey(context, session(), "m", "responses", {
      mode: "conversation",
      conversationKey: "chat",
    }),
    affinityKey(
      { ...context, executionId: "another" },
      session(),
      "m",
      "responses",
      { mode: "conversation", conversationKey: "chat" },
    ),
  );
});
test("Retry-After keeps the full provider minimum and refuses an insufficient deadline", () => {
  const now = Date.now();
  assert.equal(retryAt("120", now), now + 120000);
  assert.throws(() => retryWait("120", 0, now + 60000, now), /provider asked/);
  assert(retryWait("120", 0, now + 180000, now) >= 120000);
  assert.equal(
    retryAt(new Date(now + 120000).toUTCString(), now),
    Math.floor((now + 120000) / 1000) * 1000,
  );
});
test("Future catalog IDs/efforts and known omitted defaults are open, detached and force-refreshable", async () => {
  let calls = 0;
  const catalog = new ModelCatalog(async () => {
    calls++;
    return Response.json({
      models: [
        rawModel({
          slug: "future-model-example",
          supported_reasoning_levels: [{ effort: "novel-effort" }],
          default_reasoning_level: "novel-effort",
          supports_reasoning_summary_parameter: undefined,
          unknown_decoration: { a: 1 },
        }),
        rawModel({ slug: "invalid", use_responses_lite: "guess" }),
      ],
    });
  });
  const first = await catalog.list(session());
  assert.equal(first[0].slug, "future-model-example");
  assert.equal(first[0].supportsSummary, true);
  first[0].slug = "mutated";
  assert.equal((await catalog.list(session()))[0].slug, "future-model-example");
  await catalog.list(session(), undefined, true);
  assert.equal(calls, 2);
  assert.throws(
    () => parseModel(rawModel({ use_responses_lite: "unknown" })),
    /route/,
  );
});
test("Execution accounting deduplicates terminal events, retains coverage and cleans up", () => {
  const c = { ...context, executionId: "usage" };
  const a = recordInvocation(c, "profile", "m", "responses");
  a.attempt();
  a.rejected();
  a.attempt();
  a.admitted();
  a.complete(
    normalizeUsage({
      input_tokens: 10,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 5 },
    }),
  );
  a.complete(normalizeUsage({ input_tokens: 10, output_tokens: 2 }));
  a.close();
  const b = recordInvocation(c, "profile", "m", "responses");
  b.attempt();
  b.admitted();
  b.complete();
  b.close();
  const report = executionUsage(c, "profile");
  assert.equal(report.totals.transportAttempts, 3);
  assert.equal(report.totals.completedGenerations, 2);
  assert.equal(report.totals.admissionRetries, 1);
  assert.equal(report.totals.coverage.input, 1);
  assert.equal(report.totals.cacheRatio, 0.5);
  assert.equal(report.state, "partial");
  assert.equal(executionUsage(c, "other").state, "empty");
  clearExecutionUsage(c);
  assert.equal(usageResourceCounts().executions, 0);
});
test("Default semantic instructions, immutable bound tools and affinity fields survive both codecs", async () => {
  const { SystemMessage, HumanMessage } = require("@langchain/core/messages");
  for (const lite of [false, true]) {
    const requests = [];
    const fetchImpl = mockFetch(
      async (request, init) => {
        requests.push({ request, headers: init.headers });
        return sseResponse([complete(output())]);
      },
      rawModel({ use_responses_lite: lite }),
    );
    const tools = [
      {
        type: "function",
        function: {
          name: "action",
          description: "Keep me",
          parameters: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
      },
    ];
    const m = new CodexChatModel({
      model: "synthetic-model",
      session: async () => session(),
      catalog: new ModelCatalog(fetchImpl),
      transport: new ResponsesTransport(fetchImpl),
      context,
    });
    const bound = m.bindTools(tools);
    tools[0].function.description = "MUTATED";
    for (let i = 0; i < 2; i++)
      await bound.invoke([
        new SystemMessage("First"),
        new SystemMessage("Second"),
        new HumanMessage("Equal text"),
      ]);
    assert.equal(
      JSON.stringify(requests[0].request),
      JSON.stringify(requests[1].request),
    );
    assert.equal(
      requests[0].headers["session-id"],
      requests[0].request.prompt_cache_key,
    );
    assert.equal(requests[0].request.instructions, undefined);
    const defs = lite
      ? requests[0].request.input[0].tools[0].tools
      : requests[0].request.tools;
    assert.equal(defs[0].description, "Keep me");
    if (!lite)
      assert.equal(
        requests[0].request.input[0].content[0].text,
        "First\n\nSecond",
      );
  }
  clearExecutionUsage(context);
});

test("Post-reset retry is one logical invocation and separately counted from admission retries", () => {
  const c = { ...context, executionId: "post-reset-count" };
  const recorder = recordInvocation(c, "profile", "m", "responses");
  recorder.attempt();
  recorder.rejected();
  recorder.postReset();
  recorder.attempt();
  recorder.admitted();
  recorder.complete(normalizeUsage({ input_tokens: 0, output_tokens: 0 }));
  recorder.close();
  const report = executionUsage(c, "profile");
  assert.equal(report.totals.logicalInvocations, 1);
  assert.equal(report.totals.transportAttempts, 2);
  assert.equal(report.totals.postResetRetries, 1);
  assert.equal(report.totals.admissionRetries, 0);
  clearExecutionUsage(c);
});
test("Unseen future model IDs and efforts generate on both existing codecs without allowlist changes", async () => {
  for (const lite of [false, true]) {
    let request;
    const fetchImpl = mockFetch(
      async (r) => {
        request = r;
        return sseResponse([complete(output("Future model"))]);
      },
      rawModel({
        slug: "future-model-example",
        use_responses_lite: lite,
        supported_reasoning_levels: [{ effort: "novel-effort" }],
      }),
    );
    const model = new CodexChatModel({
      model: "future-model-example",
      session: async () => session(),
      catalog: new ModelCatalog(fetchImpl),
      transport: new ResponsesTransport(fetchImpl),
      settings: { reasoningEffort: "novel-effort" },
    });
    assert.equal(
      (await model.invoke("An exact fact.")).content,
      "Future model",
    );
    assert.equal(request.model, "future-model-example");
    assert.equal(request.reasoning.effort, "novel-effort");
  }
});


test("Catalog list and selected-model nested metadata remain detached across warm and coalesced reads", async () => {
  let reads = 0;
  const catalog = new ModelCatalog(async () => {
    reads++;
    return Response.json({ models: [rawModel({
      supported_reasoning_levels: [{ effort: "novel-effort" }],
      service_tiers: [{ id: "novel-tier", name: "Novel tier" }],
      input_modalities: ["text", "image"],
      default_reasoning_level: "novel-effort",
    })] });
  });
  const copies = await Promise.all([catalog.list(session()), catalog.list(session())]);
  copies[0][0].reasoningEfforts.push("mutated");
  copies[0][0].serviceTiers[0].id = "mutated";
  copies[0][0].inputModalities.push("mutated");
  copies[1][0].serviceTiers.push({ id: "other", name: "Other" });
  const selected = await catalog.model(session(), "synthetic-model");
  assert.deepEqual(selected.reasoningEfforts, ["novel-effort"]);
  assert.deepEqual(selected.serviceTiers, [{ id: "novel-tier", name: "Novel tier" }]);
  assert.deepEqual(selected.inputModalities, ["text", "image"]);
  assert.equal(selected.defaultReasoningEffort, "novel-effort");
  selected.serviceTiers[0].name = "changed";
  selected.reasoningEfforts.length = 0;
  selected.inputModalities.length = 0;
  assert.equal((await catalog.model(session(), "synthetic-model")).serviceTiers[0].name, "Novel tier");
  assert.deepEqual((await catalog.list(session()))[0].inputModalities, ["text", "image"]);
  assert.equal(reads, 1);
});
