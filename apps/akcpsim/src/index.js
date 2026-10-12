#!/usr/bin/env node
import { loadDotEnv, readOptions, helpText } from '@outlet/akcp/config';
import { runSimulator } from './runner.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  loadDotEnv();
  const options = readOptions('sim');
  if (options.help) process.stdout.write(helpText('sim'));
  else await runSimulator(options, { signal: controller.signal });
} catch (error) {
  process.stderr.write(`akcpsim: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
