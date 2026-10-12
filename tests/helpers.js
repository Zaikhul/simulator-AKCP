import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import aedes from 'aedes';
import { createRegistry } from '@outlet/akcp/devices';
import { PROJECT_ROOT, readOptions } from '@outlet/akcp/config';
import { createLogger } from '@outlet/akcp/logger';

export const mac = '000BDC01ADAB';
export const epoch = 1700000000;
export const logger = createLogger('test', 'silent');
export const fixture = () => JSON.parse(readFileSync(`${PROJECT_ROOT}/config/devices.json`, 'utf8'));
export const registry = () => createRegistry(fixture(), { mac });

export function brokerOptions(role, url) {
  return readOptions(role, [], {
    MQTT_URL: url, MQTT_CONNECT_TIMEOUT_MS: '2000', MQTT_ACK_TIMEOUT_MS: '2000',
    MQTT_RECONNECT_MS: '100', LOG_LEVEL: 'silent',
  });
}

export async function startBroker() {
  const broker = aedes();
  const server = createServer(broker.handle);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `mqtt://127.0.0.1:${server.address().port}`;
  return { broker, server, url, close: async () => {
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}
