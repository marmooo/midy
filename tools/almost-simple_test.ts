// Unit tests for almost-simple (gain-only) classification.
//
// Does not need fluidsynth or a browser — only web-audio-api mocks and the
// Player classification helpers. Complements tools/compare-almost-simple.test.ts
// (audio vs fluidsynth) and tools/compare-controllers.test.ts (CC7/CC11 drop).
//
// Usage:
//   deno test -A tests/almost-simple_test.ts
//
// Import side-effect: injects Web Audio constructors into globalThis.
import { assertEquals, assertNotEquals } from "../tests/mock-shared.ts";
import { Player } from "../src/player.ts";
import type { NoteOnEventEntry } from "../src/cache-strategy.ts";
import type { TimelineEvent } from "../src/base-player.ts";

function makePlayer(): Player {
  const ctx = new AudioContext();
  return new Player(ctx);
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

function pitchBend(ticks: number, value: number): TimelineEvent {
  return {
    type: "pitchBend",
    ticks,
    startTime: ticks,
    value,
  };
}

Deno.test("almost-simple: pure note is simple, not gain-only", () => {
  const player = makePlayer();
  const entry = noteEntry([]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), false);
  assertEquals(p.hasGainOnlyAutomation(entry), false);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), true);
});

Deno.test("almost-simple: CC7-only is simple + gain-only", () => {
  const player = makePlayer();
  const entry = noteEntry([cc(240, 7, 40)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), false);
  assertEquals(p.hasGainOnlyAutomation(entry), true);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), true);
});

Deno.test("almost-simple: CC11-only is simple + gain-only", () => {
  const player = makePlayer();
  const entry = noteEntry([cc(120, 11, 20), cc(240, 11, 100)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), false);
  assertEquals(p.hasGainOnlyAutomation(entry), true);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), true);
});

Deno.test("almost-simple: CC7+CC11 is still gain-only", () => {
  const player = makePlayer();
  const entry = noteEntry([cc(100, 7, 50), cc(200, 11, 30)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), false);
  assertEquals(p.hasGainOnlyAutomation(entry), true);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), true);
});

Deno.test("almost-simple: sustain CC64 does not force complex or gain-only", () => {
  const player = makePlayer();
  const entry = noteEntry([cc(0, 64, 127)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), false);
  assertEquals(p.hasGainOnlyAutomation(entry), false);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), true);
});

Deno.test("almost-simple: pitch bend forces complex", () => {
  const player = makePlayer();
  const entry = noteEntry([pitchBend(100, 9000)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), true);
  assertEquals(p.hasGainOnlyAutomation(entry), false);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), false);
});

Deno.test("almost-simple: pan (CC10) forces complex", () => {
  const player = makePlayer();
  const entry = noteEntry([cc(100, 10, 0)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), true);
  assertEquals(p.hasGainOnlyAutomation(entry), false);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), false);
});

Deno.test("almost-simple: modulation (CC1) forces complex", () => {
  const player = makePlayer();
  const entry = noteEntry([cc(50, 1, 64)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), true);
  assertEquals(p.hasGainOnlyAutomation(entry), false);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), false);
});

Deno.test("almost-simple: gain + pitch bend is complex (not gain-only)", () => {
  const player = makePlayer();
  const entry = noteEntry([cc(50, 11, 40), pitchBend(100, 8192)]);
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  assertEquals(p.hasWaveformAutomation(entry), true);
  assertEquals(p.hasGainOnlyAutomation(entry), false);
  assertEquals(player.isSimpleNote({ noteEvent: entry }), false);
});

Deno.test("almost-simple: finalizeSimpleNoteClassification puts gain-only in simpleNoteSet", () => {
  const player = makePlayer();
  player.cacheMode = "chunk";
  // timelineIndex 0: pure simple
  // timelineIndex 1: gain-only
  // timelineIndex 2: pitch bend complex
  player.noteOnEvents = [
    noteEntry([]),
    noteEntry([cc(100, 7, 20)]),
    noteEntry([pitchBend(100, 10000)]),
  ];
  // No tiled set → classify all noteOnEvents
  player.tiledBakedSet.clear();
  player.finalizeSimpleNoteClassification();

  assertEquals(player.simpleNoteSet.has(0), true, "pure simple");
  assertEquals(player.simpleNoteSet.has(1), true, "gain-only → simple");
  assertEquals(player.simpleNoteSet.has(2), false, "pitch bend → complex");

  const stats = (player as any).countNoteClassificationStats();
  assertEquals(stats.pureSimple, 1);
  assertEquals(stats.almostSimple, 1);
  assertEquals(stats.complex, 1);
  assertEquals(stats.totalCandidates, 3);
});

Deno.test("almost-simple: gain curve fingerprint differs for different trajectories", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  const a = noteEntry([cc(100, 11, 20)]);
  const b = noteEntry([cc(100, 11, 80)]);
  const fa = p.serializeGainOnlyAutomationEvents(a);
  const fb = p.serializeGainOnlyAutomationEvents(b);
  assertNotEquals(fa, fb, "different expression targets must not share a key");
  assertEquals(fa.includes("g:"), true);
});

Deno.test("almost-simple: computeGainOnlyChannelCurve steps to new gain", () => {
  const player = makePlayer();
  // deno-lint-ignore no-explicit-any
  const p = player as any;
  const entry = noteEntry([cc(240, 11, 20)]); // at ~0.5s if 480 ticks = 1s
  // durationTicks 480, duration 1.0 → tick 240 ≈ 0.5s
  entry.duration = 1.0;
  entry.durationTicks = 480;
  const sampleRate = 100; // tiny for easy indexing
  const length = 100;
  const curve = p.computeGainOnlyChannelCurve(
    entry,
    100 / 127, // vol0
    100 / 127, // expr0
    length,
    sampleRate,
    1.0,
  ) as Float32Array;
  assertEquals(curve.length, length);
  const g0 = curve[0];
  const gLate = curve[length - 1];
  // Onset: (100/127)² × (100/127)²; late: (100/127)² × (20/127)²
  assertEquals(g0 > gLate, true, "late gain must be quieter after expr drop");
  // Rough ratio check: (20/100)² = 0.04 of expression part
  const ratio = gLate / g0;
  if (ratio > 0.1 || ratio < 0.01) {
    throw new Error(
      `unexpected gain ratio ${ratio.toFixed(4)} (want ~0.04 from expr 100→20)`,
    );
  }
});
