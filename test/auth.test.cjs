const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { mkdir, mkdtemp, readFile, stat, rm } = require('node:fs/promises');
const path = require('node:path');
const { AccountSessionManager, ProfileStore, CodexAuthProvider, CodexError, parseManualTokens, PROVIDER, CODEX_CLIENT_ID, ISSUER } = require('../dist');
const { identity, tokens, profile } = require('./helpers.cjs');

async function context(t, provider) {
  await mkdir('.test-state', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.resolve('.test-state/auth-'));
  const store = new ProfileStore(directory, Buffer.alloc(32, 0x53));
  const auth = provider ?? { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async candidate => tokens({ accessToken: candidate.accessToken + '_REPLACED', refreshToken: candidate.refreshToken + '_REPLACED' }) };
  const manager = new AccountSessionManager(store, auth);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { store, manager, auth, directory };
}

test('100 concurrent expired-token callers share one renewal and retain its replacement after restart', async t => {
  let refreshes = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { refreshes++; await new Promise(r => setTimeout(r, 40)); return tokens({ accessToken: 'SYNTHETIC_REPLACEMENT_ACCESS', refreshToken: 'SYNTHETIC_REPLACEMENT_REFRESH' }); } };
  const { store, manager, directory } = await context(t, auth);
  const binding = await manager.importTokens(tokens(), 'Synthetic account');
  const current = await store.read(binding);
  await store.write({ ...current, tokens: tokens({ expiresAt: Date.now() - 1000 }) });
  const sessions = await Promise.all(Array.from({ length: 100 }, () => manager.session(binding)));
  assert.equal(refreshes, 1);
  assert.equal(new Set(sessions.map(s => s.accessToken)).size, 1);
  assert.equal((await store.read(binding)).tokens.refreshToken, 'SYNTHETIC_REPLACEMENT_REFRESH');
  const restarted = new AccountSessionManager(new ProfileStore(directory, Buffer.alloc(32, 0x53)), auth);
  assert.equal((await restarted.session(binding)).accessToken, 'SYNTHETIC_REPLACEMENT_ACCESS');
  assert.equal(refreshes, 1);
  const encrypted = await readFile(path.join(directory, `${binding.profileId}.json.enc`), 'utf8');
  assert.equal(encrypted.includes('SYNTHETIC_REPLACEMENT'), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, `${binding.profileId}.json.enc`))).mode & 0o777, 0o600);
});

test('File coordination re-reads generation rather than reusing a rotated secret', async t => {
  let calls = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { calls++; await new Promise(r => setTimeout(r, 50)); return tokens(); } };
  const { store, manager } = await context(t, auth);
  const binding = await manager.importTokens(tokens(), 'Synthetic account');
  await store.write({ ...(await store.read(binding)), tokens: tokens({ expiresAt: Date.now() - 1 }) });
  const other = new AccountSessionManager(store, auth);
  await Promise.all([manager.session(binding), other.session(binding)]);
  assert.equal(calls, 1);
});

test('Cancellation does not cancel renewal shared by other executions', async t => {
  let calls = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { calls++; await new Promise(r => setTimeout(r, 60)); return tokens(); } };
  const { store, manager } = await context(t, auth);
  const binding = await manager.importTokens(tokens(), 'Synthetic account');
  await store.write({ ...(await store.read(binding)), tokens: tokens({ expiresAt: Date.now() - 1 }) });
  const controller = new AbortController();
  const cancelled = manager.session(binding, controller.signal);
  const successful = manager.session(binding);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(cancelled, /cancelled/);
  assert((await successful).accessToken);
  assert.equal(calls, 1);
});

test('Failed import, identity mismatch and unrelated account profiles remain isolated', async t => {
  const auth = { verify: async candidate => {
    if (candidate.accessToken === 'MALFORMED_SYNTHETIC') throw new CodexError('authentication', 'Synthetic validation failure');
    return { identity: identity(candidate.accessToken === 'OTHER_SYNTHETIC' ? 'other' : undefined), tokens: candidate };
  }, refresh: async () => tokens() };
  const { store, manager } = await context(t, auth);
  const first = await manager.importTokens(tokens(), 'First');
  const second = await manager.importTokens(tokens({ accessToken: 'OTHER_SYNTHETIC', refreshToken: 'OTHER_INDEPENDENT_SYNTHETIC_REFRESH' }), 'Second');
  const before = await store.read(first);
  await assert.rejects(manager.importTokens(tokens({ accessToken: 'MALFORMED_SYNTHETIC' }), 'Failed', first), /validation/);
  await assert.rejects(manager.importTokens(tokens({ accessToken: 'OTHER_SYNTHETIC' }), 'Wrong identity', first), /different account/);
  assert.deepEqual(await store.read(first), before);
  assert.equal((await store.read(second)).accountId, 'other');
  await manager.importTokens(tokens({ accessToken: 'SYNTHETIC_RECONNECT' }), 'First renewed', first);
  assert.equal((await store.read(first)).generation, before.generation + 1);
  assert.equal((await store.read(second)).generation, 1);
  await assert.rejects(store.read({ ...first, bindingSecret: 'INCORRECT_SYNTHETIC_BINDING' }), /binding is invalid/);
});

test('Access-only, expired import, no-refresh and earliest-refresh rules are explicit', async t => {
  let count = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { count++; return tokens(); } };
  const { store, manager } = await context(t, auth);
  const binding = await manager.importTokens(tokens({ refreshToken: undefined }), 'Access only');
  assert((await manager.session(binding)).accessToken);
  await store.write({ ...(await store.read(binding)), tokens: tokens({ refreshToken: undefined, expiresAt: Date.now() - 1 }) });
  await assert.rejects(manager.session(binding), /expired/);
  assert.equal(count, 0);
  const renewable = await manager.importTokens(tokens({ expiresAt: Date.now() - 1 }), 'Expired renewable');
  assert.equal(count, 1);
  await store.write({ ...(await store.read(renewable)), tokens: tokens({ expiresAt: Date.now() - 1 }) });
  const noRefresh = new AccountSessionManager(store, auth, false);
  await assert.rejects(noRefresh.session(renewable), /expired/);
  assert.equal(count, 1);
  await store.write({ ...(await store.read(renewable)), tokens: tokens({ expiresAt: Date.now() - 1, earliestRefreshAt: Date.now() + 60000 }) });
  await assert.rejects(manager.session(renewable), /expired/);
  assert.equal(count, 1);
});

test('Unknown rotation outcome preserves tokens and fences any reuse, including restart', async t => {
  let count = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { count++; throw new CodexError('provider', 'Synthetic uncertain outcome'); } };
  const { store, manager } = await context(t, auth);
  const binding = await manager.importTokens(tokens(), 'Synthetic account');
  await store.write({ ...(await store.read(binding)), tokens: tokens({ expiresAt: Date.now() - 1 }) });
  await assert.rejects(manager.session(binding), /uncertain/);
  assert.equal((await store.read(binding)).state, 'refresh_uncertain');
  assert.equal((await store.read(binding)).tokens.refreshToken, 'SYNTHETIC_REFRESH_TOKEN_NOT_VALID');
  await assert.rejects(new AccountSessionManager(store, auth).session(binding), /previous token renewal/);
  assert.equal(count, 1);
});

test('Remote rotation followed by persistence failure cannot replay the previous refresh token', async t => {
  let count = 0;
  const auth = { verify: async candidate => ({ identity: identity(), tokens: candidate }), refresh: async () => { count++; return tokens(); } };
  const { store, manager } = await context(t, auth);
  const binding = await manager.importTokens(tokens(), 'Synthetic account');
  await store.write({ ...(await store.read(binding)), tokens: tokens({ expiresAt: Date.now() - 1 }) });
  const originalWrite = store.write.bind(store);
  store.write = async value => { if (value.generation > 1) throw new CodexError('storage', 'Synthetic persistence failure'); return originalWrite(value); };
  await assert.rejects(manager.session(binding), /persistence failure/);
  assert.equal((await store.read(binding)).state, 'refresh_uncertain');
  await assert.rejects(manager.session(binding), /persistence failure/);
  assert.equal(count, 1);
  store.write = originalWrite;
  await manager.session(binding);
  assert.equal(count, 1, 'Captured verified success recovers locally without a second POST');
});

test('Manual import is provider-scoped and cannot bootstrap from a refresh token alone', () => {
  assert.throws(() => parseManualTokens({ provider: 'siwc', client_id: 'dynamic_agent_client', access_token: 'SYNTHETIC' }, 'token-set'), /matching provider/);
  assert.throws(() => parseManualTokens({ provider: PROVIDER, client_id: CODEX_CLIENT_ID, refresh_token: 'SYNTHETIC' }, 'token-set'), /refresh-only bootstrap/);
  assert.throws(() => parseManualTokens({ OPENAI_API_KEY: 'SYNTHETIC_API_KEY', tokens: {} }, 'codex-auth-json'), /API keys/);
  assert.throws(() => parseManualTokens({ provider: PROVIDER, client_id: CODEX_CLIENT_ID, access_token: 'SYNTHETIC', arbitrary: true }, 'token-set'), /unsupported fields/);
});

test('Signed Codex tokens are checked for signature, issuer, audience, client and account identity', async () => {
  const { SignJWT, exportJWK } = await import('jose');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
  const auth = new CodexAuthProvider(async url => {
    assert.equal(String(url), `${ISSUER}/.well-known/jwks.json`);
    return Response.json({ keys: [jwk] });
  });
  const claims = { client_id: CODEX_CLIENT_ID, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' }, scope: 'openid offline_access' };
  const signed = async (overrides = {}) => new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' }).setIssuer(ISSUER).setSubject('synthetic-subject').setAudience('https://api.openai.com/v1').setExpirationTime('1h').sign(privateKey);
  const valid = await signed();
  assert.equal((await auth.verify(tokens({ accessToken: valid }))).identity.accountId, 'synthetic-account');
  await assert.rejects(auth.verify(tokens({ accessToken: await signed({ client_id: 'wrong-client' }) })), /different OAuth client/);
  const tampered = valid.slice(0, -5) + 'AAAAA';
  await assert.rejects(auth.verify(tokens({ accessToken: tampered })), /could not be verified/);
  await assert.rejects(auth.verify(tokens({ accessToken: await signed({ 'https://api.openai.com/auth': {} }) })), /account identifier/);
});

test('Abandoned profile locks fail closed without stealing or refreshing', async t => {
  const { store, directory } = await context(t);
  const id = randomUUID();
  await mkdir(path.join(directory, `${id}.lock`), { mode: 0o700 });
  let executed = false;
  await assert.rejects(store.locked(id, async () => { executed = true; }, 25), /locked by another/);
  assert.equal(executed, false);
});
