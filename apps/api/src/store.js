import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeValue, interpretStatus, metricKey, normalizeMac, parseTopic, parsePayload, ValidationError } from '@outlet/akcp/protocol';

const columns = `mac TEXT NOT NULL, compound_id TEXT NOT NULL, sensor_id TEXT NOT NULL,
  sensor_name TEXT NOT NULL, type TEXT NOT NULL, metric TEXT NOT NULL, unit TEXT,
  value REAL NOT NULL, raw_value REAL NOT NULL, status INTEGER NOT NULL,
  state TEXT NOT NULL, active INTEGER NOT NULL, timestamp INTEGER NOT NULL,
  received_at TEXT NOT NULL, topic TEXT NOT NULL, event TEXT NOT NULL, retained INTEGER NOT NULL`;
const columnNames = ['mac', 'compound_id', 'sensor_id', 'sensor_name', 'type', 'metric', 'unit',
  'value', 'raw_value', 'status', 'state', 'active', 'timestamp', 'received_at', 'topic', 'event', 'retained'];
const placeholders = columnNames.map(() => '?').join(',');

function publicRow(row) {
  if (!row) return null;
  const result = {
    id: row.id, mac: row.mac, compoundId: row.compound_id, sensorId: row.sensor_id,
    sensorName: row.sensor_name, type: row.type, metric: row.metric, unit: row.unit,
    value: row.value, rawValue: row.raw_value, status: row.status, state: row.state,
    active: Boolean(row.active), timestamp: row.timestamp,
    time: new Date(row.timestamp * 1000).toISOString(), receivedAt: row.received_at,
    topic: row.topic, event: row.event, retained: Boolean(row.retained),
  };
  if ('event_kind' in row) {
    result.eventKind = row.event_kind;
    result.previousStatus = row.previous_status;
  }
  return result;
}

export class MonitoringStore {
  constructor(file, registry, { valueFormat = 'engineering', maxRows = 100000 } = {}) {
    this.registry = registry;
    this.valueFormat = valueFormat;
    this.maxRows = maxRows;
    this.counters = { accepted: 0, duplicate: 0, stale: 0, rejected: 0 };
    if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT UNIQUE NOT NULL, ${columns});
      CREATE INDEX IF NOT EXISTS telemetry_sensor ON telemetry(mac, sensor_id, id DESC);
      CREATE TABLE IF NOT EXISTS latest (id INTEGER NOT NULL, ${columns}, PRIMARY KEY(mac, compound_id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ${columns}, event_kind TEXT NOT NULL, previous_status INTEGER);
      CREATE INDEX IF NOT EXISTS events_sensor ON events(mac, sensor_id, id DESC);`);
    const existing = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('value_format');
    if (existing && existing.value !== valueFormat) {
      this.db.close();
      throw new Error('Database value format differs from AKCP_VALUE_FORMAT; use a separate DB or the original format');
    }
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('value_format', valueFormat);
    this.insert = this.db.prepare(`INSERT OR IGNORE INTO telemetry(fingerprint,${columnNames.join(',')}) VALUES (?,${placeholders})`);
    this.upsert = this.db.prepare(`INSERT INTO latest(id,${columnNames.join(',')}) VALUES (?,${placeholders})
      ON CONFLICT(mac,compound_id) DO UPDATE SET id=excluded.id,${columnNames.map(name => `${name}=excluded.${name}`).join(',')}`);
    this.getLatest = this.db.prepare('SELECT * FROM latest WHERE mac=? AND compound_id=?');
    this.insertEvent = this.db.prepare(`INSERT INTO events(${columnNames.join(',')},event_kind,previous_status) VALUES (${placeholders},?,?)`);
    this.rowCounts = {
      telemetry: this.db.prepare('SELECT COUNT(*) AS count FROM telemetry').get().count,
      events: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
    };
    this.prune('telemetry'); this.prune('events');
    // Do not expose abandoned mappings as currently active alarms after reconfiguration.
    for (const row of this.db.prepare('SELECT mac,compound_id FROM latest').all()) {
      if (!registry.byKey.has(metricKey(row.mac, row.compound_id))) {
        this.db.prepare('DELETE FROM latest WHERE mac=? AND compound_id=?').run(row.mac, row.compound_id);
      }
    }
  }

  prune(table) {
    const excess = this.rowCounts[table] - this.maxRows;
    if (excess > 0) {
      this.db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY id LIMIT ?)`).run(excess);
      this.rowCounts[table] -= excess;
    }
  }

  ingest(topic, bytes, { retain = false, receivedAt = new Date().toISOString() } = {}) {
    try {
      const parsed = parseTopic(topic);
      const payload = parsePayload(bytes);
      const metric = this.registry.byKey.get(metricKey(parsed.mac, parsed.compoundId));
      if (!metric) throw new ValidationError('Unknown MAC or compound ID; update config/devices.json');
      const status = payload.status ?? (metric.kind === 'switch' ? switchStatus(metric.type, false) : 2);
      const { active, state } = interpretStatus(metric.type, status);
      const rawValue = payload.value ?? (metric.kind === 'switch' ? (active ? 0 : 1) : metric.baseline);
      const value = decodeValue(rawValue, metric, this.valueFormat);
      if (metric.kind !== 'switch' && (value < (metric.kind === 'temperature' ? -55 : 0) || value > (metric.kind === 'temperature' ? 75 : 100))) {
        throw new ValidationError('Analog reading is outside the physical sensor range');
      }
      if (metric.kind === 'switch' && ![0, 1].includes(rawValue)) {
        throw new ValidationError('Switch value must be 0 or 1');
      }
      const fingerprint = createHash('sha256').update(JSON.stringify([parsed.mac, parsed.event, parsed.compoundId, payload.timestamp, rawValue, status])).digest('hex');
      const fields = [parsed.mac, parsed.compoundId, metric.sensorId, metric.sensorName, metric.type, metric.kind, metric.unit,
        value, rawValue, status, state, Number(active), payload.timestamp, receivedAt, topic, parsed.event, Number(retain)];
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const inserted = this.insert.run(fingerprint, ...fields);
        if (!inserted.changes) {
          this.db.exec('COMMIT');
          this.counters.duplicate++;
          return { duplicate: true };
        }
        const id = Number(inserted.lastInsertRowid);
        const previous = this.getLatest.get(parsed.mac, parsed.compoundId);
        const stale = Boolean(previous && payload.timestamp < previous.timestamp);
        let eventKind = null;
        if (!stale) {
          this.upsert.run(id, ...fields);
          if (!previous && active) eventKind = 'INITIAL_ALARM';
          else if (previous && previous.status !== payload.status) {
            eventKind = active && !previous.active ? 'ALARM' : (!active && previous.active ? 'RECOVERY' : 'STATUS_CHANGE');
          }
          if (eventKind) this.insertEvent.run(...fields, eventKind, previous?.status ?? null);
        }
        this.db.exec('COMMIT');
        this.rowCounts.telemetry++;
        if (eventKind) this.rowCounts.events++;
        this.prune('telemetry'); this.prune('events');
        this.counters.accepted++;
        if (stale) this.counters.stale++;
        return { id, stale, eventKind, mac: parsed.mac, sensorId: metric.sensorId, status: payload.status, state };
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.counters.rejected++;
      throw error;
    }
  }

  devices() {
    return this.registry.devices.map(device => ({ mac: device.mac, name: device.name, sensors: device.sensors.length, metrics: device.sensors.reduce((count, sensor) => count + sensor.metrics.length, 0) }));
  }

  sensors({ mac } = {}) {
    const normalized = mac ? normalizeMac(mac) : null;
    const rows = this.db.prepare('SELECT * FROM latest').all();
    const latest = new Map(rows.map(row => [metricKey(row.mac, row.compound_id), row]));
    return [...this.registry.byKey.values()].filter(metric => !normalized || metric.mac === normalized).map(metric => ({
      mac: metric.mac, deviceName: metric.deviceName, sensorId: metric.sensorId,
      sensorName: metric.sensorName, type: metric.type, metric: metric.kind,
      compoundId: metric.compoundId, unit: metric.unit,
      reading: publicRow(latest.get(metricKey(metric.mac, metric.compoundId))),
    }));
  }

  alarms({ mac } = {}) { return this.sensors({ mac }).filter(sensor => sensor.reading?.active); }

  history(table, { mac, sensorId, limit = 100, before } = {}) {
    if (!['telemetry', 'events'].includes(table)) throw new Error('Invalid history table');
    const where = []; const parameters = [];
    if (mac) { where.push('mac=?'); parameters.push(normalizeMac(mac)); }
    if (sensorId) { where.push('sensor_id=?'); parameters.push(sensorId); }
    if (before !== undefined) { where.push('id<?'); parameters.push(before); }
    parameters.push(limit);
    const rows = this.db.prepare(`SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...parameters);
    return { items: rows.map(publicRow), nextBefore: rows.length === limit ? rows.at(-1).id : null };
  }

  close() { this.db.close(); }
}
