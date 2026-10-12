import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { normalizeMac, ValidationError } from '@outlet/akcp/protocol';

function pagination(search) {
  const limitText = search.get('limit') ?? '100';
  if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 500) throw new ValidationError('limit must be an integer in [1, 500]');
  const result = { limit: Number(limitText) };
  if (search.has('mac')) result.mac = normalizeMac(search.get('mac'));
  if (search.has('sensorId')) {
    const id = search.get('sensorId');
    if (!/^[\w-]{1,80}$/.test(id)) throw new ValidationError('Invalid sensorId');
    result.sensorId = id;
  }
  if (search.has('before')) {
    const text = search.get('before');
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1) throw new ValidationError('before must be a positive integer cursor');
    result.before = number;
  }
  return result;
}

function authorized(header, token) {
  if (!token) return true;
  const received = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createHttpServer(store, status, { token, logger }) {
  const startedAt = Date.now();
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const send = (code, body, headers = {}) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method !== 'GET') return send(405, { error: 'Only GET is supported' }, { Allow: 'GET' });
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return send(200, {
        status: 'ok', mqttConnected: status.connected, mqttSubscribed: status.subscribed,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), counters: { ...store.counters },
      });
      if (url.pathname === '/ready') return send(status.connected && status.subscribed ? 200 : 503, {
        ready: Boolean(status.connected && status.subscribed), mqttConnected: status.connected, mqttSubscribed: status.subscribed,
      });
      if (!authorized(request.headers.authorization, token)) return send(401, { error: 'Bearer token required' }, { 'WWW-Authenticate': 'Bearer' });
      const filters = pagination(url.searchParams);
      switch (url.pathname) {
        case '/api/v1/devices': return send(200, { items: store.devices() });
        case '/api/v1/sensors': return send(200, { items: store.sensors(filters) });
        case '/api/v1/alarms': return send(200, { items: store.alarms(filters) });
        case '/api/v1/telemetry': return send(200, store.history('telemetry', filters));
        case '/api/v1/events': return send(200, store.history('events', filters));
        default: return send(404, { error: 'Endpoint not found' });
      }
    } catch (error) {
      if (error instanceof ValidationError || error instanceof URIError) send(400, { error: error.message });
      else { logger.error('HTTP request failed', { error: error.message }); send(500, { error: 'Internal server error' }); }
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 3000;
  return server;
}
