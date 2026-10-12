const priorities = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(component, level = 'info', stream = process.stderr) {
  if (!(level in priorities)) throw new Error(`Unknown log level: ${level}`);
  return Object.fromEntries(['debug', 'info', 'warn', 'error'].map(severity => [severity, (message, context = {}) => {
    if (priorities[severity] < priorities[level]) return;
    stream.write(`${JSON.stringify({ time: new Date().toISOString(), severity, component, message, ...context })}\n`);
  }]));
}
