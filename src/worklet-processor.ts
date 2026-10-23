// AudioWorkletProcessor for midy "worklet" cacheMode (Phase 2).
//
// Self-contained source string is used via Blob URL so the library does not
// require a separate worklet file at a known path. Keep protocol field names
// in sync with worklet-protocol.ts.
//
// Phase 2 adds:
//   1. Lowpass filter (initialFilterFc / Q + modEnv / modLFO)
//   2. Mod LFO + Vib LFO → pitch / filter / volume
//   3. Modulation envelope → pitch / filter
//   4. Dynamic per-voice gain / pan / playbackRate (channel vol/expr/pan)

export const MIDY_WORKLET_NAME = "midy-synth-processor";
export const WORKLET_MAX_VOICES = 64;

/**
 * Source text registered with audioWorklet.addModule(blobURL).
 * Must not import external modules (worklet scope is isolated).
 */
export const WORKLET_PROCESSOR_SOURCE = `
const MAX_VOICES = ${WORKLET_MAX_VOICES};
const NAME = ${JSON.stringify(MIDY_WORKLET_NAME)};
const TWO_PI = Math.PI * 2;
const FULLY_OPEN_CENTS = 13500;

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

// Envelope stages (shared by vol + mod)
const ENV_IDLE = 0;
const ENV_DELAY = 1;
const ENV_ATTACK = 2;
const ENV_HOLD = 3;
const ENV_DECAY = 4;
const ENV_SUSTAIN = 5;
const ENV_RELEASE = 6;
const ENV_DONE = 7;

function centToHz(cents) {
  return 8.176 * Math.pow(2, cents / 1200);
}

function clampFc(hz, nyquist) {
  if (hz < 20) return 20;
  const max = nyquist * 0.99;
  return hz > max ? max : hz;
}

// RBJ lowpass coefficients. q is linear Q.
function lowpassCoeffs(freq, q, sr) {
  const w0 = TWO_PI * freq / sr;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * Math.max(0.001, q));
  const b0 = (1 - cosw) * 0.5;
  const b1 = 1 - cosw;
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  const invA0 = 1 / a0;
  return [b0 * invA0, b1 * invA0, b2 * invA0, a1 * invA0, a2 * invA0];
}

class Voice {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.voiceId = -1;
    this.sample = null;
    this.phase = 0;
    this.playbackRate = 1;
    this.gain = 1;
    this.panL = 0.7071;
    this.panR = 0.7071;

    // Volume envelope
    this.envStage = ENV_IDLE;
    this.envLevel = 0;
    this.envTime = 0;
    this.delay = 0;
    this.attack = 0.001;
    this.hold = 0;
    this.decay = 0.01;
    this.sustain = 1;
    this.release = 0.05;
    this.releasing = false;

    // Mod envelope
    this.modStage = ENV_IDLE;
    this.modLevel = 0;
    this.modTime = 0;
    this.delayModEnv = 0;
    this.attackModEnv = 0.001;
    this.holdModEnv = 0;
    this.decayModEnv = 0.01;
    this.sustainModEnv = 0;
    this.releaseModEnv = 0.05;
    this.modEnvToPitch = 0;
    this.modEnvToFilterFc = 0;

    // Filter
    this.filterFcCents = FULLY_OPEN_CENTS;
    this.filterQ = 0.7071;
    this.filterDcGain = 1;
    this.filterEnabled = false;
    this.z1L = 0; this.z2L = 0;
    this.z1R = 0; this.z2R = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
    this.lastFc = -1;

    // Mod LFO
    this.modLfoPhase = 0;
    this.modLfoDelay = 0;
    this.modLfoFreq = 5;
    this.modLfoToPitch = 0;
    this.modLfoToFilterFc = 0;
    this.modLfoToVolume = 0; // cB
    this.modLfoAge = 0;

    // Vib LFO
    this.vibLfoPhase = 0;
    this.vibLfoDelay = 0;
    this.vibLfoFreq = 5;
    this.vibLfoToPitch = 0;
    this.vibLfoAge = 0;

    this.startFrame = 0;
    this.releaseFrame = -1; // absolute frame to enter release; -1 = none
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
      case "loadSample": {
        const pcmL = msg.pcmL;
        const len = pcmL ? pcmL.length : 0;
        this.samples.set(msg.sampleId, new SampleEntry(
          pcmL,
          msg.pcmR || null,
          msg.sampleRate,
          msg.loopStart | 0,
          msg.loopEnd | 0,
          !!msg.loop,
        ));
        try {
          this.port.postMessage({
            type: "debug",
            message: "loadSample id=" + msg.sampleId + " len=" + len +
              " sr=" + msg.sampleRate,
          });
        } catch (_) {}
        break;
      }
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
      case "setVoiceParams":
        this.handleSetVoiceParams(msg);
        break;
    }
  }

  handleSetVoiceParams(msg) {
    const v = this.voiceById.get(msg.voiceId | 0);
    if (!v || !v.active) return;
    if (msg.gain != null) v.gain = Math.max(0, +msg.gain);
    if (msg.pan != null) {
      const pan = Math.max(-1, Math.min(1, +msg.pan));
      const angle = (pan + 1) * 0.25 * Math.PI;
      v.panL = Math.cos(angle);
      v.panR = Math.sin(angle);
    }
    if (msg.playbackRate != null) {
      v.playbackRate = Math.max(1e-6, +msg.playbackRate);
    }
  }

  findFreeVoice() {
    for (let i = 0; i < MAX_VOICES; i++) {
      if (!this.voices[i].active) return this.voices[i];
    }
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
    if (!sample) {
      try {
        this.port.postMessage({
          type: "debug",
          message: "noteOn missing sampleId=" + msg.sampleId +
            " samples=" + this.samples.size,
        });
      } catch (_) {}
      return;
    }

    const existing = this.voiceById.get(msg.voiceId);
    if (existing) {
      existing.reset();
      this.voiceById.delete(msg.voiceId);
    }

    const v = this.findFreeVoice();
    v.active = true;
    v.voiceId = msg.voiceId | 0;
    v.sample = sample;
    try {
      this.port.postMessage({
        type: "debug",
        message: "noteOn id=" + v.voiceId + " sampleLen=" + sample.length +
          " gain=" + (+msg.gain || 0) + " when=" + (+msg.when || 0) +
          " rate=" + (+msg.playbackRate || 1),
      });
    } catch (_) {}
    v.phase = 0;
    v.playbackRate = Math.max(1e-6, +msg.playbackRate || 1);
    v.gain = Math.max(0, +msg.gain || 0);
    const pan = Math.max(-1, Math.min(1, +msg.pan || 0));
    const angle = (pan + 1) * 0.25 * Math.PI;
    v.panL = Math.cos(angle);
    v.panR = Math.sin(angle);

    // Vol env
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
    v.releaseFrame = -1;

    // Filter
    v.filterFcCents = msg.filterFcCents != null ? +msg.filterFcCents : FULLY_OPEN_CENTS;
    v.filterQ = Math.max(0.001, +msg.filterQ || 0.7071);
    v.filterDcGain = msg.filterDcGain != null ? +msg.filterDcGain : 1;
    v.modEnvToFilterFc = +msg.modEnvToFilterFc || 0;
    v.modLfoToFilterFc = +msg.modLfoToFilterFc || 0;
    v.filterEnabled =
      v.filterFcCents < FULLY_OPEN_CENTS ||
      v.modEnvToFilterFc !== 0 ||
      v.modLfoToFilterFc !== 0 ||
      v.filterQ > 1.01;
    v.z1L = v.z2L = v.z1R = v.z2R = 0;
    v.lastFc = -1;

    // Mod env
    v.delayModEnv = Math.max(0, +msg.delayModEnv || 0);
    v.attackModEnv = Math.max(1e-4, +msg.attackModEnv || 1e-4);
    v.holdModEnv = Math.max(0, +msg.holdModEnv || 0);
    v.decayModEnv = Math.max(1e-4, +msg.decayModEnv || 1e-4);
    // sustainModEnv here is the linear sustain level of the envelope (0=full, SF2 sustain is inverted)
    v.sustainModEnv = Math.max(0, Math.min(1, +msg.sustainModEnv || 0));
    v.releaseModEnv = Math.max(1e-4, +msg.releaseModEnv || 0.05);
    v.modEnvToPitch = +msg.modEnvToPitch || 0;
    v.modStage = ENV_DELAY;
    v.modLevel = 0;
    v.modTime = 0;

    // Mod LFO
    v.modLfoDelay = Math.max(0, +msg.delayModLFO || 0);
    v.modLfoFreq = Math.max(0, +msg.freqModLFO || 0);
    v.modLfoToPitch = +msg.modLfoToPitch || 0;
    v.modLfoToVolume = +msg.modLfoToVolume || 0;
    v.modLfoPhase = 0;
    v.modLfoAge = 0;

    // Vib LFO
    v.vibLfoDelay = Math.max(0, +msg.delayVibLFO || 0);
    v.vibLfoFreq = Math.max(0, +msg.freqVibLFO || 0);
    v.vibLfoToPitch = +msg.vibLfoToPitch || 0;
    v.vibLfoPhase = 0;
    v.vibLfoAge = 0;

    const when = +msg.when || currentTime;
    v.startFrame = Math.max(currentFrame, Math.floor(when * sampleRate));
    this.voiceById.set(v.voiceId, v);
  }

  handleNoteOff(msg) {
    const v = this.voiceById.get(msg.voiceId | 0);
    if (!v || !v.active || v.releasing) return;
    if (msg.release != null) v.release = Math.max(1e-4, +msg.release);
    const when = +msg.when;
    // Defer release until absolute context time "when" (AudioContext seconds).
    // Early noteOff messages (lookAhead) must not cut the attack.
    if (Number.isFinite(when) && when > 0) {
      v.releaseFrame = Math.max(v.startFrame, Math.floor(when * sampleRate));
    } else {
      v.releasing = true;
      v.envStage = ENV_RELEASE;
      v.envTime = 0;
      if (v.modStage !== ENV_DONE && v.modStage !== ENV_IDLE) {
        v.modStage = ENV_RELEASE;
        v.modTime = 0;
      }
    }
  }

  stopVoice(voiceId) {
    const v = this.voiceById.get(voiceId | 0);
    if (!v) return;
    v.reset();
    this.voiceById.delete(voiceId | 0);
  }

  // Advance a generic AHDSR; mutates stage/time/level. Returns current level.
  advanceEnv(stageRef, timeRef, levelRef, delay, attack, hold, decay, sustain, release, dt, releasing) {
    // We mutate via object to keep JS simple inside the string
  }

  processVolEnv(v, dt) {
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
        v.envLevel = t;
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
        v.envLevel = 1 + (v.sustain - 1) * t;
        if (v.envTime >= v.decay) {
          v.envStage = ENV_SUSTAIN;
          v.envLevel = v.sustain;
        }
        break;
      }
      case ENV_SUSTAIN:
        v.envLevel = v.sustain;
        break;
      case ENV_RELEASE: {
        v.envTime += dt;
        // Exponential-ish linear fall from current release start level
        if (v.envTime <= 0) {
          // capture start level on first release sample
        }
        const startLevel = v._relStart != null ? v._relStart : (v._relStart = v.envLevel || 1e-6);
        const t = Math.min(1, v.envTime / v.release);
        v.envLevel = startLevel * (1 - t);
        if (v.envTime >= v.release || v.envLevel < 1e-5) {
          v.envStage = ENV_DONE;
          v.envLevel = 0;
        }
        break;
      }
      case ENV_DONE:
        v.envLevel = 0;
        break;
    }
    return v.envLevel;
  }

  processModEnv(v, dt) {
    switch (v.modStage) {
      case ENV_DELAY:
        v.modTime += dt;
        if (v.modTime >= v.delayModEnv) {
          v.modStage = ENV_ATTACK;
          v.modTime = 0;
          v.modLevel = 0;
        } else {
          v.modLevel = 0;
        }
        break;
      case ENV_ATTACK: {
        v.modTime += dt;
        const t = Math.min(1, v.modTime / v.attackModEnv);
        v.modLevel = t;
        if (v.modTime >= v.attackModEnv) {
          v.modStage = ENV_HOLD;
          v.modTime = 0;
          v.modLevel = 1;
        }
        break;
      }
      case ENV_HOLD:
        v.modTime += dt;
        v.modLevel = 1;
        if (v.modTime >= v.holdModEnv) {
          v.modStage = ENV_DECAY;
          v.modTime = 0;
        }
        break;
      case ENV_DECAY: {
        v.modTime += dt;
        const t = Math.min(1, v.modTime / v.decayModEnv);
        // sustainModEnv is already the target level (0–1)
        v.modLevel = 1 + (v.sustainModEnv - 1) * t;
        if (v.modTime >= v.decayModEnv) {
          v.modStage = ENV_SUSTAIN;
          v.modLevel = v.sustainModEnv;
        }
        break;
      }
      case ENV_SUSTAIN:
        v.modLevel = v.sustainModEnv;
        break;
      case ENV_RELEASE: {
        v.modTime += dt;
        const startLevel = v._modRelStart != null ? v._modRelStart : (v._modRelStart = v.modLevel || 0);
        const t = Math.min(1, v.modTime / v.releaseModEnv);
        v.modLevel = startLevel * (1 - t);
        if (v.modTime >= v.releaseModEnv) {
          v.modStage = ENV_DONE;
          v.modLevel = 0;
        }
        break;
      }
      case ENV_DONE:
        v.modLevel = 0;
        break;
    }
    return v.modLevel;
  }

  readSample(sample, p) {
    const len = sample.length;
    if (sample.loop) {
      const ls = sample.loopStart;
      const le = sample.loopEnd;
      if (p >= le) {
        const loopLen = le - ls;
        if (loopLen <= 0) return null;
        p = ls + ((p - ls) % loopLen);
      }
    } else if (p >= len - 1) {
      return null;
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

  updateFilter(v, fcHz, sr) {
    // Recompute coeffs only when Fc moves enough
    if (Math.abs(fcHz - v.lastFc) < 0.5) return;
    v.lastFc = fcHz;
    const c = lowpassCoeffs(fcHz, v.filterQ, sr);
    v.b0 = c[0]; v.b1 = c[1]; v.b2 = c[2];
    v.a1 = c[3]; v.a2 = c[4];
  }

  processFilter(v, left, right) {
    // Transposed Direct Form II
    const xL = left;
    const outL = v.b0 * xL + v.z1L;
    v.z1L = v.b1 * xL - v.a1 * outL + v.z2L;
    v.z2L = v.b2 * xL - v.a2 * outL;

    const xR = right;
    const outR = v.b0 * xR + v.z1R;
    v.z1R = v.b1 * xR - v.a1 * outR + v.z2R;
    v.z2R = v.b2 * xR - v.a2 * outR;

    return [outL * v.filterDcGain, outR * v.filterDcGain];
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const n = outL.length;
    const sr = sampleRate;
    const invSr = 1 / sr;
    const nyquist = sr * 0.5;
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
      let ended = false;

      for (let i = 0; i < n; i++) {
        const absFrame = frame0 + i;
        if (absFrame < v.startFrame) continue;

        // Scheduled noteOff (from lookAhead) becomes real release here.
        if (!v.releasing && v.releaseFrame >= 0 && absFrame >= v.releaseFrame) {
          v.releasing = true;
          v.envStage = ENV_RELEASE;
          v.envTime = 0;
          if (v.modStage !== ENV_DONE && v.modStage !== ENV_IDLE) {
            v.modStage = ENV_RELEASE;
            v.modTime = 0;
          }
        }

        const env = this.processVolEnv(v, invSr);
        if (v.envStage === ENV_DONE) {
          ended = true;
          break;
        }

        const modEnv = this.processModEnv(v, invSr);

        // LFO ages
        v.modLfoAge += invSr;
        v.vibLfoAge += invSr;

        let modLfo = 0;
        if (v.modLfoAge >= v.modLfoDelay && v.modLfoFreq > 0) {
          modLfo = Math.sin(v.modLfoPhase);
          v.modLfoPhase += TWO_PI * v.modLfoFreq * invSr;
          if (v.modLfoPhase > TWO_PI) v.modLfoPhase -= TWO_PI;
        }

        let vibLfo = 0;
        if (v.vibLfoAge >= v.vibLfoDelay && v.vibLfoFreq > 0) {
          vibLfo = Math.sin(v.vibLfoPhase);
          v.vibLfoPhase += TWO_PI * v.vibLfoFreq * invSr;
          if (v.vibLfoPhase > TWO_PI) v.vibLfoPhase -= TWO_PI;
        }

        // Pitch modulation in cents → rate scale
        const pitchCents =
          modEnv * v.modEnvToPitch +
          modLfo * v.modLfoToPitch +
          vibLfo * v.vibLfoToPitch;
        const rateScale = v.playbackRate *
          (sample.sampleRate / sr) *
          (pitchCents !== 0 ? Math.pow(2, pitchCents / 1200) : 1);

        // Volume LFO (centibels → linear)
        let volLfo = 1;
        if (v.modLfoToVolume !== 0 && modLfo !== 0) {
          // modLfoToVolume is in cB; bipolar LFO → ±depth
          const cb = modLfo * v.modLfoToVolume;
          volLfo = Math.pow(10, cb / 200); // cB/10 = dB; 10^(dB/20) = 10^(cB/200)
        }

        const result = this.readSample(sample, v.phase);
        if (!result) {
          ended = true;
          break;
        }
        let left = result[0];
        let right = result[1];
        v.phase = result[2] + rateScale;

        if (v.filterEnabled) {
          const fcCents =
            v.filterFcCents +
            modEnv * v.modEnvToFilterFc +
            modLfo * v.modLfoToFilterFc;
          const fcHz = clampFc(centToHz(fcCents), nyquist);
          this.updateFilter(v, fcHz, sr);
          const filtered = this.processFilter(v, left, right);
          left = filtered[0];
          right = filtered[1];
        }

        const amp = v.gain * env * volLfo * mg;
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

try {
  registerProcessor(NAME, MidySynthProcessor);
} catch (_) {
  // Already registered on this AudioWorkletGlobalScope (second Midy instance,
  // HMR, or dispose+recreate on the same AudioContext).
}
`;

/** Create a blob: URL suitable for audioWorklet.addModule(). */
export function createWorkletModuleURL(): string {
  const blob = new Blob([WORKLET_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  return URL.createObjectURL(blob);
}
