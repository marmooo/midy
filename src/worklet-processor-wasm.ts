// Drop-in alternative to midy worklet-processor.ts (WASM core).
// Volume envelope + pan + lowpass filter + modEnv + modLFO + vibLFO.
// Stats mirror pure-JS worklet so main-thread logs are comparable.

import { SYNTH_CORE_WASM_BASE64 } from "./synth_core_wasm_b64.ts";

export const MIDY_WORKLET_NAME = "midy-synth-processor";
export const WORKLET_MAX_VOICES = 1024;

const WORKLET_PROCESSOR_SOURCE = `
const NAME = "midy-synth-processor";
const MAX_SAMPLES = 512;
const FULLY_OPEN_CENTS = 13500;

class MidySynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.exports = null;
    this.memory = null;
    this.masterGain = 1;
    this.pending = [];
    this.idMap = new Map();
    this.nextSlot = 0;
    this.sampleMeta = new Map();
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
    this.statProcessMaxActive = 0;
    this.statProcessMaxMsgs = 0;
    this.statProcessOverrunMaxMs = 0;
    this.statMsgsQueued = 0;
    this.statProcHist = new Uint32Array(6);

    this._nowMs = null;
    this.timerSource = "none";
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      try {
        const t0 = performance.now();
        if (typeof t0 === "number" && t0 === t0) {
          this._nowMs = function () { return performance.now(); };
          this.timerSource = "perf";
        }
      } catch (_) {}
    }
    if (!this._nowMs && typeof Date !== "undefined" && typeof Date.now === "function") {
      this._nowMs = function () { return Date.now(); };
      this.timerSource = "date";
    }
    this.hasPerf = this.timerSource === "perf";

    this.port.onmessage = (ev) => this.onMessage(ev.data);

    let probeMs = -1;
    if (this._nowMs) {
      try { probeMs = this._nowMs(); } catch (_) { probeMs = -1; }
    }
    try {
      this.port.postMessage({
        type: "ready",
        hasPerf: this.hasPerf ? 1 : 0,
        timerSource: this.timerSource,
        probeMs: probeMs,
      });
    } catch (_) {}
  }

  postDebug(message) {
    try {
      this.port.postMessage({ type: "debug", message: String(message) });
    } catch (_) {}
  }

  mapSampleId(externalId) {
    const key = String(externalId);
    let slot = this.idMap.get(key);
    if (slot !== undefined) return slot;
    if (this.nextSlot >= MAX_SAMPLES) return -1;
    slot = this.nextSlot++;
    this.idMap.set(key, slot);
    return slot;
  }

  postStats() {
    try {
      const e = this.exports;
      const quantums = this.statQuantums || 1;
      const processCount = this.statProcessCount || 0;
      const avgProcMs = processCount > 0
        ? this.statProcessMs / processCount
        : 0;
      const quantumMs = (typeof sampleRate === "number" && sampleRate > 0)
        ? (128 / sampleRate) * 1000
        : 2.6667;
      const cpuPct = processCount > 0 && quantumMs > 0
        ? (avgProcMs / quantumMs) * 100
        : 0;
      const active = e && this.ready ? (e.sc_active_voices() | 0) : 0;
      const peakFromWasm = e && this.ready && e.sc_peak_active
        ? (e.sc_peak_active() | 0) : 0;
      const peakActive = Math.max(this.peakActive, peakFromWasm);
      const simpleVQ = e && this.ready && e.sc_simple_vq
        ? (e.sc_simple_vq() >>> 0) : 0;
      const complexVQ = e && this.ready && e.sc_complex_vq
        ? (e.sc_complex_vq() >>> 0) : 0;
      this.port.postMessage({
        type: "stats",
        active: active,
        peakActive: peakActive,
        samples: this.idMap.size,
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
        simpleVQ: simpleVQ,
        complexVQ: complexVQ,
        hasPerf: this.hasPerf ? 1 : 0,
        timerSource: this.timerSource,
        processMaxActive: this.statProcessMaxActive,
        processMaxMsgs: this.statProcessMaxMsgs,
        processOverrunMaxMs: this.statProcessOverrunMaxMs,
        procHist0: this.statProcHist[0],
        procHist1: this.statProcHist[1],
        procHist2: this.statProcHist[2],
        procHist3: this.statProcHist[3],
        procHist4: this.statProcHist[4],
        procHist5: this.statProcHist[5],
      });
    } catch (_) {}
  }

  async ensureWasm(wasmBytes) {
    if (this.ready) return;
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const e = instance.exports;
    this.exports = e;
    this.memory = e.memory;
    e.sc_init();
    e.sc_set_sample_rate(sampleRate);
    this.ready = true;
    this.postDebug(
      "wasm ready memPages=" + (e.memory.buffer.byteLength / 65536) +
      " sr=" + sampleRate + " timer=" + this.timerSource
    );
    const q = this.pending;
    this.pending = [];
    for (const m of q) this.handle(m);
  }

  onMessage(msg) {
    if (!msg || !msg.type) return;
    this.statMsgsQueued++;
    if (msg.type === "initWasm") {
      const bytes = msg.wasmBytes;
      if (!bytes || !bytes.byteLength) {
        this.postDebug("initWasm missing bytes");
        return;
      }
      this.ensureWasm(bytes).catch((err) => {
        this.postDebug("wasm init failed: " + err);
      });
      return;
    }
    if (msg.type === "setDebug") {
      this.debug = !!msg.enabled;
      if (this.debug) this.postStats();
      return;
    }
    if (msg.type === "requestStats") {
      if (this.ready) this.postStats();
      return;
    }
    if (!this.ready) {
      this.pending.push(msg);
      return;
    }
    this.handle(msg);
  }

  handle(msg) {
    const e = this.exports;
    switch (msg.type) {
      case "loadSample": {
        const len = msg.pcmL ? msg.pcmL.length : 0;
        if (!len) {
          this.postDebug("loadSample empty id=" + msg.sampleId);
          break;
        }
        const slot = this.mapSampleId(msg.sampleId);
        if (slot < 0) {
          this.postDebug("loadSample NO SLOT id=" + msg.sampleId);
          break;
        }
        const ptrL = e.sc_sample_alloc(len);
        if (!ptrL) {
          this.postDebug("loadSample ALLOC FAIL L id=" + msg.sampleId);
          break;
        }
        new Float32Array(this.memory.buffer, ptrL, len).set(msg.pcmL);
        let ptrR = 0;
        if (msg.pcmR && msg.pcmR.length === len) {
          ptrR = e.sc_sample_alloc(len);
          if (ptrR) {
            new Float32Array(this.memory.buffer, ptrR, len).set(msg.pcmR);
          } else {
            this.postDebug("loadSample ALLOC FAIL R id=" + msg.sampleId);
          }
        }
        const sr = (msg.sampleRate | 0) || (sampleRate | 0);
        const ok = e.sc_sample_register(
          slot, ptrL, ptrR, len, sr,
          msg.loop ? 1 : 0, msg.loopStart | 0, msg.loopEnd | 0,
        );
        this.sampleMeta.set(slot, { sampleRate: sr, length: len });
        this.statLoad++;
        this.postDebug(
          "loadSample id=" + msg.sampleId + " slot=" + slot +
          " len=" + len + " sr=" + sr + " reg=" + ok +
          " mapped=" + this.idMap.size
        );
        break;
      }
      case "noteOn": {
        const key = String(msg.sampleId);
        const slot = this.idMap.get(key);
        if (slot === undefined) {
          this.statMissing++;
          this.postDebug(
            "MISSING sampleId=" + msg.sampleId +
            " mapped=" + this.idMap.size
          );
          break;
        }
        const meta = this.sampleMeta.get(slot);
        let rate = +msg.playbackRate;
        if (!(rate > 0) || !isFinite(rate)) rate = 1;
        if (meta && meta.sampleRate > 0) {
          rate = rate * (meta.sampleRate / sampleRate);
        }
        const gain = isFinite(+msg.gain) ? +msg.gain : 0;
        const pan = isFinite(+msg.pan) ? +msg.pan : 0;
        const angle = (pan + 1) * 0.25 * Math.PI;
        const panL = Math.cos(angle);
        const panR = Math.sin(angle);
        const when0 = (msg.when != null && isFinite(+msg.when) && +msg.when > 0)
          ? +msg.when : currentTime;
        const startFrame = Math.max(currentFrame, Math.floor(when0 * sampleRate));
        const sustain = isFinite(+msg.sustain)
          ? Math.max(0, Math.min(1, +msg.sustain)) : 0.8;

        const filterFcCents = msg.filterFcCents != null
          ? +msg.filterFcCents : FULLY_OPEN_CENTS;
        const filterQ = Math.max(0.001, +msg.filterQ || 0.7071);
        const filterDcGain = msg.filterDcGain != null ? +msg.filterDcGain : 1;

        const delayModEnv = Math.max(0, +msg.delayModEnv || 0);
        const attackModEnv = Math.max(1e-5, +msg.attackModEnv || 1e-4);
        const holdModEnv = Math.max(0, +msg.holdModEnv || 0);
        const decayModEnv = Math.max(1e-5, +msg.decayModEnv || 1e-4);
        const sustainModEnv = Math.max(0, Math.min(1, +msg.sustainModEnv || 0));
        const releaseModEnv = Math.max(1e-5, +msg.releaseModEnv || 0.05);
        const modEnvToPitch = +msg.modEnvToPitch || 0;
        const modEnvToFilterFc = +msg.modEnvToFilterFc || 0;

        const delayModLFO = Math.max(0, +msg.delayModLFO || 0);
        const freqModLFO = Math.max(0, +msg.freqModLFO || 0);
        const modLfoToPitch = +msg.modLfoToPitch || 0;
        const modLfoToFilterFc = +msg.modLfoToFilterFc || 0;
        const modLfoToVolume = +msg.modLfoToVolume || 0;

        const delayVibLFO = Math.max(0, +msg.delayVibLFO || 0);
        const freqVibLFO = Math.max(0, +msg.freqVibLFO || 0);
        const vibLfoToPitch = +msg.vibLfoToPitch || 0;

        const vi = e.sc_voice_on(
          msg.voiceId | 0, slot, rate, gain, panL, panR,
          Math.max(0, +msg.delay || 0),
          Math.max(1e-5, +msg.attack || 0.005),
          Math.max(0, +msg.hold || 0),
          Math.max(1e-5, +msg.decay || 0.1),
          sustain,
          Math.max(1e-5, +msg.release || 0.2),
          startFrame,
          filterFcCents, filterQ, filterDcGain,
          delayModEnv, attackModEnv, holdModEnv, decayModEnv,
          sustainModEnv, releaseModEnv, modEnvToPitch, modEnvToFilterFc,
          delayModLFO, freqModLFO, modLfoToPitch, modLfoToFilterFc, modLfoToVolume,
          delayVibLFO, freqVibLFO, vibLfoToPitch,
        );
        this.statNoteOn++;
        if (vi < 0) {
          this.postDebug(
            "noteOn FAIL voice=" + msg.voiceId + " slot=" + slot +
            " rate=" + rate + " gain=" + gain
          );
        }
        break;
      }
      case "noteOff": {
        const when = +msg.when;
        const atFrame = (Number.isFinite(when) && when > 0)
          ? Math.floor(when * sampleRate) : 0;
        e.sc_voice_off(
          msg.voiceId | 0,
          msg.release != null ? Math.max(1e-5, +msg.release) : 0,
          atFrame,
        );
        this.statNoteOff++;
        break;
      }
      case "stop":
        e.sc_voice_stop(msg.voiceId | 0);
        this.statStop++;
        break;
      case "allSoundOff":
        e.sc_all_sound_off();
        break;
      case "setMasterGain":
        e.sc_set_master_gain(+msg.value || 0);
        this.masterGain = +msg.value || 0;
        break;
      case "setVoiceLimit":
      case "setVoiceParams":
        break;
      default:
        break;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const n = outL.length;
    for (let i = 0; i < n; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }
    if (!this.ready) return true;

    const e = this.exports;
    const nowFn = this._nowMs;
    const t0 = nowFn ? nowFn() : 0;
    const msgsThis = this.statMsgsQueued;
    this.statMsgsQueued = 0;

    e.sc_set_frame0(currentFrame);
    const frames = n > 128 ? 128 : n;
    e.sc_process(frames);

    const buf = e.memory.buffer;
    outL.set(new Float32Array(buf, e.sc_output_l(), frames));
    outR.set(new Float32Array(buf, e.sc_output_r(), frames));

    // voiceEnded notifications
    try {
      const ec = e.sc_ended_count();
      for (let i = 0; i < ec; i++) {
        const id = e.sc_ended_id(i);
        if (id >= 0) {
          this.statEnded++;
          this.port.postMessage({ type: "voiceEnded", voiceId: id });
        }
      }
    } catch (_) {}

    // ---- stats (same shape as pure-JS worklet) ----
    this.statQuantums++;
    const active = e.sc_active_voices() | 0;
    this.statActiveSum += active;
    if (active > this.peakActive) this.peakActive = active;

    if (nowFn) {
      const dt = nowFn() - t0;
      if (dt === dt && dt >= 0) {
        this.statProcessMs += dt;
        this.statProcessCount++;
        if (dt > this.statProcessMaxMs) {
          this.statProcessMaxMs = dt;
          this.statProcessMaxActive = active;
          this.statProcessMaxMsgs = msgsThis;
        }
        const hist = this.statProcHist;
        if (dt < 1) hist[0]++;
        else if (dt < 2) hist[1]++;
        else if (dt < 3) hist[2]++;
        else if (dt < 5) hist[3]++;
        else if (dt < 10) hist[4]++;
        else hist[5]++;
        const quantumMs = (typeof sampleRate === "number" && sampleRate > 0)
          ? (n / sampleRate) * 1000
          : 2.6667;
        if (dt > quantumMs * 1.05) {
          this.statProcessOverruns++;
          if (dt > this.statProcessOverrunMaxMs) {
            this.statProcessOverrunMaxMs = dt;
          }
        }
      }
    }

    return true;
  }
}

registerProcessor(NAME, MidySynthProcessor);
`;

function b64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function createWorkletModuleURL(): string {
  const blob = new Blob([WORKLET_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  return URL.createObjectURL(blob);
}

/**
 * Post WASM module bytes to the worklet after AudioWorkletNode is created.
 * Unified name used by worklet-backend (pure JS exports a no-op).
 */
export function postInitToWorklet(node: AudioWorkletNode): void {
  if (
    !SYNTH_CORE_WASM_BASE64 || SYNTH_CORE_WASM_BASE64.startsWith("PLACEHOLDER")
  ) {
    console.warn(
      "[midy-wasm] synth_core_wasm_b64.ts is placeholder — run wasm/scripts/embed_wasm.ts",
    );
    return;
  }
  const wasmBytes = b64ToBytes(SYNTH_CORE_WASM_BASE64);
  node.port.postMessage({ type: "initWasm", wasmBytes });
  console.info(
    "[midy-wasm] posted initWasm (" + wasmBytes.byteLength +
      " bytes) to worklet",
  );
}

/** @deprecated use postInitToWorklet */
export const postWasmToWorklet = postInitToWorklet;
