const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require('../dist');
const { AccountReader } = require('../dist/account/usage');
const { CodexAccountRouterModel } = require('../dist/routing/model');
const { coordinator, clearCoordinator } = require('../dist/routing/coordinator');
const { clearExecutionUsage } = require('../dist/core/execution-usage');
const { session, identity, profile, rawModel, output, complete, sseResponse } = require('./helpers.cjs');

for (const router of [false, true])
  for (const lite of [false, true])
    test(`${router ? 'Router' : 'Automatic leaf'} ${lite ? 'Lite' : 'standard'} classifies429 with a post-boundary read`, async (t) => {
      for (const currentAllowed of [false, true]) {
        const context = { instanceId: 'synthetic', workflowId: 'rejection-boundary', executionId: randomUUID(), nodeId: 'model', nodeName: 'Model' };
        t.after(() => { clearCoordinator(context); clearExecutionUsage(context); });
        const binding = { profileId: randomUUID(), bindingSecret: 'synthetic' };
        const a = { ...session('a'), identity: identity('a') };
        const sessions = { refreshEnabled: false, store: { read: async () => profile(binding) }, session: async () => a, currentSession: async () => a };
        let release, started, usageGets = 0, rejected = false, resets = 0;
        const pending = new Promise((r) => { release = r; });
        const startedPromise = new Promise((r) => { started = r; });
        const usage = (allowed) => ({ account_id: 'a', rate_limit: { allowed, limit_reached: !allowed, primary_window: { used_percent: allowed ? 20 : 100, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600, reset_after_seconds: 3600 } }, rate_limit_reached_type: allowed ? null : { type: 'rate_limit_reached' } });
        const reader = new AccountReader(sessions, async () => {
          if (++usageGets === 1) { started(); await pending; return Response.json(usage(!currentAllowed)); }
          return Response.json(usage(rejected ? currentAllowed : true));
        });
        const old = reader.readAccount(binding, { force: true });
        await startedPromise;
        const calls = [];
        const make = (id) => new CodexChatModel({
          model: 'synthetic-model', context, candidateKey: id,
          session: async () => id === 'a' ? a : { ...session('b'), identity: identity('b') },
          catalog: new ModelCatalog(async () => Response.json({ models: [rawModel({ use_responses_lite: lite })] })),
          transport: new ResponsesTransport(async () => {
            calls.push(id);
            if (id === 'a' && !rejected) {
              rejected = true;
              // The old read remains in flight when the rejection hook begins.
              setTimeout(release, 20);
              return new Response('', { status: 429 });
            }
            return sseResponse([complete(output('safe'))]);
          }),
          settings: { maxRetries: 0 },
          account: {
            binding,
            reader: id === 'a' ? reader : { readAccount: async () => ({ ...await reader.readAccount(binding), routing: { decision: 'allowed' } }) },
            policy: { automatic: !router, threshold: 1, maxPer24Hours: 1, order: 'next-first' },
            reset: { consumeReset: async () => { resets++; return { action: { state: 'terminal', recovery: 'allowed', outcome: 'reset' } }; } },
          },
        });
        const model = router ? new CodexAccountRouterModel({ candidates: [make('a'), make('b')], coordinator: coordinator(context).value, context, unknownLimits: 'try' }) : make('a');
        if (currentAllowed) await assert.rejects(model.invoke('Fresh task'), (e) => e.category === 'rate_limit');
        else assert.equal((await model.invoke('Fresh task')).content, 'safe');
        await old;
        assert.equal(usageGets, 3, 'one distinct post429 GET, beside the old forcedGET and ordinary preflight');
        assert.deepEqual(calls, currentAllowed ? ['a'] : router ? ['a', 'b'] : ['a', 'a']);
        assert.equal(resets, !router && !currentAllowed ? 1 : 0);
        const cached = await reader.readAccount(binding);
        assert.equal(cached.routing.decision, currentAllowed ? 'allowed' : 'quota_exhausted', 'late old response cannot overwrite the current cache');
        assert.equal(usageGets, 3);
      }
    });
