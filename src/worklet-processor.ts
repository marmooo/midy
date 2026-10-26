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
/** Hard ceiling; keep in sync with worklet-protocol.ts. */
export const WORKLET_MAX_VOICES = 1024;

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
// Block-rate for LFO / pitch / filter Fc. 16 ≈ 0.33ms @ 48kHz (still smooth).
// Simple-path volume envelope uses a dedicated SUSTAIN fast path (majority of
// polyphony time) and sample-accurate processing only for transient stages.
const MOD_BLOCK = 32;
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
    this._relStart = undefined;
    this._modRelStart = undefined;

    // Hot-path caches (avoid alloc / recompute)
    this.rateScale = 1;
    this.volLfo = 1;
    this.outL = 0;
    this.outR = 0;
    this.needsPitchMod = false;
    this.needsVolLfo = false;
    this.needsModEnv = false;
    this.simplePath = false;
    // NOTE: do NOT clear this.slot — permanent index in processor.voices[].
    // activeIndex is managed by activate/deactivate, not reset().
  }
}

class MidySynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Map();
    this.voices = new Array(MAX_VOICES);
    this.activeSlots = [];
    this.freeSlots = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = new Voice();
      v.slot = i;
      v.activeIndex = -1;
      this.voices[i] = v;
      this.freeSlots[i] = i;
    }
    this.masterGain = 1;
    this.voiceById = new Map();
    this.debug = false;
    this.statNoteOn = 0;
    this.statNoteOff = 0;
    this.statStop = 0;
    this.statSteal = 0;
    this.statMissing = 0;
    this.statLoad = 0;
    this.statEnded = 0;
    this.statQuantums = 0;
    this.statActiveSum = 0;
    this.peakActive = 0;
    this.statProcessMs = 0;
    this.statProcessMaxMs = 0;
    this.statProcessCount = 0;
    this.statProcessOverruns = 0;
    this.statSimpleVQ = 0;
    this.statComplexVQ = 0;
    // AudioWorkletGlobalScope often lacks Performance API (Chrome/Firefox/Safari
    // as of 2026; spec still landing). Fall back to Date.now() for coarse timing.
    // See: https://github.com/WebAudio/web-audio-api/issues/2413
    this._nowMs = null;
    this.timerSource = "none";
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      try {
        const t0 = performance.now();
        if (typeof t0 === "number" && t0 === t0) {
          this._nowMs = function () { return performance.now(); };
          this.timerSource = "perf";
        }
      } catch (_) { /* ignore */ }
    }
    if (!this._nowMs && typeof Date !== "undefined" && typeof Date.now === "function") {
      this._nowMs = function () { return Date.now(); };
      this.timerSource = "date";
    }
    this.hasPerf = this.timerSource === "perf";
    this.port.onmessage = (e) => this.onMessage(e.data);
    // Probe timer once so main can see source immediately.
    let probeMs = -1;
    if (this._nowMs) {
      try { probeMs = this._nowMs(); } catch (_) { probeMs = -1; }
    }
    this.port.postMessage({
      type: "ready",
      hasPerf: this.hasPerf ? 1 : 0,
      timerSource: this.timerSource,
      probeMs: probeMs,
    });
  }

  activateVoice(v) {
    if (v.activeIndex >= 0) return;
    v.activeIndex = this.activeSlots.length;
    this.activeSlots.push(v.slot);
    if (this.activeSlots.length > this.peakActive) {
      this.peakActive = this.activeSlots.length;
    }
  }

  deactivateVoice(v) {
    const i = v.activeIndex;
    if (i < 0) return;
    const slots = this.activeSlots;
    const last = slots.length - 1;
    const lastSlot = slots[last];
    slots[i] = lastSlot;
    this.voices[lastSlot].activeIndex = i;
    slots.pop();
    v.activeIndex = -1;
  }

  dbg(message) {
    if (!this.debug) return;
    if (message.indexOf("loadSample ") === 0) return;
    try {
      this.port.postMessage({ type: "debug", message: message });
    } catch (_) { /* ignore */ }
  }

  /** Snapshot for main (no console). Called on requestStats / setDebug. */
  postStats() {
    try {
      const quantums = this.statQuantums || 1;
      const processCount = this.statProcessCount || 0;
      const avgProcMs = processCount > 0
        ? this.statProcessMs / processCount
        : 0;
      // Quantum wall budget ≈ 128 / sampleRate * 1000 ms (typical render quantum).
      const quantumMs = (typeof sampleRate === "number" && sampleRate > 0)
        ? (128 / sampleRate) * 1000
        : 2.6667;
      const cpuPct = processCount > 0 && quantumMs > 0
        ? (avgProcMs / quantumMs) * 100
        : 0;
      this.port.postMessage({
        type: "stats",
        active: this.activeSlots.length,
        peakActive: this.peakActive,
        samples: this.samples.size,
        noteOn: this.statNoteOn,
        noteOff: this.statNoteOff,
        stop: this.statStop,
        steal: this.statSteal,
        missingSample: this.statMissing,
        loadSample: this.statLoad,
        ended: this.statEnded,
        quantums: this.statQuantums,
        activeSum: this.statActiveSum,
        processMs: this.statProcessMs,
        processMaxMs: this.statProcessMaxMs,
        processCount: this.statProcessCount,
        processAvgMs: avgProcMs,
        processOverruns: this.statProcessOverruns,
        quantumMs: quantumMs,
        cpuPct: cpuPct,
        simpleVQ: this.statSimpleVQ,
        complexVQ: this.statComplexVQ,
        hasPerf: this.hasPerf ? 1 : 0,
        timerSource: this.timerSource,
      });
    } catch (_) { /* ignore */ }
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
        this.statLoad++;
        this.dbg(
          "loadSample id=" + msg.sampleId + " len=" + len +
            " sr=" + msg.sampleRate + " totalSamples=" + this.samples.size,
        );
        break;
      }
      case "noteOn":
        this.handleNoteOn(msg);
        break;
      case "noteOff":
        this.statNoteOff++;
        this.handleNoteOff(msg);
        break;
      case "stop":
        this.statStop++;
        this.stopVoice(msg.voiceId);
        break;
      case "allSoundOff":
        for (let i = 0; i < this.activeSlots.length; i++) {
          this.voices[this.activeSlots[i]].reset();
          this.voices[this.activeSlots[i]].activeIndex = -1;
        }
        this.activeSlots.length = 0;
        this.freeSlots.length = 0;
        for (let i = 0; i < MAX_VOICES; i++) this.freeSlots.push(i);
        this.voiceById.clear();
        this.dbg("allSoundOff");
        break;
      case "setMasterGain":
        this.masterGain = Math.max(0, Math.min(2, +msg.value || 0));
        break;
      case "setVoiceParams":
        this.handleSetVoiceParams(msg);
        break;
      case "setDebug":
        this.debug = !!msg.enabled;
        this.dbg("setDebug " + this.debug);
        break;
      case "requestStats":
        this.postStats();
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
    // O(1) free-list path when under the hard ceiling.
    if (this.freeSlots.length > 0) {
      const slot = this.freeSlots.pop();
      return this.voices[slot];
    }
    // Steal among active only (prefer quiet releasing).
    const slots = this.activeSlots;
    let best = this.voices[slots[0]];
    let bestScore = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const v = this.voices[slots[i]];
      const score = v.releasing
        ? v.envLevel * 0.25 + v.startFrame * 1e-12
        : 1 + v.envLevel + v.startFrame * 1e-12;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    const stolenId = best.voiceId;
    this.statSteal++;
    if (stolenId >= 0) {
      this.voiceById.delete(stolenId);
      try {
        this.port.postMessage({ type: "voiceEnded", voiceId: stolenId });
      } catch (_) { /* ignore */ }
      this.dbg(
        "steal voiceId=" + stolenId + " totalSteals=" + this.statSteal +
          " env=" + (best.envLevel || 0).toFixed(3) +
          " releasing=" + !!best.releasing,
      );
    }
    // Keep slot in activeSlots; voice is reused in place (activeIndex stays).
    const keptIndex = best.activeIndex;
    best.reset();
    best.activeIndex = keptIndex;
    return best;
  }

  handleNoteOn(msg) {
    this.statNoteOn++;
    const sample = this.samples.get(msg.sampleId);
    if (!sample) {
      this.statMissing++;
      this.dbg(
        "MISSING sampleId=" + msg.sampleId +
          " voiceId=" + (msg.voiceId | 0) +
          " samples=" + this.samples.size +
          " missingTotal=" + this.statMissing,
      );
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
    // Fast path: no filter / LFO / mod-env work in the sample loop.
    v.simplePath =
      !v.filterEnabled && !v.needsPitchMod && !v.needsVolLfo && !v.needsModEnv;
    v.rateScale = v.playbackRate * (sample.sampleRate / sampleRate);
    v.volLfo = 1;
    this.voiceById.set(v.voiceId, v);
    this.activateVoice(v);
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

  releaseSlot(v) {
    this.deactivateVoice(v);
    this.freeSlots.push(v.slot);
    v.reset();
  }

  stopVoice(voiceId) {
    const v = this.voiceById.get(voiceId | 0);
    if (!v) return;
    this.voiceById.delete(voiceId | 0);
    if (v.active || v.activeIndex >= 0) this.releaseSlot(v);
  }

  // Advance a generic AHDSR; mutates stage/time/level. Returns current level.
  advanceEnv(stageRef, timeRef, levelRef, delay, attack, hold, decay, sustain, release, dt, releasing) {
    // We mutate via object to keep JS simple inside the string
  }

  // Sample-accurate volume envelope (used by complex path and release edges).
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

  // Block-rate volume envelope for simple path (MOD_BLOCK samples at a time).
  // Linear stages are advanced in one step; SUSTAIN is free.
  processVolEnvBlock(v, dt) {
    switch (v.envStage) {
      case ENV_DELAY:
        v.envTime += dt;
        if (v.envTime >= v.delay) {
          const over = v.envTime - v.delay;
          v.envStage = ENV_ATTACK;
          v.envTime = over;
          const t = Math.min(1, v.envTime / v.attack);
          v.envLevel = t;
          if (v.envTime >= v.attack) {
            v.envStage = ENV_HOLD;
            v.envTime = 0;
            v.envLevel = 1;
          }
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
        // Prefer subtract loop for typical small overshoots (faster than %).
        p = ls + (p - ls);
        while (p >= le) p -= loopLen;
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
    const voices = this.voices;
    const activeSlots = this.activeSlots;

    this.statQuantums++;
    this.statActiveSum += activeSlots.length;
    const nowFn = this._nowMs;
    const tProc0 = nowFn ? nowFn() : 0;

    for (let i = 0; i < n; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }

    for (let ai = activeSlots.length - 1; ai >= 0; ai--) {
      const v = voices[activeSlots[ai]];
      if (!v.active || !v.sample) {
        this.releaseSlot(v);
        continue;
      }

      const sample = v.sample;
      const baseRate = v.playbackRate * (sample.sampleRate / sr);
      let ended = false;

      // -------- Simple path: vol env (block-rate) + sample + pan only --------
      if (v.simplePath) {
        this.statSimpleVQ++;
        v.rateScale = baseRate > 0 ? baseRate : 1;
        const rate = v.rateScale;
        const gPanL = v.gain * v.panL * mg;
        const gPanR = v.gain * v.panR * mg;
        const pcmL = sample.pcmL;
        const pcmR = sample.pcmR;
        const len = sample.length;
        const loop = sample.loop;
        const ls = sample.loopStart;
        const le = sample.loopEnd;
        const loopLen = loop ? (le - ls) : 0;
        let phase = v.phase;

        // Skip leading silence before note start (within this quantum).
        let iStart = 0;
        if (frame0 < v.startFrame) {
          iStart = v.startFrame - frame0;
          if (iStart >= n) {
            // Entire quantum is before start; leave phase unchanged.
            continue;
          }
        }

        // Fast path when already in SUSTAIN and no pending release in this block.
        const sustainOnly = v.envStage === ENV_SUSTAIN &&
          (v.releaseFrame < 0 || v.releaseFrame >= frame0 + n);

        if (sustainOnly) {
          const env = v.sustain;
          const amp = env * gPanL;
          const ampR = env * gPanR;
          if (amp === amp) {
            for (let i = iStart; i < n; i++) {
              let p = phase;
              if (loop) {
                if (p >= le) {
                  if (loopLen <= 0) { ended = true; break; }
                  // Prefer subtract over % for typical small overshoots.
                  p = ls + (p - ls);
                  while (p >= le) p -= loopLen;
                }
              } else if (p >= len - 1) {
                ended = true;
                break;
              }
              const i0 = p | 0;
              const i1 = i0 + 1 < len ? i0 + 1 : len - 1;
              const frac = p - i0;
              const sL = pcmL[i0] + (pcmL[i1] - pcmL[i0]) * frac;
              const sR = pcmR
                ? pcmR[i0] + (pcmR[i1] - pcmR[i0]) * frac
                : sL;
              phase = p + rate;
              outL[i] += sL * amp;
              outR[i] += sR * ampR;
            }
          }
        } else {
          // General simple path.
          // - SUSTAIN / HOLD: constant (or rare block advance)
          // - DELAY / ATTACK / DECAY / RELEASE: sample-accurate for correct shape
          // Most polyphony time is spent in the dedicated sustainOnly path above.
          let env = v.envLevel;
          for (let i = iStart; i < n; i++) {
            const absFrame = frame0 + i;
            if (!v.releasing && v.releaseFrame >= 0 && absFrame >= v.releaseFrame) {
              v.releasing = true;
              v.envStage = ENV_RELEASE;
              v.envTime = 0;
              v._relStart = undefined;
            }
            const stage = v.envStage;
            if (stage === ENV_SUSTAIN) {
              env = v.sustain;
            } else if (stage === ENV_HOLD) {
              env = 1;
              // still advance time so we leave HOLD correctly
              if ((i & (MOD_BLOCK - 1)) === 0) {
                this.processVolEnvBlock(v, blockDt);
                env = v.envLevel;
              }
            } else {
              // Transient stages: sample-accurate
              env = this.processVolEnv(v, invSr);
            }
            if (v.envStage === ENV_DONE) {
              ended = true;
              break;
            }
            let p = phase;
            if (loop) {
              if (p >= le) {
                if (loopLen <= 0) { ended = true; break; }
                p = ls + (p - ls);
                while (p >= le) p -= loopLen;
              }
            } else if (p >= len - 1) {
              ended = true;
              break;
            }
            const i0 = p | 0;
            const i1 = i0 + 1 < len ? i0 + 1 : len - 1;
            const frac = p - i0;
            const sL = pcmL[i0] + (pcmL[i1] - pcmL[i0]) * frac;
            const sR = pcmR
              ? pcmR[i0] + (pcmR[i1] - pcmR[i0]) * frac
              : sL;
            phase = p + rate;
            const amp = env * gPanL;
            const ampR = env * gPanR;
            if (amp === amp) {
              outL[i] += sL * amp;
              outR[i] += sR * ampR;
            }
          }
        }
        v.phase = phase;
      } else {
        // -------- Full path: mod env / LFO / filter --------
        this.statComplexVQ++;
        let modEnv = v.modLevel;
        let modLfo = 0;
        let vibLfo = 0;
        for (let i = 0; i < n; i++) {
          const absFrame = frame0 + i;
          if (absFrame < v.startFrame) continue;

          if (!v.releasing && v.releaseFrame >= 0 && absFrame >= v.releaseFrame) {
            v.releasing = true;
            v.envStage = ENV_RELEASE;
            v.envTime = 0;
            v._relStart = undefined;
            if (v.modStage !== ENV_DONE && v.modStage !== ENV_IDLE) {
              v.modStage = ENV_RELEASE;
              v.modTime = 0;
              v._modRelStart = undefined;
            }
          }

          // SUSTAIN is constant; avoid switch overhead on the common path.
          let env;
          if (v.envStage === ENV_SUSTAIN) {
            env = v.sustain;
          } else {
            env = this.processVolEnv(v, invSr);
          }
          if (v.envStage === ENV_DONE) {
            ended = true;
            break;
          }

          if ((i & (MOD_BLOCK - 1)) === 0) {
            if (v.needsModEnv) {
              modEnv = this.processModEnv(v, blockDt);
              if (modEnv !== modEnv) modEnv = 0;
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
          if (amp === amp && v.outL === v.outL && v.outR === v.outR) {
            outL[i] += v.outL * amp * v.panL;
            outR[i] += v.outR * amp * v.panR;
          }
        }
      }

      if (ended) {
        const id = v.voiceId;
        this.voiceById.delete(id);
        this.releaseSlot(v);
        this.statEnded++;
        try {
          this.port.postMessage({ type: "voiceEnded", voiceId: id });
        } catch (_) { /* ignore */ }
      }
    }

    if (nowFn) {
      const dt = nowFn() - tProc0;
      // Guard NaN / negative (Date.now coarseness or clock skew).
      if (dt === dt && dt >= 0) {
        this.statProcessMs += dt;
        this.statProcessCount++;
        if (dt > this.statProcessMaxMs) this.statProcessMaxMs = dt;
        // Rough overrun: process wall time > quantum budget (128 frames).
        // Date.now is ms-resolution so this is only useful with perf timer.
        const quantumMs = (typeof sampleRate === "number" && sampleRate > 0)
          ? (n / sampleRate) * 1000
          : 2.6667;
        if (dt > quantumMs * 1.05) this.statProcessOverruns++;
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
