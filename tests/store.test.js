import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitoringStore } from '../apps/api/src/store.js';
import { buildTopic } from '@outlet/akcp/protocol';
import { registry, mac, epoch } from './helpers.js';

const topic = (event = 'status_change', id = '0.1.0.1.0') => buildTopic(mac, event, id);
const payload = (status, timestamp = epoch, value = status === 8 || status === 10 ? 0 : 1) => Buffer.from(JSON.stringify({ timestamp, value, status }));

test('ingest deduplicates QoS 1 and creates one alarm and one recovery', t => {
  const store = new MonitoringStore(':memory:', registry());
  t.after(() => store.close());
  store.ingest(topic('status'), payload(9));
  store.ingest(topic(), payload(8, epoch + 1));
  const duplicate = store.ingest(topic(), Buffer.from(JSON.stringify({ status: 8, value: 0, timestamp: epoch + 1 })));
  assert.equal(duplicate.duplicate, true);
  store.ingest(topic('status'), payload(8, epoch + 2));
  assert.equal(store.alarms().length, 1);
  assert.equal(store.history('events').items.length, 1);
  store.ingest(topic(), payload(9, epoch + 3));
  assert.equal(store.alarms().length, 0);
  assert.deepEqual(store.history('events').items.map(e => e.eventKind), ['RECOVERY', 'ALARM']);
  assert.equal(store.counters.duplicate, 1);
});

test('old recovery is archived without overwriting the current alarm', t => {
  const store = new MonitoringStore(':memory:', registry());
  t.after(() => store.close());
  store.ingest(topic('status'), payload(9, epoch));
  store.ingest(topic(), payload(8, epoch + 10));
  assert.equal(store.ingest(topic(), payload(9, epoch + 5)).stale, true);
  assert.equal(store.alarms().length, 1);
  assert.equal(store.history('events').items.length, 1);
  assert.equal(store.history('telemetry').items.length, 3);
});

test('unknown sensors and wrong sensor-family status codes are rejected atomically', t => {
  const store = new MonitoringStore(':memory:', registry());
  t.after(() => store.close());
  assert.throws(() => store.ingest(topic('status', '9.9.9.9.9'), payload(9)), /Unknown/);
  assert.throws(() => store.ingest(topic('status', '0.1.0.1.2'), payload(9)), /POWER/);
  assert.throws(() => store.ingest(topic('status', '0.1.0.5.0'), payload(8)), /analog/);
  assert.equal(store.history('telemetry').items.length, 0);
  assert.equal(store.counters.rejected, 3);
});

test('raw analog readings are decoded into engineering units', t => {
  const store = new MonitoringStore(':memory:', registry(), { valueFormat: 'raw' });
  t.after(() => store.close());
  store.ingest(topic('status', '0.1.0.5.0'), payload(2, epoch, 253));
  store.ingest(topic('status', '0.1.0.5.1'), payload(2, epoch, 5540));
  const samples = store.history('telemetry').items;
  assert.equal(samples.find(s => s.metric === 'temperature').value, 25.3);
  assert.equal(samples.find(s => s.metric === 'humidity').value, 55.4);
  assert(samples.every(s => s.active === false));
});

test('retained active snapshot is labeled INITIAL_ALARM and does not duplicate events', t => {
  const store = new MonitoringStore(':memory:', registry());
  t.after(() => store.close());
  store.ingest(topic('status'), payload(8), { retain: true });
  store.ingest(topic('status'), payload(8), { retain: true });
  const events = store.history('events').items;
  assert.equal(events.length, 1);
  assert.equal(events[0].eventKind, 'INITIAL_ALARM');
  assert.equal(events[0].retained, true);
  assert.equal(events[0].previousStatus, null);
});

test('telemetry, alarm state, and duplicate detection survive API restart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'akcp-store-'));
  const file = join(folder, 'monitoring.db');
  let store;
  try {
    store = new MonitoringStore(file, registry());
    store.ingest(topic(), payload(8));
    store.close();
    store = new MonitoringStore(file, registry());
    assert.equal(store.alarms().length, 1);
    assert.equal(store.history('events').items.length, 1);
    assert.equal(store.ingest(topic(), payload(8)).duplicate, true);
    store.close(); store = null;
    assert.throws(() => new MonitoringStore(file, registry(), { valueFormat: 'raw' }), /value format differs/);
  } finally { store?.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('bounded history and id cursor pagination do not repeat rows', t => {
  const store = new MonitoringStore(':memory:', registry(), { maxRows: 100 });
  t.after(() => store.close());
  for (let i = 0; i < 150; i++) store.ingest(topic('status'), payload(9, epoch + i));
  assert.equal(store.history('telemetry', { limit: 500 }).items.length, 100);
  const first = store.history('telemetry', { limit: 20 });
  const second = store.history('telemetry', { limit: 20, before: first.nextBefore });
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 40);
  assert.equal(first.items[0].id, 150);
  assert.equal(store.sensors().find(s => s.sensorId === 'door').reading.status, 9);
});
