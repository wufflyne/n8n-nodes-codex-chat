"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { StateRepository } = require("../dist/gateway/state/repository");
const { GatewayEngine } = require("../dist/gateway/engine");
const { GatewayApplication } = require("../dist/gateway/server");
const { ProfileStore } = require("../dist/auth/store");
const { AccountSessionManager } = require("../dist/auth/sessions");
const { ModelCatalog } = require("../dist/core/catalog");
const { ResponsesTransport } = require("../dist/core/transport");
const { AccountReader } = require("../dist/account/usage");
const {
  profile,
  rawModel,
  output,
  complete,
  sseResponse,
} = require("./helpers.cjs");
const { attestContext, verifyContext } = require("../dist/gateway/context");
const { BodyMemoryAdmission } = require("../dist/gateway/pool/memory");
const { AdmissionQueue } = require("../dist/gateway/pool/admission");
const { OperationStore } = require("../dist/gateway/state/operations");
async function fixture(t, respond, profiles = 1, tuning) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-gateway-"));
  await fs.chmod(dir, 0o700);
  const key = Buffer.alloc(32, 0x61),
    store = new ProfileStore(path.join(dir, "profiles"), key),
    bindings = [];
  for (let i = 0; i < profiles; i++) {
    const binding = {
      profileId: crypto.randomUUID(),
      bindingSecret: "SYNTHETIC_BINDING_" + i,
    };
    bindings.push(binding);
    await store.write(
      profile(binding, { accountId: "account-" + i, subject: "subject-" + i }),
    );
  }
  const calls = [];
  const provider = async (url, init) => {
    calls.push({ url, init });
    return respond
      ? respond(url, init, calls.length)
      : sseResponse([complete(output("Fixture answer"))]);
  };
  const sessions = new AccountSessionManager(
      store,
      {
        verify: async () => {
          throw Error("Unexpected auth");
        },
        refresh: async () => {
          throw Error("Unexpected refresh");
        },
      },
      false,
    ),
    catalog = new ModelCatalog(async () =>
      Response.json({ models: [rawModel()] }),
    );
  const resources = {
    store,
    sessions,
    catalog,
    transport: new ResponsesTransport(provider),
    account: new AccountReader(sessions, async () =>
      Response.json({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 1,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      }),
    ),
    auth: {
      deviceLogin: async () => {
        throw Error("Unexpected device");
      },
    },
  };
  const state = new StateRepository(path.join(dir, "state", "gateway.db"), key);
  await state.open();
  t.after(async () => {
    await state.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const engine = new GatewayEngine(resources, state, true, tuning),
    policy = {
      id: "connection-fixture",
      name: "Fixture",
      mode: profiles > 1 ? "pool" : "fixed",
      profiles: bindings.map((b) => b.profileId),
      allowedModels: [],
      enabled: true,
      localContinuityConsent: true,
      installationId: "instance-fixture",
      contextQualified: true,
    };
  return { dir, key, state, engine, policy, calls, bindings, resources };
}
function context(overrides = {}) {
  return {
    version: 1,
    installationId: "instance-fixture",
    projectId: "project-fixture",
    agentRevision: "revision-fixture",
    conversationId: "conversation-fixture",
    branchId: "branch-fixture",
    runId: "run-fixture",
    turnId: "turn-fixture",
    operationId: crypto.randomUUID(),
    operationIssuedAt: Date.now(),
    kind: "turn",
    ...overrides,
  };
}
const request = { model: "synthetic-model", input: "Hello" };
test("A valid JSON tool batch with one schema violation publishes no calls", async (t) => {
  const f = await fixture(t, () =>
    sseResponse([
      complete(
        output("", {
          output: [
            {
              type: "function_call",
              id: "fc_good",
              call_id: "call_good",
              name: "lookup",
              arguments: '{"value":1}',
              status: "completed",
            },
            {
              type: "function_call",
              id: "fc_bad",
              call_id: "call_bad",
              name: "lookup",
              arguments: '{"value":"wrong type"}',
              status: "completed",
            },
          ],
        }),
      ),
    ]),
  );
  await assert.rejects(
    f.engine.respond(
      f.policy,
      {
        ...request,
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
        ],
      },
      context(),
    ),
    /invalid tool arguments/,
  );
  assert.equal(f.calls.length, 1);
  const history = await f.state.list(f.state.scope("history", f.policy.id), 10);
  assert.equal(history.length, 0);
});
test("Revoking an unacknowledged key permanently prevents activation", async (t) => {
  const f = await fixture(t),
    { GatewayAuthorization } = require("../dist/gateway/auth"),
    auth = new GatewayAuthorization(f.state);
  const pending = await auth.prepareKey({
    role: "installation",
    scopes: ["context:attest"],
    installationId: "fixture",
  });
  await auth.revoke(pending.id);
  await assert.rejects(
    auth.acknowledge(pending.deliveryId),
    (error) => error.code === "key_revoked",
  );
  await assert.rejects(
    auth.authenticate(pending.key, "installation"),
    (error) => error.status === 401,
  );
  assert.equal(f.calls.length, 0);
});
test("Actual remote prompt affinity is omitted, deterministic and separately scoped for execution and conversation modes", async (t) => {
  const { RemoteService } = require("../dist/service/remote"),
    { serviceModel } = require("../dist/adapters/langchain/service-model"),
    { DEFAULT_RECOVERY } = require("../dist/account/types");
  const sent = [],
    f = await fixture(
      t,
      (_, init) => {
        sent.push(JSON.parse(init.body));
        return sseResponse([complete(output("Affinity fixture"))]);
      },
      2,
    );
  const app = new GatewayApplication(
    { admin: { bootstrapFile: path.join(f.dir, "bootstrap") } },
    f.engine,
  );
  const key = await app.authorization.prepareKey({
    role: "installation",
    scopes: ["native:*"],
    installationId: "affinity-instance",
    profiles: f.bindings.map((value) => value.profileId),
  });
  await app.authorization.acknowledge(key.deliveryId);
  const file = path.join(f.dir, "installation.key");
  await fs.writeFile(file, key.key, { mode: 0o600 });
  const remote = new RemoteService(
    "https://gateway.invalid",
    file,
    (url, init) => app.inference(new Request(url, init)),
  );
  const execution = {
    instanceId: "affinity-instance",
    workflowId: "workflow",
    executionId: "execution-a",
    nodeId: "node",
    nodeName: "Node",
  };
  const invoke = async (
    affinityPolicy,
    overrides = {},
    binding = f.bindings[0],
  ) => {
    await serviceModel(remote, binding, {
      model: "synthetic-model",
      context: { ...execution, ...overrides },
      settings: { maxRetries: 0 },
      policy: DEFAULT_RECOVERY,
      affinityPolicy,
    }).invoke("Identical synthetic prompt");
    return sent.at(-1).prompt_cache_key;
  };
  assert.equal(await invoke({ mode: "none" }), undefined);
  const automatic = await invoke({ mode: "execution" });
  assert(automatic);
  assert.equal(await invoke({ mode: "execution" }), automatic);
  assert.notEqual(
    await invoke({ mode: "execution" }, { executionId: "execution-b" }),
    automatic,
  );
  const explicit = await invoke({
    mode: "conversation",
    conversationKey: "conversation-a",
  });
  assert.equal(
    await invoke(
      { mode: "conversation", conversationKey: "conversation-a" },
      { executionId: "execution-b" },
    ),
    explicit,
  );
  assert.notEqual(
    await invoke({ mode: "conversation", conversationKey: "conversation-b" }),
    explicit,
  );
  assert.notEqual(
    await invoke(
      { mode: "conversation", conversationKey: "conversation-a" },
      {},
      f.bindings[1],
    ),
    explicit,
  );
  assert.notEqual(explicit, automatic);
  assert(
    sent.every((body) => !JSON.stringify(body).includes("conversation-a")),
  );
  await remote.finish(execution);
});
for (const lite of [false, true])
  test(`Actual LangChain remote model preserves native affinity, tools and serialized memory (${lite ? "Lite" : "standard"})`, async (t) => {
    const {
      HumanMessage,
      ToolMessage,
      mapChatMessagesToStoredMessages,
      mapStoredMessagesToChatMessages,
    } = require("@langchain/core/messages");
    const { RemoteService } = require("../dist/service/remote");
    const {
      serviceModel,
    } = require("../dist/adapters/langchain/service-model");
    const { DEFAULT_RECOVERY } = require("../dist/account/types");
    const sent = [];
    const f = await fixture(t, (_, init) => {
      sent.push(JSON.parse(init.body));
      return sseResponse([
        complete(
          output("", {
            output:
              sent.length === 1
                ? [
                    {
                      type: "reasoning",
                      id: "rs_remote",
                      summary: [],
                      encrypted_content: "SYNTHETIC_ENCRYPTED_REASONING",
                    },
                    {
                      type: "function_call",
                      id: "fc_remote",
                      call_id: "call_remote",
                      name: "lookup",
                      arguments: '{"value":"fixture"}',
                      status: "completed",
                      ...(lite ? { namespace: "functions" } : {}),
                    },
                  ]
                : output("Remote continuation").output,
          }),
        ),
      ]);
    });
    f.resources.catalog = new ModelCatalog(async () =>
      Response.json({ models: [rawModel({ use_responses_lite: lite })] }),
    );
    const app = new GatewayApplication(
      { admin: { bootstrapFile: path.join(f.dir, "bootstrap") } },
      f.engine,
    );
    const key = await app.authorization.prepareKey({
      role: "installation",
      scopes: ["native:*"],
      installationId: "native-instance",
      profiles: [f.bindings[0].profileId],
    });
    await app.authorization.acknowledge(key.deliveryId);
    const keyFile = path.join(f.dir, "installation.key");
    await fs.writeFile(keyFile, key.key, { mode: 0o600 });
    const remote = new RemoteService(
      "https://gateway.invalid",
      keyFile,
      async (url, init) => app.inference(new Request(url, init)),
    );
    const execution = {
      instanceId: "native-instance",
      workflowId: "workflow",
      executionId: "execution",
      nodeId: "node",
      nodeName: "Node",
    };
    const model = serviceModel(remote, f.bindings[0], {
      model: "synthetic-model",
      settings: { maxRetries: 0 },
      context: execution,
      policy: DEFAULT_RECOVERY,
    }).bindTools([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Synthetic lookup",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      },
    ]);
    const first = await model.invoke([new HumanMessage("Look up the fixture")]);
    assert.equal(first.tool_calls[0].name, "lookup");
    const restored = mapStoredMessagesToChatMessages(
      mapChatMessagesToStoredMessages([first]),
    );
    const second = await model.invoke([
      new HumanMessage("Look up the fixture"),
      ...restored,
      new ToolMessage({
        tool_call_id: "call_remote",
        content: "Found fixture",
      }),
    ]);
    assert.equal(second.content, "Remote continuation");
    assert(sent[0].prompt_cache_key);
    assert.equal(sent[0].prompt_cache_key, sent[1].prompt_cache_key);
    assert.equal(
      sent[1].input.find((item) => item.type === "reasoning").encrypted_content,
      "SYNTHETIC_ENCRYPTED_REASONING",
    );
    assert(sent[1].input.some((item) => item.type === "function_call_output"));
    await remote.finish(execution);
  });
test("Native RPC reports admission before any output and releases its account slot after an admitted failure", async (t) => {
  const { RemoteService } = require("../dist/service/remote");
  const { canonicalRequest } = require("../dist/kernel/request");
  let upstream;
  const f = await fixture(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            upstream = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const app = new GatewayApplication(
    { admin: { bootstrapFile: path.join(f.dir, "bootstrap") } },
    f.engine,
  );
  const key = await app.authorization.prepareKey({
    role: "installation",
    scopes: ["native:*"],
    installationId: "native-instance",
    profiles: [f.bindings[0].profileId],
  });
  await app.authorization.acknowledge(key.deliveryId);
  const keyFile = path.join(f.dir, "installation.key");
  await fs.writeFile(keyFile, key.key, { mode: 0o600 });
  const remote = new RemoteService(
    "https://gateway.invalid",
    keyFile,
    async (url, init) => app.inference(new Request(url, init)),
  );
  const execution = {
    instanceId: "native-instance",
    workflowId: "workflow",
    executionId: "execution",
    nodeId: "node",
    nodeName: "Node",
  };
  let admitted;
  const admission = new Promise((resolve) => {
    admitted = resolve;
  });
  const settings = { timeoutMs: 10000, idleTimeoutMs: 10000, maxRetries: 0 };
  const { model } = await remote.resolve(f.bindings[0], "synthetic-model");
  const stream = remote.generate(
    f.bindings[0],
    {
      request: canonicalRequest(
        {
          model: "synthetic-model",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Fixture" }],
            },
          ],
          tools: [],
          settings,
        },
        model,
      ),
      settings: { timeoutMs: 10000, idleTimeoutMs: 10000, maxRetries: 0 },
      context: execution,
      lite: false,
    },
    undefined,
    admitted,
  );
  const result = stream.next();
  await Promise.race([
    admission,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("Admission was not forwarded")),
        1000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(f.engine.queue.activeCount, 1);
  upstream.error(Error("Synthetic admitted failure before output"));
  await assert.rejects(result);
  const cleanupDeadline = Date.now() + 1000;
  while (f.engine.queue.activeCount !== 0 && Date.now() < cleanupDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    f.engine.queue.activeCount,
    0,
    "Durable unknown-outcome cleanup releases the account slot within one second",
  );
  assert.equal(app.rpcActive.size, 0);
});

test("Encrypted SQLite survives reopen, enforces AEAD ownership and keeps plaintext out of database and WAL", async (t) => {
  const f = await fixture(t);
  const owner = f.state.scope("connection"),
    marker = "PRIVATE_SYNTHETIC_PROMPT_49293";
  await f.state.transaction(
    [],
    [
      {
        owner,
        id: "record",
        value: { prompt: marker },
        expires: Date.now() + 10000,
      },
    ],
  );
  assert.equal((await f.state.get(owner, "record")).value.prompt, marker);
  await f.state.close();
  for (const file of await fs.readdir(path.dirname(f.state.filename))) {
    assert.equal(
      (
        await fs.readFile(path.join(path.dirname(f.state.filename), file))
      ).includes(Buffer.from(marker)),
      false,
    );
  }
  await f.state.open();
  assert.equal((await f.state.get(owner, "record")).value.prompt, marker);
  assert.equal(await f.state.get(f.state.scope("other"), "record"), null);
});
test("Real transport validates terminal output before stored response publication; encrypted references resolve exact supplied history", async (t) => {
  const f = await fixture(t);
  const first = await f.engine.respond(f.policy, request);
  assert.equal(f.calls.length, 1);
  const id = first.body.output[0].id;
  assert.match(id, /^item_cw_/);
  await f.engine.respond(f.policy, {
    ...request,
    input: [
      { type: "item_reference", id },
      { role: "user", content: "Continue" },
    ],
  });
  const sent = JSON.parse(f.calls[1].init.body);
  assert.equal(sent.store, false);
  assert.equal(sent.input[0].id, "msg_synthetic");
  assert.equal(sent.input[0].content[0].text, "Fixture answer");
  assert.equal(sent.input.length, 2);
  await assert.rejects(
    f.engine.respond(
      { ...f.policy, id: "other" },
      { ...request, input: [{ type: "item_reference", id }] },
    ),
    (e) => e.status === 422 && e.code === "history_expired",
  );
});
test("Authenticated retry replays one committed result; changed body and expired issuance never redispatch", async (t) => {
  const f = await fixture(t),
    c = context();
  const first = await f.engine.respond(f.policy, request, c);
  const second = await f.engine.respond(f.policy, request, c);
  assert.deepEqual(second.body, first.body);
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.engine.respond(f.policy, { ...request, input: "Different" }, c),
    (e) => e.code === "operation_conflict",
  );
  await f.state.cleanup(Date.now() + 3 * 86400000);
  await assert.rejects(
    f.engine.respond(f.policy, request, {
      ...c,
      operationIssuedAt: Date.now() - 86400001,
    }),
    (e) => e.code === "operation_expired",
  );
  assert.equal(f.calls.length, 1);
});
test("store:false creates no history or retained response content, and completed duplicate cannot redispatch", async (t) => {
  const f = await fixture(t),
    c = context(),
    input = {
      ...request,
      input: "PRIVATE_STATELESS_PROMPT_38120",
      store: false,
    };
  const response = await f.engine.respond(f.policy, input, c);
  assert.equal(response.body.store, false);
  assert.deepEqual(
    await f.state.list(f.engine.resolver.scope(f.policy.id)),
    [],
  );
  const operations = await f.state.list(
    f.state.scope("operations", f.policy.id),
  );
  assert.equal(operations.length, 1);
  assert.equal(JSON.stringify(operations).includes("PRIVATE_STATELESS"), false);
  assert.equal(operations[0].value.response, undefined);
  await assert.rejects(
    f.engine.respond(f.policy, input, c),
    (e) => e.code === "result_not_retained",
  );
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.engine.respond(
      f.policy,
      { ...input, input: [{ type: "item_reference", id: "some-id" }] },
      context(),
    ),
    (e) => e.code === "stored_dependency",
  );
  assert.equal(f.calls.length, 1);
});
test("Malformed terminal tool arguments release no executable public event and fence the admitted operation", async (t) => {
  const f = await fixture(t, () =>
    sseResponse([
      complete(
        output("", {
          output: [
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "lookup",
              arguments: "{bad",
              status: "completed",
            },
          ],
        }),
      ),
    ]),
  );
  const c = context(),
    input = {
      ...request,
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
  await assert.rejects(f.engine.respond(f.policy, input, c));
  await assert.rejects(
    f.engine.respond(f.policy, input, c),
    (e) => e.code === "outcome_unknown",
  );
  assert.equal(f.calls.length, 1);
});
test("All unsupported settings fail before provider inference", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { temperature: 0 },
    { max_output_tokens: 100 },
    { previous_response_id: "resp_x" },
    { tool_choice: "required" },
    { text: { format: { type: "json_object" } } },
    { input: [{ type: "input_file", file_id: "file_x" }] },
  ])
    await assert.rejects(
      f.engine.respond(f.policy, { ...request, ...extra }),
      (e) => e.status === 400,
    );
  assert.equal(f.calls.length, 0);
});
test("Full pool refuses missing hook and supports 32 profiles without moving admitted conversations", async (t) => {
  const f = await fixture(t, undefined, 32);
  await assert.rejects(
    f.engine.respond(f.policy, request),
    (e) => e.code === "context_required",
  );
  const c = context();
  await f.engine.respond(f.policy, request, c);
  await f.engine.respond(f.policy, request, {
    ...c,
    operationId: crypto.randomUUID(),
    turnId: "turn-2",
  });
  assert.equal(f.calls.length, 2);
  assert.equal(
    new Headers(f.calls[0].init.headers).get("chatgpt-account-id"),
    new Headers(f.calls[1].init.headers).get("chatgpt-account-id"),
  );
  assert.equal(
    (await f.state.list(f.state.scope("pins", f.policy.id))).length,
    1,
  );
});
test("Memory admission bounds large bodies before reading and cancellation removes queued demand", async () => {
  const gate = new BodyMemoryAdmission(192 * 1024 * 1024, 2, 1000),
    release = await gate.acquire(32 * 1024 * 1024);
  assert.equal(gate.reservedBytes, 160 * 1024 * 1024);
  const abort = new AbortController(),
    pending = gate.acquire(32 * 1024 * 1024, abort.signal);
  assert.equal(gate.queuedRequests, 1);
  abort.abort();
  await assert.rejects(pending);
  assert.equal(gate.queuedRequests, 0);
  release();
  assert.equal(gate.reservedBytes, 0);
});
test("Shared pending admission bounds the aggregate body and broker queues", async () => {
  const queue = new AdmissionQueue({ active: 1, account: 1, queued: 64, waitMs: 1000 }),
    memory = new BodyMemoryAdmission(100, 64, 1000),
    active = await queue.acquire("account", "active"),
    occupied = await memory.acquireBytes(100),
    abort = new AbortController(),
    settle = work => work.then(release => { release(); return "admitted"; }, error => error.code),
    broker = settle(queue.acquire("account", "pending", abort.signal)),
    bodies = Array.from({ length: 63 }, () => settle(memory.acquireBytes(1, abort.signal, queue.pending)));
  let overflow;
  try {
    assert.equal(memory.queuedRequests, 63);
    overflow = settle(memory.acquireBytes(1, abort.signal, queue.pending));
    assert.equal(await Promise.race([overflow, new Promise(resolve => setImmediate(() => resolve("still waiting")))]), "memory_queue_full");
    assert.equal(memory.queuedRequests, 63);
    assert.equal(queue.pending.count, 64);
  } finally {
    abort.abort();
    await Promise.all([broker, ...bodies, ...(overflow ? [overflow] : [])]);
    active();
    occupied();
  }
  assert.equal(queue.pending.count, 0);
  assert.equal(memory.queuedRequests, 0);
  assert.equal(memory.reservedBytes, 0);
});
test("Configured pending limits apply across layers and preserve immediate work", async () => {
  const { gatewayTuning } = require("../dist/gateway/config");
  for (const queued of [0, 1]) {
    const tuning = gatewayTuning({ admission: { active: 1, account: 1, queued, waitMs: 100 } }),
      queue = new AdmissionQueue(tuning.admission),
      memory = new BodyMemoryAdmission(100, 64, 1000),
      active = await queue.acquire("account", null),
      occupied = await memory.acquireBytes(100),
      started = Date.now(),
      body = memory.acquireBytes(1, undefined, queue.pending);
    assert.equal(queue.pending.count, queued);
    await assert.rejects(queue.acquire("account", null), error => error.code === "queue_full");
    await assert.rejects(body, error => error.code === "memory_queue_full");
    if (queued) assert(Date.now() - started >= 80, "The accepted body waiter must actually await its configured deadline");
    assert(Date.now() - started < 1000, "Configured body deadline must not use the old 1000ms default");
    assert.equal(queue.pending.count, 0);
    assert.equal(memory.queuedRequests, 0);
    await assert.rejects(queue.acquire("account", null), error => error.code === "queue_full");
    assert.equal(queue.pending.count, 0);
    occupied();
    const immediate = await memory.acquireBytes(1, undefined, queue.pending);
    assert.equal(queue.pending.count, 0);
    immediate();
    active();
    const next = await queue.acquire("account", null);
    assert.equal(queue.pending.count, 0);
    next();
    assert.equal(queue.activeCount, 0);
    assert.equal(memory.reservedBytes, 0);
  }
});
test("Shared pending permits follow actual body cancellation and broker drain settlement", async () => {
  const queue = new AdmissionQueue({ active: 1, account: 1, queued: 2, waitMs: 1000 }),
    memory = new BodyMemoryAdmission(100, 64, 1000),
    active = await queue.acquire("account", "branch"),
    occupied = await memory.acquireBytes(100),
    abort = new AbortController(),
    body = memory.acquireBytes(1, abort.signal, queue.pending),
    broker = queue.acquire("account", "branch");
  assert.equal(queue.pending.count, 2);
  queue.drain();
  assert.equal(queue.pending.count, 1, "A live body waiter must retain its permit during broker drain");
  assert.equal(memory.queuedRequests, 1);
  await assert.rejects(broker, error => error.code === "draining");
  assert.equal(queue.pending.count, 1);
  abort.abort();
  await assert.rejects(body, error => error.code === "cancelled");
  assert.equal(memory.queuedRequests, 0);
  assert.equal(queue.pending.count, 0);
  queue.drain();
  abort.abort();
  active(); active();
  occupied(); occupied();
  assert.equal(queue.pending.count, 0);
  assert.equal(queue.activeCount, 0);
  assert.equal(memory.reservedBytes, 0);
});
test("Shared pending wakeup progresses from body to branch admission without leaked permits", async () => {
  const queue = new AdmissionQueue({ active: 2, account: 2, queued: 1, waitMs: 1000 }),
    memory = new BodyMemoryAdmission(100, 64, 1000),
    active = await queue.acquire("account", "same-branch"),
    occupied = await memory.acquireBytes(100),
    body = memory.acquireBytes(1, undefined, queue.pending);
  assert.equal(queue.pending.count, 1);
  await assert.rejects(queue.acquire("account", "same-branch"), error => error.code === "queue_full");
  occupied();
  const bodyRelease = await body;
  assert.equal(queue.pending.count, 0);
  const broker = queue.acquire("account", "same-branch");
  assert.equal(queue.pending.count, 1);
  assert.equal(queue.activeCount, 1, "Branch concurrency remains one even with a free account slot");
  active();
  const brokerRelease = await broker;
  assert.equal(queue.pending.count, 0);
  assert.equal(queue.activeCount, 1);
  brokerRelease(); brokerRelease();
  bodyRelease(); bodyRelease();
  assert.equal(queue.pending.count, 0);
  assert.equal(queue.activeCount, 0);
  assert.equal(memory.reservedBytes, 0);
});
test("Independent gateway applications keep separate configured pending budgets", async t => {
  const { gatewayTuning } = require("../dist/gateway/config"),
    tuning = gatewayTuning({ admission: { active: 1, account: 1, queued: 1, waitMs: 1000 } }),
    first = await fixture(t, undefined, 1, tuning),
    second = await fixture(t, undefined, 1, tuning),
    applications = [first, second].map(f => new GatewayApplication({ admin: { bootstrapFile: path.join(f.dir, "bootstrap") } }, f.engine)),
    memory = new BodyMemoryAdmission(100, 64, 1000),
    occupied = await memory.acquireBytes(100),
    aborts = [new AbortController(), new AbortController()],
    work = applications.map((app, i) => memory.acquireBytes(1, aborts[i].signal, app.engine.queue.pending));
  try {
    assert.notEqual(applications[0].engine.queue.pending, applications[1].engine.queue.pending);
    assert.equal(memory.queuedRequests, 2);
    assert.equal(first.engine.queue.pending.count, 1);
    assert.equal(second.engine.queue.pending.count, 1);
    aborts[0].abort();
    await assert.rejects(work[0], error => error.code === "cancelled");
    assert.equal(first.engine.queue.pending.count, 0);
    assert.equal(second.engine.queue.pending.count, 1);
    aborts[1].abort();
    await assert.rejects(work[1], error => error.code === "cancelled");
    assert.equal(second.engine.queue.pending.count, 0);
    assert.equal(first.calls.length + second.calls.length, 0);
  } finally {
    for (const abort of aborts) abort.abort();
    await Promise.allSettled(work);
    occupied();
  }
  assert.equal(memory.queuedRequests, 0);
  assert.equal(memory.reservedBytes, 0);
});
test("Context attestation authenticates immutable issuance separately from attempt freshness", () => {
  const key = "SYNTHETIC_CONTEXT_KEY",
    c = context();
  assert.deepEqual(verifyContext(attestContext(c, key), key), c);
  assert.throws(
    () => verifyContext(attestContext(c, key), "wrong"),
    (e) => e.status === 401,
  );
  assert.throws(
    () => verifyContext(attestContext(c, key, Date.now() - 400000), key),
    (e) => e.code === "expired_attestation",
  );
  assert.throws(
    () =>
      verifyContext(
        attestContext({ ...c, operationIssuedAt: Date.now() - 90000000 }, key),
        key,
      ),
    (e) => e.code === "operation_expired",
  );
});
test("In-flight operation intent survives repository restart and blocks duplicate dispatch", async (t) => {
  const f = await fixture(t),
    operations = new OperationStore(f.state),
    c = context();
  await operations.begin("connection", c, { input: "fixture" }, false);
  await f.state.close();
  await f.state.open();
  await assert.rejects(
    operations.begin("connection", c, { input: "fixture" }, false),
    (e) => e.code === "operation_in_flight",
  );
});
test("Actual pinned SDK parses gateway Responses SSE, preserves reasoning and executes a two-step tool history", async (t) => {
  const sdkRoot = process.env.CODEX_WIRE_SDK_ROOT;
  if (!sdkRoot) {
    t.skip(
      "Set CODEX_WIRE_SDK_ROOT to the pinned consumer fixture node_modules.",
    );
    return;
  }
  const { createOpenAI } = require(path.join(sdkRoot, "@ai-sdk/openai"));
  let iteration = 0;
  const f = await fixture(t, () => {
    iteration++;
    return sseResponse([
      complete(
        output(iteration === 1 ? "" : "Done", {
          output:
            iteration === 1
              ? [
                  {
                    type: "reasoning",
                    id: "rs_private",
                    summary: [],
                    encrypted_content: "SYNTHETIC_REASONING",
                  },
                  {
                    type: "function_call",
                    id: "fc_private",
                    call_id: "call_private",
                    name: "lookup",
                    arguments: '{"city":"Oslo"}',
                    status: "completed",
                  },
                ]
              : output("Done").output,
        }),
      ),
    ]);
  });
  const config = {
    version: 1,
    inference: { host: "127.0.0.1", port: 8787, privateHttp: true },
    admin: {
      host: "127.0.0.1",
      port: 8788,
      origin: "http://127.0.0.1:8788",
      allowLoopbackHttp: true,
      bootstrapFile: path.join(f.dir, "bootstrap"),
    },
    storeDirectory: f.resources.store.directory,
    masterKeyFile: path.join(f.dir, "key"),
    stateFile: f.state.filename,
  };
  const app = new GatewayApplication(config, f.engine);
  await app.authorization.savePolicy(f.policy);
  const delivery = await app.authorization.prepareKey({
    role: "inference",
    scopes: ["models", "responses"],
    connectionId: f.policy.id,
  });
  await app.authorization.acknowledge(delivery.deliveryId);
  const client = createOpenAI({
      apiKey: delivery.key,
      baseURL: "https://gateway.invalid/v1",
      fetch: async (url, init) => app.inference(new Request(url, init)),
    }),
    model = client.responses("synthetic-model");
  const tools = [
    {
      type: "function",
      name: "lookup",
      description: "Read fixture weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];
  const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Weather?" }] }],
      tools,
      toolChoice: { type: "auto" },
    }),
    events = [];
  for await (const event of first.stream) events.push(event);
  const error = events.find((e) => e.type === "error");
  if (error) throw error.error;
  const call = events.find((e) => e.type === "tool-call");
  assert(call);
  assert.equal(call.input, '{"city":"Oslo"}');
  assert.match(call.toolCallId, /^call_cw_/);
  const reason = events.find((e) => e.type === "reasoning-end");
  assert(reason);
  assert.equal(
    reason.providerMetadata.openai.reasoningEncryptedContent,
    "SYNTHETIC_REASONING",
  );
  const prompt = [
    { role: "user", content: [{ type: "text", text: "Weather?" }] },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: reason.providerMetadata,
        },
        {
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: "lookup",
          input: { city: "Oslo" },
          providerOptions: call.providerMetadata,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: "lookup",
          output: { type: "text", value: "Cold" },
        },
      ],
    },
  ];
  const second = await model.doGenerate({
    prompt,
    tools,
    toolChoice: { type: "auto" },
  });
  assert.equal(second.content.find((p) => p.type === "text").text, "Done");
  const sent = JSON.parse(f.calls[1].init.body);
  assert.equal(sent.input.find((i) => i.type === "reasoning").id, "rs_private");
  assert.equal(
    sent.input.find((i) => i.type === "function_call").call_id,
    "call_private",
  );
  assert.equal(
    sent.input.find((i) => i.type === "function_call_output").call_id,
    "call_private",
  );
  assert.equal(f.calls.length, 2);
});
test("Inference, installation and console roles are isolated and credential status never calls provider", async (t) => {
  const f = await fixture(t),
    config = {
      version: 1,
      inference: { host: "127.0.0.1", port: 8787, privateHttp: true },
      admin: {
        host: "127.0.0.1",
        port: 8788,
        origin: "http://127.0.0.1:8788",
        allowLoopbackHttp: true,
        bootstrapFile: path.join(f.dir, "bootstrap"),
      },
      storeDirectory: f.resources.store.directory,
      masterKeyFile: path.join(f.dir, "key"),
      stateFile: f.state.filename,
    };
  const app = new GatewayApplication(config, f.engine);
  await app.authorization.savePolicy(f.policy);
  const install = await app.authorization.prepareKey({
    role: "installation",
    scopes: ["native:*"],
    installationId: "instance-fixture",
    profiles: [f.bindings[0].profileId],
    connections: [],
  });
  await app.authorization.acknowledge(install.deliveryId);
  const inference = await app.authorization.prepareKey({
    role: "inference",
    scopes: ["responses"],
    connectionId: f.policy.id,
  });
  await app.authorization.acknowledge(inference.deliveryId);
  const rpc = {
    protocolVersion: 1,
    operationId: crypto.randomUUID(),
    operationIssuedAt: Date.now(),
    binding: f.bindings[0],
    method: "status",
    params: {},
  };
  const call = (key, body) =>
    app.inference(
      new Request("https://gateway.invalid/wire/v1/rpc", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  let r = await call(install.key, rpc);
  assert.equal(r.status, 200);
  const status = await r.json();
  assert.equal(status.account.state, "ready");
  assert.equal(JSON.stringify(status).includes("SYNTHETIC_ACCESS"), false);
  assert.equal(f.calls.length, 0);
  assert.equal((await call(inference.key, rpc)).status, 403);
  assert.equal(
    (
      await call(install.key, {
        ...rpc,
        binding: { ...rpc.binding, bindingSecret: "wrong" },
      })
    ).status,
    400,
  );
  r = await app.admin(
    new Request("http://127.0.0.1:8788/control/v1/accounts", {
      headers: { Authorization: "Bearer " + inference.key },
    }),
  );
  assert.equal(r.status, 403);
});

async function sdkFixture(t, provider) {
  const { createOpenAI } = require(
    path.join(process.env.CODEX_WIRE_SDK_ROOT, "@ai-sdk/openai"),
  );
  const f = await fixture(t, provider),
    config = {
      version: 1,
      inference: { host: "127.0.0.1", port: 8787, privateHttp: true },
      admin: {
        host: "127.0.0.1",
        port: 8788,
        origin: "http://127.0.0.1:8788",
        allowLoopbackHttp: true,
        bootstrapFile: path.join(f.dir, "bootstrap"),
      },
      storeDirectory: f.resources.store.directory,
      masterKeyFile: path.join(f.dir, "key"),
      stateFile: f.state.filename,
    };
  const app = new GatewayApplication(config, f.engine);
  await app.authorization.savePolicy(f.policy);
  const delivery = await app.authorization.prepareKey({
    role: "inference",
    scopes: ["models", "responses"],
    connectionId: f.policy.id,
  });
  await app.authorization.acknowledge(delivery.deliveryId);
  const statuses = [],
    model = createOpenAI({
      apiKey: delivery.key,
      baseURL: "https://gateway.invalid/v1",
      fetch: async (url, init) => {
        const r = await app.inference(new Request(url, init));
        statuses.push(r.status);
        return r;
      },
    }).responses("synthetic-model");
  return { ...f, app, model, statuses };
}
const sdkPrompt = [
  {
    role: "user",
    content: [{ type: "text", text: "Synthetic streaming probe" }],
  },
];
const sdkTools = [
  {
    type: "function",
    name: "lookup",
    inputSchema: { type: "object", properties: {} },
  },
];
function encodeEvent(event) {
  return new TextEncoder().encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Probe timed out")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("Actual SDK receives incremental text before provider terminal; tools follow durable commit only", async (t) => {
  const terminalBarrier = deferred(),
    firstText = deferred(),
    timeline = {},
    events = [];
  let providerEnded = false;
  const message = {
      type: "message",
      id: "msg_live",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Live text", annotations: [] }],
    },
    tool = {
      type: "function_call",
      id: "fc_live",
      call_id: "call_live",
      name: "lookup",
      arguments: "{}",
      status: "completed",
    };
  const f = await sdkFixture(
    t,
    () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            try {
              controller.enqueue(
                encodeEvent({
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...message, status: "in_progress", content: [] },
                }),
              );
              controller.enqueue(
                encodeEvent({
                  type: "response.output_text.delta",
                  output_index: 0,
                  content_index: 0,
                  item_id: message.id,
                  delta: "Live text",
                }),
              );
              controller.enqueue(
                encodeEvent({
                  type: "response.output_item.added",
                  output_index: 1,
                  item: { ...tool, status: "in_progress", arguments: "" },
                }),
              );
              controller.enqueue(
                encodeEvent({
                  type: "response.function_call_arguments.delta",
                  output_index: 1,
                  item_id: tool.id,
                  delta: "{}",
                }),
              );
              await terminalBarrier.promise;
              providerEnded = true;
              timeline.providerTerminal = performance.now();
              controller.enqueue(
                encodeEvent(complete(output("", { output: [message, tool] }))),
              );
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  t.after(() => terminalBarrier.resolve());
  const original = f.state.transaction.bind(f.state);
  let committed = false;
  f.state.transaction = async (...args) => {
    const r = await original(...args);
    if (args[1].some((w) => w.id.startsWith("item_cw_"))) committed = true;
    return r;
  };
  const result = await f.model.doStream({
      prompt: sdkPrompt,
      tools: sdkTools,
      toolChoice: { type: "auto" },
    }),
    consume = (async () => {
      for await (const e of result.stream) {
        events.push(e);
        if (e.type === "text-delta") {
          timeline.sdkFirstText = performance.now();
          assert.equal(providerEnded, false);
          firstText.resolve();
        }
        if (e.type === "tool-call" || e.type === "tool-input-start")
          assert.equal(committed, true);
      }
    })();
  await bounded(firstText.promise);
  assert.equal(
    events.some((e) => e.type.startsWith("tool-")),
    false,
  );
  terminalBarrier.resolve();
  await bounded(consume);
  assert(timeline.sdkFirstText < timeline.providerTerminal);
  assert.equal(events.filter((e) => e.type === "tool-call").length, 1);
  assert.equal(
    events.some((e) => e.type === "error"),
    false,
  );
  assert.deepEqual(f.statuses, [200]);
  t.diagnostic(JSON.stringify(timeline));
});

test("Actual SDK late failure retains streamed text and emits error without any executable tool", async (t) => {
  const barrier = deferred(),
    firstText = deferred();
  const f = await sdkFixture(
    t,
    () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(
              encodeEvent({
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "message",
                  id: "m",
                  role: "assistant",
                  content: [],
                  status: "in_progress",
                },
              }),
            );
            c.enqueue(
              encodeEvent({
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: "m",
                delta: "Provisional",
              }),
            );
            c.enqueue(
              encodeEvent({
                type: "response.output_item.added",
                output_index: 1,
                item: {
                  type: "function_call",
                  id: "f",
                  call_id: "c",
                  name: "lookup",
                  arguments: "{}",
                  status: "in_progress",
                },
              }),
            );
            await barrier.promise;
            c.enqueue(
              encodeEvent({
                type: "response.failed",
                response: { status: "failed" },
              }),
            );
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  t.after(() => barrier.resolve());
  const result = await f.model.doStream({
      prompt: sdkPrompt,
      tools: sdkTools,
      toolChoice: { type: "auto" },
    }),
    events = [],
    consume = (async () => {
      for await (const e of result.stream) {
        events.push(e);
        if (e.type === "text-delta") firstText.resolve();
      }
    })();
  await bounded(firstText.promise);
  barrier.resolve();
  await bounded(consume);
  assert.deepEqual(f.statuses, [200]);
  assert(events.some((e) => e.type === "error"));
  assert.equal(
    events.some((e) => e.type.startsWith("tool-")),
    false,
  );
  assert.deepEqual(
    await f.state.list(f.engine.resolver.scope(f.policy.id)),
    [],
  );
});

test("Pinned SDK refusal is terminal 422 for doGenerate and supported error event after stream admission", async (t) => {
  const f = await sdkFixture(t, () =>
    sseResponse([
      complete(
        output("", {
          output: [
            {
              type: "message",
              id: "refused",
              role: "assistant",
              status: "completed",
              content: [{ type: "refusal", refusal: "Synthetic refusal" }],
            },
          ],
        }),
      ),
    ]),
  );
  await assert.rejects(
    f.model.doGenerate({ prompt: sdkPrompt }),
    (e) => e.statusCode === 422 && e.isRetryable === false,
  );
  await assert.rejects(
    f.model.doStream({ prompt: sdkPrompt }),
    (e) =>
      e.statusCode === 422 &&
      e.isRetryable === false &&
      e.data.error.type === "provider_refusal",
  );
  assert.deepEqual(f.statuses, [422, 200]);
  assert.deepEqual(
    await f.state.list(f.engine.resolver.scope(f.policy.id)),
    [],
  );
});

test("Reference amplification is rejected from metadata before decrypt/IPC; repeated references count toward aggregate", async (t) => {
  const { ItemResolver } = require("../dist/gateway/responses"),
    f = await fixture(t);
  const response = await f.engine.respond(f.policy, request),
    id = response.body.output[0].id,
    meta = (
      await f.state.metadata(f.engine.resolver.scope(f.policy.id), [id])
    )[0];
  let reads = 0;
  const original = f.state.get.bind(f.state);
  f.state.get = (...args) => {
    reads++;
    return original(...args);
  };
  const resolver = new ItemResolver(f.state, {
    expandedBytes: meta.bytes + 100,
    recordBytes: meta.bytes + 1,
    references: 4,
  });
  await assert.rejects(
    resolver.resolve(
      f.policy.id,
      { account: "account-0", model: "synthetic-model", branch: null, codec: "responses-v1" },
      [
        { type: "item_reference", id },
        { type: "item_reference", id },
      ],
      true,
    ),
    (e) => e.code === "expanded_history_limit",
  );
  assert.equal(reads, 0);
  const recordLimited = new ItemResolver(f.state, {
    expandedBytes: 100000,
    recordBytes: meta.bytes - 1,
    references: 4,
  });
  await assert.rejects(
    recordLimited.resolve(
      f.policy.id,
      { account: "account-0", model: "synthetic-model", branch: null, codec: "responses-v1" },
      [{ type: "item_reference", id }],
      true,
    ),
    (e) => e.code === "expanded_history_limit",
  );
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 1);
});

test("A waiting SSE reader does not consume the slow-consumer deadline", async () => {
  const { EventChannel } = require("../dist/gateway/stream");
  let cancelled = false;
  const channel = new EventChannel(
    () => {
      cancelled = true;
    },
    100,
    1,
    10,
  );
  const iterator = channel[Symbol.asyncIterator]();
  const pending = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    cancelled,
    false,
    "An idle provider is governed by its transport deadline",
  );
  await channel.write({ type: "text", delta: "after provider delay" });
  assert.equal((await pending).value.delta, "after provider delay");
  channel.close();
  assert.equal((await iterator.next()).done, true);
});

test("A stalled SSE reader applies bounded backpressure then cancels upstream", async () => {
  const { EventChannel } = require("../dist/gateway/stream");
  let cancelled = false;
  const channel = new EventChannel(
    () => {
      cancelled = true;
    },
    100,
    1,
    25,
  );
  await channel.write({ type: "text", delta: "a".repeat(50) });
  const bytes = channel.queuedBytes;
  await assert.rejects(channel.write({ type: "text", delta: "b".repeat(50) }));
  assert.equal(cancelled, true);
  assert.equal(channel.queuedBytes, bytes);
});

test("Full pool checks exact lifecycle build handshake before provider admission", async (t) => {
  const f = await fixture(t, undefined, 2),
    config = {
      version: 1,
      inference: { host: "127.0.0.1", port: 8787, privateHttp: true },
      admin: {
        host: "127.0.0.1",
        port: 8788,
        origin: "http://127.0.0.1:8788",
        allowLoopbackHttp: true,
        bootstrapFile: path.join(f.dir, "bootstrap"),
      },
      storeDirectory: f.resources.store.directory,
      masterKeyFile: path.join(f.dir, "key"),
      stateFile: f.state.filename,
    },
    app = new GatewayApplication(config, f.engine);
  await app.authorization.savePolicy(f.policy);
  const installation = await app.authorization.prepareKey({
      role: "installation",
      scopes: ["context:attest"],
      installationId: "instance-fixture",
      profiles: [],
      connections: [f.policy.id],
    }),
    inference = await app.authorization.prepareKey({
      role: "inference",
      scopes: ["responses"],
      connectionId: f.policy.id,
    });
  await app.authorization.acknowledge(installation.deliveryId);
  await app.authorization.acknowledge(inference.deliveryId);
  const headers = {
    authorization: "Bearer " + inference.key,
    "content-type": "application/json",
    "x-codex-wire-context": attestContext(context(), installation.key),
    "x-codex-wire-installation-key": installation.key,
  };
  const call = () =>
    app.inference(
      new Request("https://gateway.invalid/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      }),
    );
  assert.equal((await call()).status, 422);
  assert.equal(f.calls.length, 0);
  const build = require("../dist/integration/context-build.json"),
    handshake = (claim) =>
      app.inference(
        new Request("https://gateway.invalid/wire/v1/context/handshake", {
          method: "POST",
          headers: {
            authorization: "Bearer " + installation.key,
            "content-type": "application/json",
          },
          body: JSON.stringify(claim),
        }),
      );
  assert.equal((await handshake({ ...build, artifact: "wrong" })).status, 422);
  const accepted = await handshake(build);
  assert.equal(accepted.status, 200);
  headers["x-codex-wire-context-handshake"] = (await accepted.json()).id;
  assert.equal((await call()).status, 200);
  assert.equal(f.calls.length, 1);
});

test("Embedded owner prevents a second writer and offline recovery never steals by age", async (t) => {
  const { ProfileOwner } = require("../dist/service/owner"),
    f = await fixture(t),
    first = new ProfileOwner(f.resources.store.directory),
    second = new ProfileOwner(f.resources.store.directory);
  await first.acquire();
  try {
    await assert.rejects(second.acquire(), (e) => e.code === "owner_conflict");
  } finally {
    await first.close();
  }
  await second.acquire();
  await second.close();
});

test("Matched fetch hook strips Request-form internal headers off-origin and forbids attested redirects", async (t) => {
  const f = await fixture(t),
    integration = require("../dist/integration/n8n-context"),
    { atomicWrite } = require("../dist/auth/store"),
    key = "SYNTHETIC_FETCH_CONTEXT_KEY",
    previous = process.env.N8N_CODEX_CONTEXT_CONFIG_FILE;
  const configFile = path.join(f.dir, "context.json");
  await atomicWrite(path.join(f.dir, "context-key"), key);
  await atomicWrite(
    configFile,
    JSON.stringify({
      version: 1,
      installationId: "instance-fixture",
      installationKeyFile: path.join(f.dir, "context-key"),
      journalDirectory: path.join(f.dir, "journal"),
      gatewayOrigins: ["https://gateway.invalid"],
    }),
  );
  process.env.N8N_CODEX_CONTEXT_CONFIG_FILE = configFile;
  t.after(() => {
    if (previous === undefined)
      delete process.env.N8N_CODEX_CONTEXT_CONFIG_FILE;
    else process.env.N8N_CODEX_CONTEXT_CONFIG_FILE = previous;
  });
  const hooks = await integration.installFromEnvironment(),
    calls = [];
  const transport = integration.decorateModelFetch(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url),
      headers = new Headers(init.headers);
    calls.push({ origin: url.origin, headers });
    if (url.pathname === "/wire/v1/context/handshake") {
      assert.equal(init.redirect, "error");
      return Response.json({
        id: "fixture-handshake",
        expires: Date.now() + 3600000,
      });
    }
    if (url.origin === "https://gateway.invalid") {
      assert.equal(init.redirect, "error");
      return Response.redirect("https://other-provider.invalid/responses", 307);
    }
    assert.equal(headers.get("authorization"), "Bearer OTHER_SYNTHETIC_KEY");
    for (const name of [
      "x-n8n-model-operation",
      "x-codex-wire-context",
      "x-codex-wire-installation-key",
      "x-codex-wire-context-handshake",
    ])
      assert.equal(headers.get(name), null);
    return Response.json({ ok: true });
  });
  await transport(
    new Request("https://other-provider.invalid/responses", {
      headers: {
        authorization: "Bearer OTHER_SYNTHETIC_KEY",
        "X-N8n-Model-Operation": "untrusted",
        "X-Codex-Wire-Context": "untrusted",
        "X-Codex-Wire-Installation-Key": key,
        "X-Codex-Wire-Context-Handshake": "untrusted",
      },
    }),
  );
  await integration.withServerRun(
    {
      projectId: "p",
      agentRevision: "a",
      conversationId: "c",
      branchId: "b",
      turnId: "t",
      hostRunId: "h",
      hostIssuedAt: Date.now(),
    },
    async () => {
      const context = await hooks.prepare({ runId: "r" }, async () => {});
      await assert.rejects(
        hooks.run(context, () => transport(
          new Request("https://gateway.invalid/v1/responses", {
            headers: {
              authorization: "Bearer INFERENCE_FIXTURE",
              "X-N8n-Model-Operation": context.operationId,
            },
          }),
        )),
        /cannot follow redirects/,
      );
    },
  );
  assert.equal(
    calls.filter((call) => call.origin === "https://other-provider.invalid")
      .length,
    1,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.origin === "https://other-provider.invalid" &&
        call.headers.get("x-codex-wire-installation-key"),
    ),
    false,
  );
});

test("Memory upgrades fail immediately without deadlocking held ingress leases and distinguish impossible requests", async () => {
  const gate = new BodyMemoryAdmission(100, 8, 1000),
    a = await gate.acquireBytes(40),
    b = await gate.acquireBytes(40);
  assert.throws(
    () => a.tryExtend(30),
    (e) => e.status === 429,
  );
  assert.equal(gate.queuedRequests, 0);
  assert.equal(gate.reservedBytes, 80);
  b();
  const expanded = a.tryExtend(30);
  assert.equal(a.bytes, 70);
  assert.throws(
    () => a.tryExtend(31),
    (e) => e.status === 413,
  );
  expanded();
  a();
  assert.equal(gate.reservedBytes, 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    gate.acquireBytes(10, abort.signal),
    (e) => e.code === "cancelled",
  );
  assert.equal(gate.reservedBytes, 0);
});
test("Concurrent metadata GETs use small reservations and reject unexpected bodies", async () => {
  const gate = new BodyMemoryAdmission(192 * 1024 * 1024),
    leases = await Promise.all(
      Array.from({ length: 8 }, () =>
        gate.acquireRequest("GET", undefined, false),
      ),
    );
  assert.equal(gate.reservedBytes, 64 * 1024 * 1024);
  const post = await gate.acquire(1024);
  assert(gate.reservedBytes < 100 * 1024 * 1024);
  await assert.rejects(
    gate.acquireRequest("GET", 1, false),
    (e) => e.status === 400,
  );
  await assert.rejects(
    gate.acquireRequest("HEAD", undefined, true),
    (e) => e.status === 400,
  );
  post();
  for (const release of leases) release();
  assert.equal(gate.reservedBytes, 0);
});

test("Migration copies the latest rotating-token generation and uncertainty journals without restoring stale backups", async (t) => {
  const f = await fixture(t),
    { transferCurrentStore } = require("../dist/service/migration"),
    binding = f.bindings[0],
    old = await f.resources.store.read(binding);
  await f.resources.store.write({
    ...old,
    generation: 2,
    tokens: { ...old.tokens, refreshToken: "SYNTHETIC_LATEST_ROTATED_TOKEN" },
    state: "refresh_uncertain",
  });
  await fs.writeFile(
    path.join(f.resources.store.directory, ".import-fixture.used"),
    "Non-content used-token fence",
    { mode: 0o600 },
  );
  await fs.mkdir(
    path.join(f.resources.store.directory, binding.profileId + ".lock"),
    {
      mode: 0o700,
    },
  );
  const target = path.join(f.dir, "transferred");
  await assert.rejects(
    transferCurrentStore(f.resources.store.directory, target, f.key, false),
  );
  await transferCurrentStore(f.resources.store.directory, target, f.key, true);
  const transferred = await new ProfileStore(target, f.key).read(binding);
  assert(
    (
      await fs.stat(path.join(target, binding.profileId + ".lock"))
    ).isDirectory(),
  );
  assert.equal(transferred.generation, 2);
  assert.equal(
    transferred.tokens.refreshToken,
    "SYNTHETIC_LATEST_ROTATED_TOKEN",
  );
  assert.equal(transferred.state, "refresh_uncertain");
  assert.equal((await f.resources.store.read(binding)).generation, 2);
  assert.equal(
    await fs.readFile(path.join(target, ".import-fixture.used"), "utf8"),
    "Non-content used-token fence",
  );
  await assert.rejects(
    transferCurrentStore(f.resources.store.directory, target, f.key, true),
  );
});

test("Typed native RPC preserves catalog, generation, image, local status, reset policy and execution usage with durable deduplication", async (t) => {
  const f = await fixture(t),
    { RemoteService } = require("../dist/service/remote"),
    { ImageService } = require("../dist/image/service"),
    { ResetController } = require("../dist/account/reset"),
    { ResetStore } = require("../dist/account/reset-store"),
    { DEFAULT_RECOVERY } = require("../dist/account/types"),
    { canonicalRequest } = require("../dist/kernel/request"),
    { executionKey } = require("../dist/core/affinity");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  let imageCalls = 0;
  f.resources.images = new ImageService(f.resources.sessions, async () => {
    imageCalls++;
    return Response.json({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: png.toString("base64") }],
    });
  });
  f.resources.resets = new ResetController(
    f.resources.account,
    new ResetStore(f.resources.store.directory, f.key),
    async () => {
      throw Error("No reset spending is permitted in this policy-off proof");
    },
  );
  const config = {
      version: 1,
      inference: { host: "127.0.0.1", port: 8787, privateHttp: true },
      admin: {
        host: "127.0.0.1",
        port: 8788,
        origin: "http://127.0.0.1:8788",
        allowLoopbackHttp: true,
        bootstrapFile: path.join(f.dir, "bootstrap"),
      },
      storeDirectory: f.resources.store.directory,
      masterKeyFile: path.join(f.dir, "key"),
      stateFile: f.state.filename,
    },
    app = new GatewayApplication(config, f.engine),
    delivery = await app.authorization.prepareKey({
      role: "installation",
      scopes: ["native:*", "native:reset"],
      installationId: "instance-fixture",
      profiles: [f.bindings[0].profileId],
      connections: [],
    });
  await app.authorization.acknowledge(delivery.deliveryId);
  const keyFile = path.join(f.dir, "installation.key");
  await fs.writeFile(keyFile, delivery.key, { mode: 0o600 });
  const envelopes = [],
    fetch = async (url, init) => {
      if (init.body) envelopes.push(JSON.parse(init.body));
      return app.inference(new Request(url, init));
    };
  const remote = new RemoteService("https://gateway.invalid", keyFile, fetch),
    binding = f.bindings[0],
    execution = {
      instanceId: "instance-fixture",
      workflowId: "workflow",
      executionId: "execution",
      nodeId: "node",
      nodeName: "Synthetic",
    };
  assert.equal((await remote.status(binding)).account.state, "ready");
  assert.equal(f.calls.length, 0);
  const models = await remote.models(binding),
    resolved = await remote.resolve(binding, models[0].slug);
  assert.equal(resolved.identity.profileId, binding.profileId);
  assert.equal(JSON.stringify(resolved).includes("SYNTHETIC_ACCESS"), false);
  const settings = { timeoutMs: 10000, idleTimeoutMs: 10000, maxRetries: 0 },
    request = canonicalRequest(
      {
        model: models[0].slug,
        input: [{ type: "message", role: "user", content: "Native fixture" }],
        tools: [],
        settings,
      },
      models[0],
    );
  const events = [];
  for await (const e of remote.generate(binding, {
    request,
    settings,
    lite: false,
    context: execution,
  }))
    events.push(e);
  assert.equal(events.at(-1).kind, "completed");
  assert.equal(f.calls.length, 1);
  const generation = envelopes.find((e) => e.method === "generate"),
    duplicate = await app.inference(
      new Request("https://gateway.invalid/wire/v1/rpc", {
        method: "POST",
        headers: {
          authorization: "Bearer " + delivery.key,
          "content-type": "application/json",
        },
        body: JSON.stringify(generation),
      }),
    );
  assert.equal(duplicate.status, 422);
  assert.equal(f.calls.length, 1);
  const image = await remote.image(binding, "Synthetic pixel", false, {
    context: execution,
    access: "current-only",
  });
  assert.deepEqual(image.bytes, png);
  assert.equal(imageCalls, 1);
  assert.equal(
    require("../dist/gateway/pool/memory").gatewayMemory.reservedBytes,
    0,
  );
  const imageEnvelope = {
    ...envelopes.find((e) => e.method === "image"),
    operationId: crypto.randomUUID(),
    operationIssuedAt: Date.now(),
  };
  const pendingImage = await app.inference(
    new Request("https://gateway.invalid/wire/v1/rpc", {
      method: "POST",
      headers: {
        authorization: "Bearer " + delivery.key,
        "content-type": "application/json",
      },
      body: JSON.stringify(imageEnvelope),
    }),
  );
  assert.equal(pendingImage.status, 200);
  assert.equal(
    require("../dist/gateway/pool/memory").gatewayMemory.reservedBytes,
    272 * 1024 * 1024,
  );
  await pendingImage.body.cancel();
  assert.equal(
    require("../dist/gateway/pool/memory").gatewayMemory.reservedBytes,
    0,
  );
  const reset = await remote.reset(
    binding,
    {
      origin: "automatic",
      executionKey: executionKey(execution),
      policy: { ...DEFAULT_RECOVERY, automatic: false },
    },
    execution,
  );
  assert.equal(reset.action.reason, "policy_off");
  const usage = await remote.usage(binding, execution);
  assert.equal(usage.schemaVersion, 1);
  await remote.finish(execution);
});

test("A new pool branch advances only after fresh applicable pre-admission quota denial and keeps its selected pin", async (t) => {
  const f = await fixture(
    t,
    (_, init) =>
      new Headers(init.headers).get("chatgpt-account-id") === "account-0"
        ? new Response("", { status: 429 })
        : sseResponse([complete(output("Fallback fixture"))]),
    2,
  );
  f.resources.account = new AccountReader(
    f.resources.sessions,
    async (_, init) => {
      const id = new Headers(init.headers).get("chatgpt-account-id"),
        exhausted = id === "account-0";
      return Response.json({
        account_id: id,
        plan_type: "pro",
        rate_limit: {
          allowed: !exhausted,
          limit_reached: exhausted,
          primary_window: {
            used_percent: exhausted ? 100 : 10,
            limit_window_seconds: 18000,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
            reset_after_seconds: 3600,
          },
        },
        rate_limit_reached_type: exhausted
          ? { type: "rate_limit_reached" }
          : null,
      });
    },
  );
  const c = context();
  await f.engine.respond(f.policy, request, c);
  assert.deepEqual(
    f.calls.map((c) => new Headers(c.init.headers).get("chatgpt-account-id")),
    ["account-0", "account-1"],
  );
  await f.engine.respond(
    { ...f.policy, profiles: [f.bindings[0].profileId] },
    request,
    {
      ...c,
      operationId: crypto.randomUUID(),
      turnId: "next",
    },
  );
  assert.equal(
    new Headers(f.calls.at(-1).init.headers).get("chatgpt-account-id"),
    "account-1",
  );
});

test("Unknown quota evidence and admitted stream failure never move a pool branch to another account", async (t) => {
  const f = await fixture(t, () => new Response("", { status: 429 }), 2);
  await assert.rejects(f.engine.respond(f.policy, request, context()));
  assert.equal(f.calls.length, 1);
  const g = await fixture(
      t,
      () =>
        sseResponse([
          { type: "response.failed", response: { status: "failed" } },
        ]),
      2,
    ),
    c = context();
  await assert.rejects(g.engine.respond(g.policy, request, c));
  assert.equal(g.calls.length, 1);
  await assert.rejects(
    g.engine.respond(g.policy, request, c),
    (e) => e.code === "outcome_unknown",
  );
  assert.equal(g.calls.length, 1);
  const pins = await g.state.list(g.state.scope("pins", g.policy.id));
  assert.equal(pins[0].value.admitted, true);
});

test("Pool eligibility reaches the last of 32 profiles and coalesces independent branch catalogs", async (t) => {
  const f = await fixture(t, undefined, 32),
    reads = new Map();
  f.resources.catalog = new ModelCatalog(async (_, init) => {
    const id = new Headers(init.headers).get("chatgpt-account-id"),
      index = Number(id.slice(8));
    reads.set(id, (reads.get(id) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return Response.json({
      models: [
        rawModel(
          index < 16
            ? { slug: "another-model" }
            : { use_responses_lite: index < 31 },
        ),
      ],
    });
  });
  await Promise.all(
    ["branch-a", "branch-b"].map((branchId) =>
      f.engine.respond(
        f.policy,
        { ...request, parallel_tool_calls: true },
        context({ branchId }),
      ),
    ),
  );
  assert.equal(reads.size, 32);
  assert([...reads.values()].every((value) => value === 1));
  assert.deepEqual(
    f.calls.map((call) =>
      new Headers(call.init.headers).get("chatgpt-account-id"),
    ),
    ["account-31", "account-31"],
  );
  assert.equal(
    (await f.state.list(f.state.scope("pins", f.policy.id))).length,
    2,
  );
  assert(
    f.calls.every(
      (call) => JSON.parse(call.init.body).parallel_tool_calls === true,
    ),
  );
});

test("A 32-profile pool advances through fresh quota denials without skipping the last eligible account", async (t) => {
  const reads = [];
  const f = await fixture(
    t,
    (_, init) =>
      new Headers(init.headers).get("chatgpt-account-id") === "account-31"
        ? sseResponse([complete(output("Last account"))])
        : new Response(null, { status: 429 }),
    32,
  );
  f.resources.account = new AccountReader(
    f.resources.sessions,
    async (_, init) => {
      const id = new Headers(init.headers).get("chatgpt-account-id");
      reads.push(id);
      return Response.json({
        account_id: id,
        rate_limit_reached_type: { type: "rate_limit_reached" },
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: {
            used_percent: 100,
            limit_window_seconds: 3600,
            reset_after_seconds: 3600,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      });
    },
  );
  const c = context();
  assert.equal(
    (await f.engine.respond(f.policy, request, c)).body.output[0].content[0]
      .text,
    "Last account",
  );
  assert.deepEqual(
    f.calls.map((call) =>
      new Headers(call.init.headers).get("chatgpt-account-id"),
    ),
    Array.from({ length: 32 }, (_, i) => "account-" + i),
  );
  assert.deepEqual(
    reads,
    Array.from({ length: 31 }, (_, i) => "account-" + i),
  );
  await f.engine.respond(f.policy, request, {
    ...c,
    operationId: crypto.randomUUID(),
  });
  assert.equal(
    new Headers(f.calls.at(-1).init.headers).get("chatgpt-account-id"),
    "account-31",
  );
  assert.equal(reads.length, 31);
});

test("Actual remote Router preserves verified account distinction and pins an admitted tool continuation", async (t) => {
  const { RemoteService } = require("../dist/service/remote"),
    { serviceModel } = require("../dist/adapters/langchain/service-model"),
    { CodexAccountRouterModel } = require("../dist/routing/model"),
    { coordinator, clearCoordinator } = require("../dist/routing/coordinator"),
    { DEFAULT_RECOVERY } = require("../dist/account/types"),
    { HumanMessage, ToolMessage } = require("@langchain/core/messages");
  const sent = [];
  let rejected = false;
  const f = await fixture(
    t,
    (_, init) => {
      const id = new Headers(init.headers).get("chatgpt-account-id");
      sent.push(id);
      if (id === "account-0") {
        rejected = true;
        return new Response(null, { status: 429 });
      }
      const input = JSON.parse(init.body).input;
      return sseResponse([
        complete(
          output("", {
            output: input.some((item) => item.type === "function_call_output")
              ? output("Pinned answer").output
              : [
                  {
                    type: "function_call",
                    id: "fc_router",
                    call_id: "call_router",
                    name: "lookup",
                    arguments: '{"value":1}',
                    status: "completed",
                  },
                ],
          }),
        ),
      ]);
    },
    2,
  );
  f.resources.account = new AccountReader(
    f.resources.sessions,
    async (_, init) => {
      const id = new Headers(init.headers).get("chatgpt-account-id"),
        denied = rejected && id === "account-0";
      return Response.json({
        account_id: id,
        rate_limit_reached_type: denied ? { type: "rate_limit_reached" } : null,
        rate_limit: {
          allowed: !denied,
          limit_reached: denied,
          primary_window: {
            used_percent: denied ? 100 : 1,
            limit_window_seconds: 3600,
            reset_after_seconds: 3600,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      });
    },
  );
  const app = new GatewayApplication(
      { admin: { bootstrapFile: path.join(f.dir, "bootstrap") } },
      f.engine,
    ),
    key = await app.authorization.prepareKey({
      role: "installation",
      scopes: ["native:*"],
      installationId: "router-instance",
      profiles: f.policy.profiles,
    });
  await app.authorization.acknowledge(key.deliveryId);
  const keyFile = path.join(f.dir, "router.key");
  await fs.writeFile(keyFile, key.key, { mode: 0o600 });
  const remote = new RemoteService(
    "https://gateway.invalid",
    keyFile,
    (url, init) => app.inference(new Request(url, init)),
  );
  const x = {
    instanceId: "router-instance",
    workflowId: "workflow",
    executionId: "router-execution",
    nodeId: "router",
    nodeName: "Router",
  };
  const make = (execution) =>
    new CodexAccountRouterModel({
      candidates: f.bindings.map((binding) =>
        serviceModel(remote, binding, {
          model: "synthetic-model",
          settings: { maxRetries: 0 },
          context: execution,
          policy: DEFAULT_RECOVERY,
        }),
      ),
      coordinator: coordinator(execution).value,
      context: execution,
      unknownLimits: "try",
    });
  t.after(() => clearCoordinator(x));
  const router = make(x).bindTools([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
      },
    ]),
    prompt = new HumanMessage("Look up a value");
  const first = await router.invoke([prompt]);
  assert.equal(first.tool_calls[0].id, "call_router");
  const last = await router.invoke([
    prompt,
    first,
    new ToolMessage({ tool_call_id: "call_router", content: "Found" }),
  ]);
  assert.equal(last.content, "Pinned answer");
  assert.deepEqual(sent, ["account-0", "account-1", "account-1"]);
  const metadata = (await remote.resolve(f.bindings[0], "synthetic-model"))
    .identity;
  assert.match(metadata.routingIdentity, /^[a-f0-9]{64}$/);
  assert.equal(metadata.accessToken, undefined);
  assert.equal(metadata.identity, undefined);
  assert.equal(metadata.accountId, undefined);
  const secondProfile = await f.resources.store.read(f.bindings[1]);
  // Changing a verified identity under an existing family is rejected by the
  // store-wide claim before the router may consider account eligibility.
  await f.resources.store.write({ ...secondProfile, accountId: "account-0" });
  const duplicate = { ...x, executionId: "duplicate-accounts" };
  t.after(() => clearCoordinator(duplicate));
  await assert.rejects(
    make(duplicate).invoke("New run"),
    /already owned/,
  );
  assert.equal(sent.length, 3);
  await remote.finish(x);
});

test("Unsupported function schemas are rejected before inference and automatic reset checks", async (t) => {
  const f = await fixture(t),
    { serviceModel } = require("../dist/adapters/langchain/service-model"),
    { EmbeddedService } = require("../dist/service/embedded"),
    { DEFAULT_RECOVERY } = require("../dist/account/types");
  let resetReads = 0;
  f.resources.account.readAccount = async () => {
    resetReads++;
    throw Error("Unexpected recovery read");
  };
  const parameters = {
    type: "object",
    properties: { value: { $ref: "https://schema.invalid/value" } },
  };
  await assert.rejects(
    f.engine.respond(f.policy, {
      ...request,
      tools: [{ type: "function", name: "lookup", parameters }],
    }),
    (error) => error.status === 400 && error.param === "tools[0].parameters",
  );
  const model = serviceModel(new EmbeddedService(f.resources), f.bindings[0], {
    model: "synthetic-model",
    policy: { ...DEFAULT_RECOVERY, automatic: true },
    context: {
      instanceId: "instance",
      workflowId: "workflow",
      executionId: "execution",
      nodeId: "node",
      nodeName: "Node",
    },
  });
  await assert.rejects(
    model.invoke("Fixture", {
      tools: [{ type: "function", function: { name: "lookup", parameters } }],
    }),
    /Remote JSON schema references/,
  );
  assert.equal(resetReads, 0);
  assert.equal(f.calls.length, 0);
});

for (const failure of [
  "admission-pin",
  "terminal-commit",
  "cleanup-after-ambiguity",
])
  test(`Nonstream SDK ${failure} remains nonretryable after possible provider admission`, async (t) => {
    const { WireError } = require("../dist/gateway/errors"),
      { generateText } = require(
        path.join(process.env.CODEX_WIRE_SDK_ROOT, "ai"),
      );
    const f = await sdkFixture(t, () => {
      if (failure === "cleanup-after-ambiguity")
        throw Error("Synthetic connection lost after dispatch");
      return sseResponse([complete(output("Validated terminal answer"))]);
    });
    const capacity = () =>
      new WireError(503, "capacity", "No request was admitted.");
    const transaction = f.state.transaction.bind(f.state);
    let faultHits = 0;
    f.state.transaction = (checks, writes, release) => {
      if (
        (failure === "admission-pin" &&
          writes.some((write) => write.value?.admitted === true)) ||
        (failure === "terminal-commit" &&
          writes.some((write) => write.id.startsWith("item_cw_")))
      ) {
        faultHits++;
        throw capacity();
      }
      return transaction(checks, writes, release);
    };
    if (failure === "cleanup-after-ambiguity")
      f.state.release = async () => {
        faultHits++;
        throw capacity();
      };
    const installation = await f.app.authorization.prepareKey({
      role: "installation",
      scopes: ["context:attest"],
      installationId: "instance-fixture",
      connections: [f.policy.id],
    });
    await f.app.authorization.acknowledge(installation.deliveryId);
    const c = context();
    await assert.rejects(
      generateText({
        model: f.model,
        prompt: "Synthetic nonstream fault",
        maxRetries: 2,
        headers: {
          "x-codex-wire-context": attestContext(c, installation.key),
          "x-codex-wire-installation-key": installation.key,
        },
      }),
      (error) =>
        error.statusCode === 422 &&
        error.isRetryable === false &&
        !error.message.includes("No request was admitted"),
    );
    assert.deepEqual(f.statuses, [422]);
    assert.equal(f.calls.length, 1);
    assert.equal(faultHits, 1);
    assert.deepEqual(
      await f.state.list(f.engine.resolver.scope(f.policy.id)),
      [],
    );
  });

test("Pre-dispatch capacity remains explicitly retryable without a provider call", async (t) => {
  const { WireError } = require("../dist/gateway/errors"),
    f = await sdkFixture(t);
  f.state.reserve = async () => {
    throw new WireError(503, "capacity", "No request was admitted.");
  };
  await assert.rejects(
    f.model.doGenerate({ prompt: sdkPrompt }),
    (error) => error.statusCode === 503 && error.isRetryable === true,
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.statuses, [503]);
});

test("Protected pending setup survives a lost response and reload without new key or binding issuance", async (t) => {
  const f = await fixture(t),
    config = {
      admin: {
        origin: "https://console.invalid",
        bootstrapFile: path.join(f.dir, "bootstrap"),
      },
    };
  let app = new GatewayApplication(config, f.engine);
  const admin = await app.authorization.prepareKey({
    role: "administrator",
    scopes: ["control:*"],
  });
  await app.authorization.acknowledge(admin.deliveryId);
  const send = (route, data, key = admin.key) =>
    app.admin(
      new Request("https://console.invalid/control/v1/" + route, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + key,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
    );
  assert.equal(
    (
      await send("connections", {
        name: "Lost setup",
        mode: "fixed",
        profiles: [f.bindings[0].profileId],
        localContinuityConsent: true,
      })
    ).status,
    200,
  );
  f.resources.sessions = new AccountSessionManager(
    f.resources.store,
    {
      verify: async (tokens) => ({
        identity: {
          issuer: "https://auth.openai.com",
          subject: "new-subject",
          accountId: "new-account",
          clientId: require("../dist/core/types").CODEX_CLIENT_ID,
        },
        tokens,
      }),
      refresh: async () => {
        throw Error("No renewal");
      },
    },
    false,
  );
  app = new GatewayApplication(config, f.engine);
  assert.equal(
    (
      await send("import", {
        label: "Lost account setup",
        format: "token-set",
        session: {
          provider: "codex-subscription-experimental",
          client_id: require("../dist/core/types").CODEX_CLIENT_ID,
          access_token: "SYNTHETIC_ONLY",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      })
    ).status,
    200,
  );
  // Discard both initial response bodies. Reopen durable state and construct a fresh console.
  await f.state.close();
  await f.state.open();
  app = new GatewayApplication(config, f.engine);
  const pending = await (await send("deliveries")).json();
  assert.equal(pending.deliveries.length, 2);
  assert.equal(JSON.stringify(pending).includes("bindingSecret"), false);
  assert.equal(JSON.stringify(pending).includes("cw_"), false);
  const accountDelivery = pending.deliveries.find(
    (entry) => entry.kind === "account",
  );
  assert.equal(accountDelivery.connected, true);
  const original = await (
    await send("delivery", { id: accountDelivery.id })
  ).json();
  const repeated = await (
    await send("delivery", { id: accountDelivery.id })
  ).json();
  assert.deepEqual(repeated, original);
  assert.equal(
    (await f.resources.store.read(original.binding)).label,
    "Lost account setup",
  );
  const keyDelivery = pending.deliveries.find(
    (entry) => entry.kind === "inference",
  );
  const delivered = await (
    await send("delivery", { id: keyDelivery.id })
  ).json();
  await send("delivery/acknowledge", { id: keyDelivery.id });
  assert.equal(
    (await app.authorization.authenticate(delivered.key, "inference")).id,
    delivered.id,
  );
  assert.equal((await send("delivery", { id: keyDelivery.id })).status, 422);
  await send("delivery/acknowledge", { id: accountDelivery.id });
  assert.deepEqual((await (await send("deliveries")).json()).deliveries, []);
  const revoked = await app.authorization.prepareKey({
    role: "administrator",
    scopes: ["control:*"],
  });
  await app.authorization.revoke(revoked.id);
  assert.equal(
    (await send("delivery", { id: revoked.deliveryId })).status,
    422,
  );
  assert.deepEqual((await (await send("deliveries")).json()).deliveries, []);
  const expires = await app.authorization.prepareKey({
    role: "administrator",
    scopes: ["control:*"],
  });
  const entry = await f.state.get(
    app.authorization.owner,
    "delivery:" + expires.deliveryId,
  );
  await f.state.transaction(
    [],
    [
      {
        owner: app.authorization.owner,
        id: "delivery:" + expires.deliveryId,
        value: entry.value,
        expires: Date.now() - 1,
      },
    ],
  );
  assert.equal(
    (await send("delivery", { id: expires.deliveryId })).status,
    422,
  );
  assert.deepEqual((await (await send("deliveries")).json()).deliveries, []);
  assert.equal(
    (await send("deliveries", undefined, delivered.key)).status,
    403,
  );
  assert.equal(f.calls.length, 0);
});

test("Device shutdown waits for a committed account write before ownership transfer", async (t) => {
  const { ProfileOwner } = require("../dist/service/owner"),
    f = await fixture(t),
    entered = deferred(),
    release = deferred();
  const owner = new ProfileOwner(f.resources.store.directory),
    next = new ProfileOwner(f.resources.store.directory);
  await owner.acquire();
  f.resources.auth.deviceLogin = async () => ({
    accessToken: "SYNTHETIC_DEVICE",
    expiresAt: Date.now() + 3600000,
    scopes: [],
  });
  let committed = false;
  f.resources.sessions = new AccountSessionManager(
    f.resources.store,
    {
      verify: async (tokens) => ({
        identity: {
          issuer: "https://auth.openai.com",
          subject: "device-subject",
          accountId: "device-account",
          clientId: require("../dist/core/types").CODEX_CLIENT_ID,
        },
        tokens,
      }),
    },
    false,
  );
  const write = f.resources.store.write.bind(f.resources.store);
  f.resources.store.write = async (profile) => {
    entered.resolve();
    await release.promise;
    await write(profile);
    committed = true;
  };
  const app = new GatewayApplication(
    { admin: { bootstrapFile: path.join(f.dir, "bootstrap") } },
    f.engine,
  );
  await app.control.startDevice("Pending account");
  await entered.promise;
  let closed = false;
  const closing = app.control.close().then(async () => {
    assert.equal(committed, true);
    await owner.close();
    closed = true;
  });
  await assert.rejects(
    next.acquire(),
    (error) => error.code === "owner_conflict",
  );
  assert.equal(closed, false);
  release.resolve();
  await closing;
  await next.acquire();
  await next.close();
  await assert.rejects(
    app.control.startDevice("Late account"),
    (error) => error.code === "draining",
  );
});

function fakeHttp(t, onListen) {
  const { EventEmitter } = require("node:events"),
    servers = [];
  t.mock.method(require("node:http"), "createServer", (_, handler) => {
    const server = new EventEmitter();
    server.handler = handler;
    server.listen = () => {
      queueMicrotask(() => onListen(server, servers));
      return server;
    };
    server.close = (callback) => {
      callback();
      return server;
    };
    server.closeIdleConnections = () => {};
    server.closeAllConnections = () => {};
    servers.push(server);
    return server;
  });
  return servers;
}
function fakeRequest(body, headers = {}) {
  const { Readable, Writable } = require("node:stream");
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, {
    url: "/control/v1/import",
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    setTimeout: () => {},
  });
  const res = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  res.writeHead = (status) => {
    res.status = status;
    res.headersSent = true;
    return res;
  };
  return { req, res };
}

test("A failed second listener never admits a request on the first listener", async (t) => {
  const f = await fixture(t),
    app = new GatewayApplication(
      {
        inference: { host: "unused", port: 1 },
        admin: {
          host: "unused",
          port: 2,
          origin: "https://console.invalid",
          bootstrapFile: path.join(f.dir, "bootstrap"),
        },
      },
      f.engine,
    );
  let admitted = 0,
    attempted;
  app.inference = async () => {
    admitted++;
    return Response.json({});
  };
  fakeHttp(t, (server, servers) => {
    if (servers.length === 1) server.emit("listening");
    else {
      attempted = fakeRequest();
      servers[0].handler(attempted.req, attempted.res);
      server.emit("error", Error("Synthetic second listener failure"));
    }
  });
  await assert.rejects(
    require("../dist/gateway/server").listen(app),
    /Synthetic second listener failure/,
  );
  assert.equal(attempted.res.status, 503);
  assert.equal(admitted, 0);
  assert.equal(f.calls.length, 0);
});

test("Disconnected HTTP import keeps ownership until its real profile commit settles", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred(),
    { ProfileOwner } = require("../dist/service/owner");
  const owner = new ProfileOwner(f.resources.store.directory),
    next = new ProfileOwner(f.resources.store.directory);
  await owner.acquire();
  f.resources.sessions = new AccountSessionManager(
    f.resources.store,
    {
      verify: async (tokens) => ({
        identity: {
          issuer: "https://auth.openai.com",
          subject: "import-subject",
          accountId: "import-account",
          clientId: require("../dist/core/types").CODEX_CLIENT_ID,
        },
        tokens,
      }),
    },
    false,
  );
  const write = f.resources.store.write.bind(f.resources.store);
  let committed = false;
  f.resources.store.write = async (profile) => {
    entered.resolve();
    await release.promise;
    await write(profile);
    committed = true;
  };
  const app = new GatewayApplication(
    {
      inference: { host: "unused", port: 1 },
      admin: {
        host: "unused",
        port: 2,
        origin: "https://console.invalid",
        bootstrapFile: path.join(f.dir, "bootstrap"),
      },
    },
    f.engine,
  );
  const admin = await app.authorization.prepareKey({
    role: "administrator",
    scopes: ["control:*"],
  });
  await app.authorization.acknowledge(admin.deliveryId);
  const servers = fakeHttp(t, (server) => server.emit("listening")),
    listener = await require("../dist/gateway/server").listen(app);
  const { req, res } = fakeRequest(
    {
      label: "Disconnected import",
      format: "token-set",
      session: {
        provider: "codex-subscription-experimental",
        client_id: require("../dist/core/types").CODEX_CLIENT_ID,
        access_token: "SYNTHETIC_ONLY",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
    { authorization: "Bearer " + admin.key },
  );
  servers[1].handler(req, res);
  await entered.promise;
  res.destroy();
  let closed = false;
  const closing = listener.close().then(async () => {
    assert.equal(committed, true);
    await owner.close();
    closed = true;
  });
  await assert.rejects(
    next.acquire(),
    (error) => error.code === "owner_conflict",
  );
  assert.equal(closed, false);
  release.resolve();
  await closing;
  await next.acquire();
  await next.close();
});

test("Unsettled device shutdown retains an explicit owner fence", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred(),
    { ProfileOwner } = require("../dist/service/owner");
  const owner = new ProfileOwner(f.resources.store.directory),
    next = new ProfileOwner(f.resources.store.directory);
  await owner.acquire();
  f.resources.auth.deviceLogin = async () => {
    entered.resolve();
    await release.promise;
    throw Error("Synthetic cancelled device login");
  };
  const app = new GatewayApplication(
    { admin: { bootstrapFile: path.join(f.dir, "bootstrap") } },
    f.engine,
  );
  await app.control.startDevice("Uncooperative device");
  await entered.promise;
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(app.control.close(10), /preserve the owner fence/);
  clearTimeout(keepAlive);
  owner.preserveFence();
  await assert.rejects(
    next.acquire(),
    (error) => error.code === "owner_conflict",
  );
  release.resolve();
  await app.control.close();
  await owner.close();
  await next.acquire();
  await next.close();
});

test("Native and Responses admissions share the two-call bound across duplicate account profiles", async (t) => {
  const gates = [deferred(), deferred(), deferred()],
    two = deferred(),
    third = deferred();
  let active = 0,
    peak = 0;
  const f = await fixture(
    t,
    async (_, init, count) => {
      active++;
      peak = Math.max(peak, active);
      if (count === 2) two.resolve();
      if (count === 3) third.resolve();
      await gates[count - 1].promise;
      active--;
      return sseResponse([complete(output("Bounded answer"))]);
    },
    2,
  );
  await f.resources.store.write({
    ...(await f.resources.store.read(f.bindings[1])),
    accountId: "account-0",
  });
  const app = new GatewayApplication(
      { admin: { bootstrapFile: path.join(f.dir, "bootstrap") } },
      f.engine,
    ),
    key = await app.authorization.prepareKey({
      role: "installation",
      scopes: ["native:*"],
      installationId: "instance-fixture",
      profiles: f.policy.profiles,
    });
  await app.authorization.acknowledge(key.deliveryId);
  const keyFile = path.join(f.dir, "mixed.key");
  await fs.writeFile(keyFile, key.key, { mode: 0o600 });
  const { RemoteService } = require("../dist/service/remote"),
    { canonicalRequest } = require("../dist/kernel/request"),
    remote = new RemoteService(
      "https://gateway.invalid",
      keyFile,
      (url, init) => app.inference(new Request(url, init)),
    );
  const model = (await remote.resolve(f.bindings[1], "synthetic-model")).model,
    settings = { maxRetries: 0, timeoutMs: 10000, idleTimeoutMs: 10000 },
    input = canonicalRequest(
      {
        model: model.slug,
        input: [
          { type: "message", role: "user", content: "Native mixed call" },
        ],
        tools: [],
        settings,
      },
      model,
    );
  const responses = f.bindings.map((binding) =>
    f.engine.respond(
      { ...f.policy, mode: "fixed", profiles: [binding.profileId] },
      request,
    ),
  );
  await two.promise;
  const acquire = f.engine.queue.acquire.bind(f.engine.queue),
    queued = deferred();
  f.engine.queue.acquire = (...args) => {
    queued.resolve();
    return acquire(...args);
  };
  const native = (async () => {
    for await (const event of remote.generate(f.bindings[1], {
      request: input,
      settings,
      lite: false,
      context: {
        instanceId: "instance-fixture",
        workflowId: "mixed",
        executionId: "mixed",
        nodeId: "mixed",
        nodeName: "Mixed",
      },
    }))
      assert(["completed", "text"].includes(event.kind));
  })();
  await queued.promise;
  assert.equal(f.calls.length, 2);
  assert.equal(f.engine.queue.activeCount, 2);
  gates[0].resolve();
  await third.promise;
  assert.equal(peak, 2);
  gates[1].resolve();
  gates[2].resolve();
  await Promise.all([...responses, native]);
  await app.settle();
  assert.equal(f.calls.length, 3);
  assert.equal(f.engine.queue.activeCount, 0);
});

test("Quota fallback does not retry the same verified account through another profile", async (t) => {
  const f = await fixture(
    t,
    (_, init) =>
      new Headers(init.headers).get("chatgpt-account-id") === "account-0"
        ? new Response(null, { status: 429 })
        : sseResponse([complete(output("Distinct fallback"))]),
    3,
  );
  await f.resources.store.write({
    ...(await f.resources.store.read(f.bindings[1])),
    accountId: "account-0",
  });
  f.resources.account = new AccountReader(f.resources.sessions, async () =>
    Response.json({
      account_id: "account-0",
      rate_limit_reached_type: { type: "rate_limit_reached" },
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 3600,
          reset_after_seconds: 3600,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    }),
  );
  await f.engine.respond(f.policy, request, context());
  assert.deepEqual(
    f.calls.map((call) =>
      new Headers(call.init.headers).get("chatgpt-account-id"),
    ),
    ["account-0", "account-2"],
  );
});

test("Stateless tool and direct-output schemas never share retained validators or argument errors", async (t) => {
  const structured = require("../dist/kernel/structured"),
    original = structured.validator;
  t.after(() => {
    structured.validator = original;
  });
  for (const mode of ["tool", "direct"]) {
    const schema = {
      type: "object",
      description: `Private ${mode} request description`,
      properties: { value: { type: "number", default: 7 } },
      required: ["value"],
      additionalProperties: false,
    };
    const shared = original(schema),
      captured = new Set();
    assert.equal(shared({ value: 1 }), true);
    structured.validator = (value) => {
      const validate = original(value);
      if (value.description === schema.description) captured.add(validate);
      return validate;
    };
    const gate = deferred();
    const f = await fixture(t, async (_, __, call) => {
      if (call === 2) gate.resolve();
      await gate.promise;
      const args = JSON.stringify(
        call === 1
          ? { value: 1 }
          : { value: 1, private_argument_property: "private value" },
      );
      return sseResponse([
        complete(
          mode === "direct"
            ? output(args)
            : output("", {
                output: [
                  {
                    type: "function_call",
                    id: `fc_${call}`,
                    call_id: `call_${call}`,
                    name: "lookup",
                    arguments: args,
                    status: "completed",
                  },
                ],
              }),
        ),
      ]);
    });
    const raw = {
      ...request,
      store: false,
      ...(mode === "tool"
        ? { tools: [{ type: "function", name: "lookup", parameters: schema }] }
        : {
            text: {
              format: {
                type: "json_schema",
                name: "private_output",
                schema,
                strict: true,
              },
            },
          }),
    };
    const results = await Promise.allSettled([
      f.engine.respond(f.policy, raw),
      f.engine.respond(f.policy, raw),
    ]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ["fulfilled", "rejected"],
    );
    assert.equal(results.find((result) => result.status === "rejected").reason.status, 422);
    assert.equal(
      captured.size,
      2,
      "Each overlapping request must own one isolated compiled validator",
    );
    assert(!captured.has(shared));
    assert.equal(
      shared.errors,
      null,
      "Private argument errors must not reach the shared cache",
    );
    assert.equal(
      original(schema),
      shared,
      "Normal/native cache reuse remains unchanged",
    );
    assert.equal(
      (await f.state.list(f.state.scope("history", f.policy.id), 10)).length,
      0,
    );
  }
});

test("Quota exhaustion remains truthful when the final pool profile duplicates an exhausted account", async (t) => {
  const f = await fixture(t, () => new Response(null, { status: 429 }), 2);
  await f.resources.store.write({
    ...(await f.resources.store.read(f.bindings[1])),
    accountId: "account-0",
  });
  f.resources.account = new AccountReader(f.resources.sessions, async () =>
    Response.json({
      account_id: "account-0",
      rate_limit_reached_type: { type: "rate_limit_reached" },
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 3600,
          reset_after_seconds: 3600,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    }),
  );
  await assert.rejects(
    f.engine.respond(f.policy, request, context()),
    (error) => error.status === 429 && error.code === "accounts_exhausted",
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.state.list(f.state.scope("pins", f.policy.id), 10)).length,
    0,
  );
});

test("Protected operator limits govern admission, state capacity, history expiry and console disclosure", async (t) => {
  const f = await fixture(t),
    { loadConfig, gatewayTuning } = require("../dist/gateway/config");
  const config = {
    version: 1,
    inference: {
      host: "127.0.0.1",
      port: 8787,
      privateHttp: true,
      origin: "https://gateway.invalid",
    },
    admin: {
      host: "127.0.0.1",
      port: 8788,
      origin: "https://console.invalid",
      bootstrapFile: path.join(f.dir, "bootstrap"),
    },
    storeDirectory: f.resources.store.directory,
    masterKeyFile: path.join(f.dir, "key"),
    stateFile: path.join(f.dir, "tuned", "gateway.db"),
    retention: { idleDays: 2, absoluteDays: 3 },
    admission: { active: 2, account: 1, queued: 0, waitMs: 100 },
    stateLimits: {
      globalBytes: 64 * 1024 ** 2,
      connectionBytes: 32 * 1024 ** 2,
    },
  };
  const file = path.join(f.dir, "operator.json");
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const loaded = await loadConfig(file),
    tuning = gatewayTuning(loaded);
  const state = new StateRepository(
    config.stateFile,
    f.key,
    tuning.state,
    tuning.retention,
  );
  await state.open();
  try {
    const engine = new GatewayEngine(f.resources, state, true, tuning),
      { accountIdentityKey } = require("../dist/core/affinity");
    const release = await engine.queue.acquire(
      accountIdentityKey(await f.resources.store.read(f.bindings[0])),
      null,
    );
    await assert.rejects(
      engine.respond(f.policy, request),
      (error) => error.code === "queue_full" && error.status === 429,
    );
    assert.equal(f.calls.length, 0);
    release();
    const result = await engine.respond(f.policy, request),
      id = result.body.output[0].id,
      owner = engine.resolver.scope(f.policy.id);
    const record = await state.get(owner, id);
    assert(Math.abs(record.expires - Date.now() - 2 * 86400000) < 1000);
    await state.reserve("first-owner", "one", 20 * 1024 ** 2);
    await assert.rejects(
      state.reserve("first-owner", "two", 13 * 1024 ** 2),
      (error) => error.code === "capacity",
    );
    await state.reserve("second-owner", "one", 20 * 1024 ** 2);
    await state.reserve("third-owner", "one", 20 * 1024 ** 2);
    await assert.rejects(
      state.reserve("fourth-owner", "one", 5 * 1024 ** 2),
      (error) => error.code === "capacity",
    );
    const app = new GatewayApplication(loaded, engine),
      key = await app.authorization.prepareKey({
        role: "administrator",
        scopes: ["control:*"],
      });
    await app.authorization.acknowledge(key.deliveryId);
    const status = await app.admin(
      new Request("https://console.invalid/control/v1/activity", {
        headers: { authorization: "Bearer " + key.key },
      }),
    );
    assert.equal(status.status, 200);
    const activity = await status.json();
    assert.deepEqual(activity.retention, {
      idleDays: 2,
      absoluteDays: 3,
      operationHours: 48,
    });
    assert.deepEqual(activity.limits, {
      admission: tuning.admission,
      state: {
        globalBytes: tuning.state.globalBytes,
        connectionBytes: tuning.state.ownerBytes,
      },
    });
    await state.cleanup(record.expires + 1);
    await assert.rejects(
      engine.respond(f.policy, {
        ...request,
        input: [{ type: "item_reference", id }],
      }),
      (error) => error.code === "history_expired",
    );
    assert.equal(f.calls.length, 1);
  } finally {
    await state.close();
  }
  for (const invalid of [
    { retention: { idleDays: 1 } },
    { retention: { idleDays: 31 } },
    { retention: { absoluteDays: 91 } },
    { retention: { idleDays: 3, absoluteDays: 2 } },
    { admission: { active: 9 } },
    { admission: { account: 3 } },
    { admission: { active: 1, account: 2 } },
    { admission: { queued: -1 } },
    { admission: { waitMs: 10001 } },
    { stateLimits: { globalBytes: 2 ** 31 } },
    {
      stateLimits: {
        globalBytes: 32 * 1024 ** 2,
        connectionBytes: 64 * 1024 ** 2,
      },
    },
    { retention: [] },
    { retention: null },
    { admission: { queued: null } },
    { admission: { constructor: 1 } },
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...config, ...invalid }));
    await assert.rejects(loadConfig(file), /Gateway|gateway/);
  }
  assert.deepEqual(gatewayTuning(), {
    retention: { idleDays: 30, absoluteDays: 90 },
    admission: { active: 8, account: 2, queued: 64, waitMs: 10000 },
    state: { globalBytes: 1024 ** 3, ownerBytes: 256 * 1024 ** 2 },
  });
});

test("Shorter retention on restart clamps existing item and call history without shortening operation fences", async (t) => {
  const f = await fixture(t),
    { DatabaseSync } = require("node:sqlite"),
    file = path.join(f.dir, "retention", "gateway.db");
  let state = new StateRepository(file, f.key);
  await state.open();
  const now = Date.now(),
    owner = state.scope("history", "fixture"),
    operationOwner = state.scope("operations", "fixture");
  await state.transaction(
    [],
    [
      {
        owner,
        id: "item_cw_old",
        value: { content: "Synthetic retained item" },
        expires: now + 30 * 86400000,
      },
      {
        owner,
        id: "call:call_cw_old",
        value: { content: "Synthetic retained call" },
        expires: now + 30 * 86400000,
      },
      {
        owner,
        id: "item_cw_recent",
        value: { content: "Recent" },
        expires: now + 30 * 86400000,
      },
      {
        owner: operationOwner,
        id: "operation-fence",
        value: { state: "unknown" },
        expires: now + 48 * 3600000,
      },
    ],
  );
  const recent = await state.get(owner, "item_cw_recent");
  await state.close();
  const db = new DatabaseSync(file);
  db.prepare(
    "UPDATE records SET created=?,touched=? WHERE id IN ('item_cw_old','call:call_cw_old')",
  ).run(now - 4 * 86400000, now - 4 * 86400000);
  db.close();
  state = new StateRepository(file, f.key, undefined, {
    idleDays: 2,
    absoluteDays: 3,
  });
  await state.open();
  try {
    assert.equal(await state.get(owner, "item_cw_old"), null);
    assert.equal(await state.get(owner, "call:call_cw_old"), null);
    assert.equal(
      (await state.get(owner, "item_cw_recent")).expires,
      recent.touched + 2 * 86400000,
    );
    assert.equal(
      (await state.get(operationOwner, "operation-fence")).expires,
      now + 48 * 3600000,
    );
  } finally {
    await state.close();
  }
});

test("Connection capacity aggregates committed history, replay results and active reservations across restart", async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, async (_, __, call) => {
    if (call === 1) {
      entered.resolve();
      await release.promise;
    }
    return sseResponse([complete(output("x".repeat(700000)))]);
  });
  const { gatewayTuning } = require("../dist/gateway/config"),
    { DatabaseSync } = require("node:sqlite"),
    tuning = gatewayTuning({
      stateLimits: {
        globalBytes: 64 * 1024 ** 2,
        connectionBytes: 32 * 1024 ** 2,
      },
    }),
    file = path.join(f.dir, "aggregate", "gateway.db"),
    firstContext = context();
  let state = new StateRepository(file, f.key, tuning.state, tuning.retention);
  await state.open();
  try {
    let engine = new GatewayEngine(f.resources, state, true, tuning);
    const pending = engine.respond(f.policy, request, firstContext);
    await entered.promise;
    // Queue plus the full provider deadline must not expire an active reservation.
    await state.cleanup(Date.now() + 310000);
    await assert.rejects(
      state.reserve(
        engine.resolver.scope(f.policy.id),
        "competing",
        17 * 1024 ** 2,
      ),
      (error) => error.code === "capacity",
    );
    release.resolve();
    const first = await pending;
    let rejected = false;
    for (let round = 0; round < 20; round++) {
      try {
        await engine.respond(f.policy, request, context());
      } catch (error) {
        assert.equal(error.code, "capacity");
        assert.equal(error.status, 503);
        rejected = true;
        break;
      }
    }
    assert(
      rejected,
      "Combined content plus reservation must reach the connection bound",
    );
    const calls = f.calls.length;
    assert(calls > 5 && calls < 20);
    const db = new DatabaseSync(file, { readOnly: true });
    const totals = db
      .prepare(
        "SELECT owner,sum(bytes) bytes FROM records WHERE owner IN (?,?) GROUP BY owner",
      )
      .all(
        engine.resolver.scope(f.policy.id),
        state.scope("operations", f.policy.id),
      );
    db.close();
    assert.equal(totals.length, 2);
    assert(totals.every((row) => Number(row.bytes) < 16 * 1024 ** 2));
    assert(
      totals.reduce((sum, row) => sum + Number(row.bytes), 0) + 16 * 1024 ** 2 >
        tuning.state.ownerBytes,
    );
    await state.close();
    state = new StateRepository(file, f.key, tuning.state, tuning.retention);
    await state.open();
    engine = new GatewayEngine(f.resources, state, true, tuning);
    const replay = await engine.respond(f.policy, request, firstContext);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    await assert.rejects(
      engine.respond(f.policy, request, context()),
      (error) => error.code === "capacity",
    );
    assert.equal(f.calls.length, calls);
  } finally {
    release.resolve();
    await state.close();
  }
});

for (const status of [429, 500])
  test(`Observed HTTP ${status} error preserves its evidence and a durable no-redispatch fence`, async (t) => {
    const f = await fixture(t, () =>
      Response.json({ error: { message: "Synthetic rejection" } }, { status }),
    );
    if (status === 429)
      f.resources.account.readAccount = async () => ({
        routing: { decision: "quota_exhausted" },
      });
    const c = context();
    await assert.rejects(f.engine.respond(f.policy, request, c), (error) =>
      status === 429
        ? error.accepted === false
        : error.code === "provider_rejected",
    );
    const records = await f.state.list(
      f.state.scope("operations", f.policy.id),
    );
    assert.equal(records.length, 1);
    assert.equal(
      records[0].value.state,
      status === 429 ? "rejected" : "unknown",
    );
    await assert.rejects(
      f.engine.respond(f.policy, request, c),
      (error) =>
        error.code ===
        (status === 429 ? "operation_rejected" : "outcome_unknown"),
    );
    assert.equal(f.calls.length, 1);
  });

for (const initialLite of [false, true]) {
  test(`Retained same-model ${initialLite ? "Lite to Standard" : "Standard to Lite"} history and completed replay fail closed across restart`, async (t) => {
    const f = await fixture(t, () => sseResponse([complete(output("", {
      output: [
        { type: "reasoning", id: "rs_route", summary: [], encrypted_content: "SYNTHETIC_OPAQUE_ROUTE" },
        { type: "function_call", id: "fc_route", call_id: "provider_call_route", name: "lookup", arguments: '{"value":1}', status: "completed" },
      ],
    }))]));
    const setRoute = (lite) => {
      f.resources.catalog = new ModelCatalog(async () => Response.json({ models: [rawModel({ use_responses_lite: lite })] }));
    };
    setRoute(initialLite);
    const body = { ...request, tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { value: { type: "number" } } } }] };
    const c = context(), first = await f.engine.respond(f.policy, body, c);
    const replay = await f.engine.respond(f.policy, body, c);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    assert.equal(f.calls.length, 1);
    const [reasoning, call] = first.body.output;
    const inputs = [
      [{ type: "item_reference", id: reasoning.id }],
      [reasoning],
      [{ type: "item_reference", id: call.id }, { type: "function_call_output", call_id: call.call_id, output: "Done" }],
      [call, { type: "function_call_output", call_id: call.call_id, output: "Done" }],
      [{ ...call, id: undefined }, { type: "function_call_output", call_id: call.call_id, output: "Done" }],
    ];
    // The same route resolves both item IDs and call-only mappings to provider identities.
    for (const input of inputs) {
      await f.engine.respond(f.policy, { ...body, input }, context());
      const sent = JSON.parse(f.calls.at(-1).init.body);
      const toolResult = sent.input.find((item) => item.type === "function_call_output");
      if (toolResult) assert.equal(toolResult.call_id, "provider_call_route");
    }
    const before = f.calls.length;
    await f.state.close();
    await f.state.open();
    f.engine = new GatewayEngine(f.resources, f.state, true);
    setRoute(!initialLite);
    for (const input of inputs)
      await assert.rejects(f.engine.respond(f.policy, { ...body, input }, context()), (e) => e.status === 422 && e.code === "history_conflict");
    // A duplicate first request has no input references: its retained response must still be scoped.
    await assert.rejects(f.engine.respond(f.policy, body, c), (e) => e.status === 422 && e.code === "history_conflict");
    assert.equal(f.calls.length, before);
    setRoute(initialLite);
    assert.deepEqual((await f.engine.respond(f.policy, body, c)).body, first.body);
    assert.equal(f.calls.length, before);
    const historyOwner = f.engine.resolver.scope(f.policy.id);
    for (const id of [reasoning.id, call.id, `call:${call.call_id}`]) {
      const entry = await f.state.get(historyOwner, id);
      assert.equal(entry.value.codec, initialLite ? "responses-lite-v1" : "responses-v1");
      delete entry.value.codec;
      await f.state.transaction([], [{ owner: historyOwner, id, value: entry.value, expires: entry.expires }]);
    }
    const operationOwner = f.state.scope("operations", f.policy.id), operationId = f.state.scope(c.operationId);
    const operation = await f.state.get(operationOwner, operationId);
    delete operation.value.responseScope;
    await f.state.transaction([], [{ owner: operationOwner, id: operationId, value: operation.value, expires: operation.expires }]);
    await f.state.close();
    await f.state.open();
    for (const input of inputs)
      await assert.rejects(f.engine.respond(f.policy, { ...body, input }, context()), (e) => e.code === "history_scope_unproven");
    await assert.rejects(f.engine.respond(f.policy, body, c), (e) => e.code === "history_scope_unproven");
    assert.equal(f.calls.length, before);
    // Explicitly independent input is usable; legacy records are retained, never guessed or migrated.
    await f.engine.respond(f.policy, body, context({ conversationId: "fresh-route-conversation" }));
    assert.equal(f.calls.length, before + 1);
  });
}

test("store:false cannot turn retained public item/call handles into unscoped inline provider history", async (t) => {
  const f = await fixture(t);
  for (const input of [
    [{ type: "item_reference", id: "item_cw_legacy" }],
    [{ type: "message", id: "item_cw_legacy", role: "assistant", content: "Old output" }],
    [{ type: "function_call", call_id: "call_cw_legacy", name: "lookup", arguments: "{}" }, { type: "function_call_output", call_id: "call_cw_legacy", output: "Old result" }],
  ])
    await assert.rejects(f.engine.respond(f.policy, { ...request, store: false, input }), (e) => e.code === "stored_dependency");
  assert.equal(f.calls.length, 0);
});

test("Concurrent device starts reserve capacity before preparation; only fully settled statuses can be evicted", async (t) => {
  const f = await fixture(t), { GatewayAuthorization } = require("../dist/gateway/auth"), { GatewayControl } = require("../dist/gateway/control");
  const gates = [];
  f.resources.auth.deviceLogin = async () => new Promise((resolve, reject) => gates.push({ resolve, reject }));
  const control = new GatewayControl(f.resources, f.state, new GatewayAuthorization(f.state), true);
  const starts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => control.startDevice(`Device ${i}`)));
  assert.equal(starts.filter((s) => s.status === "fulfilled").length, 8);
  assert.equal(starts.filter((s) => s.status === "rejected" && s.reason.code === "device_capacity").length, 4);
  assert.equal(gates.length, 8);
  const first = starts[0].value;
  control.cancelDevice(first.id);
  await assert.rejects(control.startDevice("Ninth"), (e) => e.code === "device_capacity");
  gates[0].reject(Error("Synthetic cancelled work settled"));
  await new Promise((resolve) => setImmediate(resolve));
  const next = await control.startDevice("Ninth");
  assert.equal(next.state, "waiting");
  assert.throws(() => control.device(first.id), (e) => e.code === "device_expired");
  assert.ok(await control.delivery(first.deliveryId), "Evicting UI status preserves the independent encrypted pending binding");
  assert.equal((await control.pendingDeliveries()).deliveries.length, 9);
  for (const gate of gates) gate.reject(Error("Synthetic finished"));
  await control.close();
});

test("More than eight sequential completed device logins preserve pending delivery while bounding statuses", async (t) => {
  const f = await fixture(t), { GatewayAuthorization } = require("../dist/gateway/auth"), { GatewayControl } = require("../dist/gateway/control"), { identity } = require("./helpers.cjs");
  let count = 0;
  f.resources.auth.deviceLogin = async () => ({ accessToken: "SYNTHETIC_DEVICE_" + (++count), expiresAt: Date.now() + 3600000, scopes: [] });
  f.resources.sessions = new AccountSessionManager(f.resources.store, { verify: async (tokens) => ({ identity: identity(tokens.accessToken), tokens }) }, false);
  const control = new GatewayControl(f.resources, f.state, new GatewayAuthorization(f.state), true), attempts = [];
  for (let i = 0; i < 12; i++) {
    const attempt = await control.startDevice(`Sequential ${i}`);
    attempts.push(attempt);
    for (let wait = 0; wait < 100 && control.device(attempt.id).state === "waiting"; wait++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(control.device(attempt.id).state, "connected");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(count, 12);
  assert.throws(() => control.device(attempts[0].id), (e) => e.code === "device_expired");
  const binding = (await control.delivery(attempts[0].deliveryId)).binding;
  assert.ok(await f.resources.store.read(binding));
  assert.equal((await control.pendingDeliveries()).deliveries.length, 12);
  await control.close();
});

test("Device preparation failure releases its slot and shutdown joins a pending durable preparation", async (t) => {
  const f = await fixture(t), { GatewayAuthorization } = require("../dist/gateway/auth"), { GatewayControl } = require("../dist/gateway/control");
  let authCalls = 0;
  f.resources.auth.deviceLogin = async () => { authCalls++; throw Error("Synthetic auth stopped"); };
  const control = new GatewayControl(f.resources, f.state, new GatewayAuthorization(f.state), true);
  // Invalid labels fail during preparation, before auth and without retaining a slot.
  for (let i = 0; i < 12; i++) await assert.rejects(control.startDevice(""));
  const entered = deferred(), release = deferred(), transaction = f.state.transaction.bind(f.state);
  t.after(() => release.resolve());
  f.state.transaction = async (...args) => { entered.resolve(); await release.promise; return transaction(...args); };
  const start = control.startDevice("Interrupted preparation");
  await entered.promise;
  let closed = false;
  const close = control.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  await assert.rejects(start, (e) => e.code === "draining");
  await close;
  assert.equal(authCalls, 0);
  assert.equal((await control.pendingDeliveries()).deliveries.length, 1);
});

async function socketFixture(t, respond, tuning) {
  const http = require("node:http"),
    originalCreate = http.createServer,
    servers = [],
    f = await fixture(t, respond, 2, tuning);
  t.mock.method(http, "createServer", (...args) => {
    const server = originalCreate(...args);
    servers.push(server);
    return server;
  });
  const app = new GatewayApplication(
    {
      inference: { host: "127.0.0.1", port: 0 },
      admin: {
        host: "127.0.0.1", port: 0, origin: "https://console.invalid",
        bootstrapFile: path.join(f.dir, "bootstrap"),
      },
    },
    f.engine,
  );
  await app.authorization.savePolicy({ ...f.policy, mode: "fixed", profiles: [f.bindings[0].profileId] });
  const keys = {};
  for (const role of ["inference", "administrator"]) {
    const delivery = await app.authorization.prepareKey(
      role === "inference"
        ? { role, scopes: ["models", "responses"], connectionId: f.policy.id }
        : { role, scopes: ["control:*"] },
    );
    await app.authorization.acknowledge(delivery.deliveryId);
    keys[role] = delivery.key;
  }
  const listener = await require("../dist/gateway/server").listen(app);
  const send = (route, bytes, options = {}) => {
    let active;
    const done = new Promise((resolve, reject) => {
      active = http.request({
        host: "127.0.0.1",
        port: servers[options.admin ? 1 : 0].address().port,
        path: route, method: "POST",
        headers: {
          host: options.admin ? "console.invalid" : "gateway.internal",
          authorization: "Bearer " + keys[options.admin ? "administrator" : "inference"],
          "content-type": options.type || "application/json",
          ...(options.chunked ? {} : { "content-length": options.declared ?? bytes.length }),
        },
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      });
      active.on("error", reject);
      active.setTimeout(10000, () => active.destroy(Error("Synthetic socket test deadline")));
      if (options.partial) active.write(bytes);
      else void (async () => {
        const { once } = require("node:events");
        let offset = 0;
        for (const length of [1, 2, 3, 5, 7]) {
          if (offset >= bytes.length) break;
          if (!active.write(bytes.subarray(offset, offset + length))) await once(active, "drain");
          offset += length;
        }
        while (offset < bytes.length) {
          const end = Math.min(offset + 16381, bytes.length);
          if (!active.write(bytes.subarray(offset, end))) await once(active, "drain");
          offset = end;
        }
        active.end();
      })().catch(error => active.destroy(error));
    });
    done.catch(() => {});
    return { done, abort: () => active.destroy(Error("Synthetic ingress abort")) };
  };
  return { ...f, app, send, close: () => listener.close() };
}
async function awaitCondition(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert(Date.now() < deadline, "Bounded socket progress deadline");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("Real HTTP ingress preserves multi-chunk Unicode while a response holds its memory lease", async t => {
  const entered = deferred(), release = deferred();
  const f = await socketFixture(t, async (_, init, count) => {
    if (count !== 1) return sseResponse([complete(output("Second answer"))]);
    entered.resolve();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": admitted hold\n\n"));
        void release.promise.then(() => {
          const bytes = sseResponse([complete(output("First answer"))]);
          return bytes.arrayBuffer();
        }).then(bytes => { controller.enqueue(new Uint8Array(bytes)); controller.close(); });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const text = "Unicode boundary: Привет 世界 🙂 / exact history. ".repeat(12000),
      first = f.send("/v1/responses", Buffer.from(JSON.stringify({ model: "synthetic-model", input: text, store: false, stream: true })), { chunked: true }),
      { gatewayMemory } = require("../dist/gateway/pool/memory");
    await entered.promise;
    assert.equal(JSON.parse(f.calls[0].init.body).input[0].content[0].text, text);
    assert(gatewayMemory.reservedBytes > 0);
    const second = await f.send("/v1/responses", Buffer.from(JSON.stringify({ model: "synthetic-model", input: "Second exact input", store: false }))).done;
    assert.equal(second.status, 200);
    assert.equal(f.calls.length, 2);
    assert(gatewayMemory.reservedBytes > 0, "First streaming response still owns its lease");
    release.resolve();
    const result = await first.done;
    assert.equal(result.status, 200);
    assert(result.text.includes("First answer"));
    await awaitCondition(() => gatewayMemory.reservedBytes === 0);
    const control = await f.send("/control/v1/connections", Buffer.from(JSON.stringify({ name: "Unicode pool 世界", mode: "fixed", profiles: [f.bindings[0].profileId], allowedModels: [], installationId: "instance-fixture", localContinuityConsent: true })), { admin: true }).done;
    assert.equal(control.status, 200);
    assert.equal(JSON.parse(control.text).connection.name, "Unicode pool 世界");
    assert.equal(f.calls.length, 2);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("Real HTTP ingress rejects malformed or oversized bodies and recovers an aborted lease", async t => {
  const f = await socketFixture(t);
  try {
    const { gatewayMemory } = require("../dist/gateway/pool/memory");
    for (const [bytes, options, status] of [
      [Buffer.from("not-json"), {}, 400],
      [Buffer.from("{}"), { type: "text/plain" }, 400],
      [Buffer.from("{}"), { declared: 32 * 1024 * 1024 + 1 }, 413],
      [Buffer.alloc(512 * 1024 + 1, 32), { admin: true }, 413],
    ]) {
      const result = await f.send(options.admin ? "/control/v1/connections" : "/v1/responses", bytes, options).done;
      assert.equal(result.status, status);
      await awaitCondition(() => gatewayMemory.reservedBytes === 0);
    }
    assert.equal(f.calls.length, 0);
    const partial = f.send("/v1/responses", Buffer.from('{"model":"synthetic-model","input":"unfinished'), { declared: 1024 * 1024, partial: true });
    await awaitCondition(() => gatewayMemory.reservedBytes > 0);
    partial.abort();
    await assert.rejects(partial.done, /Synthetic ingress abort/);
    await awaitCondition(() => gatewayMemory.reservedBytes === 0);
    assert.equal(f.calls.length, 0);
    const valid = await f.send("/v1/responses", Buffer.from(JSON.stringify({ model: "synthetic-model", input: "Progress after abort", store: false }))).done;
    assert.equal(valid.status, 200);
    assert.equal(f.calls.length, 1);
    await awaitCondition(() => gatewayMemory.reservedBytes === 0);
  } finally { await f.close(); }
});

for (const queued of [0, 1]) test(`Real HTTP listeners share the configured pending limit ${queued}`, async t => {
  const { gatewayTuning } = require("../dist/gateway/config"),
    { gatewayMemory } = require("../dist/gateway/pool/memory"),
    { accountIdentityKey } = require("../dist/core/affinity"),
    tuning = gatewayTuning({ admission: { active: 1, account: 1, queued, waitMs: 1000 } }),
    f = await socketFixture(t, undefined, tuning),
    account = accountIdentityKey(await f.resources.store.read(f.bindings[0])),
    active = await f.engine.queue.acquire(account, null),
    abort = new AbortController(),
    broker = queued ? f.engine.queue.acquire(account, null, abort.signal) : undefined,
    input = Buffer.from(JSON.stringify({ model: "synthetic-model", input: "Configured queue control", store: false })),
    control = Buffer.from(JSON.stringify({ name: "Immediate control", mode: "fixed", profiles: [f.bindings[0].profileId], allowedModels: [], installationId: "instance-fixture", localContinuityConsent: true }));
  let occupied, remaining;
  broker?.catch(() => {});
  try {
    assert.equal(f.engine.queue.pending.count, queued);
    occupied = gatewayMemory.tryAcquireBytes(310 * 1024 * 1024);
    const inference = await f.send("/v1/responses", input).done;
    assert.equal(inference.status, 429);
    assert.equal(JSON.parse(inference.text).error.code, "memory_queue_full");
    assert.equal(f.engine.queue.pending.count, queued);
    const immediate = await f.send("/control/v1/connections", control, { admin: true }).done;
    assert.equal(immediate.status, 200, "Control work fitting memory must not require a pending permit");
    assert.equal(f.engine.queue.pending.count, queued);
    remaining = gatewayMemory.tryAcquireBytes(10 * 1024 * 1024);
    const admin = await f.send("/control/v1/connections", control, { admin: true }).done;
    assert.equal(admin.status, 429);
    assert.equal(JSON.parse(admin.text).error.code, "memory_queue_full");
    assert.equal(f.engine.queue.pending.count, queued);
    abort.abort();
    if (broker) await assert.rejects(broker, error => error.code === "cancelled");
    assert.equal(f.engine.queue.pending.count, 0);
    const started = Date.now(),
      timeout = await f.send("/v1/responses", input).done;
    assert.equal(timeout.status, 429);
    assert.equal(JSON.parse(timeout.text).error.code, "memory_queue_full");
    assert(Date.now() - started < 2000, "Both listeners must respect the reduced configured wait deadline");
    assert.equal(f.engine.queue.pending.count, 0);
    assert.equal(gatewayMemory.queuedRequests, 0);
    assert.equal(f.calls.length, 0);
    remaining(); remaining = undefined;
    occupied(); occupied = undefined;
    active();
    const progress = await f.send("/v1/responses", input).done;
    assert.equal(progress.status, 200);
    assert(progress.text.includes("Fixture answer"));
    assert.equal(f.calls.length, 1);
    await awaitCondition(() => gatewayMemory.reservedBytes === 0);
    assert.equal(f.engine.queue.pending.count, 0);
  } finally {
    abort.abort();
    if (broker) await Promise.allSettled([broker]);
    remaining?.();
    occupied?.();
    active();
    await f.close();
  }
});
