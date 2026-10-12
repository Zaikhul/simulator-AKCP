export const STATUS = Object.freeze({
  SENSOR_NORMAL: 2,
  SWITCH_LOW_OUT: 8,
  SWITCH_HIGH_OUT: 9,
  NO_VOLT_PRESENT: 10,
  VOLT_PRESENT: 11,
});

export const SENSOR_TYPES = Object.freeze([
  'TEMPERATURE', 'TEMPERATURE_HUMIDITY', 'DOOR', 'MOTION', 'POWER', 'PANIC_BUTTON',
]);

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

export function normalizeMac(input) {
  if (typeof input !== 'string') throw new ValidationError('MAC must be a string');
  const value = input.trim();
  if (!/^(?:[0-9a-fA-F]{12}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}|[0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})$/.test(value)) {
    throw new ValidationError(`Invalid MAC address: ${value}`);
  }
  return value.replace(/[:-]/g, '').toUpperCase();
}

export function validateCompoundId(value) {
  if (typeof value !== 'string' || value.length > 160 || !/^\d+(?:\.\d+)+$/.test(value)) {
    throw new ValidationError('compoundId must be a dotted numeric identifier');
  }
  return value;
}

export function buildTopic(mac, event, compoundId) {
  if (!['status', 'status_change', 'value_change'].includes(event)) {
    throw new ValidationError(`Unsupported AKCP event: ${event}`);
  }
  return `spp/${normalizeMac(mac)}/sensor/${event}/${validateCompoundId(compoundId)}`;
}

export function parseTopic(topic) {
  if (typeof topic !== 'string') throw new ValidationError('Topic must be a string');
  const parts = topic.split('/');
  if (parts.length !== 5 || parts[0] !== 'spp' || parts[2] !== 'sensor') {
    throw new ValidationError('Expected spp/<mac>/sensor/<event>/<compound_id>');
  }
  const [, mac, , event, compoundId] = parts;
  buildTopic(mac, event, compoundId);
  return { mac: normalizeMac(mac), event, compoundId };
}

export function parsePayload(bytes) {
  if (Buffer.byteLength(bytes) > 65536) throw new ValidationError('Payload exceeds 64 KiB');
  let payload;
  try { payload = JSON.parse(bytes.toString()); }
  catch { throw new ValidationError('Invalid JSON payload'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Payload must be a JSON object');
  }
  if (!Number.isSafeInteger(payload.timestamp) || payload.timestamp <= 0 || payload.timestamp > 253402300799) {
    throw new ValidationError('timestamp must be Unix seconds, a positive integer');
  }
  if (payload.value !== undefined && payload.value !== null) {
    if (typeof payload.value !== 'number' || !Number.isFinite(payload.value)) {
      throw new ValidationError('value must be a finite JSON number');
    }
  }
  if (payload.status !== undefined && payload.status !== null) {
    if (!Number.isInteger(payload.status)) throw new ValidationError('status must be an integer');
  }
  if ((payload.value === undefined || payload.value === null) && (payload.status === undefined || payload.status === null)) {
    throw new ValidationError('payload must contain value or status');
  }
  // Keep the wire contract minimal; unknown optional fields do not affect parsing.
  return { timestamp: payload.timestamp, value: payload.value ?? null, status: payload.status ?? null };
}

export function switchStatus(type, active) {
  if (type === 'POWER') return active ? STATUS.NO_VOLT_PRESENT : STATUS.VOLT_PRESENT;
  if (['DOOR', 'MOTION', 'PANIC_BUTTON'].includes(type)) {
    return active ? STATUS.SWITCH_LOW_OUT : STATUS.SWITCH_HIGH_OUT;
  }
  throw new ValidationError(`${type} is not a discrete sensor`);
}

export function interpretStatus(type, status) {
  if (status === undefined || status === null) {
    return { active: false, state: 'NORMAL' };
  }
  if (['TEMPERATURE', 'TEMPERATURE_HUMIDITY'].includes(type)) {
    if (![1, 2, 3, 4, 5, 6, 7, 13, 14, 15].includes(status)) {
      throw new ValidationError(`Invalid analog status: ${status}`);
    }
    return { active: status !== STATUS.SENSOR_NORMAL, state: status === 2 ? 'NORMAL' : 'ALARM' };
  }
  if (status !== switchStatus(type, true) && status !== switchStatus(type, false)) {
    throw new ValidationError(`Invalid ${type} status: ${status}`);
  }
  const active = status === switchStatus(type, true);
  const names = {
    DOOR: ['CLOSED', 'OPEN'], MOTION: ['CLEAR', 'DETECTED'],
    POWER: ['ON', 'OFF'], PANIC_BUTTON: ['RELEASED', 'PRESSED'],
  };
  return { active, state: names[type][Number(active)] };
}

export function metricKey(mac, compoundId) { return `${normalizeMac(mac)}/${compoundId}`; }

export function encodeValue(value, metric, format = 'engineering') {
  return format === 'raw' ? Math.round(value * metric.scale) : Number(value.toFixed(metric.precision));
}

export function decodeValue(value, metric, format = 'engineering') {
  return Number((format === 'raw' ? value / metric.scale : value).toFixed(metric.precision));
}
