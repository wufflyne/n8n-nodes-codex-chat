'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const source = path.resolve(__dirname,'..'), stateRoot = path.join(source,'.test-state/v010-boundaries');
const { test } = require('node:test'), assert = require('node:assert/strict');
const load = (name) => require(path.join(source, 'dist', name));
const { ProfileStore } = load('auth/store'), { AccountSessionManager } = load('auth/sessions');
const { CodexAuthProvider } = load('auth/provider');
const { StateRepository } = load('gateway/state/repository'), { GatewayEngine } = load('gateway/engine');
const { GatewayApplication } = load('gateway/server'), { EmbeddedService } = load('service/embedded');
const { RemoteService } = load('service/remote'), { serviceModel } = load('adapters/langchain/service-model');
const { ModelCatalog } = load('core/catalog'), { ResponsesTransport } = load('core/transport');
const { AccountReader } = load('account/usage'), { DEFAULT_RECOVERY } = load('account/types');
const h = require(path.join(source, 'test/helpers.cjs'));
const messages = require(path.join(source, 'node_modules/@langchain/core/messages'));
const schema = { type:'object', properties:{value:{type:'number'}}, required:['value'], additionalProperties:false };
async function fixture(t, lite, outputFor) {
 await fs.mkdir(stateRoot,{recursive:true,mode:0o700});
 const dir=await fs.mkdtemp(path.join(stateRoot,'boundary-')),key=Buffer.alloc(32,0x6a),binding={profileId:crypto.randomUUID(),bindingSecret:'synthetic-independent-binding'};
 const store=new ProfileStore(path.join(dir,'profiles'),key);await store.write(h.profile(binding,{tokens:h.tokens({refreshToken:undefined})}));
 const sessions=new AccountSessionManager(store,{verify:async()=>{throw Error('Unexpected auth');},refresh:async()=>{throw Error('Unexpected refresh');}},false);let calls=0;
 const resources={store,sessions,catalog:new ModelCatalog(async()=>Response.json({models:[h.rawModel({use_responses_lite:lite})]})),transport:new ResponsesTransport(async(_url,init)=>h.sseResponse([h.complete(h.output('',{output:outputFor(JSON.parse(init.body),++calls)}))])),account:new AccountReader(sessions,async()=>Response.json({})),auth:{deviceLogin:async()=>{throw Error('Unexpected device');}}};
 const state=new StateRepository(path.join(dir,'state/gateway.db'),key);await state.open();
 const app=new GatewayApplication({admin:{bootstrapFile:path.join(dir,'bootstrap')}},new GatewayEngine(resources,state,true));
 const delivery=await app.authorization.prepareKey({role:'installation',scopes:['native:*','native:reset'],installationId:'independent-instance',profiles:[binding.profileId]});await app.authorization.acknowledge(delivery.deliveryId);
 const file=path.join(dir,'installation.key');await fs.writeFile(file,delivery.key,{mode:0o600});
 const remote=new RemoteService('https://synthetic.invalid',file,(url,init)=>app.inference(new Request(url,init)));
 t.after(async()=>{await app.settle();await state.close();await fs.rm(dir,{recursive:true,force:true});});
 const make=(remoteMode)=>serviceModel(remoteMode?remote:new EmbeddedService(resources),binding,{model:'synthetic-model',settings:{maxRetries:0},context:{instanceId:'independent-instance',workflowId:'wf',executionId:crypto.randomUUID(),nodeId:'model',nodeName:'Model'},policy:DEFAULT_RECOVERY});
 return {dir,key,store,binding,resources,state,app,remote,make,calls:()=>calls,close:async()=>{await app.settle();await state.close();}};
}

for (const lite of [false, true]) for (const remoteMode of [false, true]) {
  const cell = `${remoteMode ? 'remote' : 'embedded'}/${lite ? 'Lite' : 'Standard'}`;
  for (const kind of ['schema', 'json', 'name', 'valid']) test(`CW010-R09 A09: owned function includeRaw parity ${cell}/${kind}`, async t => {
    const f = await fixture(t, lite, request => {
      const tool = (request.tools ?? request.input.find(i => i.type === 'additional_tools').tools[0].tools)[0];
      return [{ type: 'function_call', id: 'fc_owned', call_id: 'call_owned', name: kind === 'name' ? 'unexpected' : tool.name,
        arguments: kind === 'json' ? '{invalid' : JSON.stringify({ value: kind === 'schema' ? 'invalid' : 7 }), ...(lite ? { namespace: 'functions' } : {}) }];
    });
    const result = await f.make(remoteMode).withStructuredOutput(schema, { includeRaw: true }).invoke('Synthetic');
    assert.deepEqual(result.parsed, kind === 'valid' ? { value: 7 } : null);
    assert.equal(result.raw.tool_calls.length, kind === 'valid' ? 1 : 0);
    assert.equal(result.raw.invalid_tool_calls.length, kind === 'valid' ? 0 : 1);
    assert.equal(f.calls(), 1);
    if (kind !== 'valid') await assert.rejects(f.make(remoteMode).withStructuredOutput(schema).invoke('Synthetic'));
  });
  for (const kind of ['invalid', 'valid']) test(`CW010-R09 A09: direct JSON includeRaw parity ${cell}/${kind}`, async t => {
    const f = await fixture(t, lite, () => h.output(kind === 'valid' ? '{"value":7}' : '{"value":"invalid"}').output);
    const result = await f.make(remoteMode).withStructuredOutput(schema, { includeRaw: true, method: 'jsonSchema' }).invoke('Synthetic');
    assert.deepEqual(result.parsed, kind === 'valid' ? { value: 7 } : null);
    assert.equal(result.raw.tool_calls.length, 0); assert.equal(f.calls(), 1);
  });
  for (const method of ['functionCalling', 'jsonSchema']) test(`CW010-R09/R13 A09/A29: owned diagnostics never enter the caller Zod parser ${cell}/${method}`, async t => {
    const z = require(path.join(source, 'node_modules/zod'));
    let parsed = 0;
    const owned = z.object({ values: z.array(z.string().refine(() => { parsed++; return true; })).max(2) });
    const f = await fixture(t, lite, (request, turn) => {
      const value = JSON.stringify({ values: Array(turn === 1 ? 10000 : 2).fill('value') });
      if (method === 'jsonSchema') return h.output(value).output;
      const tool = (request.tools ?? request.input.find(i => i.type === 'additional_tools').tools[0].tools)[0];
      return [{ type: 'function_call', id: 'fc_zod', call_id: 'call_zod', name: tool.name, arguments: value, ...(lite ? { namespace: 'functions' } : {}) }];
    });
    const model = f.make(remoteMode).withStructuredOutput(owned, { includeRaw: true, method });
    const invalid = await model.invoke('Synthetic oversized collection');
    assert.equal(invalid.parsed, null); assert.equal(parsed, 0);
    const valid = await model.invoke('Synthetic valid collection');
    assert.deepEqual(valid.parsed, { values: ['value', 'value'] }); assert.equal(parsed, 2);
  });
  for (const summary of [undefined, 'invalid', null, []]) test(`CW010-R10 A10: reasoning summary ${JSON.stringify(summary)} ${cell}`, async t => {
    const f = await fixture(t, lite, (_, n) => n === 1 ? [
      { type: 'reasoning', id: 'rs_test', encrypted_content: 'SYNTHETIC_OPAQUE', ...(summary === undefined ? {} : { summary }) },
      { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'lookup', arguments: '{"value":1}', ...(lite ? { namespace: 'functions' } : {}) },
    ] : h.output('Complete').output);
    const model = f.make(remoteMode).bindTools([{ type: 'function', function: { name: 'lookup', parameters: schema } }]);
    let exposed = 0;
    if (!Array.isArray(summary)) {
      await assert.rejects((async () => { for await (const chunk of await model.stream('Synthetic')) exposed += chunk.tool_calls.length + (chunk.tool_call_chunks?.length ?? 0); })());
      assert.equal(exposed, 0); assert.equal(f.calls(), 1);
    } else {
      const result = await model.invoke('Synthetic'); assert.equal(result.tool_calls.length, 1);
      const final = await model.invoke([new messages.HumanMessage('Synthetic'), result, new messages.ToolMessage({ tool_call_id: 'call_test', content: '1' })]);
      assert.equal(final.content, 'Complete'); assert.equal(f.calls(), 2);
    }
  });
}

for (const lite of [false, true]) test(`CW010-R08 A06: native settings omissions reject and semantically equivalent original payload survives ${lite}`, async t => {
  const { DEFAULT_SETTINGS } = load('model'), { parseModel } = load('core/catalog'), { canonicalRequest } = load('kernel/request');
  const settings = { ...DEFAULT_SETTINGS, reasoningEffort: 'high', reasoningSummary: 'detailed', verbosity: 'high', maxRetries: 0 };
  const model = parseModel(h.rawModel({ use_responses_lite: lite })); let received;
  const f = await fixture(t, lite, request => { received = request; return h.output('Done').output; });
  const request = canonicalRequest({ model: model.slug, input: [{ role: 'user', content: 'Synthetic' }], tools: [], settings }, model, false);
  const context = { instanceId: 'independent-instance', workflowId: 'wf', executionId: 'settings', nodeId: 'model', nodeName: 'Model' };
  for (const field of ['reasoning', 'text']) {
    const malformed = structuredClone(request); delete malformed[field];
    await assert.rejects((async () => { for await (const _ of f.remote.generate(f.binding, { request: malformed, settings, lite, context })) {} })(), /declared settings/);
  }
  assert.equal(f.calls(), 0);
  // Equivalent input text spelling is validated, then forwarded without canonical rewriting.
  request.input[0].content = [{ type: 'text', text: 'Synthetic' }];
  for await (const _ of f.remote.generate(f.binding, { request, settings, lite, context })) {}
  assert.deepEqual(received, request); assert.equal(f.calls(), 1);
});

test('CW010-R05 A05: malformed reset options reject before core and actual RPC effects', async t => {
  const { ResetController } = load('account/reset'), { executionKey } = load('core/affinity');
  const context = { instanceId: 'independent-instance', workflowId: 'wf', executionId: 'reset', nodeId: 'account', nodeName: 'Account' };
  const valid = { origin: 'manual', acknowledgement: true, selectedCreditId: 'synthetic-credit', executionKey: executionKey(context), policy: DEFAULT_RECOVERY };
  const malformed = [ { ...valid, origin: 'unexpected' }, { ...valid, origin: undefined }, { ...valid, acknowledgement: 'true' }, { ...valid, acknowledgement: false }, { ...valid, selectedCreditId: '' }, { ...valid, extra: true }, { ...valid, policy: { ...DEFAULT_RECOVERY, threshold: 100 } }, { ...valid, policy: { ...DEFAULT_RECOVERY, automatic: 'true' } }, { ...valid, origin: 'automatic' } ];
  const f = await fixture(t, false, () => { throw Error('No provider call'); }); let effects = 0;
  const forbidden = async () => { effects++; throw Error('Unexpected effect'); };
  const core = new ResetController({ session: forbidden }, {}, forbidden);
  f.store.read = forbidden; f.app.engine.queue.acquire = forbidden; f.resources.resets = { consumeReset: forbidden };
  for (const options of malformed) {
    await assert.rejects(core.consumeReset(f.binding, options));
    await assert.rejects(f.remote.reset(f.binding, options, context));
  }
  assert.equal(effects, 0); assert.equal(f.calls(), 0);
});

for (const lite of [false, true]) test(`CW010-R06/R07 A07/A08: exact-model metadata and complete visible projection ${lite}`, () => {
  const { buildRequest, outputMessage, toolRegistry } = load('core/codec'), { ReplayLedger } = load('core/replay');
  const { parseModel } = load('core/catalog'), { DEFAULT_SETTINGS } = load('model');
  const model = parseModel(h.rawModel({ use_responses_lite: lite })), session = h.session();
  const registry = toolRegistry([{ type: 'function', function: { name: 'lookup', parameters: schema } }]);
  const response = h.output('Visible answer', { output: [
    { type: 'reasoning', id: 'rs_visible', encrypted_content: 'SYNTHETIC_OPAQUE', summary: [] },
    ...h.output('Visible answer').output,
    ...[1, 2].map(n => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'lookup', arguments: JSON.stringify({ value: n, nested: { a: 1, b: 2 } }), ...(lite ? { namespace: 'functions' } : {}) })),
  ] });
  const original = outputMessage(response, registry, session, model);
  const clone = () => messages.mapStoredMessagesToChatMessages(messages.mapChatMessagesToStoredMessages([original]))[0];
  const results = [1, 2].map(n => new messages.ToolMessage({ tool_call_id: `call_${n}`, content: String(n) }));
  const build = (message, selected = model) => buildRequest([new messages.HumanMessage('Synthetic'), message, ...results], selected, DEFAULT_SETTINGS, registry, session);
  assert.equal(original.additional_kwargs.codex_response.version, 2);
  assert.equal(build(clone()).input.filter(i => i.type === 'function_call').length, 2);
  const keyed = clone(); keyed.tool_calls[0].args = { nested: { b: 2, a: 1 }, value: 1 }; assert.doesNotThrow(() => build(keyed));
  const blocked = clone(); blocked.content = [{ type: 'text', text: 'Visible ' }, { type: 'text', text: 'answer' }]; assert.doesNotThrow(() => build(blocked));
  for (const mutate of [
    m => { m.content = 'Edited text'; }, m => { m.content = ''; }, m => { m.tool_calls.pop(); },
    m => { m.tool_calls.reverse(); }, m => { m.tool_calls[0].args.value = 999; },
    m => { m.tool_calls.push({ id: 'extra', name: 'lookup', args: { value: 3 } }); },
    m => { m.additional_kwargs.codex_response.version = 1; },
    m => { m.additional_kwargs.codex_response.codec = 'unknown-v9'; },
  ]) { const changed = clone(); mutate(changed); assert.throws(() => build(changed)); }
  assert.throws(() => build(clone(), { ...model, slug: 'another-model' }), /exact model/);
  const ledger = new ReplayLedger(); ledger.remember(original.additional_kwargs.codex_response);
  const split = new messages.AIMessage({ content: [], tool_calls: [original.tool_calls[0]] });
  assert.throws(() => ledger.restore(split, session, lite ? 'responses-lite' : 'responses', 'another-model'), /exact model/);
  ledger.clear();
});

for (const lite of [false, true]) test(`CW010-R07 A08: nonempty multi-call replay survives native split serialization ${lite}`, () => {
  const { buildRequest, outputMessage, toolRegistry } = load('core/codec'), { ReplayLedger } = load('core/replay');
  const { parseModel } = load('core/catalog'), { DEFAULT_SETTINGS } = load('model');
  const model = parseModel(h.rawModel({ use_responses_lite: lite })), session = h.session();
  const registry = toolRegistry([{ type: 'function', function: { name: 'lookup', parameters: schema } }]);
  const text = 'Checking both synthetic values.';
  const output = [
    { type: 'reasoning', id: 'rs_nonempty', encrypted_content: 'SYNTHETIC_NONEMPTY_OPAQUE', summary: [] },
    { ...h.output(text).output[0], id: 'msg_nonempty', phase: 'commentary' },
    ...[1, 2].map(n => ({ type: 'function_call', id: `fc_nonempty_${n}`, call_id: `call_nonempty_${n}`, name: 'lookup', arguments: JSON.stringify({ value: n }), ...(lite ? { namespace: 'functions' } : {}) })),
  ];
  const original = outputMessage(h.output(text, { output }), registry, session, model);
  const human = () => new messages.HumanMessage('Read both synthetic values.');
  const result = n => new messages.ToolMessage({ tool_call_id: `call_nonempty_${n}`, content: String(n) });
  const build = (history, ledger) => buildRequest(history, model, DEFAULT_SETTINGS, registry, session, undefined, ledger);
  const serialize = history => messages.mapStoredMessagesToChatMessages(messages.mapChatMessagesToStoredMessages(history));
  const canonical = build([human(), original, result(1), result(2)]);
  assert.deepEqual(canonical.input.filter(item => output.some(saved => saved.id === item.id)), output);
  assert.deepEqual(canonical.input.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['call_nonempty_1', 'call_nonempty_2']);
  for (const content of [[], text]) {
    const ledger = new ReplayLedger();
    try {
      ledger.remember(original.additional_kwargs.codex_response);
      const parts = original.tool_calls.map(call => new messages.AIMessage({ content, tool_calls: [call] }));
      const history = [human(), parts[0], result(1), parts[1], result(2)];
      // Stock Agent V3 supplies blank split text; saved matching text is a separate supported shape.
      assert.deepEqual(build(history, ledger), canonical);
      const stored = serialize(history);
      const restored = build(stored);
      assert.deepEqual(restored, canonical);
      assert.equal(restored.input.filter(item => item.type === 'reasoning').length, 1);
      assert.equal(restored.input.filter(item => item.id === 'msg_nonempty').length, 1);
      stored[3].content = 'Different visible text.';
      assert.throws(() => build(stored), /Visible split assistant text differs/);
    } finally {
      ledger.clear();
    }
  }
});

for (const lite of [false, true]) test(`CW010-R07 A08: split metadata requires complete parts, results and unchanged shared bytes ${lite}`, () => {
  const { buildRequest, outputMessage, toolRegistry } = load('core/codec'), { ReplayLedger } = load('core/replay');
  const { parseModel } = load('core/catalog'), { DEFAULT_SETTINGS } = load('model');
  const model = parseModel(h.rawModel({ use_responses_lite: lite })), session = h.session();
  const registry = toolRegistry([{ type: 'function', function: { name: 'lookup', parameters: schema } }]);
  const message = outputMessage(h.output('', { output: [1, 2].map(n => ({ type: 'function_call', id: `fc_split_${n}`, call_id: `call_split_${n}`, name: 'lookup', arguments: JSON.stringify({ value: n }), ...(lite ? { namespace: 'functions' } : {}) })) }), registry, session, model);
  const round = () => {
    const ledger = new ReplayLedger(); ledger.remember(message.additional_kwargs.codex_response);
    const parts = message.tool_calls.map(call => new messages.AIMessage({ content: [], tool_calls: [call] }));
    const history = [new messages.HumanMessage('Synthetic'), parts[0], new messages.ToolMessage({ tool_call_id: 'call_split_1', content: '1' }), parts[1], new messages.ToolMessage({ tool_call_id: 'call_split_2', content: '2' })];
    buildRequest(history, model, DEFAULT_SETTINGS, registry, session, undefined, ledger); ledger.clear();
    return messages.mapStoredMessagesToChatMessages(messages.mapChatMessagesToStoredMessages(history));
  };
  const build = history => buildRequest(history, model, DEFAULT_SETTINGS, registry, session);
  assert.doesNotThrow(() => build(round()));
  for (const mutate of [h => h.splice(3, 1), h => h.pop(), h => h.push(h[1]), h => { h[3].additional_kwargs.codex_response.items[0].arguments = '{"value":9}'; }, h => { h[1].content = 'Unexpected text'; }]) {
    const history = round(); mutate(history); assert.throws(() => build(history));
  }
});

for (const lite of [false,true]) for(const remoteMode of [false,true]) test(`CW010-R10 A10: unsupported agent-message terminal cannot release native tools ${remoteMode}/${lite}`,async t=>{
 const f=await fixture(t,lite,()=>[{type:'agent_message',id:'agent_unsupported',author:'assistant',recipient:'all',content:[{type:'input_text',text:'Unsupported retained shape'}]},{type:'function_call',id:'fc_agent',call_id:'call_agent',name:'lookup',arguments:'{"value":1}',...(lite?{namespace:'functions'}:{})}]);
 const model=f.make(remoteMode).bindTools([{type:'function',function:{name:'lookup',parameters:schema}}]);let exposed=0;
 await assert.rejects((async()=>{for await(const chunk of await model.stream('Synthetic'))exposed+=(chunk.tool_calls?.length??0)+(chunk.tool_call_chunks?.length??0);})(),/unsupported/i);assert.equal(exposed,0);assert.equal(f.calls(),1);
});

for(const lite of [false,true]) test(`CW010-R10 A10: unsupported agent-message terminal cannot commit standalone history ${lite}`,async t=>{
 const f=await fixture(t,lite,()=>[{type:'agent_message',id:'agent_unsupported',author:'assistant',recipient:'all',content:[{type:'input_text',text:'Unsupported retained shape'}]}]);const policy={id:'agent-unsupported',name:'Synthetic',mode:'fixed',profiles:[f.binding.profileId],allowedModels:[],enabled:true,localContinuityConsent:true};
 await assert.rejects(f.app.engine.respond(policy,{model:'synthetic-model',input:'Synthetic',store:true,stream:false}),/unsupported/i);assert.equal((await f.state.list(f.app.engine.resolver.scope(policy.id))).length,0);assert.equal(f.calls(),1);
});

for(const lite of [false,true]) for(const remoteMode of [false,true]) test(`CW010-R10 A10: native terminal message role and phase remain replayable ${remoteMode}/${lite}`,async t=>{
 let shape={};const f=await fixture(t,lite,()=>[{...h.output('Visible').output[0],...shape}]);
 for(const malformed of [{role:undefined},{role:'user'},{role:'unknown'},{phase:42},{phase:'unknown'}]){shape=malformed;await assert.rejects(f.make(remoteMode).invoke('Synthetic'),/role|phase/i);}
 for(const phase of [undefined,null,'commentary','partial_answer','final_answer']){shape={role:'assistant',phase};const result=await f.make(remoteMode).invoke('Synthetic');assert.equal(result.content,'Visible');assert.equal(result.additional_kwargs.codex_response.items[0].phase,phase);}
});

for(const lite of [false,true]) test(`CW010-R10 A10: standalone terminal role and phase cannot commit unreplayable history ${lite}`,async t=>{
 let shape={};const f=await fixture(t,lite,()=>[{...h.output('Visible').output[0],...shape}]);const policy={id:'terminal-shape',name:'Synthetic',mode:'fixed',profiles:[f.binding.profileId],allowedModels:[],enabled:true,localContinuityConsent:true};
 for(const malformed of [{role:undefined},{role:'user'},{role:'unknown'},{phase:42},{phase:'unknown'}]){shape=malformed;await assert.rejects(f.app.engine.respond(policy,{model:'synthetic-model',input:'Synthetic',store:true,stream:false}),/role|phase/i);assert.equal((await f.state.list(f.app.engine.resolver.scope(policy.id))).length,0);}
 for(const phase of [undefined,null,'commentary','partial_answer','final_answer']){shape={role:'assistant',phase};const result=await f.app.engine.respond(policy,{model:'synthetic-model',input:'Synthetic',store:true,stream:false});assert.equal(result.body.output[0].phase,phase);}
});
