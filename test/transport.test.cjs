const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ResponsesTransport, DEFAULT_SETTINGS } = require('../dist');
const { sseEvents } = require('../dist/core/sse');
const { output, textEvent, complete, sseResponse, session } = require('./helpers.cjs');
const request = { model: 'synthetic-model', stream: true, store: false, input: [], include: [] };
async function collect(iterator) { const events = []; for await (const event of iterator) events.push(event); return events; }

test('UTF-8, CRLF, comments and multi-line SSE data survive arbitrary chunk boundaries', async () => {
  const encoded = Buffer.from(': heartbeat\r\nevent: synthetic\r\ndata: {"type":"synthetic",\r\ndata: "text":"雪🦊"}\r\n\r\n');
  let offset = 0;
  const body = new ReadableStream({ pull(c) { if (offset === encoded.length) return c.close(); c.enqueue(encoded.subarray(offset, ++offset)); } });
  const events = await collect(sseEvents(body, new AbortController().signal, 1000));
  assert.deepEqual(events, [{ type: 'synthetic', text: '雪🦊' }]);
});

for (const terminal of ['EOF', 'response.failed', 'response.incomplete', 'error']) test(`${terminal} cannot become a successful response`, async () => {
  const events = [textEvent('Partial')];
  if (terminal !== 'EOF') events.push({ type: terminal, response: { error: { message: 'SYNTHETIC_SECRET' } } });
  let requests = 0;
  const transport = new ResponsesTransport(async () => { requests++; return sseResponse(events); });
  await assert.rejects(collect(transport.stream(request, session(), { ...DEFAULT_SETTINGS, maxRetries: 3 }, [], false)), error => !error.message.includes('SYNTHETIC_SECRET'));
  assert.equal(requests, 1);
});

test('Retries only explicit admission failures and obeys cancellation during retry delay', async () => {
  let requests = 0;
  const transport = new ResponsesTransport(async () => ++requests === 1 ? new Response('SYNTHETIC_SECRET', { status: 503, headers: { 'retry-after': '0' } }) : sseResponse([complete(output())]));
  const result = await collect(transport.stream(request, session(), DEFAULT_SETTINGS, [], false));
  assert.equal(requests, 2); assert.equal(result.at(-1).kind, 'completed');
  let ambiguous = 0;
  const broken = new ResponsesTransport(async () => { ambiguous++; throw new Error('SYNTHETIC_SECRET'); });
  await assert.rejects(collect(broken.stream(request, session(), DEFAULT_SETTINGS, [], false)), error => !error.message.includes('SYNTHETIC_SECRET'));
  assert.equal(ambiguous, 1);
  const controller = new AbortController();
  const waiting = new ResponsesTransport(async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  const promise = collect(waiting.stream(request, session(), DEFAULT_SETTINGS, [controller.signal], false));
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(promise, /cancelled/);
});

test('Cancel and idle timeout close the upstream reader promptly', async () => {
  let cancelled = false;
  const hanging = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  const controller = new AbortController();
  const transport = new ResponsesTransport(async () => hanging());
  const started = performance.now();
  const pending = collect(transport.stream(request, session(), DEFAULT_SETTINGS, [controller.signal], false));
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancelled, true); assert(performance.now() - started < 1000);
  cancelled = false;
  await assert.rejects(collect(transport.stream(request, session(), { ...DEFAULT_SETTINGS, idleTimeoutMs: 25 }, [], false)), /idle timeout/);
  assert.equal(cancelled, true);
});

test('Streaming buffers have explicit size limits', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(Buffer.from('data: ' + 'x'.repeat(5 * 1024 * 1024))); c.close(); } });
  await assert.rejects(collect(sseEvents(body, new AbortController().signal, 1000)), /size limit/);
});
