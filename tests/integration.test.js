import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi } from '../apps/api/src/service.js';
import { connectClient, publishQos1, closeClient, makeClientId } from '@outlet/akcp/mqtt';
import { buildTopic } from '@outlet/akcp/protocol';
import { scenarioCheck, waitUntil } from '../scripts/qa-utils.js';
import { startBroker, brokerOptions, logger, mac, epoch } from './helpers.js';

test('real TCP MQTT QoS 1 carries all seven metrics and eight transitions into HTTP API', { timeout: 12000 }, async () => {
  const broker = await startBroker();
  const published = [];
  broker.broker.on('publish', (packet, client) => { if (client && packet.topic.startsWith('spp/')) published.push(packet); });
  try {
    const result = await scenarioCheck(broker.url);
    assert.equal(result.ready.ready, true);
    assert.equal(result.sensors.length, 23);
    assert.equal(result.events.length, 8);
    assert.equal(result.alarms.length, 0);
    assert(published.length >= 15);
    assert(published.every(packet => packet.qos === 1 && packet.retain === false));
    for (const [type, codes] of [['DOOR', [8, 9]], ['MOTION', [8, 9]], ['POWER', [10, 11]], ['PANIC_BUTTON', [8, 9]]]) {
      assert.deepEqual(result.events.filter(e => e.type === type).reverse().map(e => e.status), codes);
    }
    assert(result.telemetry.filter(e => e.metric !== 'switch').every(e => e.status === 2));
  } finally { await broker.close(); }
});

test('HTTP token, validation, broker reconnect, and resubscription preserve ingest', { timeout: 10000 }, async () => {
  const broker = await startBroker();
  let api; let publisher;
  try {
    api = await startApi({ ...brokerOptions('api', broker.url), apiPort: 0, dbFile: ':memory:', token: 'test-token' });
    const base = `http://127.0.0.1:${api.port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/v1/sensors`)).status, 401);
    const headers = { Authorization: 'Bearer test-token' };
    assert.equal((await fetch(`${base}/api/v1/sensors?limit=NaN`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/v1/sensors?mac=invalid`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/v1/sensors`, { method: 'POST', headers })).status, 405);
    api.client.stream.destroy();
    await waitUntil(() => !api.status.connected);
    assert.equal((await fetch(`${base}/ready`)).status, 503);
    await waitUntil(() => api.status.connected && api.status.subscribed);
    publisher = await connectClient({ ...brokerOptions('sim', broker.url), clientId: makeClientId('test', mac) }, logger);
    const topic = buildTopic(mac, 'status_change', '0.1.0.1.0');
    await publishQos1(publisher, topic, { timestamp: epoch, value: 0, status: 8 }, 2000);
    await waitUntil(() => api.store.alarms().length === 1);
    await publishQos1(publisher, topic, { timestamp: epoch, value: 0, status: 8 }, 2000);
    await waitUntil(() => api.store.counters.duplicate === 1);
    await publishQos1(publisher, topic, { timestamp: epoch + 1, value: 1, status: 9 }, 2000);
    await waitUntil(() => api.store.alarms().length === 0);
    const events = await (await fetch(`${base}/api/v1/events`, { headers })).json();
    assert.equal(events.items.length, 2);
    assert.equal((await fetch(`${base}/ready`)).status, 200);
  } finally { await closeClient(publisher); await api?.close(); await broker.close(); }
});

test('initial broker connection fails within its configured deadline', { timeout: 3000 }, async () => {
  const broker = await startBroker();
  const url = broker.url;
  await broker.close();
  const start = Date.now();
  await assert.rejects(connectClient({ ...brokerOptions('sim', url), clientId: 'unreachable-test', connectTimeoutMs: 250 }, logger), /timed out/);
  assert(Date.now() - start < 2000);
});
