import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readOptions, PROJECT_ROOT } from '@outlet/akcp/config';
import { createLogger } from '@outlet/akcp/logger';
import { startApi } from '../apps/api/src/service.js';
import { runSimulator } from '../apps/akcpsim/src/runner.js';

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function waitUntil(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Condition did not become true within ${timeoutMs} ms`);
}

export async function waitForTcp(port) {
  await waitUntil(() => new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(200);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  }));
}

export async function scenarioCheck(brokerUrl) {
  const env = { MQTT_URL: brokerUrl, LOG_LEVEL: 'silent', MQTT_ACK_TIMEOUT_MS: '3000', MQTT_CONNECT_TIMEOUT_MS: '3000' };
  const apiOptions = { ...readOptions('api', [], env), apiPort: 0, dbFile: ':memory:', mac: '000BDC01ADAB' };
  const api = await startApi(apiOptions);
  try {
    const samples = [];
    const options = readOptions('sim', ['--mac', '000BDC01ADAB', '--interval', '1', '--speed', '5', '--duration', '4', '--scenario', `${PROJECT_ROOT}/config/scenario-demo.json`], env);
    const summary = await runSimulator(options, { onSample: sample => samples.push(sample), logger: createLogger('smoke', 'silent') });
    await waitUntil(() => api.store.history('events').items.length === 8);
    const base = `http://127.0.0.1:${api.port}`;
    const ready = await (await fetch(`${base}/ready`)).json();
    const sensors = await (await fetch(`${base}/api/v1/sensors`)).json();
    const events = await (await fetch(`${base}/api/v1/events`)).json();
    const alarms = await (await fetch(`${base}/api/v1/alarms`)).json();
    const telemetry = await (await fetch(`${base}/api/v1/telemetry?limit=500`)).json();
    return { ready, sensors: sensors.items, events: events.items, alarms: alarms.items, telemetry: telemetry.items, samples, summary };
  } finally { await api.close(); }
}
