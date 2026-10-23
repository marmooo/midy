// Browser-side harness for worklet cacheMode quality captures.
//
// Unlike midy-harness.js (Offline-style player.render()), worklet mode needs
// a real AudioContext + AudioWorklet. This module plays in realtime and
// captures PCM via a tiny recorder AudioWorklet, then returns WAV base64.
//
// Loaded by tools/worklet-harness.html. Exposed as globalThis.__renderMidyWorklet.

import { Midy } from "../dist/midy.js";

function encodeWavFloat32FromChannels(channelData, sampleRate) {
  const numChannels = channelData.length;
  const numFrames = channelData[0]?.length ?? 0;
  const bytesPerSample = 4;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setFloat32(offset, channelData[ch][frame] ?? 0, true);
      offset += 4;
    }
  }
  return new Uint8Array(buffer);
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const CAPTURE_PROCESSOR_SOURCE = `
class MidyCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const chs = [];
      const transfer = [];
      for (let c = 0; c < input.length; c++) {
        const copy = new Float32Array(input[c]);
        chs.push(copy);
        transfer.push(copy.buffer);
      }
      this.port.postMessage({ type: "block", chs }, transfer);
    }
    // Keep running even with silence so we cover full duration.
    return true;
  }
}
registerProcessor("midy-pcm-capture", MidyCaptureProcessor);
`;

/**
 * Realtime worklet render → WAV (float32).
 * @param {{
 *   midiBytesBase64: string,
 *   soundFontBytesBase64: string,
 *   sampleRate?: number,
 *   tailSec?: number,
 * }} params
 */
async function renderMidyWorklet(params) {
  const sampleRate = params.sampleRate ?? 48000;
  const tailSec = params.tailSec ?? 0.4;

  if (!globalThis.AudioWorkletNode) {
    throw new Error("AudioWorkletNode is not available in this browser");
  }

  const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)({
    sampleRate,
  });
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  // Install capture processor
  const blob = new Blob([CAPTURE_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  const moduleURL = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(moduleURL);
  } finally {
    URL.revokeObjectURL(moduleURL);
  }

  const player = new Midy(ctx);
  player.cacheMode = "worklet";
  await player.loadSoundFont(bytesFromBase64(params.soundFontBytesBase64));
  await player.loadMIDI(bytesFromBase64(params.midiBytesBase64));

  const capturer = new AudioWorkletNode(ctx, "midy-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  /** @type {Float32Array[]} */
  const leftBlocks = [];
  /** @type {Float32Array[]} */
  const rightBlocks = [];
  capturer.port.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "block" || !msg.chs) return;
    leftBlocks.push(msg.chs[0]);
    rightBlocks.push(msg.chs[1] ?? msg.chs[0]);
  };

  // Route dry (+ post-stage FX already into masterVolume) through capturer.
  try {
    player.masterVolume.disconnect();
  } catch {
    // ignore
  }
  player.masterVolume.connect(capturer);
  capturer.connect(ctx.destination);

  // Song length in seconds (timeline is in beats-scaled startTime units).
  const songSec = typeof player.totalTime === "number" && player.totalTime > 0
    ? player.totalTime / (player.tempo || 1)
    : 2.0;
  const captureSec = songSec + tailSec;

  await player.start();
  await new Promise((r) => setTimeout(r, Math.ceil(captureSec * 1000) + 50));
  try {
    await player.stop();
  } catch {
    // ignore
  }

  // Small drain for last blocks
  await new Promise((r) => setTimeout(r, 80));

  // Concatenate blocks
  let total = 0;
  for (const b of leftBlocks) total += b.length;
  if (total === 0) {
    try {
      await ctx.close();
    } catch { /* ignore */ }
    throw new Error("worklet capture produced 0 samples (silent or no process callbacks)");
  }

  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let o = 0;
  for (let i = 0; i < leftBlocks.length; i++) {
    left.set(leftBlocks[i], o);
    right.set(rightBlocks[i], o);
    o += leftBlocks[i].length;
  }

  const wavBytes = encodeWavFloat32FromChannels([left, right], sampleRate);

  try {
    capturer.disconnect();
    player.masterVolume.disconnect();
  } catch { /* ignore */ }
  try {
    await ctx.close();
  } catch { /* ignore */ }

  return {
    wavBase64: base64FromBytes(wavBytes),
    cacheMode: "worklet",
    sampleRate,
    frames: total,
    captureSec,
  };
}

globalThis.__renderMidyWorklet = renderMidyWorklet;
