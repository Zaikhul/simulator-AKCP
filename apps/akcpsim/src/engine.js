import { buildTopic, encodeValue, metricKey, STATUS, switchStatus } from '@outlet/akcp/protocol';

function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const demoTiming = {
  DOOR: { idleSeconds: [4, 8], activeSeconds: [2, 4] },
  MOTION: { idleSeconds: [3, 7], activeSeconds: [1, 3] },
  POWER: { idleSeconds: [12, 20], activeSeconds: [3, 6] },
  PANIC_BUTTON: { idleSeconds: [15, 25], activeSeconds: [1, 3] },
};

export class SimulationEngine {
  constructor(registry, { seed = 42, intervalSeconds = 5, profile = 'realistic', valueFormat = 'engineering', scenario = null } = {}) {
    this.registry = registry;
    this.random = randomGenerator(seed);
    this.interval = intervalSeconds;
    this.format = valueFormat;
    this.scenario = scenario;
    this.scenarioIndex = 0;
    this.nextSample = 0;
    this.lastStep = -1;
    this.analog = new Map();
    this.switches = new Map();
    for (const device of registry.devices) {
      for (const sensor of device.sensors) {
        if (sensor.metrics[0].kind === 'switch') {
          const timing = profile === 'demo' ? demoTiming[sensor.type] : sensor.timing;
          this.switches.set(`${device.mac}/${sensor.id}`, {
            device, sensor, timing, active: false,
            nextTransition: this.uniform(timing.idleSeconds),
          });
        } else {
          for (const metric of sensor.metrics) {
            this.analog.set(metricKey(device.mac, metric.compoundId), {
              device, sensor, metric, value: metric.baseline, elapsed: 0, phase: this.random() * Math.PI * 2,
            });
          }
        }
      }
    }
  }

  uniform([min, max]) { return min + this.random() * (max - min); }

  message(device, sensor, metric, event, value, status, elapsed, sourceMs) {
    const payload = { timestamp: Math.floor(sourceMs / 1000) };
    if (value !== undefined && value !== null) {
      payload.value = encodeValue(value, metric, this.format);
    }
    if (status !== undefined && status !== null) {
      payload.status = status;
    }
    return {
      topic: buildTopic(device.mac, event, metric.compoundId),
      payload,
      qos: 1, retain: false,
      // Internal metadata is deliberately kept outside the MQTT payload.
      sensorId: sensor.id, sensorType: sensor.type, simulatedSeconds: elapsed,
    };
  }

  transition(state, active, elapsed, sourceMs) {
    if (state.active === active) return null;
    state.active = active;
    return this.message(state.device, state.sensor, state.sensor.metrics[0], 'status_change',
      active ? 0 : 1, switchStatus(state.sensor.type, active), elapsed, sourceMs);
  }

  advanceAnalog(elapsed) {
    for (const state of this.analog.values()) {
      const { metric, device, sensor } = state;
      const dt = elapsed - state.elapsed;
      if (dt <= 0) continue;
      let target = metric.baseline + metric.amplitude * Math.sin((2 * Math.PI * elapsed / metric.periodSeconds) + state.phase);
      if (metric.kind === 'humidity') {
        // Temperature rising in the paired probe gently reduces relative humidity.
        const pair = sensor.metrics.find(m => m.kind === 'temperature');
        const temp = this.analog.get(metricKey(device.mac, pair.compoundId));
        target -= 0.8 * (temp.value - pair.baseline);
      }
      const power = [...this.switches.values()].find(s => s.device.mac === device.mac && s.sensor.type === 'POWER');
      if (metric.kind === 'temperature' && power?.active) target += 0.6;
      const drift = (target - state.value) * (1 - Math.exp(-dt / 60));
      const noise = (this.random() - 0.5) * 2 * metric.noise;
      const delta = clamp(drift + noise, -metric.maxStep, metric.maxStep);
      state.value = clamp(state.value + delta, metric.min, metric.max);
      state.elapsed = elapsed;
    }
  }

  periodic(elapsed, sourceMs) {
    this.advanceAnalog(elapsed);
    const samples = [];
    for (const state of this.analog.values()) {
      samples.push(this.message(state.device, state.sensor, state.metric, 'value_change', state.value,
        STATUS.SENSOR_NORMAL, elapsed, sourceMs));
    }
    for (const state of this.switches.values()) {
      samples.push(this.message(state.device, state.sensor, state.sensor.metrics[0], 'value_change',
        state.active ? 0 : 1, switchStatus(state.sensor.type, state.active), elapsed, sourceMs));
    }
    return samples;
  }

  step(elapsed, timestampMs = Date.now()) {
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed < this.lastStep) throw new Error('Simulation time must be monotonic');
    const samples = [];
    if (this.lastStep < 0) {
      samples.push(...this.periodic(0, timestampMs));
      this.nextSample = this.interval;
    }
    this.lastStep = elapsed;
    if (this.scenario !== null) {
      while (this.scenarioIndex < this.scenario.length && this.scenario[this.scenarioIndex].atSeconds <= elapsed) {
        const event = this.scenario[this.scenarioIndex++];
        const state = this.switches.get(`${event.mac}/${event.sensorId}`);
        const message = this.transition(state, event.active, event.atSeconds, timestampMs);
        if (message) samples.push(message);
      }
    } else {
      const transitions = [];
      for (const state of this.switches.values()) {
        let count = 0;
        while (elapsed >= state.nextTransition) {
          if (++count > 1000) throw new Error('Too many overdue transitions; reduce speed or timestep');
          const due = state.nextTransition;
          const message = this.transition(state, !state.active, due, timestampMs);
          if (message) transitions.push(message);
          state.nextTransition = due + this.uniform(state.active ? state.timing.activeSeconds : state.timing.idleSeconds);
        }
      }
      transitions.sort((a, b) => a.simulatedSeconds - b.simulatedSeconds);
      samples.push(...transitions);
    }
    if (elapsed >= this.nextSample) {
      samples.push(...this.periodic(elapsed, timestampMs));
      this.nextSample = (Math.floor(elapsed / this.interval) + 1) * this.interval;
    }
    return samples;
  }
}
