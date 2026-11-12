// Hybrid sustain + polyphony balance.
//
// Continuous-sustain SMFs must not:
//   (a) chop under maxPedalVoices=32 while hybrid voices keep stacking, or
//   (b) run unlimited and stall the audio graph mid-song.
//
// Hybrid policy: enforce maxVoices, raise effective maxPedalVoices to the
// same ceiling, and steal pedal residuals with a release envelope.
//
// Usage:
//   deno test -A tests/worklet-hybrid-sustain_test.ts

import { assertEquals } from "./mock-shared.ts";
import { Note } from "../src/base-player.ts";
import { Player } from "../src/player.ts";
import { isTiledCacheMode } from "../src/cache-strategy.ts";

function makePlayer(): Player {
  return new Player(new AudioContext());
}

Deno.test("hybrid-sustain: forceStopVoice sets killed", () => {
  const player = makePlayer();
  const note = new Note(60, 100, 0);
  (player as unknown as { forceStopVoice(n: Note, t: number): void })
    .forceStopVoice(note, 0);
  assertEquals(note.killed, true);
  assertEquals(note.ending, true);
});

Deno.test("hybrid-sustain: segment enforces voice ceiling (no unlimited pile)", () => {
  const player = makePlayer();
  player.cacheMode = "segment";
  assertEquals(isTiledCacheMode(player.cacheMode), true);

  const maxV = player.maxVoices; // 64 default
  for (let i = 0; i < maxV + 20; i++) {
    const n = new Note(30 + (i % 50), 80, 0);
    n.heldByPedal = true;
    (player as unknown as { soundingNotes: Set<Note> }).soundingNotes.add(n);
  }

  (player as unknown as {
    enforceMaxVoices(t: number, r?: number): void;
  }).enforceMaxVoices(0, 1);

  const after = (player as unknown as {
    countSoundingVoices(): number;
  }).countSoundingVoices();
  // Over-budget residuals must be stolen so the graph cannot explode.
  assertEquals(after <= maxV, true, `sounding ${after} must be <= ${maxV}`);
});

Deno.test("hybrid-sustain: pedal ceiling matches voice ceiling (not 32)", () => {
  const player = makePlayer();
  player.cacheMode = "segment";
  const maxV = player.maxVoices;
  const maxP = player.maxPedalVoices; // 32 default — must NOT apply as-is
  assertEquals(maxP < maxV, true);

  // Fill more than maxPedalVoices but within maxVoices.
  for (let i = 0; i < maxP + 10; i++) {
    const n = new Note(40 + (i % 40), 80, 0);
    n.heldByPedal = true;
    (player as unknown as { soundingNotes: Set<Note> }).soundingNotes.add(n);
  }

  (player as unknown as {
    enforceMaxPedalVoices(t: number): void;
  }).enforceMaxPedalVoices(0);

  const after = (player as unknown as {
    countPedalVoices(): number;
  }).countPedalVoices();
  // Hybrid raises pedal cap to maxVoices, so maxP+10 stays.
  assertEquals(
    after,
    maxP + 10,
    "pedal residuals within maxVoices must not be cut by maxPedalVoices=32",
  );
});

Deno.test("hybrid-sustain: pure ads still uses maxPedalVoices=32", () => {
  const player = makePlayer();
  player.cacheMode = "ads";
  const maxP = player.maxPedalVoices;
  for (let i = 0; i < maxP + 5; i++) {
    const n = new Note(40 + (i % 40), 80, 0);
    n.heldByPedal = true;
    (player as unknown as { soundingNotes: Set<Note> }).soundingNotes.add(n);
  }
  (player as unknown as {
    enforceMaxPedalVoices(t: number): void;
  }).enforceMaxPedalVoices(0);
  const after = (player as unknown as {
    countPedalVoices(): number;
  }).countPedalVoices();
  assertEquals(after <= maxP, true);
});

Deno.test("hybrid-sustain: noteOff under pedal marks whole noteGroup", () => {
  const player = makePlayer();
  const channel = player.channels[0];
  channel.state.sustainPedal = 1;
  const a = new Note(60, 100, 0);
  const b = new Note(60, 100, 0);
  a.noteGroupId = 7;
  b.noteGroupId = 7;
  a.voice = {} as Note["voice"];
  b.voice = {} as Note["voice"];
  a.resolveReady();
  b.resolveReady();
  channel.activeNotes[60] = [a, b];

  (player as unknown as {
    noteOffChannel(
      ch: typeof channel,
      nn: number,
      vel: number,
      t: number,
      force: boolean,
    ): void;
  }).noteOffChannel(channel, 60, 0, 1.0, false);

  assertEquals(a.heldByPedal, true);
  assertEquals(b.heldByPedal, true);
  assertEquals(a.ending, false);
  assertEquals(b.ending, false);
});

Deno.test("hybrid-sustain: pedal steal uses graceful release not hard kill", () => {
  const player = makePlayer();
  player.cacheMode = "segment";
  const n = new Note(60, 100, 0);
  n.heldByPedal = true;
  n.voice = {} as Note["voice"];
  n.resolveReady();
  (player as unknown as { soundingNotes: Set<Note> }).soundingNotes.add(n);

  const ok = (player as unknown as {
    stealOldestVoice(t: number, pedalOnly?: boolean): boolean;
  }).stealOldestVoice(0, true);

  assertEquals(ok, true);
  assertEquals(n.ending, true);
  assertEquals(n.heldByPedal, false);
  // Graceful path must NOT set killed (that is hard stop only).
  assertEquals(n.killed, false);
});
