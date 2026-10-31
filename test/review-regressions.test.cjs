const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { mkdir, mkdtemp, rm, readFile, writeFile, symlink } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { AccountSessionManager, ProfileStore, CodexChatModel, CodexAuthProvider, ModelCatalog, ResponsesTransport, DEFAULT_SETTINGS, CODEX_CLIENT_ID, ISSUER, parseManualTokens } = require('../dist');
const { ResponseAccumulator } = require('../dist/core/sse');
const { waitForSignal, readJson } = require('../dist/core/http');
const { readPrivateFile } = require('../dist/auth/store');
const { tokenResponse } = require('../dist/auth/provider');
const { rawModel, session, identity, tokens, profile, output, complete, sseResponse, mockFetch } = require('./helpers.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const modelFor = (fetchImpl, extra = {}) => new CodexChatModel({ model: 'synthetic-model', session: async () => session(), catalog: new ModelCatalog(fetchImpl), transport: new ResponsesTransport(fetchImpl), settings: { maxRetries: 0 }, ...extra });
async function storeFor(t) {
  await mkdir('.test-state', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.resolve('.test-state/review-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return { directory, store: new ProfileStore(directory, Buffer.alloc(32, 0x32)) };
}

// The shared task intentionally remains pending after cancellation: listener cleanup must not depend on it.
test('Cancelled shared waiters detach immediately while independent waiters still complete', async () => {
  const task = deferred(); const controller = new AbortController();
  const cancelled = waitForSignal(task.promise, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const remaining = waitForSignal(task.promise);
  task.resolve('completed');
  assert.equal(await remaining, 'completed');
});

test('Already-cancelled catalog calls never return warm data or start cold work', async () => {
  let requests = 0;
  const catalog = new ModelCatalog(async () => { requests++; return Response.json({ models: [rawModel()] }); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(catalog.list(session(), controller.signal), /cancelled/);
  assert.equal(requests, 0);
  await catalog.list(session());
  await assert.rejects(catalog.list(session(), controller.signal), /cancelled/);
  assert.equal(requests, 1);
});

test('JSON and SSE cancellation do not wait for an uncooperative upstream cancel callback', async () => {
  for (const mode of ['json', 'sse']) {
    const controller = new AbortController(); let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { headers: { 'content-type': 'text/event-stream' } });
    const pending = mode === 'json' ? readJson(response, 1000, controller.signal) : (async () => {
      for await (const _ of new ResponsesTransport(async () => response).stream({}, session(), DEFAULT_SETTINGS, [controller.signal], false)) {}
    })();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /cancelled/);
    assert.equal(cancelled, true);
  }
});

test('Invalid reliability settings fail before any account or network operation', async () => {
  let accounts = 0;
  const model = modelFor(async () => { throw new Error('Unexpected network'); }, { session: async () => { accounts++; return session(); }, settings: { timeoutMs: NaN } });
  await assert.rejects(model.invoke('Invalid settings'), /Overall timeout/);
  assert.equal(accounts, 0);
});

test('Model snapshots configuration and fences an account change between tool rounds', async () => {
  let current = session();
  const settings = { maxRetries: 0 };
  const fetchImpl = mockFetch(async () => sseResponse([complete(output())]));
  const model = modelFor(fetchImpl, { settings, session: async () => current });
  settings.timeoutMs = NaN;
  await model.invoke('First round');
  current = session('another-account');
  await assert.rejects(model.invoke('Second round'), /account changed during/);
});

for (const lite of [false, true]) test(`Automatic native formatting works; unproven forced choice is explicit (${lite ? 'Lite' : 'standard'})`, async () => {
  const name = 'format_final_json_response'; let requests = 0;
  const fetchImpl = mockFetch(async request => {
    requests++;
    const definitions = lite ? request.input[0].tools[0].tools : request.tools;
    assert.equal(definitions[0].name, name);
    assert.equal(request.tool_choice, 'auto');
    return sseResponse([complete(output('', { output: [{ type: 'function_call', call_id: 'format_synthetic', name, arguments: '{"answer":1}', ...(lite ? { namespace: 'functions' } : {}) }] }))]);
  }, rawModel({ use_responses_lite: lite }));
  const model = modelFor(fetchImpl);
  assert.deepEqual((await model.bindTools([tool(name)], { parallel_tool_calls: false }).invoke('Format')).tool_calls[0].args, { answer: 1 });
  for (const tool_choice of ['required', 'none', name, { type: 'function', function: { name } }]) await assert.rejects(model.bindTools([tool(name)], { tool_choice }).invoke('Force'), /automatic tool selection only/);
  assert.equal(requests, 1);
});

const call = (extra = {}) => ({ type: 'function_call', id: 'fc_synthetic', call_id: 'call_synthetic', name: 'action', arguments: '{}', ...extra });
const added = item => ({ type: 'response.output_item.added', output_index: 0, item });
const done = item => ({ type: 'response.output_item.done', output_index: 0, item });
for (const [name, events] of [
  ['changed call identity', [added(call({ arguments: '' })), done(call({ call_id: 'changed' }))]],
  ['changed item identity', [added(call({ arguments: '' })), done(call({ id: 'changed' }))]],
  ['changed tool name', [added(call({ arguments: '' })), done(call({ name: 'another' }))]],
  ['changed completed arguments', [{ type: 'response.function_call_arguments.done', item_id: 'fc_synthetic', arguments: '{"x":1}' }, done(call())]],
  ['continued completed arguments', [done(call()), { type: 'response.function_call_arguments.delta', item_id: 'fc_synthetic', delta: ' ' }]],
  ['changed full terminal identity', [added(call({ arguments: '' })), complete(output('', { output: [call({ id: 'changed' })] }))]],
  ['omitted streamed item', [added(call({ arguments: '' })), complete(output())]],
  ['unfinished final item', [complete(output('', { output: [call({ status: 'in_progress' })] }))]],
  ['duplicate terminal identity', [complete(output('', { output: [call(), call()] }))]],
]) test(`Conflicting response cannot authorize tools: ${name}`, () => {
  const accumulator = new ResponseAccumulator();
  assert.throws(() => { for (const event of events) accumulator.consume(event); }, /provider|Provider|completed response/i);
});

test('Empty argument deltas and final arguments without earlier deltas are valid', () => {
  const accumulator = new ResponseAccumulator();
  accumulator.consume(added(call({ arguments: '' })));
  accumulator.consume({ type: 'response.function_call_arguments.delta', item_id: 'fc_synthetic', delta: '' });
  accumulator.consume({ type: 'response.function_call_arguments.delta', item_id: 'fc_synthetic', delta: '{}' });
  accumulator.consume({ type: 'response.function_call_arguments.done', item_id: 'fc_synthetic', arguments: '{}' });
  accumulator.consume(done(call()));
  assert.deepEqual(accumulator.consume({ type: 'response.completed', response: { id: 'resp_synthetic' } }).output, [call()]);
});

for (const lite of [false, true]) test(`Replay retains phase/reasoning once and sends current tool definitions (${lite ? 'Lite' : 'standard'})`, async () => {
  const requests = [];
  const reasoning = { type: 'reasoning', id: 'rs_history', summary: [], encrypted_content: 'SYNTHETIC_OPAQUE' };
  const message = { type: 'message', id: 'msg_history', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working' }] };
  const firstCall = call({ name: 'old_tool', ...(lite ? { namespace: 'functions' } : {}) });
  const fetchImpl = mockFetch(async request => {
    requests.push(request);
    return sseResponse([complete(output('', { output: requests.length === 1 ? [reasoning, message, firstCall] : [] }))]);
  }, rawModel({ use_responses_lite: lite }));
  const model = modelFor(fetchImpl);
  const first = await model.bindTools([tool('old_tool')]).invoke('First');
  await model.bindTools([tool('current_tool')]).invoke([new HumanMessage('First'), first, new ToolMessage({ tool_call_id: firstCall.call_id, content: 'Result' })]);
  assert.deepEqual(requests[1].input.filter(item => item.type === 'reasoning'), [reasoning]);
  assert.deepEqual(requests[1].input.filter(item => item.type === 'message' && item.role === 'assistant'), [message]);
  const definitions = lite ? requests[1].input[0].tools[0].tools : requests[1].tools;
  assert.deepEqual(definitions.map(item => item.name), ['current_tool']);
});

test('Expired reconnect validates binding and account before attempting any refresh', async t => {
  const { store } = await storeFor(t); let refreshes = 0;
  const auth = { verify: async candidate => ({ identity: identity(candidate.accessToken === 'OTHER_SYNTHETIC' ? 'other' : undefined), tokens: candidate }), refresh: async () => { refreshes++; return tokens(); } };
  const manager = new AccountSessionManager(store, auth);
  const binding = await manager.importTokens(tokens(), 'Original');
  const original = await store.read(binding);
  await assert.rejects(manager.importTokens(tokens({ expiresAt: 0 }), 'Invalid binding', { ...binding, bindingSecret: 'WRONG_SYNTHETIC' }), /binding is invalid/);
  await assert.rejects(manager.importTokens(tokens({ accessToken: 'OTHER_SYNTHETIC', expiresAt: 0 }), 'Other identity', binding), /different account/);
  assert.equal(refreshes, 0);
  assert.deepEqual(await store.read(binding), original);
});

test('Import snapshots candidate tokens while verification awaits keys', async t => {
  const { store } = await storeFor(t); const gate = deferred(); const entered = deferred();
  const auth = { verify: async candidate => { entered.resolve(); await gate.promise; return { identity: identity(), tokens: candidate }; }, refresh: async () => { throw new Error('Unexpected refresh'); } };
  const manager = new AccountSessionManager(store, auth); const candidate = tokens();
  const operation = manager.importTokens(candidate, 'Immutable candidate');
  await entered.promise;
  candidate.accessToken = 'MUTATED_SYNTHETIC'; candidate.scopes.push('mutated');
  gate.resolve();
  const saved = await store.read(await operation);
  assert.notEqual(saved.tokens.accessToken, candidate.accessToken);
  assert.equal(saved.tokens.scopes.includes('mutated'), false);
});

test('A stale cross-manager renewal cannot immediately rotate a short-lived replacement again', async t => {
  const { store } = await storeFor(t); let refreshes = 0; const gate = deferred();
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { refreshes++; await gate.promise; return tokens({ expiresAt: Date.now() + 20000 }); } };
  const manager = new AccountSessionManager(store, auth); const other = new AccountSessionManager(store, auth);
  const binding = await manager.importTokens(tokens(), 'Short replacement');
  await store.write({ ...(await store.read(binding)), tokens: tokens({ expiresAt: 0 }) });
  // Hold the file lock until both readers have observed the old generation.
  let firstRead = 0; const read = store.read.bind(store); const both = deferred();
  store.read = async value => { const result = await read(value); if (++firstRead === 2) both.resolve(); return result; };
  const lockGate = deferred(); const locked = deferred();
  const blocker = store.locked(binding.profileId, async () => { locked.resolve(); await lockGate.promise; });
  await locked.promise;
  const one = manager.session(binding); const two = other.session(binding);
  await both.promise; lockGate.resolve(); gate.resolve();
  await Promise.all([blocker, one, two]);
  assert.equal(refreshes, 1);
});

test('An ambiguous imported renewal cannot be retried with the same rotating token after restart', async t => {
  const { store } = await storeFor(t); let refreshes = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { refreshes++; throw new Error('SYNTHETIC_AMBIGUOUS'); } };
  await assert.rejects(new AccountSessionManager(store, auth).importTokens(tokens({ expiresAt: 0 }), 'First attempt'));
  await assert.rejects(new AccountSessionManager(store, auth).importTokens(tokens({ expiresAt: 0 }), 'Retry'), /already used|claimed safely|already owned/);
  assert.equal(refreshes, 1);
});

test('Private file reads reject symlinks and AES associated data rejects swapped profiles', async t => {
  const { store, directory } = await storeFor(t);
  const one = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_ONE' };
  const two = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_TWO' };
  await store.write(profile(one)); await store.write(profile(two));
  const firstFile = path.join(directory, `${one.profileId}.json.enc`);
  const secondFile = path.join(directory, `${two.profileId}.json.enc`);
  const link = path.join(directory, 'synthetic-link'); await symlink(firstFile, link);
  await assert.rejects(readPrivateFile(link, 1024 * 1024), /protected file/);
  await writeFile(secondFile, await readFile(firstFile));
  await assert.rejects(store.read(two), /could not be read/);
});

test('Manual import and grant metadata reject malformed timestamps, scopes and lifetimes', () => {
  for (const extra of [{ expires_at: NaN }, { earliest_refresh_at: -1 }, { scopes: 'openid' }]) assert.throws(() => parseManualTokens({ provider: 'codex-subscription-experimental', client_id: CODEX_CLIENT_ID, access_token: 'SYNTHETIC', ...extra }, 'token-set'));
  assert.throws(() => parseManualTokens({}, 'unrecognized'), /supported manual import format/);
  for (const extra of [{ expires_in: Infinity }, { expires_in: -1 }, { token_type: 'MAC' }, { earliest_refresh_at: NaN }]) assert.throws(() => tokenResponse({ access_token: 'SYNTHETIC', ...extra }));
});

test('Signed negative issuer, audience, expiry and not-before claims fail verification', async () => {
  const { SignJWT, exportJWK } = await import('jose');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-key', alg: 'RS256' };
  const auth = new CodexAuthProvider(async () => Response.json({ keys: [jwk] }));
  const base = { iss: ISSUER, aud: 'https://api.openai.com/v1', sub: 'synthetic', client_id: CODEX_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } };
  for (const extra of [{ iss: 'https://incorrect.invalid' }, { aud: 'wrong' }, { exp: 0 }, { nbf: Math.floor(Date.now() / 1000) + 3600 }, { nbf: 'invalid' }]) {
    const signed = await new SignJWT({ ...base, ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' }).sign(privateKey);
    await assert.rejects(auth.verify(tokens({ accessToken: signed })));
  }
});

test('Device polling cancellation stops a pending login without exchange or token exposure', async () => {
  const controller = new AbortController(); let calls = 0;
  const auth = new CodexAuthProvider(async (url) => {
    calls++;
    if (String(url).endsWith('/usercode')) return Response.json({ device_auth_id: 'SYNTHETIC_DEVICE', user_code: 'SYNTHETIC-CODE', interval: '60' });
    setTimeout(() => controller.abort(), 10);
    return new Response('SYNTHETIC_SECRET_MUST_NOT_APPEAR', { status: 403 });
  });
  await assert.rejects(auth.deviceLogin(() => {}, controller.signal), error => /cancelled/.test(error.message) && !error.message.includes('SYNTHETIC_SECRET'));
  assert.equal(calls, 2);
});

test('Refresh grant errors never expose provider bodies, including invalid_grant variants', async () => {
  for (const [status, body, category] of [[400, { error: 'invalid_grant', message: 'SYNTHETIC_SECRET' }, 'reconnect'], [400, { error: { code: 'refresh_token_reused', message: 'SYNTHETIC_SECRET' } }, 'reconnect'], [503, { detail: 'SYNTHETIC_SECRET' }, 'provider']]) {
    const auth = new CodexAuthProvider(async () => Response.json(body, { status }));
    await assert.rejects(auth.refresh(tokens()), error => error.category === category && !error.message.includes('SYNTHETIC_SECRET'));
  }
});

test('Already-cancelled wait observes an already-rejected operation without an unhandled rejection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForSignal(Promise.reject(new Error('SYNTHETIC_LATE_FAILURE')), controller.signal), /cancelled/);
  await new Promise(resolve => setImmediate(resolve));
});

test('Explicitly empty terminal output cannot authorize previously streamed tools', () => {
  const accumulator = new ResponseAccumulator(); accumulator.consume(done(call()));
  assert.throws(() => accumulator.consume(complete(output('', { output: [] }))), /omitted a streamed output item/);
});

test('SSE accepts a large line across tiny chunks and bounded empty multiline data', async () => {
  const { sseEvents } = require('../dist/core/sse');
  const payload = 'x'.repeat(256 * 1024);
  const response = sseResponse([{ type: 'synthetic', payload }], { split: 17 });
  const result = [];
  for await (const event of sseEvents(response.body, new AbortController().signal, 1000)) result.push(event);
  assert.equal(result[0].payload, payload);
  const body = new ReadableStream({ start(c) { c.enqueue(Buffer.from('data:\n'.repeat(65537))); c.close(); } });
  await assert.rejects(async () => { for await (const _ of sseEvents(body, new AbortController().signal, 1000)) {} }, /size limit/);
});
