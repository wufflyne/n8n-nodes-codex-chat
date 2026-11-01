const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { CodexChatModel, ModelCatalog, ResponsesTransport, ProfileStore, CodexAuthProvider, CODEX_CLIENT_ID } = require('../dist');
const { session, profile, output, textEvent, complete, sseResponse, mockFetch, rawModel } = require('./helpers.cjs');

test('Codex sparse completion reassembles interleaved tools from output_item.done in provider order', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_sparse', encrypted_content: 'SYNTHETIC_REASONING', summary: [] };
  const one = { type: 'function_call', id: 'fc_sparse_one', call_id: 'call_sparse_one', name: 'native_tool', arguments: '{"value":1}' };
  const two = { type: 'function_call', id: 'fc_sparse_two', call_id: 'call_sparse_two', name: 'native_tool', arguments: '{"value":2}' };
  const fetchImpl = mockFetch(async () => sseResponse([
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
    { type: 'response.output_item.added', output_index: 1, item: { ...one, arguments: '' } },
    { type: 'response.output_item.added', output_index: 2, item: { ...two, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: one.id, delta: '{"value":' },
    { type: 'response.function_call_arguments.delta', item_id: two.id, delta: '{"value":2}' },
    { type: 'response.function_call_arguments.delta', item_id: one.id, delta: '1}' },
    { type: 'response.output_item.done', output_index: 2, item: two },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, item: one },
    { type: 'response.completed', response: { id: 'resp_sparse', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
  ], { split: 7, newline: '\r' }));
  const model = new CodexChatModel({ model: 'synthetic-model', session: async () => session(), catalog: new ModelCatalog(fetchImpl), transport: new ResponsesTransport(fetchImpl) });
  const result = await model.bindTools([{ type: 'function', function: { name: 'native_tool', parameters: { type: 'object', properties: { value: { type: 'number' } } } } }]).invoke('Sparse tool response');
  assert.deepEqual(result.tool_calls.map(call => call.args.value), [1, 2]);
  assert.deepEqual(result.additional_kwargs.codex_response.items, [reasoning, one, two]);
  assert.equal(result.usage_metadata.total_tokens, 5);
});

test('Shared catalog fetch outlives cancellation of one caller and invalidates on session generation', async () => {
  let requests = 0;
  const catalog = new ModelCatalog(async () => { requests++; await new Promise(resolve => setTimeout(resolve, 40)); return Response.json({ models: [rawModel()] }); });
  const controller = new AbortController();
  const first = catalog.list(session(), controller.signal);
  const second = catalog.list(session());
  controller.abort();
  await assert.rejects(first, /cancelled/);
  assert.equal((await second).length, 1);
  assert.equal(requests, 1);
  await catalog.list({ ...session(), generation: 2 });
  assert.equal(requests, 2);
});

test('Provider device-code handshake and renewable grant use the distinct Codex client contract', async () => {
  const calls = [];
  const auth = new CodexAuthProvider(async (url, init) => {
    calls.push({ url: String(url), body: init.body, type: init.headers['Content-Type'] });
    if (String(url).endsWith('/usercode')) return Response.json({ device_auth_id: 'SYNTHETIC_DEVICE', user_code: 'SYNTHETIC_CODE', interval: '1' });
    if (String(url).endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'SYNTHETIC_AUTH_CODE', code_verifier: 'SYNTHETIC_VERIFIER', code_challenge: 'SYNTHETIC_CHALLENGE' });
    return Response.json({ access_token: 'SYNTHETIC_NEW_ACCESS', refresh_token: 'SYNTHETIC_NEW_REFRESH', id_token: 'SYNTHETIC_ID', token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access' });
  });
  let prompted = false;
  const tokens = await auth.deviceLogin((url, code) => { prompted = true; assert.equal(url, 'https://auth.openai.com/codex/device'); assert.equal(code, 'SYNTHETIC_CODE'); });
  assert.equal(prompted, true);
  assert.equal(calls.length, 3);
  const grant = new URLSearchParams(calls[2].body);
  assert.equal(grant.get('client_id'), CODEX_CLIENT_ID);
  assert.equal(grant.get('code_verifier'), 'SYNTHETIC_VERIFIER');
  assert.equal(grant.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  await auth.refresh(tokens);
  assert.equal(JSON.parse(calls[3].body).grant_type, 'refresh_token');
  assert.equal(calls[3].type, 'application/json');
});

test('Native n8n supplyData returns an actual bindable model and respects execution cancellation', async t => {
  await mkdir('.test-state', { mode: 0o700, recursive: true });
  const directory = await mkdtemp(path.resolve('.test-state/native-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const binding = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_BINDING_ONLY' };
  const syntheticKey = Buffer.alloc(32, 0x4e);
  await new ProfileStore(directory, syntheticKey).write(profile(binding));
  const prior = { fetch: global.fetch, dir: process.env.N8N_CODEX_STORE_DIR, key: process.env.N8N_CODEX_STORE_KEY };
  process.env.N8N_CODEX_STORE_DIR = directory;
  process.env.N8N_CODEX_STORE_KEY = syntheticKey.toString('base64');
  global.fetch = mockFetch(async () => sseResponse([textEvent('Native result'), complete(output('Native result'))]));
  t.after(() => { global.fetch = prior.fetch; for (const [key, value] of [['N8N_CODEX_STORE_DIR', prior.dir], ['N8N_CODEX_STORE_KEY', prior.key]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { CodexChatModel: Node } = require('../dist/nodes/CodexChatModel/CodexChatModel.node');
  const definition = new Node();
  assert.deepEqual(definition.description.outputs, ['ai_languageModel']);
  const controller = new AbortController();
  const supplied = await definition.supplyData.call({
    getCredentials: async () => binding,
    getNodeParameter: (key, _index, fallback) => key === 'model' ? 'synthetic-model' : fallback,
    getExecutionCancelSignal: () => controller.signal,
    getChatTrigger: () => null, getNode: () => ({ id: 'synthetic-node', name: 'Synthetic native node' }),
    getInstanceId: () => 'synthetic-instance', getWorkflow: () => ({id:'synthetic-workflow'}), addInputData: () => ({index:0}), addOutputData: () => {}, getExecutionId: () => 'synthetic-execution', onExecutionFinish: callback => t.after(callback), onExecutionCancellation: () => {},
  }, 0);
  assert(supplied.response instanceof CodexChatModel);
  assert.equal(typeof supplied.response.bindTools, 'function');
  const result = await supplied.response.invoke([new HumanMessage('Native contract')]);
  assert.equal(result.content, 'Native result');
  controller.abort();
  await assert.rejects(supplied.response.invoke('Cancelled execution'), /cancelled/);
  const exported = JSON.stringify({ ...definition.description, credentials: { codexAccount: { id: 'synthetic-credential-id', name: 'Synthetic profile' } } });
  assert.equal(exported.includes(binding.bindingSecret), false);
  assert.equal(exported.includes('SYNTHETIC_ACCESS_TOKEN'), false);
});
