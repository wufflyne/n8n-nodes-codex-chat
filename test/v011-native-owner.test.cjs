const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { NativeOwner } = require('../dist/service/native-owner.js');
const { ProfileOwner } = require('../dist/service/owner.js');
const { nativeOwnerKey } = require('../dist/service/native-key.js');
const { NativeManager } = require('../dist/service/native-manager.js');
const { persistCredential, credentialPreAuthentication, credentialAuthenticate } = require('../dist/service/credential-persistence.js');

async function directory(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-v011-'));
  await fs.chmod(d, 0o700); t.after(() => fs.rm(d, { recursive: true, force: true })); return d;
}
test('native lease excludes concurrent/old owners and releases on process death', async t => {
  const d = await directory(t), file = require.resolve('../dist/service/native-owner.js');
  const child = spawn(process.execPath, ['-e', `const {NativeOwner}=require(${JSON.stringify(file)});new NativeOwner(process.argv[1]).acquire().then(()=>{process.stdout.write('ready\\n');setInterval(()=>{},1000)}).catch(()=>process.exit(2));`, d], { stdio: ['ignore','pipe','pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(Error('child owner failed'))); });
  await assert.rejects(new NativeOwner(d).acquire(), /Another Codex Wire Service/);
  await assert.rejects(new ProfileOwner(d).acquire());
  await assert.rejects(fs.mkdir(path.join(d,'.codex-wire-owner')));
  child.kill('SIGKILL'); await new Promise(resolve => child.once('exit',resolve));
  const next = new NativeOwner(d); await next.acquire(); next.close();
  assert((await fs.stat(path.join(d,'.codex-wire-owner-v2'))).isFile());
  assert((await fs.stat(path.join(d,'.codex-wire-owner'))).isFile());
});
test('native owner preserves unknown legacy fences', async t => {
  const d = await directory(t); await fs.mkdir(path.join(d,'.codex-wire-owner'), {mode:0o700});
  await assert.rejects(new NativeOwner(d).acquire());
  assert((await fs.stat(path.join(d,'.codex-wire-owner'))).isDirectory());
});
test('passphrase wrap is stable, authenticated, ID bound and never replaced on failure', async t => {
  const d = await directory(t), password = 'synthetic manager passphrase';
  const first = await nativeOwnerKey(d,'manager-one',password);
  const file=path.join(d,'manager-key-v1.enc'), before=await fs.readFile(file);
  assert.deepEqual(await nativeOwnerKey(d,'manager-one',password),first);
  await assert.rejects(nativeOwnerKey(d,'manager-one','different synthetic phrase'));
  await assert.rejects(nativeOwnerKey(d,'manager-two',password));
  assert.deepEqual(await fs.readFile(file),before);
  await fs.writeFile(path.join(d,'manager.json'),'{}',{mode:0o600}); await fs.unlink(file);
  await assert.rejects(nativeOwnerKey(d,'manager-one',password),/no recoverable/);
  assert.equal(first.length,32); first.fill(0);
});
test('full helper interval serializes and an outside hook cannot provision', async () => {
  assert.deepEqual(await credentialPreAuthentication('codexWireManager'),{});
  let saved={ownerKey:''}, helperCalls=0, reads=0;
  const ctx={getNode:()=>({credentials:{codexWireManager:{id:'real-id',name:'same name'}}}),getCredentials:async()=>{reads++;return {...saved}},helpers:{httpRequestWithAuthentication:async(type,options)=>{
    helperCalls++;const fields=await credentialPreAuthentication(type);
    await new Promise(r=>setTimeout(r,10));saved={...saved,...fields};
    await credentialAuthenticate(type,saved,options);return {};
  }}};
  const prepare=async(_id,current)=>({ownerKey:current.ownerKey||'stable-synthetic-cache'});
  const [a,b]=await Promise.all([persistCredential(ctx,'codexWireManager',prepare),persistCredential(ctx,'codexWireManager',prepare)]);
  assert.equal(helperCalls,1);assert.equal(a.data.ownerKey,b.data.ownerKey);assert(reads>=5);
  await assert.rejects(credentialAuthenticate('codexWireManager',saved,{url:'https://auth.openai.com/.well-known/jwks.json',method:'GET'}));
});
test('service close drains admitted work before releasing either lease', async () => {
  const events=[],owner={directory:os.tmpdir(),close(){events.push('child-release')}},instance={close(){events.push('instance-release')}};
  const manager=new NativeManager('synthetic',owner,randomBytes(32),'synthetic manager passphrase',instance);
  let release;const held=manager.run(()=>new Promise(resolve=>{release=()=>{events.push('write-settled');resolve()}}));
  await new Promise(r=>setImmediate(r));const closing=manager.close();
  await assert.rejects(manager.run(async()=>{}),/stopping/);assert.deepEqual(events,[]);
  release();await held;await closing;assert.deepEqual(events,['write-settled','child-release','instance-release']);
});
test('native wrapped key file contains no plaintext owner key', async t=>{
 const d=await directory(t), key=await nativeOwnerKey(d,'bounded-manager','synthetic manager passphrase');
 const raw=await fs.readFile(path.join(d,'manager-key-v1.enc'),'utf8');
 assert(!raw.includes(key.toString('base64')));assert.equal(createHash('sha256').update(key).digest().length,32);key.fill(0);
});
test('managed native model drains real adapter transport and records one logical generation', async () => {
 const { serviceModel }=require('../dist/adapters/langchain/service-model.js');
 const { EmbeddedService }=require('../dist/service/embedded.js');
 const { parseModel }=require('../dist/core/catalog.js');
 const { executionUsage,clearExecutionUsage }=require('../dist/core/execution-usage.js');
 const { DEFAULT_RECOVERY }=require('../dist/account/types.js');
 const f=require('./helpers.cjs'),events=[],owner={directory:os.tmpdir(),close(){events.push('released')}};
 const manager=new NativeManager('model-owner',owner,randomBytes(32),'synthetic manager passphrase');
 assert.equal(manager.service instanceof EmbeddedService,false);
 const context={instanceId:'native-test',workflowId:'native-workflow',executionId:'native-execution',nodeId:'native-model',nodeName:'Native Model'};
 const session=f.session();manager.resources.sessions.session=async()=>session;
 manager.resources.catalog.model=async()=>parseModel(f.rawModel());
 let release,started;const admitted=new Promise(r=>{started=r}),gate=new Promise(r=>{release=r});
 manager.resources.transport.stream=async function*(_request,_session,_settings,_signals,_lite,transport){
  transport.recorder.attempt();transport.recorder.admitted();started();await gate;
  yield {kind:'text',text:'Hello'};yield {kind:'done',response:f.output('Hello'),requestId:'native-test',elapsedMs:1};
 };
 const model=serviceModel(manager.service,{profileId:'synthetic-binding',bindingSecret:'synthetic-secret'},{model:'synthetic-model',context,policy:DEFAULT_RECOVERY});
 const work=model.invoke('Synthetic prompt');await admitted;const closing=manager.close();
 await assert.rejects(manager.service.resolve({profileId:'synthetic-binding',bindingSecret:'synthetic-secret'},'synthetic-model'),/stopping/);
 assert.deepEqual(events,[]);release();await work;await closing;
 const totals=executionUsage(context,session.affinity).totals;
 assert.equal(totals.logicalInvocations,1);assert.equal(totals.completedGenerations,1);assert.equal(totals.httpAdmitted,1);assert.equal(totals.knownTotalTokens,12);
 assert.deepEqual(events,['released']);clearExecutionUsage(context);
});
test('completed reconnect history stays bounded without deleting unresolved captures', () => {
 const {retireConnectionAttempt}=require('../dist/service/native-records.js');
 const account={binding:{profileId:'synthetic',bindingSecret:'synthetic'},deliveryId:'delivery',acknowledged:true};
 const unresolved={id:'unknown-attempt',state:'uncertain',reconnect:true,deviceId:'SYNTHETIC_DEVICE_SECRET'};
 account.attempt=unresolved;retireConnectionAttempt(account);
 for(let i=0;i<200;i++){
  account.attempt={id:'completed-'+i,state:'connected',reconnect:true,capture:'SYNTHETIC_CAPTURE',deviceId:'SYNTHETIC_DEVICE_SECRET'};
  retireConnectionAttempt(account);
 }
 assert.deepEqual(account.retiredAttempts.find(a=>a.id==='unknown-attempt'),unresolved);
 const completed=account.retiredAttempts.filter(a=>a.state==='connected');assert.equal(completed.length,16);
 assert(completed.every(a=>a.capture===undefined&&a.deviceId===undefined));
});
test('legacy remote editor snapshots require explicit refresh and remain binding scoped', async t=>{
 const {RemoteService}=require('../dist/service/remote.js');
 const {parseModel}=require('../dist/core/catalog.js');const f=require('./helpers.cjs');
 const d=await directory(t),token=path.join(d,'installation.key');await fs.writeFile(token,'SYNTHETIC_INSTALLATION_TOKEN',{mode:0o600});
 let calls=0;
 const remote=new RemoteService('https://synthetic-gateway.invalid',token,async(url,init)=>{
  calls++;if(String(url).endsWith('/handshake'))return Response.json({protocolVersion:1,release:'0.1.0',schemaVersion:1});
  const method=JSON.parse(init.body).method;
  return Response.json(method==='models'?[parseModel(f.rawModel())]:method==='limits'?{resetCredits:{entries:[],freshness:{validUntil:new Date(Date.now()+30000).toISOString()}}}:{});
 });
 const binding={profileId:'synthetic-profile',bindingSecret:'SYNTHETIC_BINDING_SECRET'};
 assert.deepEqual(remote.cachedModels(binding),[]);assert.equal(remote.cachedLimits(binding),undefined);assert.equal(calls,0);
 await remote.models(binding,undefined,true);await remote.limits(binding,{force:true,includeResetDetails:true});const observed=calls;
 const first=remote.cachedModels(binding);first[0].reasoningEfforts.push('tampered');
 assert(!remote.cachedModels(binding)[0].reasoningEfforts.includes('tampered'));assert(remote.cachedLimits(binding));assert.equal(calls,observed);
 assert.deepEqual(remote.cachedModels({...binding,bindingSecret:'DIFFERENT_SYNTHETIC_BINDING'}),[]);
 await remote.reset(binding,{});assert.equal(remote.cachedLimits(binding),undefined);
});

test('missing instance claim fences foreign zero-account roots but resumes the authorized own bootstrap', async t=>{
 const {startNativeManager}=require('../dist/service/native-manager.js');
 const prior=process.env.N8N_USER_FOLDER;t.after(()=>{if(prior===undefined)delete process.env.N8N_USER_FOLDER;else process.env.N8N_USER_FOLDER=prior;});
 async function setup(id,folder){
  process.env.N8N_USER_FOLDER=folder;const root=path.join(folder,'.n8n','codex-wire'),child=path.join(root,createHash('sha256').update(id).digest('hex'));await fs.mkdir(child,{recursive:true,mode:0o700});
  const passphrase='synthetic interrupted bootstrap',key=await nativeOwnerKey(child,id,passphrase);return{root,child,passphrase,key};
 }
 function context(id,passphrase){let saved={managerPassphrase:passphrase},calls=0;return{ctx:{getNode:()=>({credentials:{codexWireManager:{id,name:'same name'}}}),getCredentials:async()=>({...saved}),helpers:{httpRequestWithAuthentication:async(type,options)=>{calls++;saved={...saved,...await credentialPreAuthentication(type)};await credentialAuthenticate(type,saved,options);return{};}}},calls:()=>calls};}
 const foreign=await setup('foreign-manager',await directory(t)),original=await fs.readFile(path.join(foreign.child,'manager-key-v1.enc')),replacement=context('replacement-manager',foreign.passphrase);
 await assert.rejects(startNativeManager(replacement.ctx),/another Manager key wrap/);assert.equal(replacement.calls(),0);await assert.rejects(fs.stat(path.join(foreign.root,'instance-manager.json')),{code:'ENOENT'});assert.deepEqual(await fs.readFile(path.join(foreign.child,'manager-key-v1.enc')),original);foreign.key.fill(0);
 const own=await setup('own-manager',await directory(t));await fs.writeFile(path.join(own.child,'manager.json'),JSON.stringify({version:3,managerId:'own-manager',keyHash:createHash('sha256').update(own.key.toString('base64')).digest('hex')}),{mode:0o600});
 const resumed=context('own-manager',own.passphrase),manager=await startNativeManager(resumed.ctx);assert.equal(manager.id,'own-manager');assert.deepEqual(manager.key,own.key);assert.equal(resumed.calls(),1);assert.equal(JSON.parse(await fs.readFile(path.join(own.root,'instance-manager.json'))).managerId,'own-manager');await manager.close();own.key.fill(0);
});

async function importManager(t) {
 const {startNativeManager}=require('../dist/service/native-manager.js');
 const {ISSUER,CODEX_CLIENT_ID}=require('../dist/core/types.js');
 const folder=await directory(t),prior=process.env.N8N_USER_FOLDER;
 process.env.N8N_USER_FOLDER=folder;t.after(()=>{if(prior===undefined)delete process.env.N8N_USER_FOLDER;else process.env.N8N_USER_FOLDER=prior;});
 const saved={codexWireManager:{managerPassphrase:'synthetic import validation phrase'},codexAccount:{}};
 const ctx={getNode:()=>({credentials:{codexWireManager:{id:'import-manager'},codexAccount:{id:'import-account'}}}),getCredentials:async type=>({...saved[type]}),helpers:{httpRequestWithAuthentication:async(type,options)=>{saved[type]={...saved[type],...await credentialPreAuthentication(type)};await credentialAuthenticate(type,saved[type],options);return{};}}};
 const manager=await startNativeManager(ctx);t.after(()=>manager.close());
 const identity={issuer:ISSUER,clientId:CODEX_CLIENT_ID,subject:'synthetic-subject',accountId:'synthetic-account'};
 const setInput=(access,refresh)=>{saved.codexWireManager.sessionImport=JSON.stringify({tokens:{access_token:access,...(refresh?{refresh_token:refresh}:{})}});};
 return{ctx,manager,identity,setInput};
}
test('rejected import can be corrected before admission without replacing its acknowledged binding',async t=>{
 const {connectionOperation}=require('../dist/service/native-connections.js');
 const {ctx,manager,identity,setInput}=await importManager(t);let refreshes=0;
 manager.resources.auth.verify=async tokens=>{assert.notEqual(tokens.accessToken,'invalid-signature','Synthetic signature rejection');return{identity:tokens.accessToken==='wrong-identity'?{...identity,subject:'other-subject'}:identity,tokens:{...tokens,expiresAt:Date.now()+3600000}};};
 manager.resources.auth.refresh=async()=>{refreshes++;throw Error('Unexpected refresh');};
 setInput('invalid-signature');await assert.rejects(connectionOperation(ctx,'importSession'),/signature rejection/);
 let account=(await manager.records.read()).accounts['import-account'];const binding={...account.binding};assert.equal(account.importReceipt,undefined);assert.equal(account.acknowledged,true);
 setInput('valid-first');assert.equal((await connectionOperation(ctx,'importSession')).status,'connected');
 setInput('wrong-identity');await assert.rejects(connectionOperation(ctx,'importSession'),/different account/);
 setInput('valid-second');assert.equal((await connectionOperation(ctx,'importSession')).status,'connected');
 account=(await manager.records.read()).accounts['import-account'];assert.deepEqual(account.binding,binding);assert.equal(account.importReceipt.state,'connected');assert.equal(refreshes,0);
});
test('dispatched import keeps its prepared receipt and rotating uncertainty after failure',async t=>{
 const {connectionOperation}=require('../dist/service/native-connections.js');
 const {ctx,manager,identity,setInput}=await importManager(t);let refreshes=0;
 manager.resources.auth.verify=async tokens=>({identity,tokens:{...tokens,expiresAt:Date.now()-1000}});
 manager.resources.auth.refresh=async()=>{refreshes++;throw Error('Synthetic lost renewal response');};
 setInput('expired-access','independent-refresh');await assert.rejects(connectionOperation(ctx,'importSession'),/lost renewal/);
 const account=(await manager.records.read()).accounts['import-account'];assert.equal(account.importReceipt.state,'prepared');
 await assert.rejects(connectionOperation(ctx,'importSession'));assert.equal(refreshes,1);
 setInput('corrected-access','another-refresh');await assert.rejects(connectionOperation(ctx,'importSession'),/different import is pending/);assert.equal(refreshes,1);
 assert.deepEqual((await manager.records.read()).accounts['import-account'].importReceipt,account.importReceipt);
});
test('known duplicate-family and expiry refusals do not poison corrected imports',async t=>{
 const {connectionOperation}=require('../dist/service/native-connections.js');
 const {ctx,manager,identity,setInput}=await importManager(t);let refreshes=0;
 manager.resources.auth.verify=async tokens=>({identity,tokens:{...tokens,expiresAt:Date.now()+(tokens.accessToken==='expired-access'?-1000:3600000)}});
 manager.resources.auth.refresh=async()=>{refreshes++;throw Error('Unexpected refresh');};
 await manager.resources.sessions.importTokens({accessToken:'original-access',refreshToken:'owned-refresh',expiresAt:Date.now()+3600000,scopes:[]},'Synthetic original');
 setInput('duplicate-access','owned-refresh');await assert.rejects(connectionOperation(ctx,'importSession'),/already owned/);
 assert.equal((await manager.records.read()).accounts['import-account'].importReceipt,undefined);
 setInput('expired-access');await assert.rejects(connectionOperation(ctx,'importSession'),/expired/);
 assert.equal((await manager.records.read()).accounts['import-account'].importReceipt,undefined);
 setInput('independent-access','fresh-independent-refresh');assert.equal((await connectionOperation(ctx,'importSession')).status,'connected');assert.equal(refreshes,0);
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

for (const reconnect of [false, true]) for (const expired of [false, true]) {
  test(`import cancellation at rotation lock preserves pre-admission state (${reconnect ? 'reconnect' : 'new'}/${expired ? 'bootstrap' : 'register'})`, async t => {
    const { connectionOperation } = require('../dist/service/native-connections.js');
    const { ctx, manager, identity, setInput } = await importManager(t);
    let refreshes = 0;
    manager.resources.auth.verify = async tokens => ({
      identity,
      tokens: { ...tokens, expiresAt: tokens.accessToken === 'cancel-candidate' && expired ? 1 : Date.now() + 3600000 },
    });
    manager.resources.auth.refresh = async tokens => {
      refreshes++;
      return { ...tokens, accessToken: 'settled-replacement', refreshToken: 'settled-family', expiresAt: Date.now() + 3600000 };
    };
    if (reconnect) {
      setInput('original-access', 'original-family');
      await connectionOperation(ctx, 'importSession');
    } else {
      manager.resources.auth.verify = async () => { throw Error('Controlled invalid candidate'); };
      setInput('invalid');
      await assert.rejects(connectionOperation(ctx, 'importSession'), /Controlled invalid/);
      manager.resources.auth.verify = async tokens => ({ identity, tokens: { ...tokens, expiresAt: expired ? 1 : Date.now() + 3600000 } });
    }
    await manager.resources.store.rotation.initialize();
    const before = (await manager.records.read()).accounts['import-account'];
    const profile = reconnect ? await manager.resources.store.read(before.binding) : undefined;
    const journal = path.join(manager.resources.store.directory, '.rotation-v2.json.enc');
    const journalBefore = await fs.readFile(journal);
    const method = expired ? 'beginBootstrap' : 'register';
    const rotation = manager.resources.store.rotation;
    const original = rotation[method].bind(rotation);
    const reached = deferred(), held = deferred(), release = deferred();
    const cancellation = new AbortController();
    rotation[method] = async (...args) => {
      const blocker = manager.lock('rotation', async () => { held.resolve(); await release.promise; });
      await held.promise;
      const pending = original(...args);
      reached.resolve();
      await release.promise;
      await blocker;
      return pending;
    };
    setInput('cancel-candidate', 'candidate-family');
    const pending = connectionOperation(ctx, 'importSession', 'codex-auth-json', cancellation.signal);
    // This method is reached only after the real session/profile prechecks.
    await reached.promise;
    cancellation.abort();
    release.resolve();
    const outcome = await pending.then(value => ({ value }), error => ({ error }));
    rotation[method] = original;
    const after = (await manager.records.read()).accounts['import-account'];
    const observation = { cancelled: outcome.error?.category === 'cancelled', refreshes, receiptState: after.importReceipt?.state ?? null };
    assert.equal(observation.cancelled, true, JSON.stringify(observation));
    assert.equal(refreshes, 0);
    assert.deepEqual(after.importReceipt, before.importReceipt);
    assert.deepEqual(after.binding, before.binding);
    assert.deepEqual(await fs.readFile(journal), journalBefore);
    if (reconnect) assert.deepEqual(await manager.resources.store.read(before.binding), profile);
    else assert.equal(await manager.resources.store.exists(before.binding.profileId), false);
    // A known-undispatched input remains usable without replacing its target binding.
    manager.resources.auth.verify = async tokens => ({ identity, tokens: { ...tokens, expiresAt: Date.now() + 3600000 } });
    assert.equal((await connectionOperation(ctx, 'importSession')).status, 'connected');
    assert.deepEqual((await manager.records.read()).accounts['import-account'].binding, before.binding);
    assert.equal((await connectionOperation(ctx, 'importSession')).status, 'already_imported');
  });
}

test('equal-token import cancellation while waiting for native records admits no new receipt', async t => {
  const { connectionOperation } = require('../dist/service/native-connections.js');
  const { ctx, manager, identity, setInput } = await importManager(t);
  manager.resources.auth.verify = async tokens => ({ identity, tokens: { ...tokens, expiresAt: Date.now() + 3600000 } });
  setInput('same-access', 'same-family');
  await connectionOperation(ctx, 'importSession');
  const before = (await manager.records.read()).accounts['import-account'];
  const profileBefore = await manager.resources.store.read(before.binding);
  const reached = deferred(), held = deferred(), release = deferred(), cancellation = new AbortController();
  const original = manager.records.update.bind(manager.records);
  let updates = 0;
  manager.records.update = async action => {
    if (++updates !== 2) return original(action); // First update acknowledges the existing delivery.
    const blocker = manager.lock('native-records', async () => { held.resolve(); await release.promise; });
    await held.promise;
    const pending = original(action);
    reached.resolve();
    await release.promise;
    await blocker;
    return pending;
  };
  // Different import digest, identical token material: exercise local equality recovery.
  const getCredentials = ctx.getCredentials;
  ctx.getCredentials = async type => {
    const data = await getCredentials(type);
    if (type === 'codexWireManager') data.sessionImport += '\n';
    return data;
  };
  const pending = connectionOperation(ctx, 'importSession', 'codex-auth-json', cancellation.signal);
  await reached.promise;
  cancellation.abort(); release.resolve();
  await assert.rejects(pending, error => error.category === 'cancelled');
  assert.deepEqual((await manager.records.read()).accounts['import-account'].importReceipt, before.importReceipt);
  assert.deepEqual(await manager.resources.store.read(before.binding), profileBefore);
});

test('cancellation after native import receipt commit still captures and settles one renewal', async t => {
  const { connectionOperation } = require('../dist/service/native-connections.js');
  const { ctx, manager, identity, setInput } = await importManager(t);
  const cancellation = new AbortController();
  let refreshes = 0;
  manager.resources.auth.verify = async tokens => ({ identity, tokens: { ...tokens, expiresAt: tokens.accessToken === 'expired-admitted' ? 1 : Date.now() + 3600000 } });
  manager.resources.auth.refresh = async tokens => {
    refreshes++;
    return { ...tokens, accessToken: 'captured-admitted', refreshToken: 'settled-admitted', expiresAt: Date.now() + 3600000 };
  };
  const update = manager.records.update.bind(manager.records);
  manager.records.update = async action => {
    const result = await update(action);
    if ((await manager.records.read()).accounts['import-account']?.importReceipt?.state === 'prepared') cancellation.abort();
    return result;
  };
  setInput('expired-admitted', 'independent-admitted');
  const result = await connectionOperation(ctx, 'importSession', 'codex-auth-json', cancellation.signal);
  assert.equal(result.status, 'connected');
  assert.equal(result.committedAfterCancel, true);
  assert.equal(refreshes, 1);
  const account = (await manager.records.read()).accounts['import-account'];
  assert.equal(account.importReceipt.state, 'connected');
  await manager.resources.store.rotation.assertReady(await manager.resources.store.read(account.binding));
  assert.equal((await connectionOperation(ctx, 'importSession')).status, 'already_imported');
  assert.equal(refreshes, 1);
});
