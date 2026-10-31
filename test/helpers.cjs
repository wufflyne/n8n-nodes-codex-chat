const { createHash } = require('node:crypto');
const { CODEX_CLIENT_ID, ISSUER, PROVIDER } = require('../dist/core/types');

const rawModel = (extra = {}) => ({ slug: 'synthetic-model', display_name: 'Synthetic Model', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], supports_reasoning_summary_parameter: true, support_verbosity: true, service_tiers: [{ id: 'priority', name: 'Fast' }], input_modalities: ['text', 'image'], context_window: 128000, use_responses_lite: false, ...extra });
const session = (account = 'synthetic-account') => ({ accessToken: 'SYNTHETIC_ACCESS_TOKEN_NOT_VALID', accountId: account, generation: 1, affinity: `synthetic-${account}` });
const identity = (account = 'synthetic-account') => ({ issuer: ISSUER, subject: `subject-${account}`, accountId: account, clientId: CODEX_CLIENT_ID });
const tokens = (extra = {}) => ({ accessToken: 'SYNTHETIC_ACCESS_TOKEN_NOT_VALID', refreshToken: 'SYNTHETIC_REFRESH_TOKEN_NOT_VALID', expiresAt: Date.now() + 3600000, scopes: ['openid'], ...extra });
const profile = (binding, extra = {}) => ({ ...identity(), version: 1, provider: PROVIDER, id: binding.profileId, label: 'Synthetic test profile', bindingHash: createHash('sha256').update(binding.bindingSecret).digest('hex'), generation: 1, state: 'ready', tokens: tokens({ refreshToken: `SYNTHETIC_REFRESH_${binding.profileId}_NOT_VALID` }), verifiedAt: Date.now(), ...extra });
const output = (text = 'Hello', extra = {}) => ({ id: 'resp_synthetic', status: 'completed', output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, ...extra });
const textEvent = delta => ({ type: 'response.output_text.delta', delta });
const complete = response => ({ type: 'response.completed', response });
function sseResponse(events, { split = 0, newline = '\n', close = true, onCancel = () => {} } = {}) {
  const bytes = Buffer.from(events.map(e => `event: ${e.type}${newline}data: ${JSON.stringify(e)}${newline}${newline}`).join(''));
  let cursor = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) { if (close) controller.close(); return; }
      const end = split ? Math.min(cursor + split, bytes.length) : bytes.length;
      controller.enqueue(bytes.subarray(cursor, end)); cursor = end;
    }, cancel: onCancel,
  }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_synthetic' } });
}
function mockFetch(onRequest, model = rawModel()) {
  return async (url, init = {}) => {
    if (String(url).includes('/models?')) return Response.json({ models: [model] });
    if (String(url).endsWith('/responses')) return onRequest(JSON.parse(init.body), init);
    throw new Error('Unexpected synthetic endpoint');
  };
}
module.exports = { rawModel, session, identity, tokens, profile, output, textEvent, complete, sseResponse, mockFetch };
