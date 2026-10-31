'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { journalChunks, readJournal, writeJournal } = require('../dist/auth/journal-io.js');
const key = Buffer.alloc(32, 0x53), aad = Buffer.from('codex-wire/rotation/v2');
const sample = () => ({ version:2,migrated:true,claims:{ ['0'.repeat(64)]: { owner:'synthetic',identity:'1'.repeat(64),epochs:[{id:'epoch',generation:1,state:'ready'}] } },receipts:{},registrations:{} });
async function fixture(t) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-journal-io-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return path.join(dir,'journal.enc'); }
function envelope(text) { const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);const data=Buffer.concat([cipher.update(text),cipher.final()]);return JSON.stringify({version:2,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}); }
function originalRead(text) { const e=JSON.parse(text),d=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));d.setAAD(aad);d.setAuthTag(Buffer.from(e.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data,'base64')),d.final()])); }

test('CW010-R02/R03: chunk accounting and old/new v2 journal bytes preserve exact JSON semantics',async t=>{
 const file=await fixture(t),j=sample();
 // Cross both cipher/base64 and UTF-8 chunk boundaries, including surrogate pairs and escapes.
 j.registrations['synthetic-unicode']={padding:'x'.repeat(65525)+'😀'.repeat(20000)+'\n\\\"Ж漢\u0000',nested:{'__proto__':'literal',z:[1,true,null]}};
 const chunks=[...journalChunks(j)];assert.equal(chunks.join(''),JSON.stringify(j));assert(chunks.every(s=>s.length<=65536));
 const max=Buffer.byteLength(JSON.stringify(j));await fs.writeFile(file,envelope(JSON.stringify(j)),{mode:0o600});assert.deepEqual(await readJournal(file,key,max),j);
 await writeJournal(file,key,journalChunks(j));assert.deepEqual(originalRead(await fs.readFile(file,'utf8')),j);assert.deepEqual(await readJournal(file,key,max),j);
 assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.readdir(path.dirname(file))).length,1);
 await assert.rejects(readJournal(file,key,max-1),/payload limit/);
});

test('CW010-R02/R03: malformed, truncated, wrong-key and tampered journals reject without a parsed result',async t=>{
 const file=await fixture(t),valid=envelope(JSON.stringify(sample()));
 const e=JSON.parse(valid);e.tag=Buffer.alloc(16).toString('base64');
 const cases=[valid.slice(0,-1),valid+' ',valid.replace('"version":2','"version":3'),valid.replace('"data":"','"data":"!'),JSON.stringify(e),valid.replace('"data":"','"data":"AAAA'),valid.replace('"iv":"','"iv":"\u00c1')];
 for(const bytes of cases){await fs.writeFile(file,bytes,{mode:0o600});await assert.rejects(readJournal(file,key,1024*1024));}
 await fs.writeFile(file,valid,{mode:0o600});await assert.rejects(readJournal(file,Buffer.alloc(32),1024*1024));
 await fs.chmod(file,0o644);await assert.rejects(readJournal(file,key,1024*1024),/private regular/);await fs.chmod(file,0o600);
 const link=file+'.link';await fs.symlink(file,link);await assert.rejects(readJournal(link,key,1024*1024));
});

test('CW010-R02/R03: interrupted encrypted serialization preserves the previous file and removes its private sibling',async t=>{
 const file=await fixture(t),valid=envelope(JSON.stringify(sample()));await fs.writeFile(file,valid,{mode:0o600});
 function* failing(){yield '{"private":"SYNTHETIC_PAYLOAD';throw Error('Synthetic interrupted serialization');}
 await assert.rejects(writeJournal(file,key,failing()),/Synthetic interrupted/);assert.equal(await fs.readFile(file,'utf8'),valid);assert.deepEqual(await fs.readdir(path.dirname(file)),['journal.enc']);
});

test('CW010-R02/R03: rotation registration owns its profile snapshot before asynchronous journal I/O',async t=>{
 const {ProfileStore}=require('../dist/auth/store.js');const {profile}=require('./helpers.cjs');const {randomUUID}=require('node:crypto');
 const file=await fixture(t),store=new ProfileStore(path.dirname(file),key);await store.rotation.initialize();const binding={profileId:randomUUID(),bindingSecret:'SYNTHETIC_SNAPSHOT'},p=profile(binding);const expected=structuredClone(p);
 const committed=store.rotation.register(p);p.label='Mutated caller label';p.tokens.accessToken='SYNTHETIC_MUTATED_AFTER_CALL';await committed;
 assert.deepEqual(await store.read(binding),expected);
});

for (const kind of ['http', 'tokens', 'kind']) test(`CW010-R03: capture snapshots ${kind} input before its bounded journal-lock wait`, async t => {
 const {ProfileStore}=require('../dist/auth/store.js'),{profile}=require('./helpers.cjs'),{randomUUID}=require('node:crypto');
 const file=await fixture(t),store=new ProfileStore(path.dirname(file),key),binding={profileId:randomUUID(),bindingSecret:'SYNTHETIC_CAPTURE_SNAPSHOT'},p=profile(binding);
 await store.rotation.initialize();await store.rotation.register(p);const id=await store.rotation.begin(p);
 const capture=kind==='http'?{kind:'http',bytes:Buffer.from('{"access_token":"SYNTHETIC_CAPTURE"}').toString('base64')}:{kind:'tokens',tokens:structuredClone(p.tokens)},expected=structuredClone(capture);
 const lock=path.join(store.directory,'.rotation-v2.lock');await fs.mkdir(lock,{mode:0o700});
 let pending;
 try {
  pending=store.rotation.capture(id,capture);
  if(kind==='http')capture.bytes=Buffer.alloc(300000,0x78).toString('base64');
  else if(kind==='tokens')capture.tokens.scopes.push('x'.repeat(300000));
  else {capture.kind='http';capture.bytes=Buffer.alloc(300000,0x78).toString('base64');delete capture.tokens;}
 } finally {await fs.rmdir(lock);}
 await pending;const digest=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');assert.equal(digest((await store.rotation.recoveryReceipt(binding.profileId)).capture),digest(expected));
});
