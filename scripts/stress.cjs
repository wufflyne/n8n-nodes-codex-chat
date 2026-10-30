// Sustained synthetic local load. Includes real encrypted disk reads; excludes provider/network latency.
const assert = require("node:assert/strict");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { getEventListeners } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  CodexChatModel,
  ModelCatalog,
  ResponsesTransport,
  ProfileStore,
  AccountSessionManager,
} = require("../dist");
const {
  rawModel,
  profile,
  complete,
  output,
  textEvent,
  sseResponse,
} = require("../test/helpers.cjs");
const percentile = (a, p) =>
  [...a].sort((x, y) => x - y)[
    Math.min(a.length - 1, Math.floor(a.length * p))
  ];
(async () => {
  await fs.mkdir(".test-state", { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.resolve(".test-state/stress-"));
  try {
    const store = new ProfileStore(dir, Buffer.alloc(32, 0x61));
    const binding = {
      profileId: randomUUID(),
      bindingSecret: "SYNTHETIC_STRESS_BINDING",
    };
    await store.write(profile(binding));
    const manager = new AccountSessionManager(
      store,
      {
        verify: async () => {
          throw Error("No auth expected");
        },
        refresh: async () => {
          throw Error("No refresh expected");
        },
      },
      false,
    );
    const starts = new Map(),
      pre = [],
      forward = [],
      cancelTimes = [];
    let catalogs = 0,
      completed = 0,
      failed = 0,
      cancelled = 0,
      upstreamCancelled = 0;
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/models?")) {
        catalogs++;
        return Response.json({ models: [rawModel()] });
      }
      const id = Number(JSON.parse(init.body).input.at(-1).content[0].text);
      pre.push(performance.now() - starts.get(id));
      if (id % 10 === 0)
        return new Response(
          new ReadableStream({
            cancel() {
              upstreamCancelled++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const events = Array.from({ length: 16 }, () => textEvent("x"));
      if (id % 10 === 1) events.push({ type: "response.failed" });
      else events.push(complete(output("x".repeat(16), { id: `resp_${id}` })));
      const emitted = performance.now();
      const response = sseResponse(events, {
        split: 64,
        onCancel() {
          upstreamCancelled++;
        },
      });
      response.emitted = emitted;
      starts.set(`emitted-${id}`, emitted);
      return response;
    };
    const model = new CodexChatModel({
      model: "synthetic-model",
      session: (signal) => manager.session(binding, signal),
      catalog: new ModelCatalog(fetchImpl),
      transport: new ResponsesTransport(fetchImpl),
      settings: { maxRetries: 0 },
    });
    starts.set(-2, performance.now());
    await model.invoke("-2");
    pre.length = 0;
    global.gc?.();
    const baseline = process.memoryUsage().rss;
    const handles = process._getActiveHandles().length;
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const rss = [];
    const started = performance.now();
    for (let batch = 0; batch < 64; batch++) {
      for (let base = batch * 256; base < (batch + 1) * 256; base += 64)
        await Promise.all(
          Array.from({ length: 64 }, async (_, offset) => {
            const id = base + offset;
            const controller = new AbortController();
            starts.set(id, performance.now());
            let first = false;
            let timer;
            if (id % 10 === 0)
              timer = setTimeout(() => {
                starts.set(`cancel-${id}`, performance.now());
                controller.abort();
              }, 20);
            try {
              for await (const chunk of await model.stream(String(id), {
                signal: controller.signal,
              }))
                if (!first && chunk.content) {
                  first = true;
                  forward.push(performance.now() - starts.get(`emitted-${id}`));
                }
              completed++;
            } catch (error) {
              if (controller.signal.aborted || error.category === "cancelled") {
                cancelled++;
                cancelTimes.push(
                  performance.now() - starts.get(`cancel-${id}`),
                );
              } else {
                assert.equal(error.category, "provider");
                failed++;
              }
            } finally {
              clearTimeout(timer);
              assert.equal(
                getEventListeners(controller.signal, "abort").length,
                0,
              );
            }
          }),
        );
      await new Promise((r) => setTimeout(r, 25));
      global.gc?.();
      rss.push(process.memoryUsage().rss);
    }
    await new Promise((r) => setTimeout(r, 50));
    global.gc?.();
    loop.disable();
    assert.equal(completed + failed + cancelled, 16384);
    assert.equal(catalogs, 1);
    assert(cancelTimes.every((t) => t < 1000));
    console.log(
      JSON.stringify(
        {
          fixture: "synthetic-disk-backed-mixed-load",
          node: process.version,
          concurrency: 64,
          samples: 16384,
          durationMs: performance.now() - started,
          completed,
          failed,
          cancelled,
          upstreamCancelled,
          warmCatalogRequests: catalogs - 1,
          preRequestP95Ms: percentile(pre, 0.95),
          sseForwardingP95Ms: percentile(forward, 0.95),
          cancelP95Ms: percentile(cancelTimes, 0.95),
          cancelMaxMs: Math.max(...cancelTimes),
          rssBaselineBytes: baseline,
          rssAfterBatchesBytes: rss,
          rssFinalBytes: process.memoryUsage().rss,
          activeHandlesBefore: handles,
          activeHandlesAfter: process._getActiveHandles().length,
          eventLoopP95Ms: loop.percentile(95) / 1e6,
          listenerChecks: "zero after each call",
          scope:
            "Local disk/session/codec/SSE only; provider/network/subscription throughput excluded",
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("Synthetic sustained load failed:", error.message);
  process.exitCode = 1;
});
