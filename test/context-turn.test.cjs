"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const integration = require("../dist/integration/n8n-context");
const { atomicWrite } = require("../dist/auth/store");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test("Matched gateway turn validation owns bounded independent model-call frames", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-turn-"));
  const prior = process.env.N8N_CODEX_CONTEXT_CONFIG_FILE;
  t.after(async () => {
    if (prior === undefined) delete process.env.N8N_CODEX_CONTEXT_CONFIG_FILE;
    else process.env.N8N_CODEX_CONTEXT_CONFIG_FILE = prior;
    await fs.rm(root, { recursive: true, force: true });
  });
  await atomicWrite(path.join(root, "key"), "SYNTHETIC_CONTEXT_TURN_KEY");
  const config = path.join(root, "config.json");
  await atomicWrite(config, JSON.stringify({
    version: 1, installationId: "context-turn-installation",
    installationKeyFile: path.join(root, "key"), journalDirectory: path.join(root, "journal"),
    gatewayOrigins: ["https://gateway.invalid", "https://handshake-failure.invalid"],
  }));
  process.env.N8N_CODEX_CONTEXT_CONFIG_FILE = config;
  const hooks = await integration.installFromEnvironment();
  let sends = 0;
  const transport = hooks.decorateFetch(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/wire/v1/context/handshake")
      return url.hostname === "handshake-failure.invalid"
        ? new Response("Controlled refusal", { status: 503 })
        : Response.json({ id: "controlled-handshake", expires: Date.now() + 3600000 });
    sends++;
    return Response.json({ ok: true });
  });
  const identity = {
    projectId: "project", agentRevision: "revision", conversationId: "conversation",
    branchId: "branch", turnId: "turn", hostRunId: "host", hostIssuedAt: Date.now(),
  };
  const scoped = (action) => integration.withServerRun(identity, action);
  const prepare = () => hooks.prepare({ runId: randomUUID() }, async () => {});
  const request = (context, origin = "https://gateway.invalid") => transport(origin + "/v1/responses", {
    method: "POST", headers: { "X-N8n-Model-Operation": context?.operationId ?? "missing" },
  });

  await t.test("run preserves synchronous and original native Promise contracts", async () => {
    const value = {}, error = new Error("Controlled synchronous error");
    assert.equal(hooks.run(undefined, () => value), value);
    assert.throws(() => hooks.run(undefined, () => { throw error; }), (e) => e === error);
    const success = deferred(), failure = deferred();
    assert.equal(hooks.run(undefined, () => success.promise), success.promise);
    assert.equal(hooks.run(undefined, () => failure.promise), failure.promise);
    success.resolve(value); failure.reject(error);
    assert.equal(await success.promise, value);
    await assert.rejects(failure.promise, (e) => e === error);
  });

  await t.test("gateway failures reject before retry while committed finishes remain valid", () => scoped(async () => {
    const context = await prepare();
    for (const finish of ["error", "other", "unknown", "length", "content-filter", "stop", "tool-calls"])
      await hooks.run(context, async () => {
        await request(context);
        if (["stop", "tool-calls"].includes(finish)) hooks.validateModelTurn(context, finish);
        else assert.throws(() => hooks.validateModelTurn(context, finish), /committed result/);
      });
  }));

  await t.test("foreign calls with undefined context keep existing finish behavior", async () => {
    await hooks.run(undefined, async () => {
      await transport("https://foreign.invalid/v1/responses", {
        headers: { "X-N8n-Model-Operation": "untrusted" },
      });
      hooks.validateModelTurn(undefined, "error");
    });
    assert.throws(() => hooks.validateModelTurn(undefined, "stop"), /scope is missing/);
  });

  await t.test("missing, mismatched and unbound attested contexts fail closed", () => scoped(async () => {
    const context = await prepare(), before = sends;
    await assert.rejects(request(context), /scope is missing/);
    await hooks.run(undefined, async () => {
      await assert.rejects(request(context), /did not supply a durable context/);
      assert.throws(() => hooks.validateModelTurn(undefined, "stop"), /committed result/);
    });
    await hooks.run({ ...context, agentRevision: "different" }, async () => {
      await assert.rejects(request(context), /attested operation differs/);
      assert.throws(() => hooks.validateModelTurn({ ...context, agentRevision: "different" }, "stop"), /committed result/);
    });
    await hooks.run(context, async () => {
      await assert.rejects(request(context, "https://handshake-failure.invalid"), /rejected.*handshake/);
      assert.throws(() => hooks.validateModelTurn(context, "stop"), /committed result/);
    });
    assert.equal(sends, before);
    const other = await prepare();
    for (const invalid of [undefined, other]) await hooks.run(context, async () => {
      await request(context);
      hooks.validateModelTurn(context, "stop");
      await assert.rejects(request(invalid));
      assert.throws(() => hooks.validateModelTurn(context, "stop"), /committed result/);
    });
  }));

  await t.test("equal reconstructed contexts survive LRU eviction during a pending call", () => scoped(async () => {
    const context = await prepare();
    await hooks.run({ ...context }, async () => {
      for (let i = 0; i < 4097; i++) {
        const previous = { ...context, operationId: randomUUID(), runId: "eviction-" + i };
        await hooks.prepare({ runId: previous.runId, previous }, async () => {});
      }
      // The original record is now rehydrated from its durable journal as a new object.
      await request(context);
      hooks.validateModelTurn({ ...context }, "stop");
      assert.throws(() => hooks.validateModelTurn({ ...context, operationIssuedAt: context.operationIssuedAt + 1 }, "stop"), /context differs/);
    });
  }));

  await t.test("concurrent and nested runtime scopes cannot contaminate one another", () => scoped(async () => {
    const a = await prepare(), b = await prepare(), gate = deferred();
    await Promise.all([
      hooks.run(a, async () => {
        await request(a); await gate.promise;
        hooks.validateModelTurn(a, "stop");
        await hooks.run(b, async () => { await request(b); hooks.validateModelTurn(b, "tool-calls"); });
        hooks.validateModelTurn(a, "stop");
      }),
      hooks.run(b, async () => {
        await request(b); assert.throws(() => hooks.validateModelTurn(b, "error"), /committed result/);
        gate.resolve();
      }),
    ]);
  }));

  const helperModel = {
    async doGenerate(options) { return await request({ operationId: options.headers["X-N8n-Model-Operation"] }); },
  };
  await t.test("independent and nested helpers retain their own trusted scopes and parent identity", () => scoped(async () => {
    const independent = hooks.decorateModel(helperModel, "title");
    await independent.doGenerate({});
    const context = await prepare();
    await hooks.run(context, async () => {
      await request(context);
      const parent = integration.currentParentOperationId();
      await hooks.decorateModel(helperModel, "helper").doGenerate({});
      assert.equal(integration.currentParentOperationId(), parent);
      hooks.validateModelTurn(context, "stop");
      await assert.rejects(hooks.decorateModel({ async doGenerate() { throw new Error("Controlled helper failure"); } }, "compaction").doGenerate({}), /Controlled helper failure/);
      hooks.validateModelTurn(context, "stop");
    });
  }));

  await t.test("closed inherited helper work cannot erase its guard; a fresh runtime can progress", () => scoped(async () => {
    const context = await prepare(), gate = deferred();
    let late, lateDirect;
    await hooks.run(context, async () => {
      const helper = hooks.decorateModel(helperModel, "helper");
      late = gate.promise.then(() => helper.doGenerate({}));
      lateDirect = gate.promise.then(() => request(context));
    });
    const before = sends;
    const rejected = Promise.all([
      assert.rejects(late, /scope has closed/),
      assert.rejects(lateDirect, /scope has closed/),
    ]);
    gate.resolve();
    await rejected;
    assert.equal(sends, before);
    const fresh = await prepare();
    await hooks.run(fresh, async () => { await request(fresh); hooks.validateModelTurn(fresh, "stop"); });
  }));
});
