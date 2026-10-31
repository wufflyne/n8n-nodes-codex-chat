'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { gzipSync, deflateSync } = require('node:zlib');
const ts = require('../../node_modules/typescript');
const { smartquotesBody } = require('./backport-inputs.cjs');
const build = process.env.CODEX_WIRE_SECURITY_BUILD;
const source = process.env.CODEX_WIRE_UPSTREAM_SOURCE;
if (!build || !source) throw new Error('Set CODEX_WIRE_SECURITY_BUILD and CODEX_WIRE_UPSTREAM_SOURCE to the qualified local inputs.');
const fixture = createRequire(path.join(build, 'module-entry.cjs'));
const z = fixture('zod');
const image = require('./image-manifest.json');
const helperPath = path.join(build, 'overlay', image.packageRoots['@n8n/ai-utilities'].path, 'dist/cjs/utils/mcp-input-limits.js');
const limits = require(helperPath);

test('CW010-R13/R25: embedded release preflight verifies the prepared dependency, source and signed OS bundle', t => {
  const { preparedSecurity } = require('../../scripts/prepared-security.cjs');
  const root = path.resolve(__dirname, '../..');
  assert.throws(() => preparedSecurity(root, undefined), /CODEX_RELEASE_SECURITY_BUNDLE/);
  const receipt = preparedSecurity(root, build);
  assert.equal(receipt.directory, fs.realpathSync(build));
  const parent = fs.mkdtempSync(path.join(path.resolve(process.env.TMPDIR || '.test-state'), 'security-preflight-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const copy = path.join(parent, 'bundle');
  fs.cpSync(build, copy, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  const dependency = path.join(copy, 'node_modules/linkify-it/build/index.cjs.js');
  const original = fs.readFileSync(dependency); fs.appendFileSync(dependency, '\n// changed\n');
  assert.throws(() => preparedSecurity(root, copy), /dependency contents differ/);
  fs.writeFileSync(dependency, original);
  const tool = path.join(copy, 'tools/install-security.cjs'); fs.appendFileSync(tool, '\n// stale\n');
  assert.throws(() => preparedSecurity(root, copy), /Unexpected backport input/);
  fs.copyFileSync(path.join(build, 'tools/install-security.cjs'), tool);
  const output = JSON.parse(fs.readFileSync(path.join(copy, 'build-manifest.json'))).files[0].target;
  fs.unlinkSync(path.join(copy, 'overlay', output));
  assert.throws(() => preparedSecurity(root, copy), /ENOENT/);
});

test('CW010-R13: materialized-image installation rejects parent symlinks before any outside write', t => {
  const { installSecurity } = require('./install-security.cjs');
  const parent = path.resolve(process.env.TMPDIR || '.test-state'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'security-root-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'image'), outside = path.join(directory, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'sentinel'); fs.writeFileSync(sentinel, 'unchanged');
  fs.symlinkSync(outside, path.join(root, 'usr'), 'dir');
  assert.throws(() => installSecurity(root, build), /escapes the selected root/);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  const alias = path.join(directory, 'alias'); fs.symlinkSync(root, alias, 'dir');
  assert.throws(() => installSecurity(alias, build), /root must not contain symbolic-link/);
});
function sourceModule(relative, mocks = {}) {
  const filename = path.join(source, relative), input = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(input, { fileName: relative, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  return evaluated(output, filename, mocks);
}
function evaluated(code, filename, mocks) {
  const module = { exports: {} };
  const load = name => name in mocks ? mocks[name] : fixture(name);
  new vm.Script('(function(require,module,exports){' + code + '\n})', { filename }).runInThisContext()(load, module, module.exports);
  return module.exports;
}

test('CW010-R13: compatible Zod backport rejects oversized collections before callbacks and preserves valid results', async () => {
  let parsed = 0;
  const value = z.string().refine(() => ++parsed);
  const schema = z.array(value).max(2);
  assert.equal(schema.safeParse(['a', 'b', 'c']).success, false);
  assert.equal((await schema.safeParseAsync(['a', 'b', 'c'])).success, false);
  assert.equal(z.set(value).max(2).safeParse(new Set(['a', 'b', 'c'])).success, false);
  assert.equal(parsed, 0);
  assert.deepEqual(schema.parse(['a', 'b']), ['a', 'b']);
  assert.equal(parsed, 2);
  const input = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => ['k' + i, i]));
  const start = performance.now();
  assert.deepEqual(z.intersection(z.record(z.number()), z.record(z.number())).parse(input), input);
  assert(performance.now() - start < 2000);
  const emoji = z.string().emoji(), bad = '🦰'.repeat(26) + ' ';
  const before = performance.now();
  assert.equal(emoji.safeParse(bad).success, false);
  assert(performance.now() - before < 100);
  assert.equal(emoji.parse('🦰🦱🦲🦳'), '🦰🦱🦲🦳');
  const v4 = fixture('zod/v4');
  const v4Start = performance.now();
  assert.equal(v4.string().emoji().safeParse(bad).success, false);
  assert(performance.now() - v4Start < 100);
});

test('CW010-R13: smartquotes preserves ordinary rendered text and bounds adversarial openers', () => {
  const Markdown = fixture('markdown-it');
  const patched = new Markdown({ typographer: true });
  const baseFile = fixture.resolve('markdown-it/lib/rules_core/smartquotes');
  // The original published implementation is supplied explicitly by the qualification fixture.
  const original = process.env.CODEX_WIRE_ORIGINAL_SMARTQUOTES;
  if (!original) throw new Error('Set CODEX_WIRE_ORIGINAL_SMARTQUOTES to the retained 13.0.2 implementation.');
  const oldRule = evaluated(fs.readFileSync(original, 'utf8'), original, { '../common/utils': fixture('markdown-it/lib/common/utils') });
  const baseline = new Markdown({ typographer: true }); baseline.core.ruler.at('smartquotes', oldRule);
  const corpus = ['"Hello" and \'world\'.', 'It\'s a test — "a \'nested\' quote".', '"**bold** and *italic*"', '1" and 2\' and 1"".', '«Привет», "мир" — \'élève\'.', '["link"](https://example.invalid)\n\n`"code"`', '"one\nline"', 'foo-"-bar-"-baz', '"unfinished'];
  for (const quotes of ['“”‘’', ['« ', ' »', '‹ ', ' ›']]) {
    baseline.set({ quotes }); patched.set({ quotes });
    for (const input of corpus) assert.equal(patched.render(input), baseline.render(input));
  }
  patched.set({ quotes: '“”‘’' });
  const start = performance.now();
  const rendered = patched.render('"a '.repeat(20000) + "b' ".repeat(20000));
  assert(rendered.includes('a ')); assert(performance.now() - start < 2000);
  assert(fs.readFileSync(baseFile, 'utf8').includes(smartquotesBody()));
});

test('CW010-R13: maintained linkify paths preserve links and bound the four reported scan patterns', () => {
  const Markdown = fixture('markdown-it');
  const options = { html: false, linkify: true, typographer: true, breaks: true };
  const patched = new Markdown(options), baseline = new Markdown(options);
  const original = process.env.CODEX_WIRE_ORIGINAL_MARKDOWN;
  if (!original) throw new Error('Set CODEX_WIRE_ORIGINAL_MARKDOWN to retained original Markdown rule files.');
  for (const kind of ['core', 'inline']) {
    const filename = path.join(original, 'rules_' + kind, 'linkify.js');
    const rule = evaluated(fs.readFileSync(filename, 'utf8'), filename, { '../common/utils': fixture('markdown-it/lib/common/utils') });
    baseline[kind].ruler.at('linkify', rule);
  }
  for (const input of ['Visit https://example.org/a?q=1 and a@b.co.', 'one a@b.co\ntwo a@b.co', '[link](https://example.org) and `a@b.co`', 'foo\\://example.org *https://example.org/**', 'Привет https://пример.рф/a and \"quoted\" text.', 'a://x a://y', 'mailto:a@b.co', '<a href=\"https://example.org\">a@b.co</a>'])
    assert.equal(patched.render(input), baseline.render(input));
  assert.equal(fixture('linkify-it/package.json').version, '5.0.2');
  for (const [name, input] of [['fuzzy-email', 'a@b.co '.repeat(16000)], ['soft-line-email', 'a@b.co\n'.repeat(16000)], ['mailto-scan', 'mailto:'.repeat(32000)], ['unknown-scheme', 'a://'.repeat(32000)]]) {
    const start = performance.now(), output = patched.render(input), elapsed = performance.now() - start;
    assert(output.length > 0); assert(elapsed < 2000, `${name}: ${elapsed} ms`);
    if (name.includes('email')) assert.equal((output.match(/href=\"mailto:/g) || []).length, 16000);
    else assert.equal(output.includes('<a '), false);
  }
});

for (const family of [1, 2]) test(`CW010-R13: actual MCP ${family}.x tool limit rejects before schema callbacks and preserves the exact boundary`, async () => {
  let validations = 0, executions = 0;
  const input = z.object({ values: z.preprocess(value => { validations++; return value; }, z.array(z.string())) });
  const calls = [2, 9999, 10000];
  if (family === 1) {
    const { McpServer } = fixture('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = fixture('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = fixture('@modelcontextprotocol/sdk/inMemory.js');
    const server = new McpServer({ name: 'bounded', version: '1.0' }, { maxToolInputElements: limits.MCP_MAX_TOOL_ELEMENTS });
    server.registerTool('bounded', { inputSchema: input }, async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; });
    const client = new Client({ name: 'test', version: '1.0' }); const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      for (const length of calls) {
        const result = await client.callTool({ name: 'bounded', arguments: { values: Array(length).fill('x') } });
        assert.equal(Boolean(result.isError), length === 10000);
      }
    } finally { await client.close(); await server.close(); }
  } else {
    const { McpServer, createMcpHandler } = fixture('@modelcontextprotocol/server');
    const schema = { '~standard': { version: 1, vendor: 'n8n-zod-classic', validate: value => {
      const result = input.safeParse(value); return result.success ? { value: result.data } : { issues: result.error.issues };
    }, jsonSchema: { input: () => ({ type: 'object', properties: { values: { type: 'array', items: { type: 'string' } } } }), output: () => ({}) } } };
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'bounded', version: '1.0' }, { maxToolInputElements: limits.MCP_MAX_TOOL_ELEMENTS });
      server.registerTool('bounded', { inputSchema: schema }, async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; });
      return server;
    }, { legacy: 'stateless', maxRequestBodySize: limits.MCP_MAX_BODY_BYTES });
    try {
      for (const length of calls) {
        const response = await handler.fetch(new Request('https://mcp.invalid/http', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json,text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: length, method: 'tools/call', params: { name: 'bounded', arguments: { values: Array(length).fill('x') } } }) }));
        const text = await response.text();
        assert.equal(text.includes('maximum'), length === 10000, text.slice(0, 1000));
        assert.equal(text.includes('"text":"ok"'), length !== 10000, text.slice(0, 1000));
      }
    } finally { await handler.close(); }
  }
  assert.equal(validations, 2); assert.equal(executions, 2);
});

test('CW010-R13: actual MCP 2.x handler rejects oversized unparsed bytes before creating a server', async () => {
  const { createMcpHandler, McpServer } = fixture('@modelcontextprotocol/server'); let factories = 0;
  const handler = createMcpHandler(() => { factories++; return new McpServer({ name: 'bounded', version: '1.0' }); }, { legacy: 'stateless', maxRequestBodySize: limits.MCP_MAX_BODY_BYTES });
  try {
    const response = await handler.fetch(new Request('https://mcp.invalid/http', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json,text/event-stream' }, body: ' '.repeat(limits.MCP_MAX_BODY_BYTES + 1) }));
    assert.equal(response.status, 413); assert.equal(factories, 0);
  } finally { await handler.close(); }
});

let hostResponseHelper;
function responseModule() {
  if (hostResponseHelper) return hostResponseHelper;
  const errors = createRequire(path.join(process.env.CODEX_WIRE_SDK_ROOT, '__entry.cjs'))('@n8n/errors');
  const classifier = sourceModule('packages/@n8n/backend-services/src/errors/rest-error-classifier.ts', { '@n8n/errors': errors });
  const serializer = sourceModule('packages/@n8n/backend-services/src/errors/rest-error-response.ts', {
    './rest-error-classifier': classifier,
    '@n8n/api-types': { isWorkflowPublishBlockedDetails: () => false, PROMOTIONS_WORKFLOWS_MOVED_CROSS_PROJECT_CODE: 'unused' },
  });
  hostResponseHelper = sourceModule('packages/cli/src/response-helper.ts', {
    '@n8n/backend-common': { inDevelopment: false, Logger: class {} },
    '@n8n/backend-services': { ...classifier, ...serializer },
    '@n8n/db': { isUniqueConstraintError: () => false },
    '@n8n/di': { Container: { get: () => { throw Error('Unused framework DI in parser response control'); } } },
    '@n8n/errors': errors, 'n8n-core': { ErrorReporter: class {} },
    '@n8n/utils/errors/ensure-error': { ensureError: value => value instanceof Error ? value : new Error(String(value)) },
    'n8n-workflow': { FORM_TRIGGER_PATH_IDENTIFIER: 'form', NodeApiError: class extends Error {} },
    picocolors: { red: value => value },
    './webhooks/webhook-response-headers': { applySandboxCSP: () => { throw Error('Unused form response in MCP control'); } },
  });
  return hostResponseHelper;
}
function bodyModule() {
  const errors = createRequire(path.join(process.env.CODEX_WIRE_SDK_ROOT, '__entry.cjs'))('@n8n/errors');
  return evaluated(fs.readFileSync(path.join(build, 'overlay', image.packageRoots.n8n.path, 'dist/middlewares/body-parser.js'), 'utf8'), 'actual-body-parser.js', {
    '@n8n/ai-utilities/mcp-input-limits': limits,
    '@n8n/backend-network': { parseIncomingMessage: req => { req.contentType = req.headers['content-type']; req.encoding = 'utf8'; } },
    '@n8n/config': { GlobalConfig: class {} }, '@n8n/di': { Container: { get: () => ({ endpoints: { payloadSizeMax: 16 } }) } },
    'n8n-workflow': { jsonParse: JSON.parse, sanitizeXmlName: value => value }, 'xml2js': { Parser: class {} },
    '@n8n/errors': errors, '../response-helper': responseModule(),
  });
}
async function middlewareRequest({ method = 'POST', body = '', headers = { 'content-type': 'application/json' }, route = '/mcp-server/http', rawReadError, alreadyRead, headersSent = false } = {}) {
  const parser = bodyModule(), req = new PassThrough();
  req.method = method; req.path = route; req.headers = headers;
  let next = 0, forwarded, response, reads = 0;
  const res = { req: { originalUrl: route }, headersSent, setHeader(name, value) { this[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(body) { response = { status: this.statusCode, body }; this.headersSent = true; return this; } };
  parser.rawBodyReader(req, res, () => {});
  const read = req.readRawBody;
  req.readRawBody = async () => { reads++; if (rawReadError) throw rawReadError; if (alreadyRead) req.rawBody = alreadyRead; else await read(); };
  const operation = parser.bodyParser(req, res, error => { if (error !== undefined) forwarded = error; else next++; });
  req.end(body);
  let thrown;
  try { await operation; } catch (error) { thrown = error; }
  return { next, forwarded, response, reads, thrown, body: req.body, responseContentType: res['Content-Type'] };
}
async function parsedRequest(body, encoding) {
  const parser = bodyModule(), req = new PassThrough(); req.method = 'POST'; req.path = '/base/mcp-server/http';
  req.headers = { 'content-type': 'application/json', ...(encoding ? { 'content-encoding': encoding } : {}) };
  parser.rawBodyReader(req, {}, () => {});
  const operation = parser.parseMcpBody(req); req.end(body);
  await operation; return req;
}
test('CW010-R13: MCP discovery methods allow empty bodies and still bound actual non-POST bodies', async () => {
  for (const method of ['HEAD', 'GET']) {
    const empty = await middlewareRequest({ method, headers: {} });
    assert.equal(empty.next, 1); assert.equal(empty.reads, 1); assert.equal(empty.response, undefined); assert.equal(empty.thrown, undefined);
    const nonempty = await middlewareRequest({ method, headers: {}, body: 'x' });
    assert.equal(nonempty.next, 0); assert.equal(nonempty.response.status, 400); assert.equal(nonempty.thrown, undefined);
  }
  for (const encoding of [undefined, 'gzip', 'deflate']) {
    const payload = ' '.repeat(limits.MCP_MAX_BODY_BYTES + 1);
    const body = encoding === 'gzip' ? gzipSync(payload) : encoding === 'deflate' ? deflateSync(payload) : Buffer.from(payload);
    const oversized = await middlewareRequest({ method: 'GET', body, headers: encoding ? { 'content-encoding': encoding } : {} });
    assert.equal(oversized.next, 0); assert.equal(oversized.response.status, 413); assert.equal(oversized.thrown, undefined);
  }
  const cached = await middlewareRequest({ method: 'GET', headers: {}, alreadyRead: Buffer.alloc(limits.MCP_MAX_BODY_BYTES + 1, 32) });
  assert.equal(cached.response.status, 413); assert.equal(cached.next, 0);
});

test('CW010-R13: MCP middleware uses actual host error serialization and preserves exact valid bounds', async () => {
  const valid = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const exact = valid + ' '.repeat(limits.MCP_MAX_BODY_BYTES - Buffer.byteLength(valid));
  for (const body of [exact, JSON.stringify(Array(100).fill({ method: 'ping' })), JSON.stringify({ method: 'tools/call', params: { arguments: { values: Array(9999).fill(1) } } })]) {
    const value = await middlewareRequest({ body }); assert.equal(value.next, 1); assert.equal(value.response, undefined); assert.equal(value.thrown, undefined);
  }
  const cases = [
    [{ headers: {}, body: '{}' }, 400], [{ body: '{' }, 422],
    [{ body: JSON.stringify(Array(101).fill({ method: 'ping' })) }, 400],
    [{ body: JSON.stringify({ method: 'tools/call', params: { arguments: { values: Array(10000).fill(1) } } }) }, 400],
  ];
  for (const encoding of [undefined, 'gzip', 'deflate']) {
    const text = ' '.repeat(limits.MCP_MAX_BODY_BYTES + 1), body = encoding === 'gzip' ? gzipSync(text) : encoding === 'deflate' ? deflateSync(text) : Buffer.from(text);
    cases.push([{ body, headers: { 'content-type': 'application/json', ...(encoding ? { 'content-encoding': encoding } : {}) } }, 413]);
  }
  for (const [input, status] of cases) {
    const value = await middlewareRequest(input); assert.equal(value.next, 0); assert.equal(value.forwarded, undefined); assert.equal(value.thrown, undefined);
    assert.equal(value.response.status, status); assert.equal(value.response.body.code, status); assert.equal(value.responseContentType, 'application/json');
  }
});

test('CW010-R13: MCP-only error handling leaves unrelated errors and headers-sent delegation unchanged', async () => {
  const unknown = new Error('Synthetic internal parser failure'), value = await middlewareRequest({ rawReadError: unknown });
  assert.equal(value.response.status, 500); assert.equal(value.next, 0); assert.equal(value.thrown, undefined);
  const sent = await middlewareRequest({ rawReadError: unknown, headersSent: true });
  assert.equal(sent.forwarded, unknown); assert.equal(sent.response, undefined); assert.equal(sent.next, 0);
  const nonError = await middlewareRequest({ rawReadError: 'synthetic non-Error rejection' });
  assert.equal(nonError.forwarded, 'synthetic non-Error rejection'); assert.equal(nonError.response, undefined);
  const ordinary = await middlewareRequest({ route: '/rest/ordinary', body: '{' });
  assert.equal(ordinary.response, undefined); assert.equal(ordinary.next, 0); assert.equal(ordinary.thrown.httpStatusCode, 422);
});

for (const encoding of [undefined, 'gzip', 'deflate']) test(`CW010-R13: actual parsed-body path bounds ${encoding ?? 'plain'} bytes and arguments before tool admission`, async () => {
  const encode = value => encoding === 'gzip' ? gzipSync(value) : encoding === 'deflate' ? deflateSync(value) : Buffer.from(value);
  const valid = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bounded', arguments: { values: ['ok'] } } });
  assert.equal((await parsedRequest(encode(valid), encoding)).body.params.arguments.values[0], 'ok');
  await assert.rejects(parsedRequest(encode(' '.repeat(limits.MCP_MAX_BODY_BYTES + 1)), encoding), /too large|1 MiB/);
  await assert.rejects(parsedRequest(encode(JSON.stringify({ method: 'tools/call', params: { arguments: { values: Array(10000).fill(1) } } })), encoding), /10000-element/);
  await assert.rejects(parsedRequest(encode(JSON.stringify(Array(101).fill({ method: 'ping' }))), encoding), /100-message/);
});

test('CW010-R13: SDK redirect handling preserves n8n custom fetch policy, with zero foreign credential/body delivery', async () => {
  const redirect = sourceModule('packages/@n8n/ai-utilities/src/utils/follow-redirects.ts', { 'n8n-workflow': { OperationalError: Error } });
  const { createRefreshingAuthFetch } = sourceModule('packages/@n8n/ai-utilities/src/utils/refreshing-auth-fetch.ts', { './follow-redirects': redirect });
  const { fetchWithinOrigin } = fixture('@modelcontextprotocol/sdk/shared/transport.js');
  for (const status of [301, 302, 303, 307, 308]) {
    const delivered = [];
    const wrapped = createRefreshingAuthFetch({ initialHeaders: { authorization: 'SYNTHETIC_AUTH', 'x-private': 'SYNTHETIC_HEADER' }, baseFetch: async (url, init) => {
      delivered.push({ url: String(url), headers: new Headers(init.headers), body: init.body, redirect: init.redirect });
      return new Response('', { status, headers: { location: 'https://foreign.invalid/receive' } });
    } });
    const response = await fetchWithinOrigin(wrapped)('https://origin.invalid/mcp', { method: 'POST', headers: { 'x-request-private': 'SYNTHETIC_REQUEST_HEADER' }, body: 'SYNTHETIC_BODY' });
    assert.equal(response.status, status); assert.equal(delivered.length, 1); assert.equal(delivered[0].url, 'https://origin.invalid/mcp'); assert.equal(delivered[0].redirect, 'manual');
  }
  const seen = [];
  const same = createRefreshingAuthFetch({ initialHeaders: { authorization: 'SYNTHETIC_AUTH' }, baseFetch: async (url, init) => {
    seen.push({ url: String(url), body: init.body, auth: new Headers(init.headers).get('authorization') });
    return seen.length === 1 ? new Response('', { status: 307, headers: { location: '/next' } }) : new Response('ok');
  } });
  assert.equal(await (await fetchWithinOrigin(same)('https://origin.invalid/mcp', { method: 'POST', body: 'SYNTHETIC_BODY' })).text(), 'ok');
  assert.equal(seen.length, 2); assert.equal(seen[1].body, 'SYNTHETIC_BODY'); assert.equal(seen[1].auth, 'SYNTHETIC_AUTH');
});
