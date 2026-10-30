// Local synthetic overhead measurements; provider latency and subscription limits are excluded.
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const {
  rawModel,
  session,
  output,
  textEvent,
  complete,
  sseResponse,
} = require("../test/helpers.cjs");
const p95 = (values) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * 0.95))
  ];
async function run(concurrency) {
  const starts = new Map();
  const emitted = new Map();
  const preRequest = [];
  const forward = [];
  const totals = [];
  let catalogs = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/models?")) {
      catalogs++;
      return Response.json({ models: [rawModel()] });
    }
    const request = JSON.parse(init.body);
    const id = Number(request.input.at(-1).content[0].text);
    preRequest.push(performance.now() - starts.get(id));
    emitted.set(id, performance.now());
    return sseResponse([textEvent("Synthetic"), complete(output("Synthetic"))]);
  };
  const model = new CodexChatModel({
    model: "synthetic-model",
    session: async () => session(),
    catalog: new ModelCatalog(fetchImpl),
    transport: new ResponsesTransport(fetchImpl),
    settings: { maxRetries: 0 },
  });
  starts.set(-1, performance.now());
  await model.invoke("-1");
  preRequest.length = 0;
  const rss = process.memoryUsage().rss;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  for (let base = 0; base < 128; base += concurrency)
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, 128 - base) },
        async (_, offset) => {
          const id = base + offset;
          const start = performance.now();
          starts.set(id, start);
          let seen = false;
          for await (const chunk of await model.stream(String(id)))
            if (!seen && chunk.content) {
              forward.push(performance.now() - emitted.get(id));
              seen = true;
            }
          totals.push(performance.now() - start);
        },
      ),
    );
  loop.disable();
  return {
    concurrency,
    samples: 128,
    warmCatalogRequests: catalogs - 1,
    preRequestP95Ms: p95(preRequest),
    sseForwardingP95Ms: p95(forward),
    totalP95Ms: p95(totals),
    rssDeltaBytes: process.memoryUsage().rss - rss,
    eventLoopDelayP95Ms: loop.percentile(95) / 1e6,
    budget20Ms: p95(preRequest) <= 20 && p95(forward) <= 20,
  };
}
(async () => {
  const results = [];
  for (const concurrency of [1, 8, 32, 64])
    results.push(await run(concurrency));
  process.stdout.write(
    JSON.stringify(
      { fixture: "synthetic-only", node: process.version, results },
      null,
      2,
    ) + "\n",
  );
})().catch(() => {
  process.stderr.write("Synthetic benchmark failed.\n");
  process.exitCode = 1;
});
