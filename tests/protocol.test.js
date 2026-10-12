import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopic, parseTopic, normalizeMac, parsePayload, switchStatus, interpretStatus } from '@outlet/akcp/protocol';
import { createRegistry } from '@outlet/akcp/devices';
import { readOptions } from '@outlet/akcp/config';
import { makeClientId } from '@outlet/akcp/mqtt';
import { fixture, mac, epoch } from './helpers.js';

test('MAC and AKCP topics normalize consistently', () => {
  assert.equal(normalizeMac('00:0b:dc:01:ad:ab'), mac);
  assert.equal(normalizeMac('00-0B-DC-01-AD-AB'), mac);
  const topic = buildTopic('00:0b:dc:01:ad:ab', 'status_change', '0.1.0.1.0');
  assert.equal(topic, `spp/${mac}/sensor/status_change/0.1.0.1.0`);
  assert.deepEqual(parseTopic(topic), { mac, event: 'status_change', compoundId: '0.1.0.1.0' });
  assert.throws(() => parseTopic(`spp/${mac}/sensor/status_change/0.1.0.1.0/extra`));
  assert.throws(() => normalizeMac('000BDCDE400Z'));
  assert.throws(() => buildTopic(mac, 'status', '0/1/#'));
});

test('switch and power statuses preserve alarm and recovery semantics', () => {
  for (const type of ['DOOR', 'MOTION', 'PANIC_BUTTON']) {
    assert.equal(switchStatus(type, true), 8);
    assert.equal(switchStatus(type, false), 9);
    assert.equal(interpretStatus(type, 8).active, true);
    assert.equal(interpretStatus(type, 9).active, false);
    assert.throws(() => interpretStatus(type, 10));
  }
  assert.equal(switchStatus('POWER', true), 10);
  assert.equal(switchStatus('POWER', false), 11);
  assert.equal(interpretStatus('POWER', 10).state, 'OFF');
  assert.equal(interpretStatus('POWER', 11).state, 'ON');
  assert.throws(() => interpretStatus('POWER', 9));
});

test('payload validation rejects malformed, oversized, and ambiguous readings', () => {
  assert.deepEqual(parsePayload(Buffer.from(JSON.stringify({ timestamp: epoch, value: 25.5, status: 2 }))), { timestamp: epoch, value: 25.5, status: 2 });
  for (const payload of [null, [], {}, { timestamp: epoch * 1000, value: 25, status: 2 },
    { timestamp: epoch, value: '25', status: 2 }, { timestamp: epoch, value: 25, status: '2' },
    { timestamp: -1, value: 25, status: 2 }]) {
    assert.throws(() => parsePayload(Buffer.from(JSON.stringify(payload))));
  }
  assert.throws(() => parsePayload(Buffer.from('{invalid')));
  assert.throws(() => parsePayload(Buffer.alloc(65537)));
});

test('MQTT client IDs are MAC-based and do not collide in one process', () => {
  const ids = new Set(Array.from({ length: 20 }, () => makeClientId('akcp-sim', mac)));
  assert.equal(ids.size, 20);
  assert([...ids].every(id => id.startsWith(`akcp-sim-${mac}-`)));
});

test('CLI flags override environment and broker configuration is validated', () => {
  const options = readOptions('sim', ['--host', 'broker.local', '--port', '1884', '--interval', '2'], { MQTT_URL: 'mqtt://old.local:1883', SIM_INTERVAL_SECONDS: '10' });
  assert.equal(options.brokerUrl, 'mqtt://broker.local:1884');
  assert.equal(options.intervalSeconds, 2);
  assert.throws(() => readOptions('sim', ['--port', '0'], {}));
  assert.throws(() => readOptions('sim', ['--broker-url', 'https://broker'], {}));
  assert.throws(() => readOptions('sim', ['--interval', '0'], {}));
  assert.throws(() => readOptions('sim', ['--profile', 'unknown'], {}));
  assert.throws(() => readOptions('sim', ['--seed', 'NaN'], {}));
  assert.throws(() => readOptions('sim', [], { MQTT_PASSWORD: 'secret' }));
  assert.throws(() => readOptions('sim', ['--broker-url', 'mqtt://x', '--host', 'y'], {}));
});

test('registry rejects compound collisions and incomplete combined sensors', () => {
  const duplicate = fixture();
  duplicate.devices[0].sensors[3].compoundId = duplicate.devices[0].sensors[2].compoundId;
  assert.throws(() => createRegistry(duplicate), /Duplicate compound/);
  const incomplete = fixture();
  incomplete.devices[0].sensors[0].metrics.pop();
  assert.throws(() => createRegistry(incomplete), /requires metrics/);
  const impossible = fixture();
  impossible.devices[0].sensors[0].metrics[0].baseline = 120;
  assert.throws(() => createRegistry(impossible), /baseline/);
  assert.equal(createRegistry(fixture(), { mac: 'AABBCCDDEEFF' }).devices[0].mac, 'AABBCCDDEEFF');
});
