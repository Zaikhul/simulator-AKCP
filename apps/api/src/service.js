import { loadRegistry } from '@outlet/akcp/devices';
import { connectClient, subscribeQos1, closeClient, makeClientId } from '@outlet/akcp/mqtt';
import { createLogger } from '@outlet/akcp/logger';
import { MonitoringStore } from './store.js';
import { createHttpServer } from './http.js';

export async function startApi(options, { logger = createLogger('api', options.logLevel) } = {}) {
  const registry = loadRegistry(options.devicesFile);
  const store = new MonitoringStore(options.dbFile, registry, options);
  const status = { connected: false, subscribed: false };
  const clientId = options.clientId ?? makeClientId('outlet-api', registry.devices[0].mac);
  let client; let server; let closed = false;
  let lastRejectLog = 0;
  const subscribe = async () => {
    status.connected = true; status.subscribed = false;
    await subscribeQos1(client, 'spp/+/sensor/+/+', options.ackTimeoutMs);
    status.subscribed = client.connected;
    logger.info('Subscribed to AKCP telemetry', { topic: 'spp/+/sensor/+/+', qos: 1 });
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    status.connected = false; status.subscribed = false;
    await closeClient(client);
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    logger.info('API stopped');
  };
  try {
    client = await connectClient({ ...options, clientId }, logger);
    client.on('message', (topic, bytes, packet) => {
      try {
        const result = store.ingest(topic, bytes, { retain: packet.retain });
        if (result.eventKind) logger.info('Sensor event ingested', result);
      } catch (error) {
        // Invalid publishers cannot flood the logs with arbitrary payload content.
        if (Date.now() - lastRejectLog >= 1000) {
          lastRejectLog = Date.now();
          logger.warn('Rejected AKCP message', { error: error.message, rejected: store.counters.rejected });
        }
      }
    });
    client.on('offline', () => { status.connected = false; status.subscribed = false; });
    client.on('close', () => { status.connected = false; status.subscribed = false; });
    client.on('connect', () => {
      if (!closed) subscribe().catch(error => logger.error('MQTT resubscription failed', { error: error.message }));
    });
    await subscribe();
    server = createHttpServer(store, status, { token: options.token, logger });
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(options.apiPort, options.apiHost, () => { server.off('error', failed); resolve(); });
    });
    server.on('error', error => logger.error('HTTP server error', { error: error.message }));
    const address = server.address();
    logger.info('HTTP API listening', { host: options.apiHost, port: address.port });
    return { client, server, store, status, close, port: address.port };
  } catch (error) {
    await close();
    throw error;
  }
}
