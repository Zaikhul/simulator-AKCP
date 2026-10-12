import { readFileSync } from 'node:fs';
import { normalizeMac, validateCompoundId, metricKey, SENSOR_TYPES, ValidationError } from './protocol.js';

const analog = type => ['TEMPERATURE', 'TEMPERATURE_HUMIDITY'].includes(type);
const timings = {
  DOOR: { idleSeconds: [20, 90], activeSeconds: [3, 12] },
  MOTION: { idleSeconds: [10, 60], activeSeconds: [1, 6] },
  POWER: { idleSeconds: [180, 600], activeSeconds: [8, 30] },
  PANIC_BUTTON: { idleSeconds: [300, 900], activeSeconds: [2, 5] },
};

function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be a finite number in [${min}, ${max}]`);
  }
  return value;
}

function range(value, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new ValidationError(`${label} must be [minimum, maximum]`);
  const min = number(value[0], label, 0.1, 86400);
  const max = number(value[1], label, min, 86400);
  return [min, max];
}

export function createRegistry(config, { mac } = {}) {
  if (!config || !Array.isArray(config.devices) || config.devices.length < 1 || config.devices.length > 100) {
    throw new ValidationError('config.devices must contain 1..100 devices');
  }
  let configDevices = config.devices;
  if (mac) {
    const targetMac = normalizeMac(mac);
    const found = configDevices.find(d => normalizeMac(d.mac) === targetMac);
    if (found) {
      configDevices = [found];
    } else {
      configDevices = [{ ...configDevices[0], mac: targetMac }];
    }
  }
  const byKey = new Map();
  const macs = new Set();
  const devices = configDevices.map(input => {
    const deviceMac = normalizeMac(input.mac);
    if (macs.has(deviceMac)) throw new ValidationError(`Duplicate device MAC: ${deviceMac}`);
    macs.add(deviceMac);
    if (!Array.isArray(input.sensors) || input.sensors.length < 1 || input.sensors.length > 1000) {
      throw new ValidationError('Each device requires 1..1000 sensors');
    }
    const sensorIds = new Set();
    const device = { mac: deviceMac, name: input.name ?? deviceMac, sensors: [] };
    if (typeof device.name !== 'string' || device.name.length > 200) throw new ValidationError('Invalid device name');
    device.sensors = input.sensors.map(raw => {
      if (typeof raw.id !== 'string' || !/^[\w-]{1,80}$/.test(raw.id) || sensorIds.has(raw.id)) {
        throw new ValidationError('Sensor ids must be unique, 1..80 letters/digits/underscores/hyphens');
      }
      sensorIds.add(raw.id);
      if (!SENSOR_TYPES.includes(raw.type)) throw new ValidationError(`Unsupported sensor type: ${raw.type}`);
      const sensor = { id: raw.id, name: raw.name ?? raw.id, type: raw.type };
      if (typeof sensor.name !== 'string' || sensor.name.length > 200) throw new ValidationError('Invalid sensor name');
      if (analog(raw.type)) {
        const expected = raw.type === 'TEMPERATURE' ? ['temperature'] : ['temperature', 'humidity'];
        if (!Array.isArray(raw.metrics) || raw.metrics.length !== expected.length ||
            expected.some(kind => raw.metrics.filter(m => m.kind === kind).length !== 1)) {
          throw new ValidationError(`${raw.type} requires metrics: ${expected.join(', ')}`);
        }
        sensor.metrics = raw.metrics.map(metric => {
          const temp = metric.kind === 'temperature';
          const limits = temp ? [-55, 75] : [0, 100];
          const min = number(metric.min ?? (temp ? 22 : 35), 'metric.min', ...limits);
          const max = number(metric.max ?? (temp ? 30 : 75), 'metric.max', min, limits[1]);
          const result = {
            kind: metric.kind, compoundId: validateCompoundId(metric.compoundId), unit: temp ? '°C' : '%RH',
            min, max, baseline: number(metric.baseline ?? (min + max) / 2, 'baseline', min, max),
            amplitude: number(metric.amplitude ?? (temp ? 1.5 : 6), 'amplitude', 0, (max - min) / 2),
            maxStep: number(metric.maxStep ?? (temp ? 0.25 : 1), 'maxStep', 0.001, 50),
            noise: number(metric.noise ?? (temp ? 0.08 : 0.3), 'noise', 0, 50),
            periodSeconds: number(metric.periodSeconds ?? 1800, 'periodSeconds', 1, 86400),
            scale: number(metric.scale ?? (temp ? 10 : 100), 'scale', 1, 100000),
            precision: number(metric.precision ?? (temp ? 1 : 2), 'precision', 0, 6),
          };
          if (!Number.isInteger(result.precision)) throw new ValidationError('precision must be an integer');
          return result;
        });
      } else {
        sensor.metrics = [{ kind: 'switch', unit: null, compoundId: validateCompoundId(raw.compoundId), scale: 1, precision: 0 }];
        sensor.timing = {
          idleSeconds: range(raw.timing?.idleSeconds ?? timings[raw.type].idleSeconds, 'idleSeconds'),
          activeSeconds: range(raw.timing?.activeSeconds ?? timings[raw.type].activeSeconds, 'activeSeconds'),
        };
      }
      for (const metric of sensor.metrics) {
        const key = metricKey(deviceMac, metric.compoundId);
        if (byKey.has(key)) throw new ValidationError(`Duplicate compound ID on device: ${key}`);
        byKey.set(key, { ...metric, mac: deviceMac, deviceName: device.name, sensorId: sensor.id, sensorName: sensor.name, type: sensor.type });
      }
      return sensor;
    });
    return device;
  });
  return { devices, byKey };
}

export function loadRegistry(file, options) {
  return createRegistry(JSON.parse(readFileSync(file, 'utf8')), options);
}

export function loadScenario(file, registry) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.events) || config.events.length > 10000) throw new ValidationError('scenario.events must be an array (maximum 10000)');
  const events = [];
  for (const event of config.events) {
    if (event.mac) {
      const mac = normalizeMac(event.mac);
      const device = registry.devices.find(d => d.mac === mac);
      const sensor = device?.sensors.find(s => s.id === event.sensorId);
      if (!sensor || analog(sensor.type)) throw new ValidationError(`Scenario sensor must be a known discrete sensor: ${event.sensorId}`);
      if (!['active', 'normal'].includes(event.state)) throw new ValidationError('Scenario state must be active or normal');
      events.push({ mac, sensorId: sensor.id, atSeconds: number(event.atSeconds, 'atSeconds', 0, 86400 * 30), active: event.state === 'active' });
    } else {
      const targetDevices = registry.devices.filter(d => d.sensors.some(s => s.id === event.sensorId && !analog(s.type)));
      if (targetDevices.length === 0) throw new ValidationError(`Scenario sensor must be a known discrete sensor: ${event.sensorId}`);
      if (!['active', 'normal'].includes(event.state)) throw new ValidationError('Scenario state must be active or normal');
      for (const device of targetDevices) {
        events.push({ mac: device.mac, sensorId: event.sensorId, atSeconds: number(event.atSeconds, 'atSeconds', 0, 86400 * 30), active: event.state === 'active' });
      }
    }
  }
  return events.sort((a, b) => a.atSeconds - b.atSeconds);
}
