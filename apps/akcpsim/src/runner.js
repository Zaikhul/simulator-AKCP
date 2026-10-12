import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRegistry, loadScenario } from '@outlet/akcp/devices';
import { connectClient, closeClient, makeClientId, publishQos1 } from '@outlet/akcp/mqtt';
import { createLogger } from '@outlet/akcp/logger';
import { SimulationEngine } from './engine.js';

export async function runSimulator(options, { signal, onSample, logger = createLogger('akcpsim', options.logLevel) } = {}) {
  const registry = loadRegistry(options.devicesFile, { mac: options.mac });
  const scenario = options.scenarioFile ? loadScenario(options.scenarioFile, registry) : null;
  const engine = new SimulationEngine(registry, { ...options, scenario });
    const clientId = options.clientId ?? makeClientId('akcp-sim', registry.devices.length === 1 ? registry.devices[0].mac : 'multi-outlets');
  let client;
  let published = 0;
  let transitions = 0;
  try {
    if (!options.dryRun) client = await connectClient({ ...options, clientId }, logger);
    const start = performance.now();
    const tickMs = Math.max(10, Math.min(100, options.intervalSeconds * 1000 / options.speed));
    logger.info('Simulator started', { clientId, devices: registry.devices.length, deviceNames: registry.devices.map(d => `${d.name} (${d.mac})`), profile: options.profile, scenario: Boolean(scenario), valueFormat: options.valueFormat });
    while (!signal?.aborted) {
      const elapsedWall = (performance.now() - start) / 1000;
      if (options.durationSeconds > 0 && elapsedWall >= options.durationSeconds) break;
      const samples = engine.step(elapsedWall * options.speed, Date.now());
      for (const sample of samples) {
        if (signal?.aborted) break;
        if (options.dryRun) {
          process.stdout.write(`${JSON.stringify({ topic: sample.topic, payload: sample.payload, qos: 1, retain: false })}\n`);
        } else {
          await publishQos1(client, sample.topic, sample.payload, options.ackTimeoutMs);
        }
        published++;
        if (sample.topic.includes('/status_change/')) {
          transitions++;
          logger.info('Sensor transition', { mac: sample.topic.split('/')[1], sensorId: sample.sensorId, type: sample.sensorType, status: sample.payload.status });
        } else logger.debug('Sensor reading', { topic: sample.topic, ...sample.payload });
        await onSample?.(sample);
      }
      try { await delay(tickMs, undefined, { signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    return { clientId, published, transitions };
  } finally {
    await closeClient(client);
    logger.info('Simulator stopped', { published, transitions });
  }
}
