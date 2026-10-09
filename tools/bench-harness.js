// Realtime playback harness for main-thread load benchmarking.
// Loaded inside headless Chromium by tools/bench-main-load.ts.
//
// Unlike midy-harness.js (offline render → WAV), this path calls
// player.start() so liveRealtime / updateChunkPipeline / worker mix paths
// actually run — the same code paths as interactive browser playback.
import { Midy } from "../dist/midy.js";

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Coerce a JSON-ish value onto a player property.
 * Booleans/numbers/strings/null are assigned as-is.
 */
function applySettings(player, settings) {
  if (!settings || typeof settings !== "object") return;
  const applied = {};
  const skipped = [];
  for (const [key, value] of Object.entries(settings)) {
    try {
      // Always attempt assignment — Midy has many public knobs.
      player[key] = value;
      applied[key] = player[key];
      console.log(`[bench] set ${key}=${JSON.stringify(player[key])}`);
    } catch (err) {
      skipped.push(key);
      console.warn(`[bench] failed to set ${key}: ${err}`);
    }
  }
  return { applied, skipped };
}

/**
 * @param {{
 *   midiBytesBase64: string,
 *   soundFontBytesBase64: string,
 *   sampleRate?: number,
 *   settings?: Record<string, unknown>,
 *   maxPlaySec?: number,
 * }} params
 * @returns {Promise<{
 *   totalTime: number,
 *   elapsedMs: number,
 *   applied: Record<string, unknown>,
 *   skipped: string[],
 *   cacheMode: string,
 * }>}
 */
async function benchMainLoad(params) {
  const sampleRate = params.sampleRate ?? 48000;
  const audioContext = new (globalThis.AudioContext ||
    globalThis.webkitAudioContext)({ sampleRate });

  // Headless Chrome sometimes starts suspended.
  try {
    await audioContext.resume();
  } catch {
    // ignore
  }

  const player = new Midy(audioContext);

  // Defaults useful for bench; user settings override afterwards.
  player.debug = true;
  if (typeof player.cacheMode !== "undefined") {
    player.cacheMode = "chunk";
  }

  await player.loadSoundFont(bytesFromBase64(params.soundFontBytesBase64));

  const { applied, skipped } = applySettings(player, params.settings) ?? {
    applied: {},
    skipped: [],
  };

  // Ensure debug stays on unless the user explicitly turned it off.
  if (params.settings?.debug === undefined) {
    player.debug = true;
  }

  await player.loadMIDI(bytesFromBase64(params.midiBytesBase64));

  const totalTime = typeof player.totalTime === "number" ? player.totalTime : 0;
  console.log(
    `[bench] start play totalTime=${totalTime.toFixed(2)}s ` +
      `cacheMode=${player.cacheMode} sampleRate=${sampleRate}`,
  );

  const t0 = performance.now();
  const maxPlaySec = params.maxPlaySec ??
    (totalTime > 0 ? totalTime + 5 : 120);

  // start() resolves when playback ends (see Player.start → playNotes).
  // Guard with a timeout so a stuck pipeline cannot hang the batch forever.
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    console.warn(
      `[bench] play timeout after ${maxPlaySec}s — calling stop()`,
    );
    try {
      player.stop?.();
    } catch {
      // ignore
    }
  }, maxPlaySec * 1000);

  try {
    await player.start({ preload: true });
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsedMs = performance.now() - t0;
  console.log(
    `[bench] play finished elapsedMs=${elapsedMs.toFixed(0)} ` +
      `timedOut=${timedOut} totalTime=${totalTime.toFixed(2)}s`,
  );

  try {
    await audioContext.close();
  } catch {
    // ignore
  }

  return {
    totalTime,
    elapsedMs,
    timedOut,
    applied,
    skipped,
    cacheMode: String(player.cacheMode ?? ""),
  };
}

globalThis.__benchMainLoad = benchMainLoad;
