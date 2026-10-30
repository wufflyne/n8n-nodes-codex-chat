const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { HumanMessage } = require("@langchain/core/messages");
const { AccountReader } = require("../dist/account/usage");
const { ResetStore } = require("../dist/account/reset-store");
const { ResetController } = require("../dist/account/reset");
const { normalizeImage, imageMime, imageDimensions } = require("../dist/image/validation");
const { ImageService } = require("../dist/image/service");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const { profile, session, identity, rawModel, mockFetch } = require("./helpers.cjs");
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
function fixture() {
  const binding = { profileId: randomUUID(), bindingSecret: "synthetic" };
  const current = { ...session(), identity: identity(), profileId: binding.profileId };
  return {
    binding, current,
    sessions: {
      refreshEnabled: false,
      store: { read: async () => profile(binding) },
      session: async () => current,
      currentSession: async () => current,
    },
  };
}
const usage = (used) => ({
  account_id: "synthetic-account",
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: {
      used_percent: used, limit_window_seconds: 18000,
      reset_at: Math.floor(Date.now() / 1000) + 3600, reset_after_seconds: 3600,
    },
  },
  rate_limit_reset_credits: { available_count: used ? 1 : 0 },
});
const credits = (count) => ({
  available_count: count,
  credits: count ? [{
    id: "synthetic-credit", reset_type: "codex_rate_limits", status: "available",
    granted_at: new Date(Date.now() - 60000).toISOString(), expires_at: null,
  }] : [],
});
for (const reconcile of [false, true])
  test(`Definite ${reconcile ? "reconciliation" : "consume"} reads post-action limits/details and fences late pre-action snapshots`, async (t) => {
    const f = fixture();
    await fs.mkdir(".test-state", { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.resolve(".test-state/v003-freshness-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const oldUsage = deferred(), oldCredits = deferred(), usageStarted = deferred(), creditsStarted = deferred();
    let applied = false, blockUsage = false, blockCredits = false, clock = Date.now();
    let usageGets = 0, creditGets = 0, posts = 0, oldUsageRead, oldCreditRead, reader;
    const bodies = [];
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/consume")) {
        posts++; bodies.push(JSON.parse(init.body));
        if (reconcile && posts === 1) throw Error("Synthetic ambiguous dispatch");
        // Two ordinary callers begin reads before the action; neither blocks the action owner.
        blockCredits = true;
        oldCreditRead = reader.readWithSession(f.binding, f.current, { includeResetDetails: true });
        await creditsStarted.promise;
        blockUsage = true;
        oldUsageRead = reader.readWithSession(f.binding, f.current, { force: true });
        await usageStarted.promise;
        applied = true;
        return Response.json({ code: reconcile ? "already_redeemed" : "reset", windows_reset: 1 });
      }
      if (String(url).endsWith("/usage")) {
        usageGets++;
        if (blockUsage) {
          blockUsage = false; usageStarted.resolve();
          await oldUsage.promise;
          return Response.json(usage(99));
        }
        return Response.json(usage(applied ? 0 : 99));
      }
      creditGets++;
      if (blockCredits) {
        blockCredits = false; creditsStarted.resolve();
        await oldCredits.promise;
        return Response.json(credits(1));
      }
      return Response.json(credits(applied ? 0 : 1));
    };
    reader = new AccountReader(f.sessions, fetchImpl);
    const controller = new ResetController(reader, new ResetStore(directory, Buffer.alloc(32, 3)), fetchImpl, () => clock);
    const key = (value) => createHash("sha256").update(value).digest("hex");
    const consume = () => controller.consumeReset(f.binding, {
      origin: "manual", selectedCreditId: "synthetic-credit", acknowledgement: true,
      executionKey: key("initial"), policy: { automatic: false, threshold: 1, maxPer24Hours: 1, order: "next-first" },
    });
    if (reconcile) {
      assert.equal((await consume()).action.state, "uncertain");
      clock += 31000;
    }
    let timer;
    try {
      const action = reconcile
        ? controller.resolvePendingReset(f.binding, { executionKey: key("reconcile") })
        : consume();
      const result = await Promise.race([
        action,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Post-action read joined a pre-action waiter")), 2000); }),
      ]);
      assert.equal(result.action.state, "terminal");
      assert.equal(result.action.limitsRefreshed, true);
      assert.equal(result.limits.buckets[0].windows[0].usedPercent, 0);
      assert.equal(result.resetCredits.availableCount, 0);
      assert.deepEqual(result.resetCredits.entries, []);
      assert.equal(usageGets, reconcile ? 5 : 4);
      assert.equal(creditGets, 4);
      assert.equal(posts, reconcile ? 2 : 1);
      if (reconcile) assert.deepEqual(bodies[1], bodies[0]);
    } finally {
      clearTimeout(timer);
      oldUsage.resolve(); oldCredits.resolve();
      await Promise.allSettled([oldUsageRead, oldCreditRead]);
    }
    const before = usageGets;
    const warm = await reader.readWithSession(f.binding, f.current);
    assert.equal(warm.limits.buckets[0].windows[0].usedPercent, 0);
    assert.equal(usageGets, before);
  });

test("A detached older read cannot delete a newer shared pending request", async () => {
  const f = fixture(), old = deferred(), newer = deferred(), firstStarted = deferred(), nextStarted = deferred();
  let reads = 0;
  const reader = new AccountReader(f.sessions, async () => {
    const index = ++reads;
    if (index === 1) { firstStarted.resolve(); await old.promise; }
    else { nextStarted.resolve(); await newer.promise; }
    return Response.json(usage(index === 1 ? 99 : 0));
  });
  const first = reader.readWithSession(f.binding, f.current, { force: true });
  await firstStarted.promise;
  reader.invalidateBeforeFreshRead(f.current);
  const second = reader.readWithSession(f.binding, f.current, { force: true });
  await nextStarted.promise;
  old.resolve(); await first;
  const third = reader.readWithSession(f.binding, f.current, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  newer.resolve();
  await Promise.all([second, third]);
  assert.equal(reads, 2);
});

test("Canonical DNS-local image hosts fail before inference; public URL bytes stay unchanged on both codecs", async () => {
  const denied = [
    "https://localhost./image", "https://a.localhost./image", "https://metadata.google.internal./image",
    "https://LOCALHOST./image", "https://localhost。/image", "https://ｌｏｃａｌｈｏｓｔ./image",
    "https://%6cocalhost./image", "https://127.0.0.1./image", "https://2130706433/image", "https://[::ffff:127.0.0.1]/image",
  ];
  const publicUrl = "https://例え.example./asset%20name.png?x=%E9%9B%AA#pixel";
  assert.equal(normalizeImage({ type: "image_url", image_url: publicUrl }, { supportsImages: true }, { count: 0, bytes: 0 }).image_url, publicUrl);
  for (const lite of [false, true]) {
    let inferenceCalls = 0;
    const fetchImpl = mockFetch(async () => { inferenceCalls++; throw Error("Rejected URL reached inference"); }, rawModel({ use_responses_lite: lite }));
    const model = new CodexChatModel({ model: "synthetic-model", session: async () => session(), catalog: new ModelCatalog(fetchImpl), transport: new ResponsesTransport(fetchImpl) });
    for (const url of denied)
      await assert.rejects(model.invoke([new HumanMessage({ content: [{ type: "image_url", image_url: url }] })]), /Local|Private/);
    assert.equal(inferenceCalls, 0);
  }
});

test("Post-reset invalidation spans renewed generations while unrelated account reads still populate their cache", async () => {
  const f = fixture(), renewed = { ...f.current, generation: 2 };
  const other = { ...f.current, affinity: "unrelated-profile", accountId: "unrelated-account" };
  const oldRead = deferred(), unrelatedRead = deferred(), oldStarted = deferred(), unrelatedStarted = deferred();
  let selectedReads = 0, unrelatedReads = 0;
  const reader = new AccountReader(f.sessions, async (_url, init) => {
    const account = new Headers(init.headers).get("ChatGPT-Account-Id");
    if (account === other.accountId) {
      unrelatedReads++;
      unrelatedStarted.resolve(); await unrelatedRead.promise;
      return Response.json({ ...usage(7), account_id: other.accountId });
    }
    const index = ++selectedReads;
    if (index === 1) { oldStarted.resolve(); await oldRead.promise; }
    return Response.json(usage(index === 1 ? 99 : 0));
  });
  const pending = reader.readWithSession(f.binding, renewed, { force: true });
  const unrelated = reader.readWithSession(f.binding, other, { force: true });
  await Promise.all([oldStarted.promise, unrelatedStarted.promise]);
  reader.invalidateBeforeFreshRead(f.current);
  try {
    const postAction = await reader.readWithSession(f.binding, renewed, { force: true });
    assert.equal(postAction.limits.buckets[0].windows[0].usedPercent, 0);
    assert.equal(selectedReads, 2);
  } finally {
    oldRead.resolve(); unrelatedRead.resolve();
    await Promise.all([pending, unrelated]);
  }
  assert.equal((await reader.readWithSession(f.binding, renewed)).limits.buckets[0].windows[0].usedPercent, 0);
  assert.equal((await reader.readWithSession(f.binding, other)).limits.buckets[0].windows[0].usedPercent, 7);
  assert.equal(selectedReads, 2);
  assert.equal(unrelatedReads, 1);
});

test("Raster magic and dimension-header identifiers compare exact bytes without masking high bits", async () => {
  for (const magic of ["GIF87a", "GIF89a", "RIFFxxxxWEBP"])
    for (const index of magic.startsWith("RIFF") ? [0, 1, 2, 3, 8, 9, 10, 11] : [0, 1, 2, 3, 4, 5]) {
      const bytes = Buffer.from(magic);
      bytes[index] |= 0x80;
      assert.throws(() => imageMime(bytes), /signature/);
      assert.throws(() => normalizeImage({ type: "image", mimeType: magic.startsWith("RIFF") ? "image/webp" : "image/gif", data: bytes }, { supportsImages: true }, { count: 0, bytes: 0 }), /signature/);
    }
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0x8AAAAASUVORK5CYII=", "base64");
  for (let index = 12; index < 16; index++) {
    const forged = Buffer.from(png); forged[index] |= 0x80;
    assert.throws(() => imageDimensions(forged), /PNG header/);
  }
  for (const kind of ["VP8X", "VP8 ", "VP8L"]) {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0); bytes.writeUInt32LE(22, 4); bytes.write("WEBP", 8);
    bytes.write(kind, 12); bytes.writeUInt32LE(10, 16);
    if (kind === "VP8 ") {
      bytes.set([0x9d, 1, 0x2a], 23); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(1, 28);
    } else if (kind === "VP8L") bytes[20] = 0x2f;
    assert.equal(imageDimensions(bytes).width, 1);
    for (let index = 12; index < 16; index++) {
      const forged = Buffer.from(bytes); forged[index] |= 0x80;
      assert.throws(() => imageDimensions(forged), /WebP dimension header/);
    }
  }
  const gif = Buffer.alloc(13);
  gif.write("GIF89a"); gif.writeUInt16LE(1, 6); gif.writeUInt16LE(1, 8); gif[0] |= 0x80;
  let calls = 0;
  const service = new ImageService({ session: async () => session() }, async () => {
    calls++;
    return Response.json({ created: 1, data: [{ b64_json: gif.toString("base64") }] });
  });
  await assert.rejects(service.generate({}, "Synthetic", false), (error) => error.category === "protocol");
  assert.equal(calls, 1);
});
