// Minimum checks for worklet cacheMode (Phase 2 synth + post-stage FX sends).
//
// These tests intentionally avoid requiring a real AudioWorklet runtime
// (npm:web-audio-api does not implement audioWorklet). They guard:
//   - protocol / registration constants
//   - cacheMode recognition
//   - processor source contains Phase-2 feature markers
//   - WorkletEngine bookkeeping (voice ids, samples, effect send maps)
//   - OfflineAudioContext rejection for ensureWorkletEngine

import "./mock-shared.ts";
import {
  assertEquals,
  assertNotEquals,
} from "./mock-shared.ts";
import { assert, assertRejects } from "@std/assert";

import {
  MIDY_WORKLET_NAME,
  WORKLET_MAX_VOICES,
  type WorkletNoteOnMsg,
  type WorkletSetVoiceParamsMsg,
} from "../src/worklet-protocol.ts";
import {
  createWorkletModuleURL,
  WORKLET_PROCESSOR_SOURCE,
} from "../src/worklet-processor.ts";
import { WorkletEngine } from "../src/worklet-engine.ts";
import {
  isWorkletCacheMode,
  type CacheMode,
} from "../src/cache-strategy.ts";
import { MidyGMLite } from "../src/midy-GMLite.ts";
import { OfflineAudioContext as WebOfflineAudioContext } from "web-audio-api";

// ---------------------------------------------------------------------------
// Protocol / registration
// ---------------------------------------------------------------------------

Deno.test("worklet protocol: processor name and voice limit", () => {
  assertEquals(MIDY_WORKLET_NAME, "midy-synth-processor");
  assertEquals(WORKLET_MAX_VOICES, 64);
  assert(WORKLET_MAX_VOICES > 0);
});

Deno.test("worklet protocol: noteOn message shape (Phase 2 fields)", () => {
  // Compile-time + runtime presence of required Phase-2 keys.
  const msg: WorkletNoteOnMsg = {
    type: "noteOn",
    voiceId: 1,
    sampleId: 10,
    when: 0,
    playbackRate: 1,
    gain: 0.5,
    pan: 0,
    delay: 0,
    attack: 0.01,
    hold: 0,
    decay: 0.1,
    sustain: 0.7,
    release: 0.2,
    filterFcCents: 13500,
    filterQ: 0.7071,
    filterDcGain: 1,
    delayModEnv: 0,
    attackModEnv: 0.01,
    holdModEnv: 0,
    decayModEnv: 0.1,
    sustainModEnv: 0,
    releaseModEnv: 0.2,
    modEnvToPitch: 0,
    modEnvToFilterFc: 0,
    delayModLFO: 0,
    freqModLFO: 5,
    modLfoToPitch: 0,
    modLfoToFilterFc: 0,
    modLfoToVolume: 0,
    delayVibLFO: 0,
    freqVibLFO: 5,
    vibLfoToPitch: 0,
  };
  assertEquals(msg.type, "noteOn");
  assertEquals(typeof msg.filterFcCents, "number");
  assertEquals(typeof msg.modLfoToPitch, "number");
  assertEquals(typeof msg.modEnvToFilterFc, "number");
  assertEquals(typeof msg.vibLfoToPitch, "number");
});

Deno.test("worklet protocol: setVoiceParams message shape", () => {
  const msg: WorkletSetVoiceParamsMsg = {
    type: "setVoiceParams",
    voiceId: 3,
    gain: 0.25,
    pan: -0.5,
    playbackRate: 1.01,
  };
  assertEquals(msg.type, "setVoiceParams");
  assertEquals(msg.voiceId, 3);
});

// ---------------------------------------------------------------------------
// cacheMode
// ---------------------------------------------------------------------------

Deno.test("cache-strategy: isWorkletCacheMode", () => {
  assertEquals(isWorkletCacheMode("worklet"), true);
  const others: CacheMode[] = [
    "none",
    "ads",
    "adsr",
    "note",
    "segment",
    "chunk",
    "audio",
  ];
  for (const m of others) {
    assertEquals(isWorkletCacheMode(m), false);
  }
});

// ---------------------------------------------------------------------------
// Processor source (Blob module) feature markers
// ---------------------------------------------------------------------------

Deno.test("worklet processor source: Phase-2 feature markers present", () => {
  const src = WORKLET_PROCESSOR_SOURCE;
  // Registration
  assert(src.includes("midy-synth-processor"), "processor name");
  assert(src.includes("registerProcessor"), "registerProcessor");
  // Volume envelope stages
  assert(src.includes("ENV_ATTACK"), "vol env");
  // Filter
  assert(src.includes("filterFcCents") || src.includes("filterQ"), "filter");
  assert(src.includes("lowpassCoeffs") || src.includes("processFilter"), "biquad");
  // LFO
  assert(src.includes("modLfo") || src.includes("modLfoPhase"), "mod LFO");
  assert(src.includes("vibLfo") || src.includes("vibLfoPhase"), "vib LFO");
  // Mod envelope
  assert(src.includes("modEnv") || src.includes("modStage"), "mod env");
  // Dynamic voice params
  assert(src.includes("setVoiceParams"), "setVoiceParams handler");
  // Message types
  assert(src.includes("noteOn"), "noteOn");
  assert(src.includes("noteOff"), "noteOff");
  assert(src.includes("loadSample"), "loadSample");
  assert(src.includes("allSoundOff"), "allSoundOff");
});

Deno.test("worklet processor: createWorkletModuleURL returns blob URL", () => {
  const url = createWorkletModuleURL();
  assert(typeof url === "string");
  assert(url.startsWith("blob:") || url.startsWith("data:"), `url=${url}`);
  try {
    URL.revokeObjectURL(url);
  } catch {
    // data: URLs need no revoke
  }
});

// ---------------------------------------------------------------------------
// WorkletEngine bookkeeping (no AudioWorklet required)
// ---------------------------------------------------------------------------

Deno.test("WorkletEngine: allocVoiceId is unique and wraps safely", () => {
  const ctx = new AudioContext();
  const engine = new WorkletEngine(ctx as unknown as AudioContext);
  const ids = new Set<number>();
  for (let i = 0; i < 100; i++) {
    const id = engine.allocVoiceId();
    assert(id > 0);
    assertEquals(ids.has(id), false, `duplicate voiceId ${id}`);
    ids.add(id);
  }
  assertEquals(ids.size, 100);
  // Force wrap path
  (engine as unknown as { nextVoiceId: number }).nextVoiceId = 0x7fffffff;
  const a = engine.allocVoiceId();
  const b = engine.allocVoiceId();
  assertEquals(a, 0x7fffffff);
  assertEquals(b, 1);
  engine.dispose();
  try {
    (ctx as unknown as { close(): Promise<void> }).close();
  } catch { /* ignore */ }
});

Deno.test("WorkletEngine: hasSample / loadSample bookkeeping without node", () => {
  const ctx = new AudioContext();
  const engine = new WorkletEngine(ctx as unknown as AudioContext);
  assertEquals(engine.hasSample(42), false);
  // loadSample posts only when node exists; still marks loaded set.
  const pcm = new Float32Array(64);
  for (let i = 0; i < 64; i++) pcm[i] = Math.sin(i / 8);
  engine.loadSample(42, pcm, null, 44100, 0, 64, false);
  // Without node, post is a no-op but local set should update.
  assertEquals(engine.hasSample(42), true);
  assertEquals(engine.hasSample(99), false);
  engine.dispose();
  assertEquals(engine.hasSample(42), false);
  try {
    (ctx as unknown as { close(): Promise<void> }).close();
  } catch { /* ignore */ }
});

Deno.test("WorkletEngine: effect send maps update and clear without node", () => {
  const ctx = new AudioContext();
  const engine = new WorkletEngine(ctx as unknown as AudioContext);

  // Should not throw when send gains are not yet created.
  engine.setVoiceEffectSends(1, { reverb: 0.5, chorus: 0.25, delay: 0.1 });
  engine.setVoiceEffectSends(2, { reverb: 0.8, chorus: 0.1, delay: 0 });
  engine.setVoiceEffectSends(3, { reverb: 0.2 });

  const reverb = (engine as unknown as {
    voiceReverb: Map<number, number>;
  }).voiceReverb;
  const chorus = (engine as unknown as {
    voiceChorus: Map<number, number>;
  }).voiceChorus;
  const delay = (engine as unknown as {
    voiceDelay: Map<number, number>;
  }).voiceDelay;

  assertEquals(reverb.get(1), 0.5);
  assertEquals(reverb.get(2), 0.8);
  assertEquals(chorus.get(1), 0.25);
  // delay 0 removes entry
  assertEquals(delay.has(2), false);
  assertEquals(delay.get(1), 0.1);

  // Max aggregation helper
  const maxMap = (engine as unknown as {
    maxMap: (m: Map<number, number>) => number;
  }).maxMap.bind(engine);
  assertEquals(maxMap(reverb), 0.8);
  assertEquals(maxMap(chorus), 0.25);

  engine.stop(1); // clears sends for voice 1 (post is no-op without node)
  assertEquals(reverb.has(1), false);
  assertEquals(chorus.has(1), false);

  engine.allSoundOff();
  assertEquals(reverb.size, 0);
  assertEquals(chorus.size, 0);
  assertEquals(delay.size, 0);
  assertEquals(engine.activeVoiceCount, 0);

  engine.dispose();
  try {
    (ctx as unknown as { close(): Promise<void> }).close();
  } catch { /* ignore */ }
});

Deno.test("WorkletEngine: noteOn/noteOff/setVoiceParams safe without node", () => {
  const ctx = new AudioContext();
  const engine = new WorkletEngine(ctx as unknown as AudioContext);
  const voiceId = engine.allocVoiceId();
  engine.noteOn(voiceId, {
    sampleId: 1,
    when: 0,
    playbackRate: 1,
    gain: 0.5,
    pan: 0,
    delay: 0,
    attack: 0.01,
    hold: 0,
    decay: 0.1,
    sustain: 0.5,
    release: 0.1,
    filterFcCents: 13500,
    filterQ: 0.7071,
    filterDcGain: 1,
    delayModEnv: 0,
    attackModEnv: 0.01,
    holdModEnv: 0,
    decayModEnv: 0.1,
    sustainModEnv: 0,
    releaseModEnv: 0.1,
    modEnvToPitch: 0,
    modEnvToFilterFc: 0,
    delayModLFO: 0,
    freqModLFO: 5,
    modLfoToPitch: 0,
    modLfoToFilterFc: 0,
    modLfoToVolume: 0,
    delayVibLFO: 0,
    freqVibLFO: 5,
    vibLfoToPitch: 0,
  });
  assertEquals(engine.activeVoiceCount, 1);
  engine.setVoiceParams(voiceId, { gain: 0.2, pan: -0.3 });
  engine.noteOff(voiceId, 1.0, 0.05);
  engine.stop(voiceId);
  assertEquals(engine.activeVoiceCount, 0);
  engine.dispose();
  try {
    (ctx as unknown as { close(): Promise<void> }).close();
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Player integration (OfflineAudioContext must reject worklet)
// ---------------------------------------------------------------------------

Deno.test("ensureWorkletEngine rejects OfflineAudioContext", async () => {
  const offline = new WebOfflineAudioContext(
    2,
    44100,
    44100,
  ) as unknown as OfflineAudioContext;
  const midy = new MidyGMLite(offline);
  midy.cacheMode = "worklet";
  await assertRejects(
    () => midy.ensureWorkletEngine(),
    Error,
    "OfflineAudioContext",
  );
});

Deno.test("WorkletEngine.ensureStarted fails without full AudioWorklet support", async () => {
  const ctx = new AudioContext();
  const engine = new WorkletEngine(ctx as unknown as AudioContext);
  // npm:web-audio-api may expose a stub audioWorklet but no AudioWorkletNode.
  // Accept either our explicit Error or a ReferenceError from missing globals.
  let failed = false;
  let errMsg = "";
  try {
    await engine.ensureStarted(
      (ctx as unknown as { destination: AudioNode }).destination,
    );
    // If it somehow succeeded (real browser), that is also fine.
    assertNotEquals(engine.node, null);
  } catch (e) {
    failed = true;
    errMsg = e instanceof Error ? e.message : String(e);
  }
  if (failed) {
    assert(
      /AudioWorklet|AudioWorkletNode|addModule/i.test(errMsg),
      `unexpected error: ${errMsg}`,
    );
  }
  engine.dispose();
  try {
    (ctx as unknown as { close(): Promise<void> }).close();
  } catch { /* ignore */ }
});
