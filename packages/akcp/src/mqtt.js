import mqtt from 'mqtt';
import { randomBytes } from 'node:crypto';

export function makeClientId(prefix, mac) {
  return `${prefix}-${mac}-${randomBytes(4).toString('hex')}`;
}

export async function connectClient(options, logger) {
  const client = mqtt.connect(options.brokerUrl, {
    clientId: options.clientId,
    protocolVersion: 4, clean: true, keepalive: options.keepalive,
    connectTimeout: options.connectTimeoutMs, reconnectPeriod: options.reconnectMs,
    username: options.username, password: options.password, resubscribe: false,
    queueQoSZero: false, rejectUnauthorized: true, ...options.tls,
  });
  client.on('error', error => logger.warn('MQTT transport error', { error: error.message }));
  client.on('reconnect', () => logger.debug('Reconnecting to MQTT broker'));
  client.on('offline', () => logger.warn('MQTT broker offline'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('connect', ready);
      client.end(true);
      reject(new Error(`MQTT connection timed out after ${options.connectTimeoutMs} ms`));
    }, options.connectTimeoutMs);
    function ready() { clearTimeout(timer); resolve(); }
    client.once('connect', ready);
  });
  logger.info('Connected to MQTT broker', { clientId: options.clientId });
  return client;
}

function acknowledged(client, start, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.off('end', ended);
      error ? reject(error) : resolve();
    };
    const ended = () => finish(new Error('MQTT client ended before acknowledgement'));
    const timer = setTimeout(() => {
      // End the client to release its pending packet callbacks. Continuing
      // after an uncertain QoS 1 delivery would silently reorder transitions.
      finish(new Error(`MQTT acknowledgement timed out after ${timeoutMs} ms`));
      client.end(true);
    }, timeoutMs);
    client.once('end', ended);
    try { start(finish); } catch (error) { finish(error); }
  });
}

export function publishQos1(client, topic, payload, timeoutMs) {
  return acknowledged(client, callback => client.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, callback), timeoutMs);
}

export function subscribeQos1(client, topic, timeoutMs) {
  return acknowledged(client, callback => client.subscribe(topic, { qos: 1 }, (error, granted) => {
    if (error) return callback(error);
    if (!granted?.length || granted.some(item => item.qos !== 1)) {
      return callback(new Error('Broker did not grant the requested QoS 1 subscription'));
    }
    callback();
  }), timeoutMs);
}

export function closeClient(client, timeoutMs = 2000) {
  if (!client || client.disconnected) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { client.end(true); resolve(); }, timeoutMs);
    client.end(false, {}, () => { clearTimeout(timer); resolve(); });
  });
}
