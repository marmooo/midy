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
/** Dense SMFs need headroom; 64 was easy to exhaust and mask as "silence". */
export const WORKLET_MAX_VOICES = 128;

/**
 * Source text registered with audioWorklet.addModule(blobURL).
 * Must not import external modules (worklet scope is isolated).
 */
export const WORKLET_PROCESSOR_SOURCE = `
const MAX_VOICES = ${WORKLET_MAX_VOICES};
const NAME = ${JSON.stringify(MIDY_WORKLET_NAME)};
const TWO_PI = Math.PI * 2;
const FULLY_OPEN_CENTS = 13500;
// Update LFO / pitch scale / filter Fc every N samples (block-rate).
// At 48kHz, N=8 ≈ 0.17ms — inaudible for LFO while cutting sin/pow cost ~8×.
const MOD_BLOCK = 8;
const LN2_OVER_1200 = Math.LN2 / 1200;

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

// RBJ lowpass coefficients written into voice fields (no array alloc).
function lowpassCoeffsInto(v, freq, q, sr) {
  const w0 = TWO_PI * freq / sr;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * Math.max(0.001, q));
  const b0 = (1 - cosw) * 0.5;
  const b1 = 1 - cosw;
  const a0 = 1 + alpha;
  const invA0 = 1 / a0;
  v.b0 = b0 * invA0;
  v.b1 = b1 * invA0;
  v.b2 = b0 * invA0;
  v.a1 = (-2 * cosw) * invA0;
  v.a2 = (1 - alpha) * invA0;
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

    // Hot-path caches (avoid alloc / recompute)
    this.rateScale = 1;
    this.volLfo = 1;
    this.outL = 0;
    this.outR = 0;
    this.needsPitchMod = false;
    this.needsVolLfo = false;
    this.needsModEnv = false;
    // NOTE: do NOT clear this.slot — it is the permanent index in
    // processor.voices[], set once in the constructor. Clearing it made
    // activateVoice() no-op after the first release, so recycled voices
    // never re-entered activeSlots and sound died mid-song.
  }
}

class MidySynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Map();
    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = new Voice();
      v.slot = i;
      this.voices[i] = v;
    }
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
    // Steal: prefer quietest releasing voice, else oldest startFrame.
    let best = this.voices[0];
    let bestScore = Infinity;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      // Lower score = better steal candidate.
      const score = v.releasing
        ? v.envLevel * 0.25 + v.startFrame * 1e-12
        : 1 + v.envLevel + v.startFrame * 1e-12;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    const stolenId = best.voiceId;
    if (stolenId >= 0) {
      this.voiceById.delete(stolenId);
      // Tell main thread the voice is gone (otherwise it keeps dead ids).
      try {
        this.port.postMessage({ type: "voiceEnded", voiceId: stolenId });
      } catch (_) { /* ignore */ }
    }
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
    // Match main-thread isFilterAudible intent: skip fully-open with no mod.
    v.filterEnabled =
      v.filterFcCents < FULLY_OPEN_CENTS - 1 ||
      v.modEnvToFilterFc !== 0 ||
      v.modLfoToFilterFc !== 0;
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
    // Feature flags: skip sin/pow/modEnv work when depths are zero.
    v.needsPitchMod =
      v.modEnvToPitch !== 0 ||
      v.modLfoToPitch !== 0 ||
      v.vibLfoToPitch !== 0;
    v.needsVolLfo = v.modLfoToVolume !== 0;
    v.needsModEnv =
      v.needsPitchMod ||
      v.filterEnabled ||
      v.modEnvToFilterFc !== 0;
    v.rateScale = v.playbackRate * (sample.sampleRate / sampleRate);
    v.volLfo = 1;
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

  // Read interpolated sample into v.outL/v.outR. Returns new phase, or -1 if ended.
  readSampleInto(v, sample, p) {
    const len = sample.length;
    if (sample.loop) {
      const ls = sample.loopStart;
      const le = sample.loopEnd;
      if (p >= le) {
        const loopLen = le - ls;
        if (loopLen <= 0) return -1;
        p = ls + ((p - ls) % loopLen);
      }
    } else if (p >= len - 1) {
      return -1;
    }
    const i0 = p | 0;
    const i1 = i0 + 1 < len ? i0 + 1 : len - 1;
    const frac = p - i0;
    const l0 = sample.pcmL[i0];
    const l1 = sample.pcmL[i1];
    v.outL = l0 + (l1 - l0) * frac;
    if (sample.pcmR) {
      const r0 = sample.pcmR[i0];
      const r1 = sample.pcmR[i1];
      v.outR = r0 + (r1 - r0) * frac;
    } else {
      v.outR = v.outL;
    }
    return p;
  }

  updateFilter(v, fcHz, sr) {
    // Recompute coeffs only when Fc moves enough
    if (Math.abs(fcHz - v.lastFc) < 0.5) return;
    v.lastFc = fcHz;
    lowpassCoeffsInto(v, fcHz, v.filterQ, sr);
  }

  // Transposed Direct Form II; mutates v.outL/v.outR in place.
  processFilterInPlace(v) {
    const xL = v.outL;
    const yL = v.b0 * xL + v.z1L;
    v.z1L = v.b1 * xL - v.a1 * yL + v.z2L;
    v.z2L = v.b2 * xL - v.a2 * yL;

    const xR = v.outR;
    const yR = v.b0 * xR + v.z1R;
    v.z1R = v.b1 * xR - v.a1 * yR + v.z2R;
    v.z2R = v.b2 * xR - v.a2 * yR;

    const g = v.filterDcGain;
    v.outL = yL * g;
    v.outR = yR * g;
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
    const frame0 = currentFrame;
    const blockDt = invSr * MOD_BLOCK;
    // MAX_VOICES is small (≤128); scanning is cheaper than active-list bugs.
    const voices = this.voices;

    for (let i = 0; i < n; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }

    for (let vi = 0; vi < MAX_VOICES; vi++) {
      const v = voices[vi];
      if (!v.active || !v.sample) continue;

      const sample = v.sample;
      const baseRate = v.playbackRate * (sample.sampleRate / sr);
      let ended = false;
      let modEnv = v.modLevel;
      let modLfo = 0;
      let vibLfo = 0;

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

        // Block-rate: LFO / pitch / filter Fc (every MOD_BLOCK samples).
        if ((i % MOD_BLOCK) === 0) {
          if (v.needsModEnv) {
            modEnv = this.processModEnv(v, blockDt);
            if (modEnv !== modEnv) modEnv = 0; // NaN guard
          } else {
            modEnv = 0;
          }

          v.modLfoAge += blockDt;
          v.vibLfoAge += blockDt;

          modLfo = 0;
          if (v.modLfoAge >= v.modLfoDelay && v.modLfoFreq > 0 &&
            (v.needsPitchMod || v.needsVolLfo || v.filterEnabled)) {
            modLfo = Math.sin(v.modLfoPhase);
            v.modLfoPhase += TWO_PI * v.modLfoFreq * blockDt;
            if (v.modLfoPhase > TWO_PI) v.modLfoPhase -= TWO_PI;
          }

          vibLfo = 0;
          if (v.vibLfoAge >= v.vibLfoDelay && v.vibLfoFreq > 0 &&
            v.vibLfoToPitch !== 0) {
            vibLfo = Math.sin(v.vibLfoPhase);
            v.vibLfoPhase += TWO_PI * v.vibLfoFreq * blockDt;
            if (v.vibLfoPhase > TWO_PI) v.vibLfoPhase -= TWO_PI;
          }

          if (v.needsPitchMod) {
            const pitchCents =
              modEnv * v.modEnvToPitch +
              modLfo * v.modLfoToPitch +
              vibLfo * v.vibLfoToPitch;
            let rs = pitchCents !== 0
              ? baseRate * Math.exp(pitchCents * LN2_OVER_1200)
              : baseRate;
            // Clamp: extreme cents or NaN must not poison the mix bus.
            if (!(rs > 1e-6 && rs < 64)) rs = baseRate > 0 ? baseRate : 1;
            v.rateScale = rs;
          } else {
            v.rateScale = baseRate > 0 ? baseRate : 1;
          }

          if (v.needsVolLfo && modLfo !== 0) {
            const cb = modLfo * v.modLfoToVolume;
            const vl = Math.exp(cb * (Math.LN10 / 200));
            v.volLfo = (vl === vl && vl > 0) ? vl : 1;
          } else {
            v.volLfo = 1;
          }

          if (v.filterEnabled) {
            const fcCents =
              v.filterFcCents +
              modEnv * v.modEnvToFilterFc +
              modLfo * v.modLfoToFilterFc;
            const fcHz = clampFc(centToHz(fcCents), nyquist);
            this.updateFilter(v, fcHz, sr);
          }
        }

        const newPhase = this.readSampleInto(v, sample, v.phase);
        if (newPhase < 0) {
          ended = true;
          break;
        }
        v.phase = newPhase + v.rateScale;

        if (v.filterEnabled) {
          this.processFilterInPlace(v);
        }

        const amp = v.gain * env * v.volLfo * mg;
        // Skip non-finite samples — one NaN would poison outL/outR forever.
        if (amp === amp && v.outL === v.outL && v.outR === v.outR) {
          outL[i] += v.outL * amp * v.panL;
          outR[i] += v.outR * amp * v.panR;
        }
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
