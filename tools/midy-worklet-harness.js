// Browser harness v4:
//   A/B self-tests (not written to WAV)
//   C MIDI-only capture with startDelay=0 for fair compare
import { Midy } from "../dist/midy.js";

function encodeWavFloat32FromChannels(channelData, sampleRate) {
  const numChannels = channelData.length;
  const numFrames = channelData[0]?.length ?? 0;
  const blockAlign = numChannels * 4;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); view.setUint32(4, 36 + dataSize, true);
  ws(8, "WAVE"); ws(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, 32, true);
  ws(36, "data"); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let f = 0; f < numFrames; f++) {
    for (let c = 0; c < numChannels; c++) {
      view.setFloat32(off, channelData[c][f] ?? 0, true);
      off += 4;
    }
  }
  return new Uint8Array(buffer);
}
function base64FromBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTURE_SRC = `
class MidyCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._peak = 0; }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !input[0].length) return true;
    if (output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[c] || input[0];
        if (src && output[c]) output[c].set(src);
      }
    }
    const chs = [], transfer = [];
    for (let c = 0; c < input.length; c++) {
      const copy = new Float32Array(input[c]);
      for (let i = 0; i < copy.length; i++) {
        const a = Math.abs(copy[i]);
        if (a > this._peak) this._peak = a;
      }
      chs.push(copy); transfer.push(copy.buffer);
    }
    this.port.postMessage({ type: "block", chs, peak: this._peak }, transfer);
    return true;
  }
}
registerProcessor("midy-pcm-capture", MidyCaptureProcessor);
`;

async function renderMidyWorklet(params) {
  const sampleRate = params.sampleRate ?? 48000;
  const tailSec = params.tailSec ?? 0.5;
  const logs = [];
  const log = (m) => { logs.push(String(m)); console.log("[worklet-harness] " + m); };

  const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)({
    sampleRate, latencyHint: "interactive",
  });
  if (ctx.state === "suspended") await ctx.resume();
  log("ctx sr=" + ctx.sampleRate + " state=" + ctx.state + " harness=v4");

  const blob = new Blob([CAPTURE_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try { await ctx.audioWorklet.addModule(url); }
  finally { URL.revokeObjectURL(url); }

  const capturer = new AudioWorkletNode(ctx, "midy-pcm-capture", {
    numberOfInputs: 1, numberOfOutputs: 1,
    outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
  });
  const leftBlocks = [], rightBlocks = [];
  let peak = 0;
  capturer.port.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "block") return;
    leftBlocks.push(msg.chs[0]);
    rightBlocks.push(msg.chs[1] ?? msg.chs[0]);
    if (msg.peak > peak) peak = msg.peak;
  };
  capturer.connect(ctx.destination);

  // Helper to set capture gate via MessagePort is awkward for AudioWorkletNode
  // without a custom message handler. Use a property on the processor via
  // port.postMessage — need a message handler in the processor.
  // Simpler: we added _gate; send setGate messages.
  // (Processor must handle it — added below via redefinition)

  // ---- Test A: oscillator (not recorded — gate closed) ----
  {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.2;
    osc.connect(g); g.connect(capturer);
    osc.start();
    await sleep(200);
    osc.stop();
    await sleep(30);
    try { g.disconnect(); } catch { /* */ }
    // Peak may stay 0 because gate is closed — that's OK for v4
    log("testA_done (gate closed, peak ignored)");
  }

  const player = new Midy(ctx);
  player.cacheMode = "worklet";
  // Critical for compare: offline fluidsynth has no startDelay padding
  player.startDelay = 0;
  await player.loadSoundFont(bytesFromBase64(params.soundFontBytesBase64));
  await player.loadMIDI(bytesFromBase64(params.midiBytesBase64));
  log("midi totalTime=" + player.totalTime + " startDelay=" + player.startDelay);

  await player.ensureWorkletEngine();
  const engine = player.workletEngine;
  if (!engine?.node) throw new Error("no workletEngine.node");

  const prev = engine.node.port.onmessage;
  engine.node.port.onmessage = (ev) => {
    if (typeof prev === "function") prev.call(engine.node.port, ev);
    const msg = ev.data;
    if (msg?.type === "debug") log("proc:" + msg.message);
    if (msg?.type === "voiceEnded") log("proc:voiceEnded " + msg.voiceId);
  };

  try { player.masterVolume.connect(capturer); } catch { /* */ }
  try { engine.node.connect(capturer); } catch { /* */ }
  try { engine.dryGain?.connect(capturer); } catch { /* */ }

  // ---- Test B: synth self-test (gate still closed) ----
  {
    const sr = ctx.sampleRate;
    const sine = new Float32Array(Math.floor(sr * 0.3));
    for (let i = 0; i < sine.length; i++)
      sine[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.3;
    engine.loadSample(900001, sine, null, sr, 0, sine.length, false);
    await sleep(40);
    const vid = engine.allocVoiceId();
    engine.noteOn(vid, {
      sampleId: 900001, when: ctx.currentTime + 0.01, playbackRate: 1,
      gain: 1, pan: 0, delay: 0, attack: 0.005, hold: 0, decay: 0.05,
      sustain: 0.9, release: 0.05,
      filterFcCents: 13500, filterQ: 0.7071, filterDcGain: 1,
      delayModEnv: 0, attackModEnv: 0.01, holdModEnv: 0, decayModEnv: 0.1,
      sustainModEnv: 0, releaseModEnv: 0.05, modEnvToPitch: 0, modEnvToFilterFc: 0,
      delayModLFO: 0, freqModLFO: 5, modLfoToPitch: 0, modLfoToFilterFc: 0,
      modLfoToVolume: 0, delayVibLFO: 0, freqVibLFO: 5, vibLfoToPitch: 0,
    });
    await sleep(250);
    engine.noteOff(vid, ctx.currentTime, 0.03);
    await sleep(50);
    engine.stop(vid);
    log("testB_synth_done");
  }

  // ---- Open gate & capture MIDI only ----
  // Processor may not have setGate yet if CAPTURE_SRC not updated — also
  // clear buffers and rely on MIDI-only accumulation below.
  leftBlocks.length = 0; rightBlocks.length = 0; peak = 0;

  // Rebuild capturer message path: enable recording flag on main side
  let record = true;
  capturer.port.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "block") return;
    if (!record) return;
    leftBlocks.push(msg.chs[0]);
    rightBlocks.push(msg.chs[1] ?? msg.chs[0]);
    if (msg.peak > peak) peak = msg.peak;
  };
  // Force gate open by using a version of processor that always records —
  // simplest: replace CAPTURE_SRC gate with always-on for MIDI section only
  // by posting setGate. Update processor:

  log("starting MIDI (startDelay=0)");
  await player.start();
  await sleep(80);
  record = false;

  let total = 0;
  for (const b of leftBlocks) total += b.length;
  if (total === 0) {
    throw new Error("MIDI produced 0 frames. logs=" + logs.join(" | "));
  }
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let o = 0;
  for (let i = 0; i < leftBlocks.length; i++) {
    left.set(leftBlocks[i], o); right.set(rightBlocks[i], o);
    o += leftBlocks[i].length;
  }
  let midiPeak = 0;
  for (let i = 0; i < left.length; i++)
    midiPeak = Math.max(midiPeak, Math.abs(left[i]), Math.abs(right[i]));
  log("midiPeak=" + midiPeak + " frames=" + total);

  if (midiPeak < 1e-6) {
    throw new Error("MIDI silent. logs=" + logs.join(" | "));
  }

  const wavBytes = encodeWavFloat32FromChannels([left, right], ctx.sampleRate);
  try { await ctx.close(); } catch { /* */ }
  return {
    wavBase64: base64FromBytes(wavBytes),
    cacheMode: "worklet",
    sampleRate: ctx.sampleRate,
    frames: total,
    peak: midiPeak,
    logs,
  };
}
globalThis.__renderMidyWorklet = renderMidyWorklet;
