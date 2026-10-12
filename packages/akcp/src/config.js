import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function loadDotEnv(cwd = process.cwd()) {
  const file = resolve(cwd, '.env');
  if (existsSync(file)) loadEnvFile(file);
}

const str = { type: 'string' };
const commonOptions = {
  help: { type: 'boolean', short: 'h' }, host: str, port: str, 'broker-url': str,
  username: str, password: str, 'client-id': str, config: str, 'value-format': str,
  'log-level': str, 'connect-timeout-ms': str, 'ack-timeout-ms': str,
};
const simOptions = {
  mac: str, interval: str, duration: str, profile: str, speed: str, seed: str,
  scenario: str, 'dry-run': { type: 'boolean' },
};
const apiOptions = { 'api-host': str, 'api-port': str, db: str, token: str, 'max-rows': str };

function numeric(input, name, min, max, integer = false) {
  if (String(input).trim() === '') throw new Error(`${name} cannot be empty`);
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

export function readOptions(role, args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args, options: { ...commonOptions, ...(role === 'sim' ? simOptions : apiOptions) }, strict: true });
  if (values.help) return { help: true };
  const base = new URL(values['broker-url'] ?? env.MQTT_URL ?? 'mqtt://127.0.0.1:1883');
  if (!['mqtt:', 'mqtts:'].includes(base.protocol)) throw new Error('Use mqtt:// or mqtts:// broker URLs');
  if (!values['broker-url']) {
    // Explicit host/port flags override even MQTT_URL. Environment host/port
    // are used only if MQTT_URL is absent, keeping precedence predictable.
    const host = values.host ?? (!env.MQTT_URL ? env.MQTT_HOST : undefined);
    const port = values.port ?? (!env.MQTT_URL ? env.MQTT_PORT : undefined);
    if (host) base.hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    if (port !== undefined) base.port = String(numeric(port, 'MQTT port', 1, 65535, true));
  }
  if (values['broker-url'] && (values.host || values.port)) throw new Error('Choose --broker-url OR --host/--port');
  const username = values.username ?? env.MQTT_USERNAME ?? decodeURIComponent(base.username);
  const password = values.password ?? env.MQTT_PASSWORD ?? decodeURIComponent(base.password);
  if (password && !username) throw new Error('MQTT_PASSWORD requires MQTT_USERNAME');
  base.username = ''; base.password = '';
  if (!base.hostname || (base.pathname && base.pathname !== '/') || base.search || base.hash) {
    throw new Error('MQTT URL must contain only a host and port');
  }
  const format = values['value-format'] ?? env.AKCP_VALUE_FORMAT ?? 'engineering';
  if (!['engineering', 'raw'].includes(format)) throw new Error('value-format must be engineering or raw');
  const result = {
    role, brokerUrl: base.toString(), username: username || undefined, password: password || undefined,
    clientId: values['client-id'] ?? (role === 'sim' ? env.AKCP_CLIENT_ID : env.API_MQTT_CLIENT_ID),
    devicesFile: resolve(values.config ?? env.AKCP_DEVICES_FILE ?? resolve(PROJECT_ROOT, 'config/devices.json')),
    valueFormat: format, logLevel: values['log-level'] ?? env.LOG_LEVEL ?? 'info',
    connectTimeoutMs: numeric(values['connect-timeout-ms'] ?? env.MQTT_CONNECT_TIMEOUT_MS ?? 10000, 'connect timeout', 100, 120000, true),
    ackTimeoutMs: numeric(values['ack-timeout-ms'] ?? env.MQTT_ACK_TIMEOUT_MS ?? 10000, 'ACK timeout', 100, 120000, true),
    reconnectMs: numeric(env.MQTT_RECONNECT_MS ?? 1000, 'reconnect interval', 100, 60000, true),
    keepalive: numeric(env.MQTT_KEEPALIVE ?? 30, 'keepalive', 1, 65535, true),
  };
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(result.logLevel)) throw new Error('Invalid LOG_LEVEL');
  if (result.clientId && (result.clientId.length > 200 || /[\u0000-\u001f]/.test(result.clientId))) {
    throw new Error('Invalid MQTT client ID');
  }
  result.tls = {};
  for (const [name, key] of [['MQTT_CA_FILE', 'ca'], ['MQTT_CERT_FILE', 'cert'], ['MQTT_KEY_FILE', 'key']]) {
    if (env[name]) {
      if (base.protocol !== 'mqtts:') throw new Error(`${name} requires mqtts://`);
      result.tls[key] = readFileSync(resolve(env[name]));
    }
  }
  if (Boolean(result.tls.cert) !== Boolean(result.tls.key)) throw new Error('TLS certificate and key must be supplied together');
  if (env.MQTT_SERVERNAME) result.tls.servername = env.MQTT_SERVERNAME;
  if (role === 'sim') {
    Object.assign(result, {
      mac: values.mac ?? env.AKCP_MAC,
      intervalSeconds: numeric(values.interval ?? env.SIM_INTERVAL_SECONDS ?? 5, 'interval', 0.1, 3600),
      durationSeconds: numeric(values.duration ?? env.SIM_DURATION_SECONDS ?? 0, 'duration', 0, 86400 * 30),
      speed: numeric(values.speed ?? env.SIM_SPEED ?? 1, 'speed', 0.1, 100),
      seed: numeric(values.seed ?? env.SIM_SEED ?? 42, 'seed', 0, 0xffffffff, true),
      profile: values.profile ?? env.SIM_PROFILE ?? 'realistic',
      scenarioFile: values.scenario ?? env.SIM_SCENARIO_FILE,
      dryRun: values['dry-run'] ?? false,
    });
    if (!['realistic', 'demo'].includes(result.profile)) throw new Error('profile must be realistic or demo');
    if (result.scenarioFile) result.scenarioFile = resolve(result.scenarioFile);
  } else {
    Object.assign(result, {
      apiHost: values['api-host'] ?? env.API_HOST ?? '127.0.0.1',
      apiPort: numeric(values['api-port'] ?? env.API_PORT ?? 3000, 'API port', 1, 65535, true),
      dbFile: values.db ?? env.API_DB_FILE ?? resolve(PROJECT_ROOT, 'data/monitoring.db'),
      token: values.token ?? env.API_TOKEN,
      maxRows: numeric(values['max-rows'] ?? env.API_MAX_TELEMETRY_ROWS ?? 100000, 'max rows', 100, 10000000, true),
    });
  }
  return result;
}

export function helpText(role) {
  const common = `  --host <host> --port <port>  Broker (default 127.0.0.1:1883)\n  --broker-url <url>          mqtt:// or mqtts://\n  --config <file>             Device/compound ID mapping\n  --value-format <format>     engineering (default) or raw\n  --client-id <id>            Override automatic unique client ID\n  --username <name>           MQTT username; prefer MQTT_PASSWORD env for password\n  --connect-timeout-ms <ms>   Initial connection deadline\n  --ack-timeout-ms <ms>       Publish/subscription acknowledgement deadline\n  --log-level <level>         debug, info, warn, error, silent\n  --help                     Show this help\n`;
  return `Usage: npm run ${role === 'sim' ? 'sim' : 'api'} -- [options]\n\n${common}${role === 'sim' ?
    '  --mac <MAC>                Override MAC for a single-device config\n  --interval <seconds>       Heartbeat and analog period (default 5)\n  --profile <name>           realistic (default) or demo\n  --scenario <file>          Explicit switch event timeline\n  --speed <number>           Simulation time multiplier (0.1..100)\n  --seed <integer>           Reproducible random generator (default 42)\n  --duration <seconds>       Wall-clock runtime; 0 = unlimited\n  --dry-run                 Print topic/payload/QoS, without a broker\n' :
    '  --api-host <host>          HTTP bind address (default 127.0.0.1)\n  --api-port <port>          HTTP port (default 3000)\n  --db <file>                SQLite file (default data/monitoring.db)\n  --token <token>            Optional bearer token; prefer API_TOKEN env\n  --max-rows <number>        Rolling telemetry/event/dedup retention\n'}`;
}
