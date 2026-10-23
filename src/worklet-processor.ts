// AudioWorkletProcessor for midy "worklet" cacheMode (Phase 1).
//
// Self-contained source string is used via Blob URL so the library does not
// require a separate worklet file at a known path. Keep protocol field names
// in sync with worklet-protocol.ts.

export const MIDY_WORKLET_NAME = "midy-synth-processor";
export const WORKLET_MAX_VOICES = 64;

/**
 * Source text registered with audioWorklet.addModule(blobURL).
 * Must not import external modules (worklet scope is isolated).
 */
export const WORKLET_PROCESSOR_SOURCE = `
const MAX_VOICES = ${WORKLET_MAX_VOICES};
const NAME = ${JSON.stringify(MIDY_WORKLET_NAME)};

class SampleEntry {
  constructor(pcmL, pcmR, sampleRate, loopStart, loopEnd, loop) {
    this.pcmL = pcmL;
    this.pcmR = pcmR;
    this.sampleRate = sampleRate;
    this.loopStart = loopStart;
    this.loopEnd = loopEnd;
    this.loop = loop;
    this.length = pcmL.length;
  }
}

// Envelope stages
const ENV_IDLE = 0;
const ENV_DELAY = 1;
const ENV_ATTACK = 2;
const ENV_HOLD = 3;
const ENV_DECAY = 4;
const ENV_SUSTAIN = 5;
const ENV_RELEASE = 6;
const ENV_DONE = 7;

class Voice {
  constructor() {
    this.active = false;
    this.voiceId = -1;
    this.sample = null;
    this.phase = 0;
    this.playbackRate = 1;
    this.gain = 1;
    this.panL = 0.7071;
    this.panR = 0.7071;
    this.envStage = ENV_IDLE;
    this.envLevel = 0;
    this.envTime = 0;
    this.delay = 0;
    this.attack = 0.001;
    this.hold = 0;
    this.decay = 0.01;
    this.sustain = 1;
    this.release = 0.05;
    this.startFrame = 0;
    this.releasing = false;
  }

  reset() {
    this.active = false;
    this.voiceId = -1;
    this.sample = null;
    this.phase = 0;
    this.envStage = ENV_IDLE;
    this.envLevel = 0;
    this.envTime = 0;
    this.releasing = false;
  }
}

class MidySynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Map();
    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) this.voices[i] = new Voice();
    this.masterGain = 1;
    this.voiceById = new Map();
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ type: "ready" });
  }

  onMessage(msg) {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "loadSample":
        this.samples.set(msg.sampleId, new SampleEntry(
          msg.pcmL,
          msg.pcmR || null,
          msg.sampleRate,
          msg.loopStart | 0,
          msg.loopEnd | 0,
          !!msg.loop,
        ));
        break;
      case "noteOn":
        this.handleNoteOn(msg);
        break;
      case "noteOff":
        this.handleNoteOff(msg);
        break;
      case "stop":
        this.stopVoice(msg.voiceId);
        break;
      case "allSoundOff":
        for (let i = 0; i < MAX_VOICES; i++) {
          if (this.voices[i].active) this.voices[i].reset();
        }
        this.voiceById.clear();
        break;
      case "setMasterGain":
        this.masterGain = Math.max(0, Math.min(2, +msg.value || 0));
        break;
    }
  }

  findFreeVoice() {
    for (let i = 0; i < MAX_VOICES; i++) {
      if (!this.voices[i].active) return this.voices[i];
    }
    // Steal oldest (lowest startFrame among active)
    let best = this.voices[0];
    for (let i = 1; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.startFrame < best.startFrame) best = v;
    }
    if (best.voiceId >= 0) this.voiceById.delete(best.voiceId);
    best.reset();
    return best;
  }

  handleNoteOn(msg) {
    const sample = this.samples.get(msg.sampleId);
    if (!sample) return;

    // Replace existing same voiceId
    const existing = this.voiceById.get(msg.voiceId);
    if (existing) {
      existing.reset();
      this.voiceById.delete(msg.voiceId);
    }

    const v = this.findFreeVoice();
    v.active = true;
    v.voiceId = msg.voiceId | 0;
    v.sample = sample;
    v.phase = 0;
    v.playbackRate = Math.max(1e-6, +msg.playbackRate || 1);
    v.gain = Math.max(0, +msg.gain || 0);
    const pan = Math.max(-1, Math.min(1, +msg.pan || 0));
    // Constant-power pan
    const angle = (pan + 1) * 0.25 * Math.PI;
    v.panL = Math.cos(angle);
    v.panR = Math.sin(angle);
    v.delay = Math.max(0, +msg.delay || 0);
    v.attack = Math.max(1e-4, +msg.attack || 1e-4);
    v.hold = Math.max(0, +msg.hold || 0);
    v.decay = Math.max(1e-4, +msg.decay || 1e-4);
    v.sustain = Math.max(0, Math.min(1, +msg.sustain || 0));
    v.release = Math.max(1e-4, +msg.release || 0.05);
    v.envStage = ENV_DELAY;
    v.envLevel = 0;
    v.envTime = 0;
    v.releasing = false;
    // Schedule relative to currentTime
    const when = +msg.when || currentTime;
    v.startFrame = Math.max(currentFrame, Math.floor(when * sampleRate));
    this.voiceById.set(v.voiceId, v);
  }

  handleNoteOff(msg) {
    const v = this.voiceById.get(msg.voiceId | 0);
    if (!v || !v.active || v.releasing) return;
    v.releasing = true;
    if (msg.release != null) v.release = Math.max(1e-4, +msg.release);
    // Enter release from current level
    v.envStage = ENV_RELEASE;
    v.envTime = 0;
  }

  stopVoice(voiceId) {
    const v = this.voiceById.get(voiceId | 0);
    if (!v) return;
    v.reset();
    this.voiceById.delete(voiceId | 0);
  }

  processEnvelope(v, dt) {
    // Advance envelope by dt seconds; returns linear env level 0–1 (peak=1)
    switch (v.envStage) {
      case ENV_DELAY:
        v.envTime += dt;
        if (v.envTime >= v.delay) {
          v.envStage = ENV_ATTACK;
          v.envTime = 0;
          v.envLevel = 0;
        } else {
          v.envLevel = 0;
        }
        break;
      case ENV_ATTACK: {
        v.envTime += dt;
        const t = Math.min(1, v.envTime / v.attack);
        // Approximate log attack: start near silence
        v.envLevel = Math.max(1e-5, Math.exp(Math.log(1e-5) + t * (0 - Math.log(1e-5))));
        if (v.envTime >= v.attack) {
          v.envStage = ENV_HOLD;
          v.envTime = 0;
          v.envLevel = 1;
        }
        break;
      }
      case ENV_HOLD:
        v.envTime += dt;
        v.envLevel = 1;
        if (v.envTime >= v.hold) {
          v.envStage = ENV_DECAY;
          v.envTime = 0;
        }
        break;
      case ENV_DECAY: {
        v.envTime += dt;
        const t = Math.min(1, v.envTime / v.decay);
        const logStart = 0; // log(1)
        const logEnd = Math.log(Math.max(v.sustain, 1e-5));
        v.envLevel = Math.exp(logStart + t * (logEnd - logStart));
        if (v.envTime >= v.decay) {
          v.envStage = ENV_SUSTAIN;
          v.envTime = 0;
          v.envLevel = v.sustain;
        }
        break;
      }
      case ENV_SUSTAIN:
        v.envLevel = v.sustain;
        break;
      case ENV_RELEASE: {
        v.envTime += dt;
        const start = Math.max(v.envLevel, 1e-5);
        // On first release sample, freeze start level into envLevel as peak for ramp
        if (v.envTime <= dt) {
          v._releaseStart = start;
        }
        const rs = v._releaseStart || start;
        const t = Math.min(1, v.envTime / v.release);
        const logStart = Math.log(Math.max(rs, 1e-5));
        const logEnd = Math.log(1e-5);
        v.envLevel = Math.exp(logStart + t * (logEnd - logStart));
        if (v.envTime >= v.release || v.envLevel <= 1e-5) {
          v.envStage = ENV_DONE;
          v.envLevel = 0;
        }
        break;
      }
      default:
        v.envLevel = 0;
        break;
    }
    return v.envLevel;
  }

  readSample(sample, phase) {
    const len = sample.length;
    if (len <= 0) return [0, 0];
    let p = phase;
    if (sample.loop && sample.loopEnd > sample.loopStart) {
      const ls = sample.loopStart;
      const le = sample.loopEnd;
      if (p >= le) {
        const loopLen = le - ls;
        p = ls + ((p - ls) % loopLen);
      }
    } else if (p >= len - 1) {
      return null; // ended
    }
    const i0 = Math.floor(p);
    const i1 = Math.min(i0 + 1, len - 1);
    const frac = p - i0;
    const l0 = sample.pcmL[i0];
    const l1 = sample.pcmL[i1];
    const left = l0 + (l1 - l0) * frac;
    let right = left;
    if (sample.pcmR) {
      const r0 = sample.pcmR[i0];
      const r1 = sample.pcmR[i1];
      right = r0 + (r1 - r0) * frac;
    }
    return [left, right, p];
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const n = outL.length;
    const sr = sampleRate;
    const invSr = 1 / sr;
    const mg = this.masterGain;

    for (let i = 0; i < n; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }

    const frame0 = currentFrame;

    for (let vi = 0; vi < MAX_VOICES; vi++) {
      const v = this.voices[vi];
      if (!v.active || !v.sample) continue;

      const sample = v.sample;
      const rateScale = v.playbackRate * (sample.sampleRate / sr);
      let ended = false;

      for (let i = 0; i < n; i++) {
        const absFrame = frame0 + i;
        if (absFrame < v.startFrame) continue;

        const env = this.processEnvelope(v, invSr);
        if (v.envStage === ENV_DONE) {
          ended = true;
          break;
        }

        const result = this.readSample(sample, v.phase);
        if (!result) {
          ended = true;
          break;
        }
        const left = result[0];
        const right = result[1];
        v.phase = result[2] + rateScale;

        const amp = v.gain * env * mg;
        outL[i] += left * amp * v.panL;
        outR[i] += right * amp * v.panR;
      }

      if (ended) {
        const id = v.voiceId;
        v.reset();
        this.voiceById.delete(id);
        try {
          this.port.postMessage({ type: "voiceEnded", voiceId: id });
        } catch (_) { /* ignore */ }
      }
    }

    return true;
  }
}

registerProcessor(NAME, MidySynthProcessor);
`;

/** Create a blob: URL suitable for audioWorklet.addModule(). */
export function createWorkletModuleURL(): string {
  const blob = new Blob([WORKLET_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  return URL.createObjectURL(blob);
}
