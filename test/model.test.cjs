const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HumanMessage, SystemMessage, ToolMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } = require('@langchain/core/messages');
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require('../dist');
const { rawModel, session, output, textEvent, complete, sseResponse, mockFetch } = require('./helpers.cjs');

const fn = name => ({ type: 'function', function: { name, description: 'Synthetic test tool', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } });
function createModel(fetchImpl, extra = {}) { return new CodexChatModel({ model: 'synthetic-model', session: async () => session(), catalog: new ModelCatalog(fetchImpl), transport: new ResponsesTransport(fetchImpl), settings: { maxRetries: 0 }, ...extra }); }

for (const lite of [false, true]) test(`Native model preserves parallel tools and opaque history through serialization (${lite ? 'Responses Lite' : 'Responses'})`, async () => {
  const requests = [];
  const reasoning = { type: 'reasoning', id: 'rs_synthetic', summary: [], encrypted_content: 'SYNTHETIC_OPAQUE_REASONING' };
  const calls = ['lookup-a', 'lookup-b'].map((name, i) => ({ type: 'function_call', id: `fc_${i}`, call_id: `call_${i}`, name, arguments: JSON.stringify({ value: i + 1 }), status: 'completed', ...(lite ? { namespace: 'functions' } : {}) }));
  const fetchImpl = mockFetch(async request => {
    requests.push(request);
    if (requests.length === 1) return sseResponse([
      { type: 'response.output_item.added', output_index: 1, item: { ...calls[0], arguments: '' } },
      { type: 'response.output_item.added', output_index: 2, item: { ...calls[1], arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_0', delta: '{"value":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"value":2}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_0', delta: '1}' },
      complete(output('', { output: [reasoning, ...calls] })),
    ], { split: 1, newline: '\r\n' });
    return sseResponse([textEvent('Done ✓'), complete(output('Done ✓'))], { split: 1 });
  }, rawModel({ use_responses_lite: lite }));
  const model = createModel(fetchImpl).bindTools([fn('lookup-a'), fn('lookup-b')]);
  const initial = [new SystemMessage('Use the native tools.'), new HumanMessage('Compute two values.')];
  const first = await model.invoke(initial);
  assert.equal(first.tool_calls.length, 2);
  assert.deepEqual(first.tool_calls.map(c => [c.id, c.name, c.args.value]), [['call_0', 'lookup-a', 1], ['call_1', 'lookup-b', 2]]);
  const restored = mapStoredMessagesToChatMessages(mapChatMessagesToStoredMessages([first]));
  const final = await model.invoke([...initial, ...restored, new ToolMessage({ tool_call_id: 'call_0', content: '1' }), new ToolMessage({ tool_call_id: 'call_1', content: '2' })]);
  assert.equal(final.content, 'Done ✓');
  assert.equal(final.usage_metadata.total_tokens, 12);
  assert.deepEqual(requests[1].input.filter(item => item.type === 'reasoning'), [reasoning]);
  assert.equal(requests[1].input.filter(item => item.type === 'function_call').length, 2);
  assert.equal(requests[1].input.filter(item => item.type === 'function_call_output').length, 2);
  assert.equal(requests[0].store, false); assert.equal(requests[0].stream, true);
  if (lite) {
    assert.equal(requests[0].tools, undefined);
    assert.equal(requests[0].input[0].type, 'additional_tools');
    assert.equal(requests[0].reasoning.context, 'all_turns');
    assert.equal(requests[0].input[0].tools[0].name, 'functions');
  } else assert.equal(requests[0].tools.length, 2);
});

test('Native structured-output tool and automatic bindTools options reach the provider without an agent loop', async () => {
  let seen;
  const fetchImpl = mockFetch(async request => {
    seen = request;
    return sseResponse([complete(output('', { output: [{ type: 'function_call', call_id: 'format_1', name: 'format_final_json_response', arguments: '{"value":7}' }] }))]);
  });
  const result = await createModel(fetchImpl).bindTools([fn('format_final_json_response')], { tool_choice: 'auto', parallel_tool_calls: false }).invoke('Format the result.');
  assert.equal(seen.parallel_tool_calls, false);
  assert.equal(seen.tool_choice, 'auto');
  assert.deepEqual(result.tool_calls[0].args, { value: 7 });
});

test('Warm invocations reuse the account catalog and keep profile histories isolated', async () => {
  let catalogRequests = 0;
  const basic = mockFetch(async () => sseResponse([complete(output())]));
  const fetchImpl = async (...args) => { if (String(args[0]).includes('/models?')) catalogRequests++; return basic(...args); };
  const model = createModel(fetchImpl);
  const message = await model.invoke('First');
  await model.invoke('Second');
  assert.equal(catalogRequests, 1);
  const other = createModel(fetchImpl, { session: async () => session('other-account') });
  await assert.rejects(other.invoke([new HumanMessage('Cross account'), message]), /different account/);
});

test('Streaming exposes text but withholds all tools until a successful terminal event', async () => {
  const fetchImpl = mockFetch(async () => sseResponse([textEvent('Visible'), { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'bad', name: 'action', arguments: '{}' } }, { type: 'response.failed', response: { error: { message: 'SYNTHETIC_SECRET_MUST_NOT_APPEAR' } } }]));
  const stream = await createModel(fetchImpl).bindTools([fn('action')]).stream('Fail late');
  let text = ''; let calls = 0;
  await assert.rejects(async () => { for await (const chunk of stream) { text += chunk.content; calls += chunk.tool_calls?.length ?? 0; } }, error => !error.message.includes('SYNTHETIC_SECRET') && /failed response/.test(error.message));
  assert.equal(text, 'Visible'); assert.equal(calls, 0);
});

test('Malformed complete tool arguments are rejected atomically', async () => {
  const fetchImpl = mockFetch(async () => sseResponse([complete(output('', { output: [
    { type: 'function_call', call_id: 'ok', name: 'action', arguments: '{}' },
    { type: 'function_call', call_id: 'invalid', name: 'action', arguments: '{partial' },
  ] }))]));
  await assert.rejects(createModel(fetchImpl).bindTools([fn('action')]).invoke('Test invalid arguments'), /invalid tool arguments/);
});

test('Unsupported reasoning and speed are rejected using catalog evidence', async () => {
  let inference = 0;
  const fetchImpl = mockFetch(async () => { inference++; return sseResponse([complete(output())]); });
  await assert.rejects(createModel(fetchImpl, { settings: { reasoningEffort: 'ultra' } }).invoke('Test'), /reasoning effort/);
  await assert.rejects(createModel(fetchImpl, { settings: { serviceTier: 'ultrafast' } }).invoke('Test'), /speed tier/);
  assert.equal(inference, 0);
});

test('Native credential definition and model serialization do not expose account tokens', async () => {
  const { CodexAccount } = require('../dist/credentials/CodexAccount.credentials');
  const fields = new CodexAccount().properties;
  assert.equal(fields.find(p => p.name === 'bindingSecret').typeOptions.password, true);
  assert.equal(fields.some(p => /accessToken|refreshToken/.test(p.name)), false);
  const model = createModel(mockFetch(async () => sseResponse([complete(output())])));
  assert.equal(JSON.stringify(model.toJSON()).includes('SYNTHETIC_ACCESS_TOKEN'), false);
});
