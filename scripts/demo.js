import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDotEnv, readOptions, PROJECT_ROOT } from '@outlet/akcp/config';

loadDotEnv();
const options = readOptions('api', []);
const children = new Set();
let stopping = false;
let resolveExit;
const exit = new Promise(resolve => { resolveExit = resolve; });
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    timeout.unref();
    child.once('exit', () => clearTimeout(timeout));
  }
  resolveExit();
}
function launch(file, args = []) {
  const child = spawn(process.execPath, [file, ...args], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  children.add(child);
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { children.delete(child); if (!stopping) stop(code ?? 1); });
  return child;
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
launch('apps/api/src/index.js');
try {
  const host = ['0.0.0.0', '::'].includes(options.apiHost) ? '127.0.0.1' : options.apiHost;
  const endpoint = `http://${host.includes(':') ? `[${host}]` : host}:${options.apiPort}/ready`;
  const deadline = Date.now() + options.connectTimeoutMs + 5000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try { ready = (await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { ready = false; }
    if (ready) break;
    await delay(200);
  }
  if (!stopping && !ready) throw new Error('API did not become ready; check Mosquitto and MQTT settings');
  if (!stopping) launch('apps/akcpsim/src/index.js', ['--profile', 'demo']);
  await exit;
} catch (error) { console.error(error.message); stop(1); }
