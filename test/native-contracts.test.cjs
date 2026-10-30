const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AIMessage, HumanMessage, ToolMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } = require('@langchain/core/messages');
const { ReplayLedger } = require('../dist/core/replay');
const { buildRequest, outputMessage, toolRegistry, wireName, outputText } = require('../dist/core/codec');
const { runtimeFromEnvironment } = require('../dist/runtime');
const { parseModel } = require('../dist/core/catalog');
const { admissionError, requestId, readJson } = require('../dist/core/http');
const { DEFAULT_SETTINGS, CodexChatModel, ModelCatalog, ResponsesTransport } = require('../dist');
const { rawModel, session, output, complete, sseResponse, mockFetch } = require('./helpers.cjs');
const fn = name => ({ type:'function',function:{name,parameters:{type:'object',properties:{value:{type:'number'}},required:['value']}} });
const model=parseModel(rawModel());
const registry=toolRegistry([fn('native_tool')]);
const calls=[1,2].map(n=>({type:'function_call',id:`fc_${n}`,call_id:`call_${n}`,name:'native_tool',arguments:JSON.stringify({value:n})}));
const response=output('',{output:[{type:'reasoning',id:'rs_1',encrypted_content:'SYNTHETIC_OPAQUE'},...calls]});
const metadata=outputMessage(response,registry,session(),model).additional_kwargs.codex_response;
const part=n=>new AIMessage({content:[],tool_calls:[{id:`call_${n}`,name:'native_tool',args:{value:n},type:'tool_call'}]});
const history=()=>[new HumanMessage('Synthetic'),part(1),new ToolMessage({tool_call_id:'call_1',content:'1'}),part(2),new ToolMessage({tool_call_id:'call_2',content:'2'})];

test('Native V3 split parallel calls recover exactly one original provider group and survive memory serialization',()=>{
 const replay=new ReplayLedger();replay.remember(metadata);const messages=history();
 const request=buildRequest(messages,model,DEFAULT_SETTINGS,registry,session(),undefined,replay);
 assert.equal(request.input.filter(i=>i.type==='reasoning').length,1);
 assert.deepEqual(request.input.filter(i=>i.type==='function_call').map(i=>i.call_id),['call_1','call_2']);
 replay.clear();
 const restored=mapStoredMessagesToChatMessages(mapChatMessagesToStoredMessages(messages));
 const after=buildRequest(restored,model,DEFAULT_SETTINGS,registry,session(),undefined,new ReplayLedger());
 assert.deepEqual(after.input,request.input);
});

test('Replay rejects account/route changes, tampered args, unknown IDs and in-flight restart',()=>{
 const replay=new ReplayLedger();replay.remember(metadata);
 const changed=part(1);changed.tool_calls[0].args={value:99};
 assert.throws(()=>replay.restore(changed,session(),'responses'),/arguments differ/);
 assert.throws(()=>replay.restore(part(1),session('other'),'responses'),/another account/);
 assert.throws(()=>replay.restore(part(1),session(),'responses-lite'),/another account or route/);
 assert.throws(()=>new ReplayLedger().restore(part(1),session(),'responses'),/process restart/);
 assert.throws(()=>replay.restore(part(9),session(),'responses'),/metadata is missing/);
 replay.clear();assert.throws(()=>replay.restore(part(1),session(),'responses'),/metadata is missing/);
});

test('Replay size/group/reused-ID limits fail closed and clear releases capacity',()=>{
 assert.throws(()=>new ReplayLedger(10).remember(metadata),/replay limit/);
 const replay=new ReplayLedger();replay.remember(metadata);
 assert.throws(()=>replay.remember(metadata),/reused/);replay.clear();replay.remember(metadata);replay.clear();
});

test('History rejects duplicate results and incomplete native tool rounds',()=>{
 const replay=new ReplayLedger();replay.remember(metadata);
 const messages=history();messages.push(new ToolMessage({tool_call_id:'call_2',content:'duplicate'}));
 assert.throws(()=>buildRequest(messages,model,DEFAULT_SETTINGS,registry,session(),undefined,replay),/duplicate provider item or tool result/);
 assert.throws(()=>buildRequest([part(1)],model,DEFAULT_SETTINGS,registry,session()),/incomplete tool round/);
});

test('Unicode/long tool names map stably and reversibly through provider output',()=>{
 for(const name of ['Read snow 雪','x'.repeat(100)]) {
  const tools=toolRegistry([fn(name)]);const wire=wireName(name);assert.match(wire,/^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(outputMessage(output('',{output:[{type:'function_call',call_id:'call',name:wire,arguments:'{"value":1}'}]}),tools,session(),model).tool_calls[0].name,name);
 }
 assert.throws(()=>toolRegistry([fn('duplicate'),fn('duplicate')]),/unique/);
});

test('Advertised images and refusal blocks are decoded without enabling unknown inputs',()=>{
 const image=new HumanMessage({content:[{type:'text',text:'Describe'},{type:'image_url',image_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0x8AAAAASUVORK5CYII='}]});
 assert.equal(buildRequest([image],model,DEFAULT_SETTINGS,registry,session()).input[0].content[1].type,'input_image');
 assert.throws(()=>buildRequest([image],{...model,supportsImages:false},DEFAULT_SETTINGS,registry,session()),/Image input/);
 assert.throws(()=>buildRequest([new HumanMessage({content:[{type:'file',file_id:'synthetic'}]})],model,DEFAULT_SETTINGS,registry,session()),/unsupported/);
 assert.equal(outputText(output('',{output:[{type:'message',content:[{type:'refusal',refusal:'Synthetic refusal'}]}]})),'Synthetic refusal');
});

test('Native callbacks and streamEvents carry terminal metadata and controlled errors',async()=>{
 const fetchImpl=mockFetch(async()=>sseResponse([complete(output('Synthetic final'))]));
 const m=new CodexChatModel({model:'synthetic-model',session:async()=>session(),catalog:new ModelCatalog(fetchImpl),transport:new ResponsesTransport(fetchImpl)});
 const counts={start:0,end:0,token:0};
 const result=await m.invoke('Synthetic',{callbacks:[{handleLLMStart(){counts.start++;},handleLLMEnd(){counts.end++;},handleLLMNewToken(){counts.token++;}}]});
 assert.equal(result.content,'Synthetic final');assert.deepEqual(counts,{start:1,end:1,token:1});
 const events=[];for await(const e of m.streamEvents('Synthetic',{version:'v2'}))events.push(e.event);
 assert(events.includes('on_chat_model_start'));assert(events.includes('on_chat_model_stream'));assert(events.includes('on_chat_model_end'));
});

test('Runtime rejects queue mode and malformed/missing master key without printing values',()=>{
 const prior={...process.env};
 try {
  process.env.EXECUTIONS_MODE='queue';assert.throws(()=>runtimeFromEnvironment(),/Queue mode/);
  delete process.env.EXECUTIONS_MODE;delete process.env.N8N_CODEX_STORE_DIR;assert.throws(()=>runtimeFromEnvironment(),/STORE_DIR/);
  process.env.N8N_CODEX_STORE_DIR='/synthetic';process.env.N8N_CODEX_STORE_KEY='SYNTHETIC_SECRET';assert.throws(()=>runtimeFromEnvironment(),e=>!e.message.includes('SYNTHETIC_SECRET')&&/base64/.test(e.message));
 } finally {for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);}
});

test('Admission status/request-ID sanitization and bounded malformed JSON are controlled',async()=>{
 for(const status of [401,403,429,500]){const e=await admissionError(new Response('SYNTHETIC_SECRET',{status,headers:{'x-request-id':'req_safe'}}));assert.equal(e.status,status);assert.equal(e.requestId,'req_safe');assert(!e.message.includes('SYNTHETIC_SECRET'));}
 assert.equal(requestId(new Response('',{headers:{'x-request-id':'unsafe id'}})),undefined);
 await assert.rejects(readJson(new Response('x'.repeat(100)),10),/size limit/);
 await assert.rejects(readJson(new Response('{invalid')),/invalid JSON/);
 assert.equal(parseModel(rawModel({visibility:'hide'})),undefined);
});

test('Internal SSE remains validated when MIME is incorrect; HTML cannot become completion',async()=>{
 const make=(body)=>new ResponsesTransport(async()=>new Response(body,{headers:{'content-type':'application/json'}}));
 const valid=sseResponse([complete(output())]);const body=await valid.text();
 const collect=async transport=>{const events=[];for await(const e of transport.stream({},session(),DEFAULT_SETTINGS,[],true))events.push(e);return events;};
 assert.equal((await collect(make(body))).at(-1).kind,'completed');
 await assert.rejects(collect(make('<html>Synthetic error</html>')),/before response.completed/);
});


test('Concurrent profile reads validate each binding, isolate caller mutations and observe committed generations',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
 const {ProfileStore}=require('../dist');const {profile}=require('./helpers.cjs');
 await fs.mkdir('.test-state',{recursive:true,mode:0o700});const dir=await fs.mkdtemp(path.resolve('.test-state/read-coalescing-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new ProfileStore(dir,Buffer.alloc(32,0x39));const binding={profileId:randomUUID(),bindingSecret:'SYNTHETIC_CORRECT_BINDING'};
 await store.write(profile(binding));
 const [valid,invalid,other]=await Promise.allSettled([store.read(binding),store.read({...binding,bindingSecret:'SYNTHETIC_WRONG_BINDING'}),store.read(binding)]);
 assert.equal(valid.status,'fulfilled');assert.equal(invalid.status,'rejected');assert.equal(other.status,'fulfilled');
 valid.value.tokens.accessToken='MUTATED_SYNTHETIC';assert.notEqual(other.value.tokens.accessToken,valid.value.tokens.accessToken);
 await store.write({...other.value,generation:2});assert.equal((await store.read(binding)).generation,2);
});

test('Native replay prefix contains only the current tool turn and does not resurrect a closed conversation',async()=>{
 const replay=new ReplayLedger();let count=0;
 const fetchImpl=mockFetch(async()=>sseResponse([complete(output('',{id:`resp_${++count}`,output:[{type:'function_call',id:`fc_turn_${count}`,call_id:`call_turn_${count}`,name:'native_tool',arguments:'{"value":1}'}]}))]));
 const m=new CodexChatModel({model:'synthetic-model',session:async()=>session(),catalog:new ModelCatalog(fetchImpl),transport:new ResponsesTransport(fetchImpl),replay});
 const first=await m.bindTools([fn('native_tool')]).invoke('Old turn');
 const second=await m.bindTools([fn('native_tool')]).invoke([new HumanMessage('Old turn'),first,new ToolMessage({tool_call_id:'call_turn_1',content:'1'}),new AIMessage('Old final'),new HumanMessage('New turn')]);
 assert.deepEqual(second.additional_kwargs.codex_response.prefix,[]);replay.clear();
});

test('Two OS processes coordinate one rotating-token refresh through the actual encrypted store lock',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
 const {ProfileStore}=require('../dist'),{profile,tokens}=require('./helpers.cjs');
 await fs.mkdir('.test-state',{recursive:true,mode:0o700});const dir=await fs.mkdtemp(path.resolve('.test-state/process-lock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const binding={profileId:randomUUID(),bindingSecret:'SYNTHETIC_PROCESS_BINDING'};const store=new ProfileStore(path.join(dir,'profiles'),Buffer.alloc(32,0x4a));
 await store.write(profile(binding,{tokens:tokens({expiresAt:0})}));
 const worker=path.join(dir,'worker.cjs'),count=path.join(dir,'refreshes.txt');
 await fs.writeFile(worker,`const fs=require('node:fs/promises');const {ProfileStore,AccountSessionManager}=require(${JSON.stringify(path.resolve('dist'))});const {identity,tokens}=require(${JSON.stringify(path.resolve('test/helpers.cjs'))});const store=new ProfileStore(${JSON.stringify(path.join(dir,'profiles'))},Buffer.alloc(32,0x4a));const auth={verify:async t=>({identity:identity(),tokens:t}),refresh:async()=>{await fs.appendFile(${JSON.stringify(count)},'refresh\\n');await new Promise(r=>setTimeout(r,100));return tokens();}};new AccountSessionManager(store,auth).session(${JSON.stringify(binding)}).then(()=>process.stdout.write('completed')).catch(()=>process.exitCode=1);`);
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[worker],{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',d=>out+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(Error('Synthetic worker failed')));});
 assert.deepEqual(await Promise.all([run(),run()]),['completed','completed']);assert.equal(await fs.readFile(count,'utf8'),'refresh\n');assert.equal((await store.read(binding)).generation,2);
});

test('Overall admission timeout, shared rejection and failing stream readers terminate cleanly',async()=>{
 const {waitForSignal}=require('../dist/core/http');const {getEventListeners}=require('node:events');
 const controller=new AbortController();await assert.rejects(waitForSignal(Promise.reject(Error('Synthetic failure')),controller.signal),/Synthetic failure/);assert.equal(getEventListeners(controller.signal,'abort').length,0);
 const hanging=new ResponsesTransport(async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('Synthetic abort')),{once:true})));
 await assert.rejects(async()=>{for await(const e of hanging.stream({},session(),{...DEFAULT_SETTINGS,timeoutMs:25},[],false)){}},e=>e.category==='timeout');
 const broken=new ResponsesTransport(async()=>new Response(new ReadableStream({start(c){c.error(Error('Synthetic reader failure'));}})));
 await assert.rejects(async()=>{for await(const e of broken.stream({},session(),DEFAULT_SETTINGS,[],false)){}},/stream was interrupted/);
 const catalog=new ModelCatalog(async()=>{throw Error('Synthetic network failure');});
 for(let i=0;i<2;i++)await assert.rejects(catalog.list(session()),/catalog could not be loaded/);
});

test('Model diagnostics expose only provider/model identity and explicit import scopes remain validated',async()=>{
 const {parseManualTokens,PROVIDER,CODEX_CLIENT_ID}=require('../dist');
 const fetchImpl=mockFetch(async()=>sseResponse([complete(output())]));
 const m=new CodexChatModel({model:'synthetic-model',session:async()=>session(),catalog:new ModelCatalog(fetchImpl),transport:new ResponsesTransport(fetchImpl)});
 const diagnostic=JSON.stringify({identity:m._identifyingParams(),secrets:m.lc_secrets});assert(!diagnostic.includes('SYNTHETIC_ACCESS_TOKEN'));assert.match(diagnostic,/synthetic-model/);
 const base={provider:PROVIDER,client_id:CODEX_CLIENT_ID,access_token:'SYNTHETIC_ACCESS_ONLY'};
 assert.deepEqual(parseManualTokens({...base,scopes:['openid','offline_access']},'token-set').scopes,['openid','offline_access']);
 assert.throws(()=>parseManualTokens({...base,scopes:[7]},'token-set'),/scopes/);
});
