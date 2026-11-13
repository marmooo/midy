// channel.detune must return to 0 after resetChannelStates / resetAllControllers
// even when pitch bends accumulated (cacheVoiceIds walk, live play, seek).
//
// Usage:
//   deno test -A tests/detune-reset_test.ts

import { assertAlmostEquals, assertEquals } from "./mock-shared.ts";
import { Player } from "../src/player.ts";

function makePlayer(): Player {
  return new Player(new AudioContext());
}

Deno.test("resetChannelStates zeros residual pitch-bend detune", () => {
  const player = makePlayer();
  player.createChannels();
  const ch = player.channels[0];
  // Accumulate a full-scale down bend like the end of a timeline walk.
  ch.setPitchBend(0); // absolute max down → about -200 cents at default range
  assertEquals(ch.detune < -100, true);
  ch.resetChannelStates();
  assertAlmostEquals(ch.detune, 0, 0.01);
  assertAlmostEquals(ch.state.pitchWheel, 8192 / 16383, 1e-6);
});

Deno.test("resetAllControllers zeros residual pitch-bend detune", () => {
  const player = makePlayer();
  player.createChannels();
  const ch = player.channels[0];
  ch.setPitchBend(0);
  const before = ch.detune;
  assertEquals(before < -100, true);
  ch.resetAllControllers();
  assertAlmostEquals(ch.detune, 0, 0.01);
  assertAlmostEquals(ch.state.pitchWheel * 16383, 8192, 1);
});

Deno.test("updateStates rebuilds from zero when seeking backward", () => {
  const player = makePlayer();
  player.createChannels();
  // Minimal timeline: pitch bend down then later center.
  // deno-lint-ignore no-explicit-any
  (player as any).timeline = [
    {
      type: "pitchBend",
      channel: 0,
      ticks: 0,
      startTime: 0,
      value: -4096, // signed → abs 4096
    },
    {
      type: "pitchBend",
      channel: 0,
      ticks: 480,
      startTime: 480,
      value: 0, // center
    },
  ];
  player.tempo = 1; // startTime is already in seconds when tempo=1
  const ch = player.channels[0];
  // Simulate being mid-song at non-center wheel without going through events.
  ch.setPitchBend(0);
  assertEquals(ch.detune < -100, true);
  // Seek to just after first event: should end at abs 4096 (-100c), not residual.
  player.resumeTime = 0;
  player.updateStates(99, 1); // old queueIndex ignored; rebuilds [0,1)
  const expected = ((4096 - 8192) / 8192) * (2 / 128) * 12800;
  assertAlmostEquals(ch.detune, expected, 0.5);
});

Deno.test("GM1SystemOn clears residual detune after timeline-like bends", () => {
  const player = makePlayer();
  player.createChannels();
  for (const ch of player.channels) {
    if (ch.isDrum) continue;
    ch.setPitchBend(0);
  }
  player.GM1SystemOn(0);
  for (const ch of player.channels) {
    if (ch.isDrum) continue;
    assertAlmostEquals(ch.detune, 0, 0.01);
  }
});
