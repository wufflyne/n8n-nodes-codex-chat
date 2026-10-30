const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HumanMessage } = require('@langchain/core/messages');
const { CodexChatModel, ModelCatalog, ResponsesTransport, ProfileStore, AccountSessionManager } = require('../dist');
const { AccountReader } = require('../dist/account/usage');
const { ResetStore } = require('../dist/account/reset-store');
const { ResetController } = require('../dist/account/reset');
const { CodexAccountRouterModel } = require('../dist/routing/model');
const { coordinator, clearCoordinator } = require('../dist/routing/coordinator');
const { clearExecutionUsage } = require('../dist/core/execution-usage');
const { profile, rawModel, complete, output, sseResponse } = require('./helpers.cjs');
const tool = { type: 'function', function: { name: 'safe', parameters: { type: 'object', properties: {} } } };
const schema = { type: 'json_schema', name: 'result', strict: true, schema: { type: 'object', properties: {} } };
for (const lite of [false, true])
  for (const mode of ['leaf', 'reset-first', 'next-first'])
    test(`Automatic ${mode} ${lite ? 'Lite' : 'standard'} validates local input before consuming a credit`, async (t) => {
      const invalid = [
        { name: 'invalid raster', input: [new HumanMessage({ content: [{ type: 'image_url', image_url: 'data:image/png;base64,AAAA' }] })] },
        { name: 'unsupported content', input: [new HumanMessage({ content: [{ type: 'file', file: { file_data: 'synthetic' } }] })] },
        { name: 'tools and direct schema', options: { tools: [tool], codexOutputFormat: schema } },
        { name: 'malformed tool', options: { tools: [{ type: 'function', function: { name: 'safe', strict: 'yes' } }] } },
        { name: 'invalid direct schema', options: { codexOutputFormat: { ...schema, schema: { type: 'object', $ref: 'https://example.invalid/schema' } } } },
        { name: 'invalid affinity', affinityPolicy: { mode: 'conversation', conversationKey: '' } },
        { name: 'stop option', options: { stop: ['stop'] } },
        { name: 'oversize request', input: 'x'.repeat(32 * 1024 * 1024) },
        { name: 'valid recovery', valid: true },
      ];
      for (const fixture of invalid) {
        await fs.mkdir('.test-state', { recursive: true, mode: 0o700 });
        const directory = await fs.mkdtemp(path.resolve('.test-state/reset-validation-'));
        const master = Buffer.alloc(32, 73), binding = { profileId: randomUUID(), bindingSecret: 'synthetic' };
        const store = new ProfileStore(directory, master); await store.write(profile(binding));
        const sessions = new AccountSessionManager(store, { verify: async () => { throw Error('No verify'); }, refresh: async () => { throw Error('No refresh'); } }, false);
        let posts = 0, generations = 0;
        const provider = async (url) => {
          if (String(url).endsWith('/consume')) { posts++; return Response.json({ code: 'reset', windows_reset: 1 }); }
          if (String(url).endsWith('/usage')) return Response.json({ account_id: 'synthetic-account', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: posts ? 0 : 99, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600, reset_after_seconds: 3600 } }, rate_limit_reset_credits: { available_count: 1 } });
          return Response.json({ available_count: 1, credits: [{ id: 'synthetic-credit', reset_type: 'codex_rate_limits', status: 'available', granted_at: new Date(Date.now() - 60000).toISOString(), expires_at: null }] });
        };
        const reader = new AccountReader(sessions, provider), reset = new ResetController(reader, new ResetStore(directory, master), provider);
        const context = { instanceId: 'synthetic', workflowId: 'validation', executionId: randomUUID(), nodeId: 'model', nodeName: 'Model' };
        const policy = { automatic: mode === 'leaf', threshold: 1, maxPer24Hours: 1, order: mode === 'next-first' ? 'next-first' : 'reset-first' };
        const make = (id) => new CodexChatModel({
          model: 'synthetic-model', candidateKey: id, context, affinityPolicy: fixture.affinityPolicy,
          session: async () => { const s = await sessions.session(binding); return id === 'a' ? s : { ...s, affinity: s.affinity + 'b', accountId: 'other', identity: { ...s.identity, accountId: 'other' } }; },
          catalog: new ModelCatalog(async () => Response.json({ models: [rawModel({ use_responses_lite: lite })] })),
          transport: new ResponsesTransport(async () => { generations++; return sseResponse([complete(output('safe'))]); }),
          account: { binding, reader, reset, policy },
        });
        let model = make('a');
        if (mode !== 'leaf') model = new CodexAccountRouterModel({ candidates: [model, make('b')], coordinator: coordinator(context).value, context, unknownLimits: 'try', policy: { ...policy, automatic: true }, affinityPolicy: fixture.affinityPolicy });
        try {
          if (fixture.valid) assert.equal((await model.invoke('Fresh valid task')).content, 'safe');
          else await assert.rejects(model.invoke(fixture.input ?? 'Fresh task', fixture.options ?? {}), undefined, fixture.name);
          assert.equal(posts, fixture.valid ? 1 : 0, fixture.name + ': reset POST count');
          assert.equal(generations, fixture.valid ? 1 : 0, fixture.name + ': Responses count');
        } finally { clearCoordinator(context); clearExecutionUsage(context); await fs.rm(directory, { recursive: true, force: true }); }
      }
    });
