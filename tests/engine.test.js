import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario, createRegistry } from '@outlet/akcp/devices';
import { PROJECT_ROOT } from '@outlet/akcp/config';
import { SimulationEngine } from '../apps/akcpsim/src/engine.js';
import { registry, mac, epoch, fixture } from './helpers.js';

test('initial snapshot includes both TH metrics and all normal discrete states', () => {
  const engine = new SimulationEngine(registry());
  const samples = engine.step(0, epoch * 1000);
  assert.equal(samples.length, 6);
  assert.equal(samples.filter(s => s.sensorType === 'TEMPERATURE_HUMIDITY').length, 2);
  assert(samples.filter(s => s.sensorType.startsWith('TEMPERATURE')).every(s => s.payload.status === 2));
  assert.equal(samples.find(s => s.sensorId === 'power').payload.status, 11);
  assert(samples.filter(s => ['door', 'motion', 'panic'].includes(s.sensorId)).every(s => s.payload.status === 9));
  assert(samples.every(s => s.qos === 1 && s.retain === false));
  assert(samples.every(s => Object.keys(s.payload).sort().join(',') === 'status,timestamp,value'));
});

test('scenario produces eight ordered alarm/recovery transitions with correct status codes', () => {
  const mapping = registry();
  const scenario = loadScenario(`${PROJECT_ROOT}/config/scenario-demo.json`, mapping);
  const engine = new SimulationEngine(mapping, { scenario });
  const messages = [];
  for (let s = 0; s <= 20; s++) messages.push(...engine.step(s, (epoch + s) * 1000));
  const transitions = messages.filter(m => m.topic.includes('/status_change/'));
  assert.equal(transitions.length, 8);
  for (const [id, codes] of [['door', [8, 9]], ['motion', [8, 9]], ['power', [10, 11]], ['panic', [8, 9]]]) {
    assert.deepEqual(transitions.filter(m => m.sensorId === id).map(m => m.payload.status), codes);
  }
  const last = engine.step(25, (epoch + 25) * 1000);
  assert.equal(last.find(m => m.sensorId === 'power').payload.status, 11);
  assert.deepEqual(transitions.map(m => m.simulatedSeconds), [2, 3, 5, 6, 8, 13, 15, 17]);
});

test('scenario state repetitions do not create false status_change events', () => {
  const scenario = [1, 2, 3, 4].map((atSeconds, index) => ({ mac, sensorId: 'door', atSeconds, active: index < 2 }));
  const engine = new SimulationEngine(registry(), { scenario });
  const messages = [];
  for (let s = 0; s < 6; s++) messages.push(...engine.step(s, (epoch + s) * 1000));
  assert.equal(messages.filter(m => m.topic.includes('/status_change/')).length, 2);
});

test('analog drift stays bounded and gradual over a long simulation', () => {
  const mapping = registry();
  const engine = new SimulationEngine(mapping, { seed: 88 });
  const previous = new Map();
  for (let s = 0; s <= 3600; s += 5) {
    for (const sample of engine.step(s, (epoch + s) * 1000).filter(m => m.sensorType.startsWith('TEMPERATURE'))) {
      const metric = mapping.byKey.get(`${mac}/${sample.topic.split('/').at(-1)}`);
      const value = sample.payload.value;
      assert(value >= metric.min && value <= metric.max);
      if (previous.has(sample.topic)) assert(Math.abs(value - previous.get(sample.topic)) <= metric.maxStep + 2 * 10 ** -metric.precision);
      previous.set(sample.topic, value);
      assert.equal(sample.payload.status, 2);
    }
  }
});

test('seeded output is reproducible and demo switches repeatedly recover', () => {
  const a = new SimulationEngine(registry(), { seed: 9, profile: 'demo' });
  const b = new SimulationEngine(registry(), { seed: 9, profile: 'demo' });
  const events = [];
  for (let s = 0; s < 100; s++) {
    const messages = a.step(s, (epoch + s) * 1000);
    assert.deepEqual(messages, b.step(s, (epoch + s) * 1000));
    events.push(...messages.filter(m => m.topic.includes('/status_change/')));
  }
  for (const id of ['door', 'motion', 'power', 'panic']) {
    const codes = events.filter(m => m.sensorId === id).map(m => m.payload.status);
    assert(codes.length >= 4);
    for (let i = 1; i < codes.length; i++) assert.notEqual(codes[i], codes[i - 1]);
  }
  assert.throws(() => a.step(1, epoch * 1000), /monotonic/);
});

test('raw value profile scales analog metrics without changing switch codes', () => {
  const samples = new SimulationEngine(registry(), { valueFormat: 'raw' }).step(0, epoch * 1000);
  assert.equal(samples.find(s => s.topic.endsWith('0.1.0.5.0')).payload.value, 250);
  assert.equal(samples.find(s => s.topic.endsWith('0.1.0.5.1')).payload.value, 5500);
  assert.equal(samples.find(s => s.sensorId === 'power').payload.value, 1);
  assert.equal(samples.find(s => s.sensorId === 'power').payload.status, 11);
});

test('multi-device simulation produces samples across all 4 outlet devices', () => {
  const multiRegistry = createRegistry(fixture());
  assert.equal(multiRegistry.devices.length, 4);
  const engine = new SimulationEngine(multiRegistry);
  const samples = engine.step(0, epoch * 1000);
  assert.equal(samples.length, 23);
  const macs = new Set(samples.map(s => s.topic.split('/')[1]));
  assert.deepEqual([...macs].sort(), ['000BDC01ADAA', '000BDC01ADAB', '000BDC01ADAC', '000BDC01ADAD']);
});
