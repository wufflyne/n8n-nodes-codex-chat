const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto');
const { ProfileStore, AccountSessionManager, CodexAuthProvider, CodexError } = require('../dist');
const { ProfileOwner } = require('../dist/service/owner');
const { transferCurrentStore } = require('../dist/service/migration');
const { deliverBinding } = require('../dist/auth/connection');
const { ROTATION_LIMITS } = require('../dist/auth/rotation-store');
const { identity, tokens, profile } = require('./helpers.cjs');
const key = Buffer.alloc(32, 0x48);
async function setup(t, auth) {
  await fs.mkdir('.test-state', { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.resolve('.test-state/v010-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ProfileStore(directory, key);
  auth ??= { verify: async tokens => ({ identity: identity(), tokens }), refresh: async tokens => ({ ...tokens, accessToken: 'SYNTHETIC_SUCCESS', expiresAt: Date.now() + 3600000 }) };
  return { directory, store, auth, manager: new AccountSessionManager(store, auth) };
}
async function journal(directory) {
  const envelope = JSON.parse(await fs.readFile(path.join(directory, '.rotation-v2.json.enc'), 'utf8'));
  const cipher = createDecipheriv('aes-256-gcm', createHmac('sha256', key).update('codex-wire/rotation/encryption/v2').digest(), Buffer.from(envelope.iv, 'base64'));
  cipher.setAAD(Buffer.from('codex-wire/rotation/v2')); cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString());
}
async function expire(store, binding) { const p = await store.read(binding); await store.write({ ...p, tokens: { ...p.tokens, expiresAt: Date.now() - 1 } }); }
async function writeJournal(directory, value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHmac('sha256', key).update('codex-wire/rotation/encryption/v2').digest(), iv);
  cipher.setAAD(Buffer.from('codex-wire/rotation/v2'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  await fs.writeFile(path.join(directory, '.rotation-v2.json.enc'), JSON.stringify({ version: 2, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
}

test('CW010-R02 A01/A02: exact token ownership fences new/prepared/reconnect aliases while independent families remain legal', async t => {
  const { store, manager, directory } = await setup(t);
  const first = await manager.importTokens(tokens(), 'First');
  await assert.rejects(manager.importTokens(tokens(), 'Duplicate'), /already owned/);
  await manager.importTokens(tokens({ accessToken: 'SYNTHETIC_UPDATED' }), 'Same owner', first);
  const second = await manager.importTokens(tokens({ refreshToken: 'SYNTHETIC_INDEPENDENT' }), 'Independent family');
  await assert.rejects(manager.importTokens(tokens(), 'Conflicting reconnect', second), /already owned/);
  const prepared = manager.prepareNewProfile();
  const bindingDurable = await deliverBinding(path.join(directory, 'prepared-binding.json'), prepared.binding);
  await assert.rejects(manager.activatePreparedProfile(prepared, tokens(), 'Prepared alias', { bindingDurable }), /already owned/);
  assert.equal(await store.exists(prepared.binding.profileId), false);
  assert.equal((await store.read(first)).accountId, (await store.read(second)).accountId);
  await manager.importTokens(tokens({ refreshToken: undefined }), 'Access only');
});

for (const bootstrap of [false, true]) for (const variant of ['different', 'same', 'omitted']) {
  test(`CW010-R03 A03: verified ${variant} success ${bootstrap ? 'bootstrap' : 'ordinary'} advances only its same-owner epoch`, async t => {
    let calls = 0;
    const auth = { verify: async tokens => ({ identity: identity(), tokens }), refresh: async current => {
      calls++; await new Promise(resolve => setTimeout(resolve, 10));
      return tokens({ accessToken: `SYNTHETIC_NEW_${calls}`, refreshToken: variant === 'omitted' ? undefined : variant === 'same' ? current.refreshToken : `SYNTHETIC_REPLACEMENT_${calls}` });
    } };
    const { store, manager, directory } = await setup(t, auth);
    const binding = await manager.importTokens(tokens({ expiresAt: Date.now() + (bootstrap ? -1 : 3600000) }), 'Epoch test');
    if (!bootstrap) { await expire(store, binding); await Promise.all(Array.from({ length: 16 }, () => manager.session(binding))); }
    assert.equal(calls, 1);
    const after = await store.read(binding), j = await journal(directory);
    assert.equal(Object.values(j.receipts).length, 0);
    assert.equal(Object.values(j.claims).flatMap(c => c.epochs).filter(e => e.state === 'terminal').length, 1);
    assert.equal(Object.values(j.claims).flatMap(c => c.epochs).filter(e => e.state === 'ready').length, 1);
    await assert.rejects(manager.importTokens(after.tokens, 'Duplicate successor'), /already owned/);
    await expire(store, binding);
    const other = new AccountSessionManager(new ProfileStore(directory, key), auth);
    await Promise.all([manager.session(binding), other.session(binding)]);
    assert.equal(calls, 2);
  });
}

for (const failure of ['rejected', 'lost', 'malformed', 'verification']) {
  test(`CW010-R03 A03: expired independent reconnect ${failure} preserves the working profile`, async t => {
    let calls = 0;
    const raw = Buffer.from('{"access_token":"SYNTHETIC_NEW","refresh_token":"SYNTHETIC_NEW_REFRESH","expires_in":"malformed"}');
    const auth = {
      verify: async candidate => {
        if (candidate.accessToken === 'SYNTHETIC_NEW' && failure === 'verification') throw new CodexError('authentication', 'Synthetic verification failure');
        return { identity: identity(), tokens: candidate };
      },
      refresh: async (candidate, capture) => {
        calls++;
        if (failure === 'rejected') throw new CodexError('reconnect', 'Synthetic rejection');
        if (failure === 'lost') throw new CodexError('provider', 'Synthetic lost response');
        if (failure === 'malformed') { await capture(raw); throw new CodexError('protocol', 'Synthetic malformed success'); }
        return tokens({ accessToken: 'SYNTHETIC_NEW', refreshToken: 'SYNTHETIC_NEW_REFRESH' });
      },
    };
    const { store, manager, directory } = await setup(t, auth);
    const binding = await manager.importTokens(tokens(), 'Working profile'), before = await store.read(binding);
    const candidate = tokens({ accessToken: 'SYNTHETIC_EXPIRED', refreshToken: 'SYNTHETIC_INDEPENDENT', expiresAt: 1 });
    await assert.rejects(manager.importTokens(candidate, 'Attempted reconnect', binding), /Synthetic/);
    assert.deepEqual(await store.read(binding), before);
    assert.equal((await manager.session(binding)).accessToken, before.tokens.accessToken);
    await assert.rejects(manager.importTokens(candidate, 'Retry alias'), /already owned/);
    assert.equal(calls, 1);
    const j = await journal(directory), receipt = Object.values(j.receipts)[0];
    assert.equal(Boolean(receipt.capture), failure === 'malformed' || failure === 'verification');
    if (failure === 'malformed') assert(Buffer.from(receipt.capture.bytes, 'base64').equals(raw));
    const disk = await fs.readFile(path.join(directory, '.rotation-v2.json.enc'), 'utf8');
    assert.equal(disk.includes('SYNTHETIC_NEW'), false);
  });
}

test('CW010-R03 A03: concrete HTTP success capture runs before JSON parsing and remains exact', async t => {
  const bytes = Buffer.from(' {"access_token":"SYNTHETIC_RETURNED", "refresh_token":"SYNTHETIC_RETURNED_REFRESH", "expires_in":"bad"}\n');
  let calls = 0;
  const auth = new CodexAuthProvider(async () => { calls++; return new Response(bytes); });
  auth.verify = async candidate => ({ identity: identity(), tokens: candidate });
  const { store, manager, directory } = await setup(t, auth);
  const binding = await manager.importTokens(tokens(), 'Concrete capture');
  await expire(store, binding);
  await assert.rejects(manager.session(binding), /lifetime/);
  const capture = Object.values((await journal(directory)).receipts)[0].capture;
  assert(Buffer.from(capture.bytes, 'base64').equals(bytes));
  await assert.rejects(new AccountSessionManager(new ProfileStore(directory, key), auth).session(binding), /previous token renewal/);
  assert.equal(calls, 1);
});

test('CW010-R03 A03: a mutating injected provider cannot replace preserved tokens on renewal failure', async t => {
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async candidate => {
    candidate.refreshToken = 'SYNTHETIC_ACCIDENTAL_MUTATION';
    throw new CodexError('reconnect', 'Synthetic rejected renewal');
  } };
  const { manager, store } = await setup(t, auth);
  const binding = await manager.importTokens(tokens(), 'Provider snapshot'); await expire(store, binding);
  const before = await store.read(binding);
  await assert.rejects(manager.session(binding), /Synthetic rejected renewal/);
  const after = await store.read(binding);
  assert.deepEqual(after.tokens, before.tokens); assert.equal(after.generation, before.generation);
  assert.equal(after.state, 'reconnect');
});

for (const bootstrap of [false, true]) for (const boundary of ['verified', 'profile', 'claim']) {
  test(`CW010-R03 A03: local ${bootstrap ? 'bootstrap' : 'ordinary'} promotion resumes after ${boundary} without POST`, async t => {
    let calls = 0;
    const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { calls++; return tokens({ refreshToken: undefined, accessToken: 'SYNTHETIC_SUCCESS' }); } };
    const { store, manager, directory } = await setup(t, auth);
    const prepared = manager.prepareNewProfile();
    const bindingDurable = bootstrap ? await deliverBinding(path.join(directory, 'prepared-binding.json'), prepared.binding) : undefined;
    let binding;
    if (!bootstrap) { binding = await manager.importTokens(tokens(), 'Promotion'); await expire(store, binding); }
    if (boundary === 'verified') {
      const original = store.rotation.verifyReceipt.bind(store.rotation);
      store.rotation.verifyReceipt = async (...args) => { await original(...args); throw new CodexError('storage', 'Synthetic process boundary'); };
    } else if (boundary === 'profile') {
      const original = store.write.bind(store);
      store.write = async p => { await original(p); if (p.tokens.accessToken === 'SYNTHETIC_SUCCESS') throw new CodexError('storage', 'Synthetic process boundary'); };
    } else {
      const original = store.rotation.promote.bind(store.rotation);
      store.rotation.promote = async (...args) => { await original(...args); throw new CodexError('storage', 'Synthetic process boundary'); };
    }
    if (bootstrap) {
      binding = prepared.binding;
      await assert.rejects(manager.activatePreparedProfile(prepared, tokens({ expiresAt: 1 }), 'Promotion', { bindingDurable }), /Synthetic process boundary/);
    } else await assert.rejects(manager.session(binding), /Synthetic process boundary/);
    const restarted = new AccountSessionManager(new ProfileStore(directory, key), auth);
    await restarted.recover(binding);
    assert.equal((await restarted.session(binding)).accessToken, 'SYNTHETIC_SUCCESS');
    assert.equal(calls, 1);
  });
}

test('CW010-R04 A04: legacy duplicates and original import tombstones cannot elect a refresh owner', async t => {
  const { store, manager, directory } = await setup(t);
  const a = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_BINDING_A' }, b = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_BINDING_B' };
  const duplicate = tokens();
  await store.write(profile(a, { tokens: duplicate })); await store.write(profile(b, { tokens: duplicate }));
  await assert.rejects(manager.session(a), /already owned/);
  await assert.rejects(manager.session(b), /already owned/);
  const c = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_BINDING_C' }, token = 'SYNTHETIC_LEGACY_USED';
  const otherDir = path.join(directory, 'legacy'); await fs.mkdir(otherDir, { mode: 0o700 });
  const other = new ProfileStore(otherDir, key); await other.write(profile(c, { tokens: tokens({ refreshToken: token }) }));
  const digest = createHmac('sha256', key).update(token).digest('hex');
  await fs.writeFile(path.join(otherDir, `.import-${digest}.used`), 'Legacy fence', { mode: 0o600 });
  await assert.rejects(new AccountSessionManager(other, { verify: async t => ({ identity: identity(), tokens: t }), refresh: async () => { throw Error('No POST allowed'); } }).session(c), /already owned/);
});

test('CW010-R04 A04: permanent legacy guard survives clean close and unknown old lock is never converted', async t => {
  const { directory } = await setup(t);
  const owner = new ProfileOwner(directory); await owner.acquire(); await owner.close();
  await fs.stat(path.join(directory, '.codex-wire-owner', 'format.json'));
  await assert.rejects(fs.stat(path.join(directory, '.codex-wire-owner-v2')), { code: 'ENOENT' });
  const unsafe = path.join(directory, 'unsafe'); await fs.mkdir(path.join(unsafe, '.codex-wire-owner'), { recursive: true, mode: 0o700 });
  await assert.rejects(new ProfileOwner(unsafe).acquire(), /old owner path/);
  assert.deepEqual(await fs.readdir(path.join(unsafe, '.codex-wire-owner')), []);
});

test('CW010-R02 A02: another manager invalidates a warm ready claim before an uncertain epoch can be reused', async t => {
  let calls = 0;
  const auth = { verify: async t => ({ identity: identity(), tokens: t }), refresh: async () => { calls++; throw new CodexError('provider', 'Synthetic uncertain response'); } };
  const { store, manager, directory } = await setup(t, auth);
  const binding = await manager.importTokens(tokens(), 'Warm cache'); await manager.session(binding);
  const other = new AccountSessionManager(new ProfileStore(directory, key), auth);
  await expire(store, binding); await assert.rejects(other.session(binding), /Synthetic uncertain/);
  await assert.rejects(manager.session(binding), /previous token renewal/);
  await assert.rejects(manager.importTokens(tokens(), 'Alias'), /already owned/);
  assert.equal(calls, 1);
});

test('CW010-R02/R04 A01/A04: read-only diagnostics cannot create a registry, lock or profile intent', async t => {
  const { store, directory } = await setup(t);
  const binding = { profileId: randomUUID(), bindingSecret: 'SYNTHETIC_READ_ONLY' };
  await store.write(profile(binding));
  await fs.writeFile(path.join(directory, 'sentinel'), 'Unchanged sentinel', { mode: 0o600 });
  const snapshot = async () => Promise.all((await fs.readdir(directory)).sort().map(async name => ({ name, bytes: (await fs.readFile(path.join(directory, name))).toString('base64'), mode: (await fs.stat(path.join(directory, name))).mode })));
  const before = await snapshot();
  const diagnostic = new ProfileStore(directory, key, undefined, true), current = await diagnostic.read(binding);
  const manager = new AccountSessionManager(diagnostic, { verify: async () => { throw Error('No verification'); }, refresh: async () => { throw Error('No renewal'); } });
  for (const action of [() => diagnostic.rotation.initialize(), () => diagnostic.rotation.register(current), () => diagnostic.rotation.begin(current), () => diagnostic.rotation.beginBootstrap(current), () => diagnostic.rotation.assertReady(current), () => manager.currentSession(binding), () => manager.session(binding)])
    await assert.rejects(action(), /read-only diagnostics/);
  assert.deepEqual(await snapshot(), before);
});

for (const where of ['import', 'renewal', 'recovery']) test(`CW010-R03 A03: ${where} verifier cannot change captured material by mutating its input`, async t => {
  let calls = 0, corrupt = where === 'import';
  const auth = { verify: async candidate => {
    if (corrupt) candidate.refreshToken = 'SYNTHETIC_SUBSTITUTED';
    return { identity: identity(), tokens: candidate };
  }, refresh: async () => { calls++; return tokens({ refreshToken: 'SYNTHETIC_RECEIVED', accessToken: 'SYNTHETIC_SUCCESS' }); } };
  const { manager, store, directory } = await setup(t, auth);
  if (where === 'import') {
    await assert.rejects(manager.importTokens(tokens(), 'Mutating verifier'), /changed captured token/);
    assert.equal(calls, 0); return;
  }
  const binding = await manager.importTokens(tokens(), 'Captured verification');
  await expire(store, binding); corrupt = true;
  await assert.rejects(manager.session(binding), /changed captured token/);
  if (where === 'recovery') await assert.rejects(manager.recover(binding), /changed captured token/);
  const receipt = Object.values((await journal(directory)).receipts)[0];
  assert.equal(receipt.capture.tokens.refreshToken, 'SYNTHETIC_RECEIVED');
  corrupt = false; await manager.recover(binding);
  assert.equal((await store.read(binding)).tokens.refreshToken, 'SYNTHETIC_RECEIVED');
  assert.equal(calls, 1);
});

test('CW010-R02/R04 A02/A04: an established missing journal cannot be reconstructed from profiles', async t => {
  let calls = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { calls++; return tokens(); } };
  const { manager, store, directory } = await setup(t, auth);
  const binding = await manager.importTokens(tokens(), 'Established store');
  await fs.unlink(path.join(directory, '.rotation-v2.json.enc'));
  await expire(store, binding);
  await assert.rejects(new AccountSessionManager(new ProfileStore(directory, key), auth).session(binding), /established token journal is missing/);
  assert.equal(calls, 0);
  await assert.rejects(fs.stat(path.join(directory, '.rotation-v2.json.enc')), { code: 'ENOENT' });
});

for (const bootstrap of [false, true]) test(`CW010-R02 A02: successful independent ${bootstrap ? 'bootstrap' : 'unexpired'} reconnect retires old ready material`, async t => {
  const { manager, store, directory } = await setup(t);
  const binding = await manager.importTokens(tokens(), 'Prior family'), prior = await store.read(binding);
  await manager.importTokens(tokens({ refreshToken: 'SYNTHETIC_INDEPENDENT', expiresAt: bootstrap ? 1 : Date.now() + 3600000 }), 'New family', binding);
  const replacement = await store.read(binding);
  await store.write(prior);
  await assert.rejects(new AccountSessionManager(new ProfileStore(directory, key), {}).currentSession(binding), /already owned/);
  await store.write(replacement);
  assert.equal((await manager.currentSession(binding)).generation, replacement.generation);
});

for (const available of [1, 2]) test(`CW010-R02/R03 A02/A03: ${available} free journal records ${available === 1 ? 'fence POST' : 'cover the complete different-token successor'}`, async t => {
  let calls = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { calls++; return tokens({ refreshToken: 'SYNTHETIC_LAST_SUCCESSOR' }); } };
  const { manager, store, directory } = await setup(t, auth);
  const binding = await manager.importTokens(tokens(), 'Record boundary'); await expire(store, binding);
  const before = await store.read(binding), j = await journal(directory);
  const filler = Object.values(j.claims)[0];
  filler.epochs.unshift(...Array.from({ length: ROTATION_LIMITS.records - available - 2 }, (_, i) => ({ id: randomUUID(), generation: i + 1, state: 'terminal' })));
  await writeJournal(directory, j);
  if (available === 1) {
    await assert.rejects(manager.session(binding), /journal is full/);
    assert.equal(calls, 0); assert.deepEqual(await store.read(binding), before);
  } else {
    await manager.session(binding); assert.equal(calls, 1);
    const committed = await journal(directory);
    assert.equal(Object.keys(committed.receipts).length, 0);
    assert.equal(Object.values(committed.claims).reduce((n, c) => n + 1 + c.epochs.length, 0), ROTATION_LIMITS.records);
    await expire(store, binding); await assert.rejects(manager.session(binding), /journal is full/); assert.equal(calls, 1);
  }
});

test('CW010-R02/R03 A02/A03: 128 unresolved captures prevent another POST without evicting any receipt', async t => {
  let calls = 0;
  const { manager, store, directory } = await setup(t, { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { calls++; return tokens(); } });
  const binding = await manager.importTokens(tokens(), 'Capture boundary'); await expire(store, binding);
  const before = await store.read(binding), j = await journal(directory);
  for (let i = 0; i < ROTATION_LIMITS.captures; i++) {
    const id = randomUUID(), owner = randomUUID(), digest = i.toString(16).padStart(64, '0'), epoch = randomUUID();
    j.claims[digest] = { owner, identity: '0'.repeat(64), epochs: [{ id: epoch, generation: 1, state: 'dispatching' }] };
    const nextEpoch = randomUUID(), replacement = { ...before, id: owner, generation: 2 };
    j.claims[digest].epochs.push({ id: nextEpoch, generation: 2, state: 'blocked' });
    j.receipts[id] = { id, digest, epoch, before: { ...before, id: owner }, capture: { kind: 'tokens', tokens: replacement.tokens }, replacement, nextEpoch };
  }
  await writeJournal(directory, j);
  await assert.rejects(manager.session(binding), /journal is full/);
  assert.equal(calls, 0); assert.deepEqual(await store.read(binding), before);
  assert.deepEqual(await journal(directory), j);
});

test('CW010-R02/R03 A02/A03: payload capacity reserves raw capture, verified profile and successor before POST', async t => {
  let calls = 0;
  const rawObject = { access_token: 'A'.repeat(65536), refresh_token: 'R'.repeat(65536), id_token: 'I'.repeat(65536), expires_in: 3600, padding: '' };
  rawObject.padding = 'P'.repeat(ROTATION_LIMITS.responseBytes - Buffer.byteLength(JSON.stringify(rawObject)));
  const raw = Buffer.from(JSON.stringify(rawObject)); assert.equal(raw.length, ROTATION_LIMITS.responseBytes);
  const auth = new CodexAuthProvider(async () => { calls++; return new Response(raw); });
  auth.verify = async candidate => ({ identity: identity(), tokens: candidate.accessToken === rawObject.access_token ? { ...candidate, scopes: ['S'.repeat(300000)] } : candidate });
  const { manager, store, directory } = await setup(t, auth);
  const binding = await manager.importTokens(tokens(), 'Payload boundary'); await expire(store, binding);
  const before = await store.read(binding), j = await journal(directory);
  // Real registration intents can hold bounded profiles independently of the receipt count.
  // Populate that valid state directly to avoid hundreds of unrelated filesystem commits.
  const target = ROTATION_LIMITS.bytes - 600000;
  while (Buffer.byteLength(JSON.stringify(j)) < target - 500000) {
    const id = randomUUID();
    j.registrations[id] = { ...before, id, tokens: { ...before.tokens, scopes: ['S'.repeat(480000)] } };
  }
  const lastId = randomUUID();
  const last = j.registrations[lastId] = { ...before, id: lastId, tokens: { ...before.tokens, scopes: [''] } };
  last.tokens.scopes[0] = 'S'.repeat(target - Buffer.byteLength(JSON.stringify(j)));
  for (const p of Object.values(j.registrations)) assert(Buffer.byteLength(JSON.stringify(p)) <= 512 * 1024);
  assert.equal(Buffer.byteLength(JSON.stringify(j)), target);
  await writeJournal(directory, j);
  await assert.rejects(manager.session(binding), /payload limit/);
  assert.equal(calls, 0); assert.deepEqual(await store.read(binding), before);
  // Reclaim only a synthetic pending registration: production never evicts historical token claims.
  delete j.registrations[Object.keys(j.registrations)[0]];
  await writeJournal(directory, j);
  await manager.session(binding);
  assert.equal(calls, 1);
  assert.equal((await store.read(binding)).tokens.refreshToken, rawObject.refresh_token);
  const committed = await journal(directory);
  assert.equal(Object.keys(committed.receipts).length, 0);
  assert(Buffer.byteLength(JSON.stringify(committed)) <= ROTATION_LIMITS.bytes);
});
