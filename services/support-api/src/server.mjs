import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 2048;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respond(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export function supportServer(recognize, { timeoutMs = 5500, supportContact = '' } = {}) {
  const sessions = new Map();
  let inFlight = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/v1/health/ready') {
      respond(response, 200, { status: 'ready' });
      return;
    }
    if (request.url !== '/api/v1/support/chat' || request.method !== 'POST') {
      respond(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      respond(response, 415, { code: 'JSON_REQUIRED' });
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          respond(response, 413, { code: 'MESSAGE_TOO_LARGE' });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        respond(response, 400, { code: 'INVALID_JSON' });
        return;
      }
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      const sessionId = body?.sessionId ?? randomUUID();
      if (!text || text.length > 500 || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
        respond(response, 400, { code: 'INVALID_SUPPORT_MESSAGE' });
        return;
      }
      const now = Date.now();
      for (const [id, value] of sessions) if (value.until <= now) sessions.delete(id);
      const budget = sessions.get(sessionId) ?? { until: now + 300_000, count: 0 };
      if (budget.count >= 10 || inFlight >= 5 || (!sessions.has(sessionId) && sessions.size >= 1000)) {
        respond(response, 429, { code: 'SUPPORT_RATE_LIMITED' }); return;
      }
      budget.count += 1; sessions.set(sessionId, budget); inFlight += 1;
      let timer;
      let messages;
      try {
        messages = await Promise.race([recognize(text, sessionId), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Support provider timeout')), timeoutMs);
        })]);
      } finally { clearTimeout(timer); inFlight -= 1; }
      if (!Array.isArray(messages) || messages.length > 4 || messages.some(
          message => typeof message !== 'string' || message.length > 1000)) {
        throw new Error('Invalid support provider response');
      }
      respond(response, 200, {
        sessionId,
        messages: messages.length ? messages : [`I could not answer that. Contact Health ID support${supportContact ? ': ' + supportContact : '.'}`],
      });
    } catch {
      respond(response, 503, { code: 'SUPPORT_BOT_UNAVAILABLE' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
