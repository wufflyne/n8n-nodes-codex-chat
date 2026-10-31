const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { ProfileStore, AccountSessionManager } = require("../dist");
const {
  AccountReader,
  parseUsage,
  parseResetCredits,
  emptySnapshot,
  quotaDecision,
} = require("../dist/account/usage");
const { localStatus, verifiedDisplay } = require("../dist/auth/status");
const { ResetStore } = require("../dist/account/reset-store");
const { ResetController } = require("../dist/account/reset");
const { resetEligibility } = require("../dist/account/reset-policy");
const { DEFAULT_RECOVERY } = require("../dist/account/types");
const { deliverBinding } = require("../dist/auth/connection");
const { profile, tokens, identity, session } = require("./helpers.cjs");
const key = (x) => createHash("sha256").update(x).digest("hex");
function usage(used = 99, allowed = true) {
  return {
    account_id: "synthetic-account",
    plan_type: "pro",
    rate_limit: {
      allowed,
      limit_reached: !allowed,
      primary_window: {
        used_percent: used,
        limit_window_seconds: 18000,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        reset_after_seconds: 3600,
      },
    },
    rate_limit_reached_type: allowed ? null : { type: "rate_limit_reached" },
    credits: { has_credits: true, unlimited: false, balance: "2.50" },
    rate_limit_reset_credits: { available_count: 4 },
  };
}
function credits() {
  return {
    available_count: 4,
    credits: [
      {
        id: "earned-reset-1",
        reset_type: "codex_rate_limits",
        status: "available",
        granted_at: new Date(Date.now() - 3600000).toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        title: "Available reset",
        description: "Synthetic allocation",
      },
    ],
  };
}
async function setup(t, options = {}) {
  await fs.mkdir(".test-state", { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.resolve(".test-state/v002-reset-"));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const master = Buffer.alloc(32, 0x72),
    store = new ProfileStore(path.join(dir, "profiles"), master),
    auth = {
      verify: async (candidate) => ({
        identity: identity(),
        tokens: candidate,
      }),
      refresh: async () => {
        throw Error("No refresh expected");
      },
    },
    manager = new AccountSessionManager(store, auth),
    binding = await manager.importTokens(tokens(), "Synthetic");
  let consumes = 0,
    gets = 0;
  const bodies = [];
  let currentUsage = usage();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/consume")) {
      consumes++;
      bodies.push(JSON.parse(init.body));
      if (options.consume) return options.consume(url, init);
      currentUsage = usage(0, true);
      return Response.json({ code: options.code ?? "reset", windows_reset: 1 });
    }
    gets++;
    return Response.json(
      String(url).endsWith("/usage") ? currentUsage : credits(),
    );
  };
  let clock = Date.now();
  const reader = new AccountReader(manager, fetchImpl),
    journal = new ResetStore(store.directory, master),
    controller = new ResetController(reader, journal, fetchImpl, () => clock);
  return {
    dir,
    store,
    manager,
    binding,
    reader,
    journal,
    controller,
    bodies,
    counters: () => ({ consumes, gets }),
    setUsage: (x) => {
      currentUsage = x;
    },
    advance: (n) => {
      clock += n;
    },
  };
}
const policy = { ...DEFAULT_RECOVERY, automatic: true };
test("Effective status and verified metadata distinguish renewal policy and authenticated claim provenance", () => {
  const p = profile({ profileId: randomUUID(), bindingSecret: "synthetic" });
  assert.equal(localStatus(p, false).account.renewal, "disabled_by_instance");
  assert.equal(
    localStatus({ ...p, tokens: tokens({ refreshToken: undefined }) }, true)
      .account.renewal,
    "access_only",
  );
  const d = verifiedDisplay(
    { email: "person@example.invalid" },
    { chatgpt_plan_type: "pro" },
  );
  assert.equal(d.plan.value, "pro");
  assert.equal(
    verifiedDisplay(
      {
        email: "a@example.invalid",
        "https://api.openai.com/profile": { email: "b@example.invalid" },
      },
      {},
    ),
    undefined,
  );
  assert.equal(verifiedDisplay({ email: "invalid\nmail" }, {}), undefined);
});
test("Prepared activation requires a complete durable binding and cancellation before verification cannot activate", async (t) => {
  const c = await setup(t),
    prepared = c.manager.prepareNewProfile(),
    file = path.join(c.dir, "binding.json");
  await assert.rejects(
    c.manager.activatePreparedProfile(prepared, tokens(), "Prepared", {
      bindingDurable: { binding: prepared.binding },
    }),
    /durable binding/,
  );
  const proof = await deliverBinding(file, prepared.binding);
  assert.deepEqual(
    JSON.parse(await fs.readFile(file, "utf8")),
    prepared.binding,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    c.manager.activatePreparedProfile(prepared, tokens(), "Prepared", {
      bindingDurable: proof,
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.equal(await c.store.exists(prepared.binding.profileId), false);
  await c.manager.activatePreparedProfile(prepared, tokens({ refreshToken: "SYNTHETIC_PREPARED_FAMILY" }), "Prepared", {
    bindingDurable: proof,
  });
  assert.equal((await c.store.read(prepared.binding)).state, "ready");
});
test("Cancellation while JWKS verification waits never reaches commit; cancellation after write starts retains connection", async (t) => {
  const c = await setup(t);
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    entry = new Promise((r) => (entered = r));
  const manager = new AccountSessionManager(c.store, {
    verify: async (candidate) => {
      entered();
      await gate;
      return { identity: identity(), tokens: candidate };
    },
    refresh: async () => tokens(),
  });
  const prepared = manager.prepareNewProfile(),
    proof = await deliverBinding(
      path.join(c.dir, "cancel.json"),
      prepared.binding,
    ),
    cancel = new AbortController();
  const pending = manager.activatePreparedProfile(
    prepared,
    tokens(),
    "Cancel",
    { bindingDurable: proof, signal: cancel.signal },
  );
  await entry;
  cancel.abort();
  release();
  await assert.rejects(pending, /cancelled/);
  assert.equal(await c.store.exists(prepared.binding.profileId), false);
  const next = c.manager.prepareNewProfile(),
    nextProof = await deliverBinding(
      path.join(c.dir, "committed.json"),
      next.binding,
    ),
    after = new AbortController(),
    write = c.store.write.bind(c.store);
  c.store.write = async (p) => {
    after.abort();
    await write(p);
  };
  const result = await c.manager.activatePreparedProfile(
    next,
    tokens({ refreshToken: "SYNTHETIC_COMMITTED_FAMILY" }),
    "Committed",
    { bindingDurable: nextProof, signal: after.signal },
  );
  assert.equal(result.state, "committed_after_cancel");
  assert.equal((await c.store.read(next.binding)).state, "ready");
});
test("Quota permission is separate from percentages, spending scope and exact additional model mapping", () => {
  const base = emptySnapshot(
    localStatus(profile({ profileId: randomUUID(), bindingSecret: "x" }), true),
  );
  const s = session();
  assert.equal(
    parseUsage(usage(100, true), base, s).routing.decision,
    "allowed",
  );
  assert.equal(
    parseUsage(usage(0, false), base, s).routing.decision,
    "quota_exhausted",
  );
  const unknown = usage(100, false);
  delete unknown.rate_limit.limit_reached;
  assert.equal(parseUsage(unknown, base, s).routing.decision, "unknown");
  unknown.rate_limit_reached_type = {
    type: "workspace_owner_credits_depleted",
  };
  assert.equal(parseUsage(unknown, base, s).routing.decision, "unknown");
  assert.throws(
    () => parseUsage({ ...usage(), account_id: "other" }, base, s),
    /identity/,
  );
  const modelBase = {
    ...base,
    routing: { ...base.routing, model: "exact-model" },
  };
  const u = {
    ...usage(),
    additional_rate_limits: [
      {
        metered_feature: "special",
        normal_model_slug: "exact-model",
        rate_limit: { allowed: false, limit_reached: true },
      },
    ],
    rate_limit_reached_type: { type: "rate_limit_reached" },
  };
  assert.equal(parseUsage(u, modelBase, s).routing.decision, "quota_exhausted");
  u.additional_rate_limits[0].normal_model_slug = "another-model";
  assert.equal(parseUsage(u, modelBase, s).routing.decision, "allowed");
});
test("Reset eligibility accepts explicit allowed=true at <=1% without equating it to exhaustion", () => {
  const base = emptySnapshot(
    localStatus(profile({ profileId: randomUUID(), bindingSecret: "x" }), true),
  );
  for (const [used, eligible] of [
    [99, true],
    [98.99, false],
    [100, true],
  ]) {
    let snapshot = parseResetCredits(
      credits(),
      parseUsage(usage(used, true), base, session()),
    );
    assert.equal(
      resetEligibility(snapshot, policy, "automatic").eligible,
      eligible,
    );
  }
  let snapshot = parseResetCredits(
    credits(),
    parseUsage(usage(0, false), base, session()),
  );
  assert.equal(resetEligibility(snapshot, policy, "automatic").eligible, false);
  snapshot.limits.buckets[0].allowed = null;
  assert.equal(resetEligibility(snapshot, policy, "manual").eligible, false);
});
test("Reset list keeps authoritative aggregate, excludes expired/unknown/conflicting rows and never guesses IDs", () => {
  const base = emptySnapshot(
    localStatus(profile({ profileId: randomUUID(), bindingSecret: "x" }), true),
  );
  const rows = credits();
  rows.credits.push({ ...rows.credits[0], reset_type: "unknown" });
  const parsed = parseResetCredits(rows, base);
  assert.equal(parsed.resetCredits.availableCount, 4);
  assert.equal(parsed.resetCredits.detailsComplete, null);
  assert.equal(parsed.resetCredits.entries[0].eligible, false);
  assert.equal(
    parsed.resetCredits.entries[0].ineligibleReason,
    "conflicting_duplicate",
  );
});
test("Account reads coalesce, detach waiters and use managed/current-only renewal discipline", async (t) => {
  const c = await setup(t);
  await Promise.all(
    Array.from({ length: 16 }, () => c.reader.readAccount(c.binding)),
  );
  assert.equal(c.counters().gets, 1);
  const a = await c.reader.readAccount(c.binding);
  a.limits.buckets.length = 0;
  assert.equal(
    (await c.reader.readAccount(c.binding)).limits.buckets.length,
    1,
  );
  await c.reader.readAccount(c.binding, { force: true });
  assert.equal(c.counters().gets, 2);
  await c.store.write({
    ...(await c.store.read(c.binding)),
    tokens: tokens({ expiresAt: 0 }),
  });
  await assert.rejects(
    c.reader.readAccount(c.binding, { access: "current-only" }),
    /expired/,
  );
});
for (const code of [
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
])
  test(`Manual reset records definite ${code} and one execution/rolling cap across profiles`, async (t) => {
    const c = await setup(t, { code });
    const opts = {
      origin: "manual",
      executionKey: key("execution"),
      policy: DEFAULT_RECOVERY,
      selectedCreditId: "earned-reset-1",
      acknowledgement: true,
    };
    const result = await c.controller.consumeReset(c.binding, opts);
    assert.equal(result.action.state, "terminal");
    assert.equal(result.action.outcome, code);
    assert.equal(result.action.limitsRefreshed, true);
    assert.equal(c.counters().consumes, 1);
    c.setUsage(usage());
    const second = await c.controller.consumeReset(c.binding, opts);
    assert.equal(second.action.reason, "cap_reached");
    const duplicate = await c.manager.importTokens(
      tokens({ refreshToken: "SYNTHETIC_INDEPENDENT_FAMILY" }),
      "Duplicate same account",
    );
    const other = await c.controller.consumeReset(duplicate, {
      ...opts,
      executionKey: key("another"),
    });
    assert.equal(other.action.reason, "cap_reached");
    assert.equal(c.counters().consumes, 1);
    const encrypted = await fs.readFile(
      path.join(c.journal.directory, `${c.journal.scope(identity())}.json.enc`),
      "utf8",
    );
    assert(!encrypted.includes("earned-reset"));
  });
test("Uncertain POST retains same-key recovery, blocks other spending and limits explicit reconciliation attempts", async (t) => {
  let fail = true;
  const c = await setup(t, {
    consume: async () => {
      if (fail) throw Error("SYNTHETIC_UNKNOWN");
      return Response.json({ code: "already_redeemed", windows_reset: 0 });
    },
  });
  const result = await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("initial"),
    policy,
  });
  assert.equal(result.action.state, "uncertain");
  const blocked = await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("second"),
    policy,
  });
  assert.equal(blocked.action.reason, "pending_action");
  assert.equal(c.counters().consumes, 1);
  c.advance(31000);
  fail = false;
  const resolved = await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("resolve"),
  });
  assert.equal(resolved.action.outcome, "already_redeemed");
  assert.deepEqual(c.bodies[1], c.bodies[0]);
  assert.equal(c.counters().consumes, 2);
});
test("Automatic off and missing acknowledgement cannot consume or fetch reset details", async (t) => {
  const c = await setup(t);
  await assert.rejects(
    c.controller.consumeReset(c.binding, {
      origin: "manual",
      executionKey: key("bad"),
      policy: DEFAULT_RECOVERY,
      acknowledgement: false,
    }),
    /Allow/,
  );
  const before = c.counters();
  const result = await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("off"),
    policy: DEFAULT_RECOVERY,
  });
  assert.equal(result.action.reason, "policy_off");
  assert.equal(c.counters().consumes, 0);
  assert.equal(c.counters().gets - before.gets, 1);
});

test("Durable execution reservation serializes competing account resets before either POST", async (t) => {
  // Keep quota low for both concurrent reads so the reservation is the reason
  // the second request stops, regardless of filesystem scheduling.
  const c = await setup(t, { consume: async () => Response.json({ code: "reset", windows_reset: 1 }) }),
    second = await c.manager.importTokens(tokens({ refreshToken: "SYNTHETIC_SECOND_FAMILY" }), "Second profile");
  const options = {
    origin: "automatic",
    executionKey: key("competing-execution"),
    policy,
  };
  const results = await Promise.all([
    c.controller.consumeReset(c.binding, options),
    c.controller.consumeReset(second, options),
  ]);
  assert.equal(c.counters().consumes, 1);
  assert.equal(results.filter((r) => r.action.state === "terminal").length, 1);
  assert.equal(
    results.filter((r) => r.action.reason === "cap_reached").length,
    1,
  );
});
test("Cancellation before durable dispatch leaves zero POSTs and a releasable reservation", async (t) => {
  const c = await setup(t),
    cancel = new AbortController(),
    write = c.journal.writeLedger.bind(c.journal);
  c.journal.writeLedger = async (ledger) => {
    await write(ledger);
    if (ledger.actions.some((a) => a.state === "prepared")) cancel.abort();
  };
  const result = await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("before-send"),
    policy,
    signal: cancel.signal,
  });
  assert.equal(c.counters().consumes, 0);
  assert.equal(result.action.state, "cancelled_before_send");
  assert.equal(
    (await c.journal.reservation(key("before-send"))).state,
    "cancelled_before_send",
  );
});
test("Cancellation after POST and terminal persistence failure both retain an uncertainty fence", async (t) => {
  const cancel = new AbortController();
  const c = await setup(t, {
    consume: async () => {
      cancel.abort();
      throw Error("SYNTHETIC_CANCELLED_POST");
    },
  });
  const result = await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("after-send"),
    policy,
    signal: cancel.signal,
  });
  assert.equal(result.action.state, "uncertain");
  assert.equal(c.counters().consumes, 1);
  const d = await setup(t),
    write = d.journal.writeLedger.bind(d.journal);
  let failed = false;
  d.journal.writeLedger = async (ledger) => {
    if (!failed && ledger.actions.some((a) => a.state === "terminal")) {
      failed = true;
      throw Error("SYNTHETIC_TERMINAL_FSYNC");
    }
    return write(ledger);
  };
  const persisted = await d.controller.consumeReset(d.binding, {
    origin: "automatic",
    executionKey: key("terminal-fsync"),
    policy,
  });
  assert.equal(persisted.action.state, "uncertain");
  assert.equal(d.counters().consumes, 1);
  const ledger = await d.journal.ledger(d.journal.scope(identity()));
  assert.equal(ledger.actions[0].state, "uncertain");
});
test("Explicit orphan recovery proves an existing account ledger before releasing the original reservation", async (t) => {
  const c = await setup(t),
    scope = c.journal.scope(identity()),
    execution = key("orphan");
  await c.journal.writeLedger(await c.journal.ledger(scope));
  await c.journal.reserve(execution, scope, randomUUID());
  const result = await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("orphan-recovery"),
  });
  assert.equal(result.action.state, "cancelled_before_send");
  assert.equal(
    (await c.journal.reservation(execution)).state,
    "cancelled_before_send",
  );
  assert.equal(c.counters().consumes, 0);
});
test("Reconciliation preserves one idempotency key and stops after three total dispatches", async (t) => {
  const c = await setup(t, {
    consume: async () => {
      throw Error("SYNTHETIC_UNCERTAIN");
    },
  });
  await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("initial-uncertain"),
    policy,
  });
  c.advance(31000);
  await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("resolve-one"),
  });
  c.advance(31000);
  const same = await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("resolve-one"),
  });
  assert.equal(same.action.reason, "cooldown");
  assert.equal(c.counters().consumes, 2);
  await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("resolve-two"),
  });
  c.advance(31000);
  const blocked = await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("resolve-three"),
  });
  assert.equal(blocked.action.reason, "pending_action");
  assert.equal(c.counters().consumes, 3);
  assert(
    c.bodies.every(
      (body) => JSON.stringify(body) === JSON.stringify(c.bodies[0]),
    ),
  );
});

test("Malformed percentages/windows and invalid calendar timestamps cannot authorize routing or resets", () => {
  const { isoDate } = require("../dist/account/usage");
  const base = emptySnapshot(
    localStatus(profile({ profileId: randomUUID(), bindingSecret: "x" }), true),
  );
  for (const invalid of [-1, 101, "99", NaN]) {
    const u = usage(invalid, false);
    assert.equal(parseUsage(u, base, session()).routing.decision, "unknown");
  }
  for (const value of [
    "2026-02-30T12:00:00Z",
    "2026-10-30T24:00:00Z",
    "2026-10-30T12:00:00",
  ])
    assert.equal(isoDate(value), null);
});

test("Reconciliation occupies the current durable execution slot without minting a new provider action", async (t) => {
  let failed = true;
  const c = await setup(t, {
    consume: async () => {
      if (failed) throw Error("Synthetic uncertainty");
      return Response.json({ code: "already_redeemed" });
    },
  });
  await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("original"),
    policy,
  });
  c.advance(31000);
  failed = false;
  const current = key("reconciliation-exec");
  await c.controller.resolvePendingReset(c.binding, { executionKey: current });
  assert.equal((await c.journal.reservation(current)).state, "terminal");
  assert.equal(
    await c.journal.reserve(
      current,
      c.journal.scope(identity("other")),
      randomUUID(),
    ),
    false,
  );
  assert.deepEqual(c.bodies[1], c.bodies[0]);
});

for (const observedState of ["absent", "prepared"])
  test(`Reconciliation cannot dispatch after its ${observedState} observation becomes uncertain without a reserved execution`, async (t) => {
    const c = await setup(t, {
      consume: async () => {
        throw Error("Synthetic uncertain original action");
      },
    });
    const initialOptions = {
      origin: "automatic",
      executionKey: key(`observation-original-${observedState}`),
      policy,
    };
    let original, releaseOriginal;
    if (observedState === "prepared") {
      let entered;
      const prepared = new Promise((resolve) => { entered = resolve; });
      const resume = new Promise((resolve) => { releaseOriginal = resolve; });
      const write = c.journal.writeLedger.bind(c.journal);
      c.journal.writeLedger = async (value) => {
        await write(value);
        if (value.actions.some((action) => action.state === "prepared")) {
          entered();
          await resume;
        }
      };
      original = c.controller.consumeReset(c.binding, initialOptions);
      await prepared;
    }
    let entered, releaseObservation;
    const observed = new Promise((resolve) => { entered = resolve; });
    const resume = new Promise((resolve) => { releaseObservation = resolve; });
    const ledger = c.journal.ledger.bind(c.journal);
    let first = true;
    c.journal.ledger = async (...args) => {
      const value = await ledger(...args);
      if (first) {
        first = false;
        entered();
        await resume;
      }
      return value;
    };
    const executionKey = key(`observation-reconcile-${observedState}`);
    const rejected = assert.rejects(
      c.controller.resolvePendingReset(c.binding, { executionKey }),
      /changed before reconciliation/,
    );
    await observed;
    if (releaseOriginal) releaseOriginal();
    else original = c.controller.consumeReset(c.binding, initialOptions);
    assert.equal((await original).action.state, "uncertain");
    c.advance(31000);
    releaseObservation();
    await rejected;
    assert.equal(c.counters().consumes, 1);
    assert.equal(await c.journal.reservation(executionKey), undefined);
    const action = (await ledger(c.journal.scope(identity()))).actions[0];
    assert.equal(action.state, "uncertain");
    assert.equal(action.dispatchCount, 1);
    assert.deepEqual(action.attemptExecutions, [initialOptions.executionKey]);
  });

test("Orphan recovery durably invalidates a paused original writer before releasing its execution reservation", async (t) => {
  const c = await setup(t),
    execution = key("paused-orphan"),
    reserve = c.journal.reserve.bind(c.journal);
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const reserved = new Promise((r) => {
    entered = r;
  });
  c.journal.reserve = async (...args) => {
    const result = await reserve(...args);
    entered();
    await gate;
    return result;
  };
  const original = c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: execution,
    policy,
  });
  await reserved;
  const originalId = (await c.journal.reservation(execution)).redeemRequestId;
  const recovered = await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("paused-orphan-recovery"),
  });
  assert.equal(recovered.action.state, "cancelled_before_send");
  const scope = c.journal.scope(identity());
  const tombstone = (await c.journal.ledger(scope)).actions.find(
    (a) => a.redeemRequestId === originalId,
  );
  assert.equal(tombstone.state, "cancelled_before_send");
  assert.equal(tombstone.dispatchCount, 0);
  // A different account can now reserve this execution; the old writer must stay fenced.
  assert.equal(
    await reserve(execution, c.journal.scope(identity("other")), randomUUID()),
    true,
  );
  release();
  await assert.rejects(original, /cancelled or replaced/);
  assert.equal(c.counters().consumes, 0);
  const restarted = new ResetStore(c.store.directory, Buffer.alloc(32, 0x72));
  assert.equal(
    (await restarted.ledger(scope)).actions.find(
      (a) => a.redeemRequestId === originalId,
    ).state,
    "cancelled_before_send",
  );
});

test("Interrupted orphan recovery leaves a durable tombstone and is safely resumable", async (t) => {
  const c = await setup(t),
    execution = key("orphan-release-interruption"),
    scope = c.journal.scope(identity()),
    id = randomUUID();
  await c.journal.writeLedger(await c.journal.ledger(scope));
  await c.journal.reserve(execution, scope, id);
  const update = c.journal.updateReservation.bind(c.journal);
  c.journal.updateReservation = async () => {
    throw Error("Synthetic process interruption after tombstone fsync");
  };
  await assert.rejects(
    c.controller.resolvePendingReset(c.binding, {
      executionKey: key("recovery-interrupted"),
    }),
    /Synthetic process interruption/,
  );
  assert.equal((await c.journal.reservation(execution)).state, "reserved");
  assert.equal(
    (await c.journal.ledger(scope)).actions[0].state,
    "cancelled_before_send",
  );
  c.journal.updateReservation = update;
  const result = await c.controller.resolvePendingReset(c.binding, {
    executionKey: key("recovery-resumed"),
  });
  assert.equal(result.action.state, "cancelled_before_send");
  assert.equal(
    (await c.journal.reservation(execution)).state,
    "cancelled_before_send",
  );
  assert.equal(c.counters().consumes, 0);
});

test("A definite reset followed by a throwing refresh never claims recovery from its pre-reset snapshot", async (t) => {
  const c = await setup(t),
    read = c.reader.readWithSession.bind(c.reader);
  c.reader.readWithSession = async (...args) => {
    if (c.counters().consumes)
      throw Error("Synthetic post-action authentication failure");
    return read(...args);
  };
  const result = await c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: key("post-action-read-failure"),
    policy,
  });
  assert.equal(result.action.state, "terminal");
  assert.equal(result.action.outcome, "reset");
  assert.equal(result.action.limitsRefreshed, false);
  assert.equal(result.action.recovery, "unknown");
  assert.equal(result.limits.freshness.state, "stale");
  assert.equal(result.limits.freshness.reason, "read_failed");
  assert.equal(c.counters().consumes, 1);
});

test("Orphan tombstone fences a writer while recovery is paused before its reservation update", async (t) => {
  const c = await setup(t),
    execution = key("orphan-account-lock-gap"),
    reserve = c.journal.reserve.bind(c.journal),
    update = c.journal.updateReservation.bind(c.journal);
  let releaseWriter, writerReserved, releaseRecovery, recoveryUnlocked;
  const writerGate = new Promise((r) => {
    releaseWriter = r;
  });
  const reserved = new Promise((r) => {
    writerReserved = r;
  });
  const recoveryGate = new Promise((r) => {
    releaseRecovery = r;
  });
  const unlocked = new Promise((r) => {
    recoveryUnlocked = r;
  });
  c.journal.reserve = async (...args) => {
    const result = await reserve(...args);
    writerReserved();
    await writerGate;
    return result;
  };
  const original = c.controller.consumeReset(c.binding, {
    origin: "automatic",
    executionKey: execution,
    policy,
  });
  await reserved;
  let firstUpdate = true;
  c.journal.updateReservation = async (...args) => {
    if (firstUpdate) {
      firstUpdate = false;
      recoveryUnlocked();
      await recoveryGate;
    }
    return update(...args);
  };
  const recovery = c.controller.resolvePendingReset(c.binding, {
    executionKey: key("orphan-gap-recovery"),
  });
  await unlocked;
  assert.equal((await c.journal.reservation(execution)).state, "reserved");
  releaseWriter();
  const originalResult = await original;
  assert.equal(originalResult.action.state, "cancelled_before_send");
  assert.equal(c.counters().consumes, 0);
  releaseRecovery();
  await recovery;
  assert.equal(
    (await c.journal.reservation(execution)).state,
    "cancelled_before_send",
  );
});
