const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HumanMessage } = require("@langchain/core/messages");
const { NodeConnectionTypes } = require("n8n-workflow");
const { ChatOutputBudget, CHAT_OUTPUT_LIMITS } = require("../dist/core/chat-output.js");
const { ReplayLedger } = require("../dist/core/replay.js");
const { nativeChatOutputPolicy } = require("../dist/n8n/chat-output-policy.js");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const {
  rawModel,
  session,
  output,
  textEvent,
  complete,
  sseResponse,
  mockFetch,
} = require("./helpers.cjs");
test("Chat output admits bounded prefixes and refuses the first excess quote without advancing state", () => {
  const b = new ChatOutputBudget();
  b.admit('"'.repeat(CHAT_OUTPUT_LIMITS.quotes));
  assert.throws(() => b.admit("'"), /rendering budget/);
  b.admit("safe");
});
test("Chat output separately bounds visible length and cumulative renderer work", () => {
  const b = new ChatOutputBudget();
  b.admit("x".repeat(CHAT_OUTPUT_LIMITS.text));
  assert.throws(() => b.admit("x"), /rendering budget/);
  const w = new ChatOutputBudget();
  w.admit('"'.repeat(512));
  let accepted = 0;
  assert.throws(() => {
    for (; accepted < 1000; accepted++) w.admit("a");
  }, /rendering budget/);
  assert(accepted > 0 && accepted < 300);
});
const modelNode = { name: "Model", type: "n8n-nodes-codex-chat.codexChatModel" };
function context(kind) {
  return {
    getChatTrigger: () => (kind === "ordinary" ? null : { name: "Chat Trigger", parameters: {} }),
    getNode: () => modelNode,
    getChildNodes: (name) => {
      assert.equal(name, "Chat Trigger");
      return kind === "custom"
        ? [{ name: "Code", type: "n8n-nodes-base.code", typeVersion: 2 }]
        : [
            {
              name: "Agent",
              type: "@n8n/n8n-nodes-langchain.agent",
              typeVersion: 3,
              parameters: kind === "fallback" ? { needsFallback: true } : {},
            },
          ];
    },
    getParentNodes: (_name, { connectionType }) => {
      if (connectionType === NodeConnectionTypes.AiTool)
        return kind === "tools" ? [{ name: "Tool" }] : [];
      if (connectionType === NodeConnectionTypes.AiOutputParser)
        return kind === "parser" ? [{ name: "Parser" }] : [];
      if (connectionType === NodeConnectionTypes.AiLanguageModel)
        return kind === "router"
          ? [{ name: "Router", type: "n8n-nodes-codex-chat.codexAccountRouter" }]
          : kind === "models"
            ? [modelNode, modelNode]
            : [modelNode];
      return [];
    },
  };
}
test("Public native Chat policy uses Chat MAIN root and leaves ordinary workflows alone", () => {
  assert.equal(nativeChatOutputPolicy(context("ordinary")), false);
  assert.equal(nativeChatOutputPolicy(context("basic")), true);
});
for (const kind of ["tools", "parser", "custom", "router", "models", "fallback"])
  test("Native Chat refuses independent " + kind + " output before account/provider work", () => {
    assert.throws(() => nativeChatOutputPolicy(context(kind)), /ordinary workflow/);
  });
for (const lite of [false, true]) {
  function model(events, chat = true, replay) {
    let calls = 0;
    const fetchImpl = mockFetch(
      async () => {
        calls++;
        return sseResponse(events);
      },
      rawModel({ use_responses_lite: lite }),
    );
    return {
      m: new CodexChatModel({
        model: "synthetic-model",
        session: async () => session(),
        catalog: new ModelCatalog(fetchImpl),
        transport: new ResponsesTransport(fetchImpl),
        nativeChatOutput: chat,
        replay,
        settings: { maxRetries: 0 },
      }),
      calls: () => calls,
    };
  }
  test(`Chat safe streaming and nonstreaming output remain exact (${lite})`, async () => {
    const text = 'A "bounded" reply.',
      x = model([textEvent(text), complete(output(text))]);
    assert.equal((await x.m.invoke("Synthetic")).content, text);
    const chunks = [];
    for await (const c of await x.m.stream("Synthetic")) chunks.push(c.content);
    assert.equal(chunks.join(""), text);
    assert.equal(x.calls(), 2);
  });
  test(`Chat refuses unsafe streaming fragment before yield or token callback (${lite})`, async () => {
    const unsafe = '"'.repeat(CHAT_OUTPUT_LIMITS.quotes + 1),
      x = model([textEvent("safe"), textEvent(unsafe), complete(output("safe" + unsafe))]),
      chunks = [],
      callbacks = [];
    await assert.rejects(async () => {
      for await (const c of await x.m.stream("Synthetic", {
        callbacks: [
          {
            handleLLMNewToken: (t) => {
              callbacks.push(t);
            },
          },
        ],
      }))
        chunks.push(c.content);
    }, /rendering budget/);
    assert.equal(chunks.join(""), "safe");
    assert(callbacks.includes("safe"));
    assert(callbacks.every((t) => t === "safe"));
    assert.equal(x.calls(), 1);
  });
  test(`Chat refuses unsafe final-only tail with no delivered output (${lite})`, async () => {
    const replay = new ReplayLedger();
    let remembered = 0;
    const original = replay.remember.bind(replay);
    replay.remember = (...args) => {
      remembered++;
      return original(...args);
    };
    const x = model([complete(output('"'.repeat(CHAT_OUTPUT_LIMITS.quotes + 1)))], true, replay),
      callbacks = [];
    await assert.rejects(
      x.m.invoke("Synthetic", {
        callbacks: [
          {
            handleLLMNewToken: (t) => {
              callbacks.push(t);
            },
          },
        ],
      }),
      /rendering budget/,
    );
    assert.deepEqual(callbacks, []);
    assert.equal(remembered, 0);
    assert.equal(x.calls(), 1);
  });
  test(`Safe Chat prefix keeps original late-failure semantics (${lite})`, async () => {
    const x = model([
        textEvent("safe"),
        {
          type: "response.failed",
          response: { status: "failed", error: { message: "controlled" } },
        },
      ]),
      chunks = [];
    await assert.rejects(async () => {
      for await (const c of await x.m.stream("Synthetic")) chunks.push(c.content);
    });
    assert.equal(chunks.join(""), "safe");
    assert.equal(x.calls(), 1);
  });
  test(`Large ordinary non-Chat output retains its existing bound (${lite})`, async () => {
    const text = "x".repeat(CHAT_OUTPUT_LIMITS.text + 1),
      x = model([complete(output(text))], false);
    assert.equal((await x.m.invoke("Synthetic")).content, text);
    assert.equal(x.calls(), 1);
  });
  test(`Chat cannot release function-derived assistant output (${lite})`, async () => {
    const x = model([
      complete(
        output("", {
          output: [
            {
              type: "function_call",
              call_id: "controlled",
              name: "return_value",
              arguments: '{"value":"fixture"}',
            },
          ],
        }),
      ),
    ]);
    await assert.rejects(
      x.m
        .bindTools([
          {
            type: "function",
            function: {
              name: "return_value",
              description: "Return a value.",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          },
        ])
        .invoke("Synthetic"),
      /plain model replies/,
    );
    assert.equal(x.calls(), 1);
  });
}

test("Missing public Chat context cannot silently disable output protection", () => {
  assert.throws(() => nativeChatOutputPolicy({}), /pinned native Chat context/);
});

for (const value of [true, "={{ true }}", "disabled"])
  test("Chat route refuses public, dynamic or disabled trigger: " + value, () => {
    const ctx = context("basic");
    ctx.getChatTrigger = () => ({
      name: "Chat Trigger",
      disabled: value === "disabled",
      parameters: { public: value === "disabled" ? false : value },
    });
    assert.throws(() => nativeChatOutputPolicy(ctx), /private Chat Trigger/);
  });
