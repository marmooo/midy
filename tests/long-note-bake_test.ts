// Unit tests for long-note full-note offline bake classification
// (perf: bake long note — longNoteBakedSet).
//
// fluidsynth / browser は使わない。Player の分類ヘルパーのみ。
//
// Usage:
//   deno test -A tests/long-note-bake_test.ts

import { assertEquals, makeDefaultVoiceParams } from "./mock-shared.ts";
import { Player } from "../src/player.ts";
import { envelopeCurve } from "../src/base-player.ts";
import type { NoteOnEventEntry } from "../src/cache-strategy.ts";
import type { TimelineEvent, VoiceParams } from "../src/base-player.ts";

function makePlayer(): Player {
  const ctx = new AudioContext();
  return new Player(ctx);
}

function noteOnEvent(
  startTime: number,
  duration: number,
  opts: { soundOff?: boolean } = {},
): NoteOnEventEntry {
  return {
    duration,
    durationTicks: Math.round(duration * 480),
    startTime,
    startTicks: Math.round(startTime * 480),
    events: [],
    soundOff: opts.soundOff,
  };
}

function noteOnTimeline(
  channel: number,
  noteNumber: number,
  startTime: number,
): TimelineEvent {
  return {
    type: "noteOn",
    ticks: Math.round(startTime * 480),
    startTime,
    channel,
    noteNumber,
    velocity: 100,
  };
}

function vp(exclusiveClass = 0, releaseVolEnv = 0.2): VoiceParams {
  return Object.assign(makeDefaultVoiceParams(exclusiveClass), {
    releaseVolEnv,
  }) as unknown as VoiceParams;
}

/** Seed classification inputs without a full MIDI load. */
function seedClassification(
  player: Player,
  entries: {
    duration: number;
    exclusiveClass?: number;
    releaseVolEnv?: number;
    soundOff?: boolean;
    channel?: number;
    noteNumber?: number;
    startTime?: number;
  }[],
): void {
  const n = entries.length;
  player.tiledVoiceParams = new Array(n);
  player.noteOnDurations = new Array(n);
  player.noteOnEvents = new Array(n);
  player.timeline = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const start = e.startTime ?? i;
    player.tiledVoiceParams[i] = vp(
      e.exclusiveClass ?? 0,
      e.releaseVolEnv ?? 0.2,
    );
    player.noteOnDurations[i] = e.duration;
    player.noteOnEvents[i] = noteOnEvent(start, e.duration, {
      soundOff: e.soundOff,
    });
    player.timeline[i] = noteOnTimeline(
      e.channel ?? 0,
      e.noteNumber ?? 60,
      start,
    );
  }
  player.tiledBakedSet.clear();
  player.longNoteBakedSet.clear();
  player.noteBakeDurations = [];
}

Deno.test("long-note-bake: short non-exclusive note goes to tiledBakedSet", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  seedClassification(player, [{ duration: 1.0 }]);
  player.finalizeSegmentClassification();

  assertEquals(player.tiledBakedSet.has(0), true, "short note → tiled");
  assertEquals(player.longNoteBakedSet.has(0), false, "not long-note bake");
});

Deno.test("long-note-bake: duration+releaseTail over maxTiled → longNoteBakedSet", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  // duration 8 + releaseTail(~0.087) > 8
  seedClassification(player, [{ duration: 8.0, releaseVolEnv: 0.2 }]);
  player.finalizeSegmentClassification();

  assertEquals(player.tiledBakedSet.has(0), false, "too long for tile");
  assertEquals(player.longNoteBakedSet.has(0), true, "full-note bake path");
});

Deno.test("long-note-bake: just under threshold still tiles", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  seedClassification(player, [{ duration: 8.0, releaseVolEnv: 0 }]);
  player.finalizeSegmentClassification();

  assertEquals(
    player.tiledBakedSet.has(0),
    true,
    "exactly at max with 0 release → tile",
  );
  assertEquals(player.longNoteBakedSet.has(0), false);
});

Deno.test("long-note-bake: exclusive-class notes are never tiled", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  seedClassification(player, [{
    duration: 0.5,
    exclusiveClass: 1,
    channel: 9,
    noteNumber: 42,
  }]);
  player.finalizeSegmentClassification();

  assertEquals(player.tiledBakedSet.has(0), false, "exclusive never tiled");
});

Deno.test("long-note-bake: soundOff zeros release tail so long note can tile", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  seedClassification(player, [{
    duration: 8.0,
    releaseVolEnv: 0.2,
    soundOff: true,
  }]);
  player.finalizeSegmentClassification();

  assertEquals(
    player.tiledBakedSet.has(0),
    true,
    "All Sound Off → no release tail → can tile at max duration",
  );
  assertEquals(player.longNoteBakedSet.has(0), false);
});

Deno.test("long-note-bake: mixed short/long classification", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 2;
  seedClassification(player, [
    { duration: 0.5, releaseVolEnv: 0 },
    { duration: 3.0, releaseVolEnv: 0 },
    { duration: 1.0, releaseVolEnv: 0 },
    { duration: 10.0, exclusiveClass: 2 },
  ]);
  player.finalizeSegmentClassification();

  assertEquals(player.tiledBakedSet.has(0), true);
  assertEquals(player.longNoteBakedSet.has(0), false);

  assertEquals(player.tiledBakedSet.has(1), false);
  assertEquals(player.longNoteBakedSet.has(1), true);

  assertEquals(player.tiledBakedSet.has(2), true);
  assertEquals(player.longNoteBakedSet.has(2), false);

  assertEquals(player.tiledBakedSet.has(3), false, "exclusive not tiled");
});

Deno.test("long-note-bake: releaseTail math matches envelopeCurve * 5", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 1;
  const releaseVolEnv = 0.5;
  const expectedTail = releaseVolEnv * envelopeCurve * 5;
  const duration = 1 - expectedTail / 2;
  seedClassification(player, [{ duration, releaseVolEnv }]);
  player.finalizeSegmentClassification();

  assertEquals(
    duration + expectedTail > player.maxTiledNoteDuration,
    true,
    "precondition: sum exceeds max",
  );
  assertEquals(player.longNoteBakedSet.has(0), true);
  assertEquals(player.tiledBakedSet.has(0), false);
});

Deno.test("long-note-bake: null voiceParams slots are skipped", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  player.tiledVoiceParams = [null, vp(0, 0)];
  player.noteOnDurations = [1, 1];
  player.noteOnEvents = [noteOnEvent(0, 1), noteOnEvent(1, 1)];
  player.timeline = [
    noteOnTimeline(0, 60, 0),
    noteOnTimeline(0, 62, 1),
  ];
  player.finalizeSegmentClassification();

  assertEquals(player.tiledBakedSet.has(0), false, "null slot skipped");
  assertEquals(player.tiledBakedSet.has(1), true);
});

// Exclusive-class note bake (choke-truncated duration) — classification only
Deno.test("exclusive-bake: single exclusive uses natural duration", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  seedClassification(player, [{
    duration: 1.5,
    exclusiveClass: 1,
    channel: 9,
    noteNumber: 42,
    startTime: 0,
  }]);
  player.finalizeSegmentClassification();

  assertEquals(player.tiledBakedSet.has(0), false);
  assertEquals(player.longNoteBakedSet.has(0), true);
  assertEquals(player.noteBakeDurations[0], 1.5);
});

Deno.test("exclusive-bake: next same-class note truncates bake duration", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  const fade = Player.EXCLUSIVE_CHOKE_FADE_SEC;
  seedClassification(player, [
    {
      duration: 2.0,
      exclusiveClass: 1,
      channel: 9,
      noteNumber: 46,
      startTime: 0,
    },
    {
      duration: 0.4,
      exclusiveClass: 1,
      channel: 9,
      noteNumber: 42,
      startTime: 0.5,
    },
  ]);
  player.finalizeSegmentClassification();

  assertEquals(player.longNoteBakedSet.has(0), true);
  assertEquals(player.longNoteBakedSet.has(1), true);
  const expectedHeld = Math.max(0, 0.5 - fade);
  assertEquals(player.noteBakeDurations[0], expectedHeld);
  assertEquals(player.noteBakeDurations[1], 0.4);
  assertEquals(player.tiledBakedSet.size, 0);
});

Deno.test("exclusive-bake: different exclusive classes do not choke each other", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  seedClassification(player, [
    {
      duration: 1.0,
      exclusiveClass: 1,
      channel: 9,
      noteNumber: 42,
      startTime: 0,
    },
    {
      duration: 1.0,
      exclusiveClass: 2,
      channel: 9,
      noteNumber: 71,
      startTime: 0.2,
    },
  ]);
  player.finalizeSegmentClassification();
  assertEquals(player.noteBakeDurations[0], 1.0);
  assertEquals(player.noteBakeDurations[1], 1.0);
});

Deno.test("exclusive-bake: different channels do not choke each other", () => {
  const player = makePlayer();
  player.maxTiledNoteDuration = 8;
  seedClassification(player, [
    {
      duration: 1.0,
      exclusiveClass: 1,
      channel: 9,
      noteNumber: 42,
      startTime: 0,
    },
    {
      duration: 1.0,
      exclusiveClass: 1,
      channel: 10,
      noteNumber: 42,
      startTime: 0.2,
    },
  ]);
  player.finalizeSegmentClassification();
  assertEquals(player.noteBakeDurations[0], 1.0);
  assertEquals(player.noteBakeDurations[1], 1.0);
});
