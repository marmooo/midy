// Runs INSIDE the headless browser page (loaded as a <script type="module">
// by tools/render-midy-headless.ts via Puppeteer). Real AudioContext /
// OfflineAudioContext / GainNode / BiquadFilterNode are all natively
// available here, unlike in Deno — that's the whole point of driving midy
// from a real browser instead of a Node/Deno Web Audio polyfill.
//
// Assumes the browser build of midy is at "../dist/midy.js" relative to
// this file. Adjust the import below if your build output path differs.
import { Midy } from "../dist/midy.js";

/**
 * @param {ArrayBuffer} audioBuffer
 * @returns {Uint8Array} bytes of a WAV file (PCM32 float, matches
 *   AudioBuffer's native Float32 samples 1:1 — no quantization).
 */
function encodeWavFloat32(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
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
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 3, true); // format = 3 (IEEE float)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(audioBuffer.getChannelData(ch));
  }
  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setFloat32(offset, channelData[ch][frame], true);
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

/**
 * @param {{
 *   midiBytesBase64: string,
 *   soundFontBytesBase64: string,
 *   cacheMode: "none"|"ads"|"adsr"|"note"|"segment"|"chunk"|"audio",
 *   sampleRate?: number,
 * }} params
 * @returns {Promise<string>} base64-encoded WAV bytes
 */
async function renderMidyMode(params) {
  const audioContext = new (globalThis.AudioContext ||
    globalThis.webkitAudioContext)({
    sampleRate: params.sampleRate ?? 48000,
  });

  const player = new Midy(audioContext);
  await player.loadSoundFont(bytesFromBase64(params.soundFontBytesBase64));
  player.cacheMode = params.cacheMode; // set before loadMIDI
  await player.loadMIDI(bytesFromBase64(params.midiBytesBase64));

  // "audio" mode renders automatically inside loadMIDI() when cacheMode was
  // already "audio" at load time; every other mode needs an explicit call.
  const rendered = player.renderedAudioBuffer ?? await player.render();
  if (!rendered) {
    throw new Error(
      `render() returned nothing for cacheMode=${params.cacheMode}`,
    );
  }
  const wavBytes = encodeWavFloat32(rendered);
  return base64FromBytes(wavBytes);
}

// Exposed for Puppeteer's page.evaluate() to call by name.
globalThis.__renderMidyMode = renderMidyMode;
