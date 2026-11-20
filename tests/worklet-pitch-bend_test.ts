// Live / MPE pitch bend must reach worklet voices (no bufferSource).
// Regression: 0.7.4 routed timeline-less notes to worklet whenever
// cacheMode !== "none", but updateChannelDetune only touched bufferSource.
//
// Usage:
//   deno test -A tests/worklet-pitch-bend_test.ts

import { assertAlmostEquals, assertEquals } from "./mock-shared.ts";
import { Note, Player } from "../src/player.ts";

type VoiceParamCall = {
  voiceId: number;
  playbackRate?: number;
  gain?: number;
  pan?: number;
};

/** Absolute PB 0..16383 → rate multiplier at default ±2 semitone (200 cent) range. */
function rateAtDefaultRange(absolute: number): number {
  const signed = (absolute - 8192) / 8192;
  const cents = signed * (2 / 128) * 12800; // = signed * 200
  return Math.pow(2, cents / 1200);
}

function makePlayer(): Player {
  return new Player(new AudioContext());
}

function installMockWorkletEngine(player: Player): VoiceParamCall[] {
  const calls: VoiceParamCall[] = [];
  // Minimal stub: only setVoiceParams is exercised by updateChannelDetune.
  // deno-lint-ignore no-explicit-any
  (player as any).workletEngine = {
    setVoiceParams(
      voiceId: number,
      p: { gain?: number; pan?: number; playbackRate?: number },
    ) {
      calls.push({ voiceId, ...p });
    },
  };
  return calls;
}

function attachWorkletNote(
  player: Player,
  channelIndex: number,
  noteNumber: number,
  voiceId: number,
  basePlaybackRate = 1,
  voiceDetune = 0,
): Note {
  const ch = player.channels[channelIndex];
  const note = player.createNoteInstance(
    noteNumber,
    100,
    player.audioContext.currentTime,
  );
  note.workletVoiceId = voiceId;
  // Minimal voiceParams: only fields read by calcNoteDetune / rate fold.
  // deno-lint-ignore no-explicit-any
  note.voiceParams = {
    playbackRate: basePlaybackRate,
    detune: voiceDetune,
  } as any;
  if (!ch.activeNotes[noteNumber]) ch.activeNotes[noteNumber] = [];
  ch.activeNotes[noteNumber].push(note);
  return note;
}

Deno.test("setPitchBend pushes playbackRate to worklet voices", () => {
  const player = makePlayer();
  player.createChannels();
  const calls = installMockWorkletEngine(player);
  const ch = player.channels[0];
  attachWorkletNote(player, 0, 60, 7, 1, 0);

  // Center → no-op delta should still push current rate (1.0).
  ch.setPitchBend(8192);
  assertEquals(calls.length >= 1, true);
  const afterCenter = calls[calls.length - 1];
  assertEquals(afterCenter.voiceId, 7);
  assertAlmostEquals(afterCenter.playbackRate ?? 0, 1, 1e-9);

  // Max-up (16383): signed = 8191/8192, not quite +200 cents.
  calls.length = 0;
  ch.setPitchBend(16383);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].voiceId, 7);
  assertAlmostEquals(
    calls[0].playbackRate ?? 0,
    rateAtDefaultRange(16383),
    1e-9,
  );
  assertEquals(ch.detune > 100, true);
});

Deno.test("setPitchBend updates multiple worklet layers on same key", () => {
  const player = makePlayer();
  player.createChannels();
  const calls = installMockWorkletEngine(player);
  attachWorkletNote(player, 0, 64, 10, 1, 0);
  attachWorkletNote(player, 0, 64, 11, 1.5, 0); // second zone, different base rate

  player.channels[0].setPitchBend(0); // full down ≈ -200 cents at default range
  assertEquals(calls.length, 2);
  const byId = new Map(calls.map((c) => [c.voiceId, c.playbackRate]));
  const ratio = Math.pow(2, -200 / 1200);
  assertAlmostEquals(byId.get(10) ?? 0, 1 * ratio, 1e-6);
  assertAlmostEquals(byId.get(11) ?? 0, 1.5 * ratio, 1e-6);
});

Deno.test("setPitchBendRange rescale pushes worklet playbackRate", () => {
  const player = makePlayer();
  player.createChannels();
  const calls = installMockWorkletEngine(player);
  const ch = player.channels[0];
  attachWorkletNote(player, 0, 48, 3, 1, 0);

  // Bend halfway up at default ±2 semitones, then widen range to ±12 (1200 cent).
  ch.setPitchBend(8192 + 4096); // signed = 0.5 → +100 cents at default
  calls.length = 0;
  ch.setPitchBendRange(1200); // ±12 semitones; wheel still at 0.5 → +600 cents
  assertEquals(calls.length, 1);
  assertEquals(calls[0].voiceId, 3);
  const expected = Math.pow(2, 600 / 1200);
  assertAlmostEquals(calls[0].playbackRate ?? 0, expected, 1e-6);
});

Deno.test("bufferSource notes still get setDetune; worklet notes do not need bufferSource", () => {
  const player = makePlayer();
  player.createChannels();
  const calls = installMockWorkletEngine(player);
  const ch = player.channels[0];

  // Worklet-only note
  attachWorkletNote(player, 0, 60, 99, 1, 0);

  // Fake bufferSource note on another key (minimal AudioBufferSourceNode mock)
  const bufNote = player.createNoteInstance(
    61,
    100,
    player.audioContext.currentTime,
  );
  const detuneValues: number[] = [];
  // deno-lint-ignore no-explicit-any
  bufNote.bufferSource = {
    detune: {
      cancelAndHoldAtTime() {
        return this;
      },
      setTargetAtTime(value: number) {
        detuneValues.push(value);
        return this;
      },
    },
  } as any;
  // deno-lint-ignore no-explicit-any
  bufNote.voiceParams = { playbackRate: 1, detune: 0 } as any;
  if (!ch.activeNotes[61]) ch.activeNotes[61] = [];
  ch.activeNotes[61].push(bufNote);

  ch.setPitchBend(0);
  // worklet path
  assertEquals(calls.some((c) => c.voiceId === 99), true);
  // bufferSource path
  assertEquals(detuneValues.length >= 1, true);
  assertEquals(detuneValues[detuneValues.length - 1] < -100, true);
});

Deno.test("player-level setPitchBend (MPE entry) reaches worklet voice", async () => {
  // Midy subclasses wire player.setPitchBend → forMPEZone → channel.setPitchBend.
  // Base Player exposes the same channel path used inside that fan-out.
  const player = makePlayer();
  player.createChannels();
  const calls = installMockWorkletEngine(player);
  attachWorkletNote(player, 2, 72, 5, 1, 0);

  player.channels[2].setPitchBend(16383);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].voiceId, 5);
  assertAlmostEquals(
    calls[0].playbackRate ?? 0,
    rateAtDefaultRange(16383),
    1e-9,
  );
});
