import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { freePort, waitForTcp, scenarioCheck } from './qa-utils.js';

const folder = mkdtempSync(join(tmpdir(), 'akcp-mosquitto-'));
const port = await freePort();
const config = join(folder, 'mosquitto.conf');
writeFileSync(config, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\nlog_dest stderr\n${process.getuid?.() === 0 ? 'user root\n' : ''}`);
const binary = process.env.MOSQUITTO_BIN ?? 'mosquitto';
const broker = spawn(binary, ['-c', config], { stdio: ['ignore', 'ignore', 'pipe'] });
let brokerError;
let logs = '';
broker.once('error', error => { brokerError = error; });
broker.stderr.on('data', data => { logs = `${logs}${data}`.slice(-2000); });
try {
  await waitForTcp(port);
  if (brokerError) throw brokerError;
  const result = await scenarioCheck(`mqtt://127.0.0.1:${port}`);
  assert.equal(result.ready.ready, true);
  assert.equal(result.sensors.length, 6);
  assert.equal(result.events.length, 8);
  assert.equal(result.alarms.length, 0);
  for (const [type, active, normal] of [['DOOR', 8, 9], ['MOTION', 8, 9], ['POWER', 10, 11], ['PANIC_BUTTON', 8, 9]]) {
    assert(result.events.some(e => e.type === type && e.status === active && e.eventKind === 'ALARM'));
    assert(result.events.some(e => e.type === type && e.status === normal && e.eventKind === 'RECOVERY'));
  }
  assert(result.telemetry.filter(t => ['temperature', 'humidity'].includes(t.metric)).every(t => t.status === 2));
  console.log(JSON.stringify({ result: 'PASS', broker: 'Eclipse Mosquitto', metrics: result.sensors.length, transitions: result.events.length, alarmsAfterRecovery: result.alarms.length, telemetry: result.telemetry.length, qos: 1 }, null, 2));
} catch (error) {
  console.error(`Mosquitto smoke test failed: ${brokerError?.message ?? error.message}\n${logs}`);
  process.exitCode = 1;
} finally {
  if (broker.exitCode === null && !brokerError) {
    const exited = new Promise(resolve => broker.once('exit', resolve));
    broker.kill('SIGTERM');
    const kill = setTimeout(() => broker.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(kill);
  }
  rmSync(folder, { recursive: true, force: true });
}
