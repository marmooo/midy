// Unit tests for maxAdsBakeDuration (ADS bake length cap).
//
// Guards the regression where long SF2 decay either:
//   (a) produced multi-10s ADS PCM bakes (CPU/memory blow-up), or
//   (b) fell back to a raw AudioBuffer while staying on the ADS lean graph
//       (pitch not applied → broken intervals).
//
// Cap keeps a pitch-baked RenderedBuffer and compresses decay so the
// envelope still reaches sustain inside the buffer.
//
// Usage:
//   deno test -A tests/ads-bake-cap_test.ts

import {
  assertAlmostEquals,
  assertEquals,
  makeDefaultVoiceParams,
} from "./mock-shared.ts";
import { Player } from "../src/player.ts";
import { RenderedBuffer } from "../src/base-player.ts";
import type { VoiceParams } from "../src/base-player.ts";
import type { Note } from "../src/base-player.ts";

function makePlayer(): Player {
  const ctx = new AudioContext();
  return new Player(ctx);
}

/** Minimal note stub for createAdsRenderedBuffer. */
function makeNote(noteNumber = 60): Note {
  return {
    noteNumber,
    velocity: 100,
    startTime: 0,
    pressure: 0,
  } as unknown as Note;
}

/**
 * Mono PCM buffer (1s of a soft sine) so renderSampleTypedArray has data.
 * Sample rate matches the player context when possible.
 */
function makeSrcBuffer(
  player: Player,
  durationSec = 1,
  sampleRate = 44100,
): AudioBuffer {
  const ctx = player.audioContext;
  const length = Math.max(1, Math.ceil(durationSec * sampleRate));
  // Prefer context factory; fall back to global AudioBuffer mock.
  const buf = typeof ctx.createBuffer === "function"
    ? ctx.createBuffer(1, length, sampleRate)
    : new AudioBuffer({ length, numberOfChannels: 1, sampleRate });
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return buf;
}

function vp(overrides: Partial<VoiceParams> = {}): VoiceParams {
  return Object.assign(
    makeDefaultVoiceParams(0),
    {
      // Fully open filter → no biquad path (faster, less mock surface).
      initialFilterFc: 20000,
      initialFilterQ: 0,
      modEnvToFilterFc: 0,
      sampleModes: 1, // loop
      loopStart: 0,
      loopEnd: 22050, // 0.5s at 44.1k
    },
    overrides,
  ) as unknown as VoiceParams;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("ads-bake-cap: computeAdsDuration = delay+attack+hold+decay", () => {
  const player = makePlayer();
  const params = vp({
    delayVolEnv: 0.1,
    attackVolEnv: 0.2,
    holdVolEnv: 0.3,
    decayVolEnv: 0.4,
  });
  assertAlmostEquals(player.computeAdsDuration(params), 1.0, 1e-9);
});

Deno.test("ads-bake-cap: shouldCapAdsBake respects threshold and 0=disabled", () => {
  const player = makePlayer();
  player.maxAdsBakeDuration = 4;
  const short = vp({
    delayVolEnv: 0,
    attackVolEnv: 0.01,
    holdVolEnv: 0.01,
    decayVolEnv: 0.1,
  });
  const long = vp({
    delayVolEnv: 0,
    attackVolEnv: 0.001,
    holdVolEnv: 0.001,
    decayVolEnv: 25,
  });
  assertEquals(player.shouldCapAdsBake(short), false);
  assertEquals(player.shouldCapAdsBake(long), true);

  player.maxAdsBakeDuration = 0;
  assertEquals(player.shouldCapAdsBake(long), false, "0 disables cap");
});

// ---------------------------------------------------------------------------
// createAdsRenderedBuffer: length / meta / pitch path
// ---------------------------------------------------------------------------

Deno.test("ads-bake-cap: short ADS is not capped (adsDuration preserved)", () => {
  const player = makePlayer();
  player.maxAdsBakeDuration = 4;
  player.debug = false;
  const params = vp({
    delayVolEnv: 0,
    attackVolEnv: 0.01,
    holdVolEnv: 0.01,
    decayVolEnv: 0.5,
  });
  const natural = player.computeAdsDuration(params);
  assertEquals(natural < 4, true);

  const src = makeSrcBuffer(player);
  const rendered = player.createAdsRenderedBuffer(
    { programNumber: 0 } as Parameters<Player["createAdsRenderedBuffer"]>[0],
    makeNote(60),
    params,
    src,
    false,
  );

  assertEquals(rendered instanceof RenderedBuffer, true);
  assertEquals(rendered.isFull, false);
  assertEquals(rendered.adsDuration != null, true);
  assertAlmostEquals(rendered.adsDuration!, natural, 1e-6);
  // Buffer must be long enough to cover ADS (loop alignment may add a bit).
  const bufSec = rendered.buffer.duration;
  assertEquals(
    bufSec + 1e-3 >= natural,
    true,
    `buffer ${bufSec}s should cover ads ${natural}s`,
  );
});

Deno.test("ads-bake-cap: extreme decay is capped to maxAdsBakeDuration", () => {
  const player = makePlayer();
  player.maxAdsBakeDuration = 4;
  player.debug = false;
  const params = vp({
    delayVolEnv: 0,
    attackVolEnv: 0.001,
    holdVolEnv: 0.001,
    decayVolEnv: 25.0, // same class of SF2 outliers as production logs
  });
  const natural = player.computeAdsDuration(params);
  assertEquals(natural > 20, true);

  const src = makeSrcBuffer(player);
  const rendered = player.createAdsRenderedBuffer(
    { programNumber: 0 } as Parameters<Player["createAdsRenderedBuffer"]>[0],
    makeNote(46),
    params,
    src,
    false,
  );

  assertEquals(rendered instanceof RenderedBuffer, true);
  assertEquals(rendered.isFull, false);
  // Meta adsDuration is the capped value.
  assertAlmostEquals(rendered.adsDuration!, 4, 1e-6);
  // Output PCM must stay bounded (loop align ≤ one extra loop period).
  const bufSec = rendered.buffer.duration;
  assertEquals(
    bufSec < 6,
    true,
    `capped bake must stay near 4s, got ${bufSec}s (natural was ${natural}s)`,
  );
  assertEquals(
    bufSec >= 3.5,
    true,
    `capped bake should still reach ~cap, got ${bufSec}s`,
  );
});

Deno.test("ads-bake-cap: maxAdsBakeDuration=0 keeps full extreme decay length", () => {
  const player = makePlayer();
  player.maxAdsBakeDuration = 0; // legacy: no cap
  player.debug = false;
  const params = vp({
    delayVolEnv: 0,
    attackVolEnv: 0.001,
    holdVolEnv: 0.001,
    decayVolEnv: 8.0,
  });
  const natural = player.computeAdsDuration(params);

  const src = makeSrcBuffer(player);
  const rendered = player.createAdsRenderedBuffer(
    { programNumber: 0 } as Parameters<Player["createAdsRenderedBuffer"]>[0],
    makeNote(60),
    params,
    src,
    false,
  );

  assertAlmostEquals(rendered.adsDuration!, natural, 1e-6);
  // Uncapped: buffer tracks the long ADS (loop-aligned).
  assertEquals(
    rendered.buffer.duration >= natural - 0.05,
    true,
    `uncapped buffer ${rendered.buffer.duration}s < natural ${natural}s`,
  );
});

Deno.test("ads-bake-cap: different noteNumbers bake different pitch (playbackRate)", () => {
  const player = makePlayer();
  player.maxAdsBakeDuration = 4;
  player.debug = false;

  // Two notes sharing a long-decay instrument: both get capped, both stay
  // RenderedBuffer with pitch baked via voiceParams.playbackRate.
  const base = {
    delayVolEnv: 0,
    attackVolEnv: 0.001,
    holdVolEnv: 0.001,
    decayVolEnv: 20.0,
  };
  // +12 semitones ≈ 2× rate
  const low = vp({ ...base, playbackRate: 1.0 });
  const high = vp({ ...base, playbackRate: 2.0 });
  const src = makeSrcBuffer(player, 0.5);

  const rbLow = player.createAdsRenderedBuffer(
    { programNumber: 0 } as Parameters<Player["createAdsRenderedBuffer"]>[0],
    makeNote(48),
    low,
    src,
    false,
  );
  const rbHigh = player.createAdsRenderedBuffer(
    { programNumber: 0 } as Parameters<Player["createAdsRenderedBuffer"]>[0],
    makeNote(60),
    high,
    src,
    false,
  );

  // Both capped
  assertAlmostEquals(rbLow.adsDuration!, 4, 1e-6);
  assertAlmostEquals(rbHigh.adsDuration!, 4, 1e-6);

  // Pitch is in the PCM: zero-crossing density / energy layout should differ.
  // Compare a short window of absolute sample sums — rates 1× vs 2× must not
  // produce identical waveforms when the source is a sine.
  const a = rbLow.buffer.getChannelData(0);
  const b = rbHigh.buffer.getChannelData(0);
  const n = Math.min(a.length, b.length, 4096);
  let diff = 0;
  for (let i = 0; i < n; i++) {
    diff += Math.abs(a[i] - b[i]);
  }
  assertEquals(
    diff > 1e-3,
    true,
    `expected pitched PCM to differ for rate 1 vs 2 (diff=${diff})`,
  );
});

Deno.test("ads-bake-cap: capped buffer is never a raw AudioBuffer", () => {
  const player = makePlayer();
  player.maxAdsBakeDuration = 2;
  const params = vp({
    delayVolEnv: 0,
    attackVolEnv: 0.001,
    holdVolEnv: 0.001,
    decayVolEnv: 30,
  });
  const src = makeSrcBuffer(player);
  const rendered = player.createAdsRenderedBuffer(
    { programNumber: 0 } as Parameters<Player["createAdsRenderedBuffer"]>[0],
    makeNote(53),
    params,
    src,
    false,
  );
  // Regression: must stay RenderedBuffer so setNoteAudioNode uses the ADS
  // lean path with pitch already in PCM (not the raw-buffer mis-branch).
  assertEquals(rendered instanceof RenderedBuffer, true);
  assertEquals(rendered.isFull, false);
  assertEquals(typeof rendered.adsDuration, "number");
});

Deno.test("ads-bake-cap: useRealtimeEnvelope only for none or raw buffers", () => {
  // Document the setNoteAudioNode contract: lean ADS path requires
  // RenderedBuffer; raw AudioBuffer must take the realtime envelope path.
  // (Logic is inline in setNoteAudioNode; mirror it here as a lock.)
  const cacheModeNone = "none";
  const cacheModeAds = "ads";
  const isRenderedTrue = true;
  const isRenderedFalse = false;

  const useRt = (mode: string, isRendered: boolean) =>
    mode === "none" || !isRendered;

  assertEquals(useRt(cacheModeNone, isRenderedTrue), true);
  assertEquals(useRt(cacheModeNone, isRenderedFalse), true);
  assertEquals(
    useRt(cacheModeAds, isRenderedTrue),
    false,
    "ADS + Rendered → lean",
  );
  assertEquals(
    useRt(cacheModeAds, isRenderedFalse),
    true,
    "ADS + raw → realtime (pitch safety)",
  );
  assertEquals(useRt("chunk", isRenderedTrue), false);
  assertEquals(useRt("chunk", isRenderedFalse), true);
  assertEquals(useRt("segment", isRenderedFalse), true);
});
