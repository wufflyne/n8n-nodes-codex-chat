'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID,createHash}=require('node:crypto');
const {ResetStore}=require('../dist/account/reset-store.js'),{ResetController}=require('../dist/account/reset.js'),{emptySnapshot,parseUsage,parseResetCredits}=require('../dist/account/usage.js'),{localStatus}=require('../dist/auth/status.js'),{DEFAULT_RECOVERY}=require('../dist/account/types.js'),h=require('./helpers.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
async function setup(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-reset-missing-'));await fs.chmod(directory,0o700);t.after(()=>fs.rm(directory,{recursive:true,force:true}));const binding={profileId:randomUUID(),bindingSecret:'SYNTHETIC'},session={...h.session(),identity:h.identity()},store=new ResetStore(directory,Buffer.alloc(32,0x55));
 let snapshot=emptySnapshot(localStatus(h.profile(binding),true));snapshot=parseUsage({account_id:session.accountId,rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:99,limit_window_seconds:18000,reset_at:Math.floor(Date.now()/1000)+3600,reset_after_seconds:3600}},rate_limit_reset_credits:{available_count:3}},snapshot,session);
 snapshot=parseResetCredits({available_count:3,credits:[{id:'synthetic-allocation',reset_type:'codex_rate_limits',status:'available',granted_at:new Date(Date.now()-3600000).toISOString(),expires_at:new Date(Date.now()+86400000).toISOString()}]},snapshot,Date.now(),session);
 const reader={session:async()=>session,readWithSession:async()=>structuredClone(snapshot),sessions:{currentSession:async()=>session},invalidateBeforeFreshRead(){}};let posts=0;const controller=new ResetController(reader,store,async()=>{posts++;throw Error('Synthetic unknown consume outcome');});
 return {directory,binding,session,store,controller,posts:()=>posts,options:key=>({origin:'manual',executionKey:hash(key),policy:DEFAULT_RECOVERY,acknowledgement:true,selectedCreditId:'synthetic-allocation'})};}

test('CW010-R20 A20/A24: a missing established reset account journal cannot authorize a fresh consume',async t=>{
 const f=await setup(t);assert.equal((await f.controller.consumeReset(f.binding,f.options('first'))).action.state,'uncertain');assert.equal(f.posts(),1);const scope=f.store.scope(f.session.identity);await fs.unlink(path.join(f.store.directory,scope+'.json.enc'));
 await assert.rejects(f.controller.consumeReset(f.binding,f.options('second')),/missing|established|preserve/i);assert.equal(f.posts(),1);
});

test('CW010-R20 A20/A24: legacy execution evidence prevents recreation when its account journal is missing',async t=>{
 const f=await setup(t),scope=f.store.scope(f.session.identity);await f.store.reserve(hash('legacy'),scope,randomUUID());
 await assert.rejects(f.controller.consumeReset(f.binding,f.options('new-execution')),/missing|established|preserve/i);assert.equal(f.posts(),0);
});

for(const state of ['reserved','dispatched','terminal','cancelled_before_send'])test(`CW010-R20 A20/A24: legacy ${state} reservation still proves missing ledger history`,async t=>{
 const f=await setup(t),scope=f.store.scope(f.session.identity),execution=hash(state),id=randomUUID();await f.store.reserve(execution,scope,id);if(state!=='reserved')await f.store.updateReservation(execution,scope,id,state);
 await assert.rejects(f.controller.consumeReset(f.binding,f.options('new-'+state)),/missing|established|preserve/i);assert.equal(f.posts(),0);
});

test('CW010-R20 A20/A24: fresh and legacy valid ledgers initialize markers without discarding actions',async t=>{
 const f=await setup(t),scope=f.store.scope(f.session.identity),marker=path.join(f.store.directory,scope+'.initialized');assert.equal((await f.controller.consumeReset(f.binding,f.options('fresh'))).action.state,'uncertain');assert.equal(f.posts(),1);
 const before=await f.store.ledger(scope);assert.equal(await fs.readFile(marker,'utf8'),'codex-wire/reset-ledger/v1\n');await fs.unlink(marker);assert.deepEqual(await f.store.ledger(scope),before);assert.equal(await fs.readFile(marker,'utf8'),'codex-wire/reset-ledger/v1\n');
 await fs.unlink(marker);await fs.unlink(path.join(f.store.directory,scope+'.json.enc'));await assert.rejects(f.store.ledger(scope),/missing|established|preserve/i);assert.equal(f.posts(),1);
});

for(const artifact of ['ledger-directory','ledger-symlink','ledger-corrupt','marker-directory','marker-symlink','marker-corrupt'])test(`CW010-R20 A20/A24: unsafe ${artifact} is never treated as a fresh account`,async t=>{
 const f=await setup(t),scope=f.store.scope(f.session.identity);await f.controller.consumeReset(f.binding,f.options('first'));const ledger=path.join(f.store.directory,scope+'.json.enc'),marker=path.join(f.store.directory,scope+'.initialized'),target=artifact.startsWith('ledger')?ledger:marker;
 if(artifact.endsWith('directory')){await fs.unlink(target);await fs.mkdir(target,{mode:0o700});}else if(artifact.endsWith('symlink')){const saved=target+'.saved';await fs.rename(target,saved);await fs.symlink(saved,target);}else await fs.writeFile(target,'Invalid synthetic state',{mode:0o600});
 await assert.rejects(f.controller.consumeReset(f.binding,f.options('second')));assert.equal(f.posts(),1);
});
