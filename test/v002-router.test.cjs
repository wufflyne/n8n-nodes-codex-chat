const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  HumanMessage,
  ToolMessage,
  AIMessage,
} = require("@langchain/core/messages");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const { CodexAccountRouterModel } = require("../dist/routing/model");
const {
  coordinator,
  clearCoordinator,
  routerResourceCount,
} = require("../dist/routing/coordinator");
const { emptySnapshot, parseUsage } = require("../dist/account/usage");
const { localStatus } = require("../dist/auth/status");
const {
  rawModel,
  session,
  identity,
  profile,
  output,
  complete,
  sseResponse,
} = require("./helpers.cjs");
const { randomUUID } = require("node:crypto");
const { clearExecutionUsage } = require("../dist/core/execution-usage");
function fixture(t, handler, { unknown = false } = {}) {
  const context = {
      instanceId: "instance",
      workflowId: "router-test",
      executionId: randomUUID(),
      nodeId: "router",
      nodeName: "Router",
    },
    calls = [],
    permissions = { a: true, b: true };
  const base = emptySnapshot(
    localStatus(profile({ profileId: randomUUID(), bindingSecret: "x" }), true),
  );
  const make = (id) => {
    const s = { ...session(id), identity: identity(id) };
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/models?"))
        return Response.json({ models: [rawModel()] });
      calls.push(id);
      return handler(id, JSON.parse(init.body), { permissions, calls });
    };
    return new CodexChatModel({
      model: "synthetic-model",
      session: async () => s,
      catalog: new ModelCatalog(fetchImpl),
      transport: new ResponsesTransport(fetchImpl),
      settings: { maxRetries: 0 },
      context,
      candidateKey: id,
      account: {
        binding: { profileId: id, bindingSecret: "x" },
        reader: {
          readAccount: async () => {
            if (unknown) return structuredClone(base);
            return parseUsage(
              {
                account_id: id,
                rate_limit: {
                  allowed: permissions[id],
                  limit_reached: !permissions[id],
                },
                rate_limit_reached_type: permissions[id]
                  ? null
                  : { type: "rate_limit_reached" },
              },
              base,
              s,
            );
          },
        },
        reset: {
          consumeReset: async () => {
            throw Error("No reset expected");
          },
        },
        policy: {
          automatic: false,
          threshold: 1,
          maxPer24Hours: 1,
          order: "next-first",
        },
      },
    });
  };
  const candidates = [make("a"), make("b")],
    state = coordinator(context).value;
  const router = () =>
    new CodexAccountRouterModel({
      candidates,
      coordinator: state,
      context,
      unknownLimits: "try",
    });
  t.after(() => {
    clearCoordinator(context);
    clearExecutionUsage(context);
  });
  return { context, candidates, state, router, calls, permissions };
}
test("Router switches only on HTTP429 plus fresh quota denial and remains pinned through reconstructed tool turns", async (t) => {
  const f = fixture(t, (id, request, { permissions }) => {
    if (id === "a") {
      permissions.a = false;
      return new Response("", { status: 429 });
    }
    const done = request.input.some((i) => i.type === "function_call_output");
    return sseResponse([
      complete(
        output(done ? "Done" : "", {
          output: done
            ? output("Done").output
            : [
                {
                  type: "function_call",
                  id: "fc_router",
                  call_id: "call_router",
                  name: "safe_tool",
                  arguments: "{}",
                },
              ],
        }),
      ),
    ]);
  });
  const tools = [
      {
        type: "function",
        function: { name: "safe_tool", parameters: { type: "object" } },
      },
    ],
    human = new HumanMessage("Use a safe tool.");
  const first = await f.router().bindTools(tools).invoke([human]);
  assert.equal(f.state.pinned, 1);
  assert.equal(first.tool_calls.length, 1);
  const last = await f
    .router()
    .bindTools(tools)
    .invoke([
      human,
      first,
      new ToolMessage({ tool_call_id: "call_router", content: "Safe result" }),
    ]);
  assert.equal(last.content, "Done");
  assert.deepEqual(f.calls, ["a", "b", "b"]);
  await assert.rejects(f.router().invoke("Another root"), /one fresh/);
});
for (const status of [200, 401, 403, 503])
  test(`Router never switches after HTTP${status} without positive quota rejection`, async (t) => {
    const f = fixture(t, () =>
      status === 200
        ? new Response("<html>not SSE</html>")
        : new Response("", { status }),
    );
    await assert.rejects(f.router().invoke("Test"));
    assert.deepEqual(f.calls, ["a"]);
    if (status === 200) assert.equal(f.state.pinned, 0);
  });
test("Router HTTP429 with unknown limits and network ambiguity never reaches another account", async (t) => {
  for (const behavior of [
    () => new Response("", { status: 429 }),
    () => {
      throw Error("Network unknown");
    },
  ]) {
    const f = fixture(t, behavior, { unknown: true });
    await assert.rejects(f.router().invoke("Test"));
    assert.deepEqual(f.calls, ["a"]);
  }
});
test("Router rejects prior history, overlapping invocation and duplicate accounts before inference", async (t) => {
  const f = fixture(t, () => new Promise(() => {}));
  await assert.rejects(
    f.router().invoke([new HumanMessage("Old"), new AIMessage("History")]),
    /history/,
  );
  assert.deepEqual(f.calls, []);
  const g = fixture(t, () => sseResponse([complete(output())]));
  g.state.inFlight = true;
  await assert.rejects(g.router().invoke("Overlap"), /in flight/);
  assert.deepEqual(g.calls, []);
  const duplicate = new CodexAccountRouterModel({
    candidates: [g.candidates[0], g.candidates[0]],
    coordinator: (g.state = { ...g.state, state: "new", inFlight: false }),
    context: g.context,
    unknownLimits: "try",
  });
  await assert.rejects(duplicate.invoke("Duplicate"), /distinct/);
  assert.deepEqual(g.calls, []);
});
test("Router rejects foreign providers, nested routers and mixed semantic settings before requests", async (t) => {
  const f = fixture(t, () => sseResponse([complete(output())]));
  assert.throws(
    () =>
      new CodexAccountRouterModel({
        candidates: [f.candidates[0], {}],
        coordinator: f.state,
        context: f.context,
        unknownLimits: "try",
      }),
    /directly/,
  );
  const other = new CodexChatModel({
    model: "different",
    session: async () => session(),
    catalog: new ModelCatalog(),
    transport: new ResponsesTransport(),
  });
  assert.throws(
    () =>
      new CodexAccountRouterModel({
        candidates: [f.candidates[0], other],
        coordinator: f.state,
        context: f.context,
        unknownLimits: "try",
      }),
    /same model/,
  );
});

test("Router next-first defers low-but-allowed A; reset-first recovers A before B", async (t) => {
  for (const order of ["next-first", "reset-first"]) {
    const context = {
        instanceId: "i",
        workflowId: "order",
        executionId: randomUUID(),
        nodeId: "router",
        nodeName: "Router",
      },
      state = coordinator(context).value,
      calls = [],
      base = emptySnapshot(
        localStatus(
          profile({ profileId: randomUUID(), bindingSecret: "x" }),
          true,
        ),
      );
    const candidates = ["a", "b"].map((id) => {
      const s = { ...session(id), identity: identity(id) },
        fetchImpl = async (url) =>
          String(url).includes("/models?")
            ? Response.json({ models: [rawModel()] })
            : (calls.push("generate-" + id),
              sseResponse([complete(output("Done"))]));
      return new CodexChatModel({
        model: "synthetic-model",
        session: async () => s,
        catalog: new ModelCatalog(fetchImpl),
        transport: new ResponsesTransport(fetchImpl),
        settings: { maxRetries: 0 },
        context,
        candidateKey: id,
        account: {
          binding: { profileId: id, bindingSecret: "x" },
          policy: { automatic: false, threshold: 1, maxPer24Hours: 1, order },
          reader: {
            readAccount: async () =>
              parseUsage(
                {
                  account_id: id,
                  rate_limit: {
                    allowed: true,
                    limit_reached: false,
                    primary_window: {
                      used_percent: id === "a" ? 99 : 10,
                      limit_window_seconds: 18000,
                      reset_at: Math.floor(Date.now() / 1000) + 3600,
                      reset_after_seconds: 3600,
                    },
                  },
                },
                base,
                s,
              ),
          },
          reset: {
            consumeReset: async () => {
              calls.push("reset-" + id);
              return {
                action: {
                  state: "terminal",
                  outcome: "reset",
                  recovery: "allowed",
                },
              };
            },
          },
        },
      });
    });
    const router = new CodexAccountRouterModel({
      candidates,
      coordinator: state,
      context,
      unknownLimits: "try",
      policy: { automatic: true, threshold: 1, maxPer24Hours: 1, order },
    });
    await router.invoke("Test order");
    assert.deepEqual(
      calls,
      order === "next-first" ? ["generate-b"] : ["reset-a", "generate-a"],
    );
    clearCoordinator(context);
    clearExecutionUsage(context);
  }
});
