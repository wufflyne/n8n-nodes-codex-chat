const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdir, mkdtemp, rm, readFile, writeFile, stat, access } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { ProfileStore } = require('../dist');
const { profile, tokens } = require('./helpers.cjs');
const cli = path.resolve('dist/cli.js');
async function context(t) {
  await mkdir('.test-state', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.resolve('.test-state/cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storeDir = path.join(directory, 'profiles');
  const key = Buffer.alloc(32, 0x43);
  const env = { ...process.env, N8N_CODEX_STORE_DIR: storeDir, N8N_CODEX_STORE_KEY: key.toString('base64') };
  const run = args => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 10000 });
  return { directory, store: new ProfileStore(storeDir, key), run };
}

test('CLI help and invalid arguments produce controlled English output without echoing supplied values', async t => {
  const { run } = await context(t);
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /Manual Import|import --format/);
  const invalid = run(['--SYNTHETIC_SECRET_NOT_AN_OPTION']);
  assert.equal(invalid.status, 1); assert.equal(invalid.stderr.includes('SYNTHETIC_SECRET'), false);
});

test('CLI keygen creates only a new private key file and refuses profile-store placement', async t => {
  const { directory, run } = await context(t); const output = path.join(directory, 'key.env');
  const created = run(['keygen', '--output', output]); assert.equal(created.status, 0);
  const value = await readFile(output, 'utf8');
  assert.match(value, /^N8N_CODEX_STORE_KEY=[A-Za-z0-9+/]{43}=\n$/);
  assert.equal(created.stdout.includes(value.trim().split('=')[1]), false);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(run(['keygen', '--output', output]).status, 1);
  assert.equal(await readFile(output, 'utf8'), value);
  assert.equal(run(['keygen', '--output', path.join(directory, 'profiles', 'key.env')]).status, 1);
});

test('CLI status reads a protected binding without refresh and never prints account tokens or binding secrets', async t => {
  const { directory, store, run } = await context(t);
  const binding = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_BINDING_SECRET' };
  await store.write(profile(binding, { tokens: tokens({ expiresAt: 0 }) }));
  const filename = path.join(directory, 'binding.json');
  await writeFile(filename, JSON.stringify(binding), { mode: 0o600 });
  const result = run(['status', '--binding', filename]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).generation, 1);
  assert.equal(result.stdout.includes('SYNTHETIC_'), false);
  assert.equal((await store.read(binding)).generation, 1);
  await store.write({ ...(await store.read(binding)), state: 'refresh_uncertain' });
  const blocked = JSON.parse(run(['status', '--binding', filename]).stdout);
  assert.equal(blocked.account.renewal, 'blocked');
  assert.equal(blocked.automaticRenewal, false);
});

test('Failed CLI manual import leaves no unusable reserved binding file', async t => {
  const { directory, run } = await context(t);
  const input = path.join(directory, 'invalid.json'); const output = path.join(directory, 'binding.json');
  await writeFile(input, '{invalid SYNTHETIC_SECRET', { mode: 0o600 });
  const result = run(['import', '--format', 'token-set', '--input', input, '--label', 'Synthetic', '--binding-output', output]);
  assert.equal(result.status, 1); assert.match(result.stderr, /not valid JSON/);
  assert.equal(result.stderr.includes('SYNTHETIC_SECRET'), false);
  await assert.rejects(access(output));
  assert.equal(await readFile(input, 'utf8'), '{invalid SYNTHETIC_SECRET');
});

test('Protected CLI manual stdin import, reconnect and device login complete against a signed synthetic provider', async t => {
  const { generateKeyPairSync }=require('node:crypto');
  const { SignJWT,exportJWK }=await import('jose');
  const { CODEX_CLIENT_ID,ISSUER,PROVIDER }=require('../dist');
  const {directory}=await context(t);
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...await exportJWK(publicKey),kid:'synthetic-cli',alg:'RS256'};
  const accessToken=await new SignJWT({client_id:CODEX_CLIENT_ID,'https://api.openai.com/auth':{chatgpt_account_id:'SYNTHETIC_CLI_ACCOUNT'}}).setProtectedHeader({alg:'RS256',kid:'synthetic-cli'}).setIssuer(ISSUER).setSubject('SYNTHETIC_CLI_SUBJECT').setAudience('https://api.openai.com/v1').setExpirationTime('1h').sign(privateKey);
  const preload=path.join(directory,'synthetic-provider.cjs');
  await writeFile(preload,`global.fetch=async url=>{const u=String(url);if(u.endsWith('/jwks.json'))return Response.json({keys:[${JSON.stringify(jwk)}]});if(u.endsWith('/usercode'))return Response.json({device_auth_id:'SYNTHETIC_DEVICE',user_code:'SYNTHETIC-CODE',interval:1});if(u.endsWith('/deviceauth/token'))return Response.json({authorization_code:'SYNTHETIC_CODE',code_verifier:'SYNTHETIC_PKCE'});if(u.endsWith('/oauth/token'))return Response.json({access_token:${JSON.stringify(accessToken)},expires_in:3600});throw Error('Unexpected synthetic endpoint');};`,{mode:0o600});
  const env={...process.env,N8N_CODEX_STORE_DIR:path.join(directory,'profiles'),N8N_CODEX_STORE_KEY:Buffer.alloc(32,0x43).toString('base64')};
  const invoke=(args,input)=>spawnSync(process.execPath,['--require',preload,cli,...args],{env,input,encoding:'utf8',timeout:10000});
  const binding=path.join(directory,'manual.json');
  const input=JSON.stringify({provider:PROVIDER,client_id:CODEX_CLIENT_ID,access_token:accessToken});
  for(const extra of [['--binding-output',binding],['--reconnect',binding]]){
    const result=invoke(['import','--format','token-set','--input','-','--label','Synthetic manual',...extra],input);
    assert.equal(result.status,0,result.stderr);assert(!result.stdout.includes(accessToken));assert(!result.stderr.includes(accessToken));
  }
  assert.equal(JSON.parse(invoke(['status','--binding',binding]).stdout).generation,2);
  const device=invoke(['device-login','--label','Synthetic device','--binding-output',path.join(directory,'device.json')]);
  assert.equal(device.status,0,device.stderr);assert.match(device.stdout,/SYNTHETIC-CODE/);assert(!device.stdout.includes(accessToken));
});

test('CLI SIGTERM cancels synthetic device polling and removes only its reserved binding',async t=>{
 const {spawn}=require('node:child_process');const {directory}=await context(t);
 const preload=path.join(directory,'pending-device.cjs'),binding=path.join(directory,'pending-binding.json');
 await writeFile(preload,"global.fetch=async url=>String(url).endsWith('/usercode')?Response.json({device_auth_id:'SYNTHETIC',user_code:'SYNTHETIC-CODE',interval:60}):new Response('',{status:403});",{mode:0o600});
 const env={...process.env,N8N_CODEX_STORE_DIR:path.join(directory,'profiles'),N8N_CODEX_STORE_KEY:Buffer.alloc(32,0x43).toString('base64')};
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--require',preload,cli,'device-login','--label','Synthetic pending','--binding-output',binding],{env,stdio:['ignore','pipe','pipe']});
  let stderr='',stopped=false;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic CLI did not cancel'));},5000);
  child.stdout.on('data',data=>{if(!stopped&&data.toString().includes('Waiting for authorization')){stopped=true;setTimeout(()=>child.kill('SIGTERM'),20);}});
  child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,stderr});});
 });
 assert.equal(result.code,1);assert.match(result.stderr,/cancelled/);await assert.rejects(access(binding));
});
