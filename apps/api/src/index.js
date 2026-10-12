#!/usr/bin/env node
import { loadDotEnv, readOptions, helpText } from '@outlet/akcp/config';
import { startApi } from './service.js';

let service;
let stopping = false;
let signalReceived = false;
async function stop() {
  signalReceived = true;
  if (stopping || !service) return;
  stopping = true;
  await service.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  loadDotEnv();
  const options = readOptions('api');
  if (options.help) process.stdout.write(helpText('api'));
  else {
    service = await startApi(options);
    if (signalReceived) await stop();
  }
} catch (error) {
  process.stderr.write(`api: ${error.message}\n`);
  process.exitCode = 1;
}
