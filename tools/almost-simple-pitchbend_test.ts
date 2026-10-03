// Unit tests for almost-simple pitch-bend classification + rate curve.
//
// Does not need fluidsynth or a browser — only web-audio-api mocks and the
// Player helpers. Complements tools/compare-almost-simple-pitchbend.test.ts
// (audio pitch measurement vs full complex / fluidsynth).
//
// Usage:
//   deno test -A tools/almost-simple-pitchbend_test.ts
//
import { assertAlmostEquals, assertEquals } from "@std/assert";
// Import side-effect: injects Web Audio constructors into globalThis when
// available via tests/mock-shared; fall back to a minimal stub for CI.
try {
  await import("../tests/mock-shared.ts");
} catch {
  // optional in environments that already provide Web Audio
}
import { Player } from "../src/player.ts";
import type { NoteOnEventEntry } from "../src/cache-strategy.ts";
import type { TimelineEvent } from "../src/base-player.ts";

function makePlayer(): Player {
  // deno-lint-ignore no-explicit-any
  const ctx = (globalThis as any).AudioContext
    // deno-lint-ignore no-explicit-any
    ? new (globalThis as any).AudioContext()
    : {
      sampleRate: 48000,
      currentTime: 0,
      createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1 } }),
      createBiquadFilter: () => ({
        connect() {},
        disconnect() {},
        frequency: { value: 20000 },
        Q: { value: 1 },
        type: "lowpass",
      }),
      destination: {},
    };
  return new Player(ctx as AudioContext);
}

function noteEntry(
  events: TimelineEvent[],
  duration = 1.0,
  durationTicks = 480,
): NoteOnEventEntry {
  return {
    duration,
    durationTicks,
    startTime: 0,
    startTicks: 0,
    events,
  };
}

function pitchBend(ticks: number, value: number): TimelineEvent {
  return {
    type: "pitchBend",
    ticks,
    startTime: ticks,
    value,
  };
}

function cc(
  ticks: number,
  controllerType: number,
  value: number,
): TimelineEvent {
  return {
    type: "controller",
    ticks,
    startTime: ticks,
    controllerType,
    value,
  };
}

Deno.test("almost-simple pitchbend: pure bend is simple + bend-only", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  p.useAlmostSimplePitchBend = true;
  const entry = noteEntry([pitchBend(240, 8191)]); // max up (signed)
  assertEquals(p.hasWaveformAutomation(entry), false);
  assertEquals(p.hasPitchBendOnlyAutomation(entry), true);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), true);
});

Deno.test("almost-simple pitchbend: flag off forces complex", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  p.useAlmostSimplePitchBend = false;
  const entry = noteEntry([pitchBend(240, 8191)]);
  assertEquals(p.hasWaveformAutomation(entry), true);
  assertEquals(p.hasPitchBendOnlyAutomation(entry), false);
});

Deno.test("almost-simple pitchbend: bend + gain still almost-simple", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  p.useAlmostSimplePitchBend = true;
  const entry = noteEntry([
    pitchBend(120, 4096),
    cc(240, 11, 40),
  ]);
  assertEquals(p.hasWaveformAutomation(entry), false);
  assertEquals(p.hasPitchBendOnlyAutomation(entry), true);
  assertEquals(p.hasGainOnlyAutomation(entry), true);
});

Deno.test("almost-simple pitchbend: bend + mod forces complex", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  p.useAlmostSimplePitchBend = true;
  const entry = noteEntry([
    pitchBend(120, 4096),
    cc(240, 1, 64), // modulation
  ]);
  assertEquals(p.hasWaveformAutomation(entry), true);
  assertEquals(p.hasPitchBendOnlyAutomation(entry), false);
});

Deno.test("almost-simple pitchbend: rate curve +200 cents at full bend", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  const entry = noteEntry([pitchBend(0, 8191)]); // signed max ≈ +8191
  const length = 480;
  const sampleRate = 480;
  // Default GM sensitivity = 2/128 (= 200 cents / 12800)
  const rates = p.computePitchBendRateCurve(
    entry,
    8192 / 16383, // onset center
    2 / 128,
    length,
    sampleRate,
    1.0,
  ) as Float32Array;
  // Full scale up ≈ +200 cents → rate ≈ 2^(200/1200)
  const expected = Math.pow(2, 200 / 1200);
  assertAlmostEquals(rates[0], expected, expected * 0.02);
  assertAlmostEquals(rates[length - 1], expected, expected * 0.02);
});

Deno.test("almost-simple pitchbend: serialize fingerprint is stable", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  const entry = noteEntry([
    pitchBend(100, 1000),
    pitchBend(200, -1000),
  ]);
  const fp = p.serializePitchBendAutomationEvents(entry) as string;
  assertEquals(fp.includes("b:100:1000"), true);
  assertEquals(fp.includes("b:200:-1000"), true);
});

Deno.test("almost-simple pitchbend: absolute rate is 1.0 at center onset", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  const entry = noteEntry([]); // no in-note events; onset stays center
  const length = 100;
  const sampleRate = 100;
  const rates = p.computePitchBendRateCurve(
    entry,
    8192 / 16383,
    2 / 128,
    length,
    sampleRate,
    1.0,
  ) as Float32Array;
  assertAlmostEquals(rates[0], 1.0, 1e-6);
  assertAlmostEquals(rates[length - 1], 1.0, 1e-6);
});

Deno.test("almost-simple pitchbend: onset already at +200c → relative rate 1.0", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  // Rate curve is relative to onset wheel; onset cents live in channelDetune.
  // With no in-note bends, every sample stays 1.0 (absolute pitch from detune).
  const entry = noteEntry([]);
  const length = 100;
  const sampleRate = 100;
  const rates = p.computePitchBendRateCurve(
    entry,
    16383 / 16383, // onset already max
    2 / 128,
    length,
    sampleRate,
    1.0,
  ) as Float32Array;
  assertAlmostEquals(rates[0], 1.0, 1e-5);
  assertAlmostEquals(rates[length - 1], 1.0, 1e-5);
});

Deno.test("almost-simple pitchbend: detuneWithoutPitchWheel strips wheel cents", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  const state = new Float32Array(256);
  state[14] = 16383 / 16383; // max up
  state[16] = 2 / 128;
  const wheelCents = p.pitchWheelCentsFromState(state) as number;
  // Simulate channelDetune that includes wheel
  const channelDetune = 50 + wheelCents; // 50c other + wheel
  const stripped = p.detuneWithoutPitchWheel(channelDetune, state) as number;
  assertAlmostEquals(stripped, 50, 0.05);
});

Deno.test("almost-simple pitchbend: multi-step curve returns to 1.0 at center", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  // Matches multi-step-down scenario (absolute wheel positions).
  const entry = noteEntry(
    [
      pitchBend(0, 0), // center (signed)
      pitchBend(120, 7424 - 8192),
      pitchBend(192, 7807 - 8192),
      pitchBend(264, 0),
      pitchBend(336, 6912 - 8192),
      pitchBend(432, 0),
    ],
    1.2,
    576,
  );
  const sampleRate = 480;
  const length = Math.ceil(1.2 * sampleRate);
  const rates = p.computePitchBendRateCurve(
    entry,
    8192 / 16383,
    2 / 128,
    length,
    sampleRate,
    1.2,
  ) as Float32Array;
  // Sample at center regions (t≈0.1 and t≈1.0)
  const i0 = Math.floor(0.1 * sampleRate);
  const iEnd = Math.floor(1.0 * sampleRate);
  assertAlmostEquals(rates[i0], 1.0, 1e-5);
  assertAlmostEquals(rates[iEnd], 1.0, 1e-5);
  // At down6912 (t≈0.8): abs 6912 → signed -1280/8192 → -31.25c
  const iDown = Math.floor(0.8 * sampleRate);
  const expectDown = Math.pow(2, ((6912 - 8192) / 8192) * 200 / 1200);
  assertAlmostEquals(rates[iDown], expectDown, expectDown * 0.001);
});

Deno.test("almost-simple pitchbend: full-scale up stays relative 1.0 at onset max", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  // Relative-to-onset design: onset wheel is in channelDetune; curve is 1.0
  // when the in-note wheel does not move away from onset.
  const entry = noteEntry([pitchBend(0, 8191)]);
  const rates = p.computePitchBendRateCurve(
    entry,
    16383 / 16383,
    2 / 128,
    100,
    100,
    1.0,
  ) as Float32Array;
  assertAlmostEquals(rates[0], 1.0, 1e-5);
});
