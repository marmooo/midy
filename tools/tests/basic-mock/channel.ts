// Channel-level state: pitchBend, programChange, resetAllControllers, initial defaults.
import {
  assertAlmostEquals,
  assertEquals,
  flushNotePromises,
  PlayerFactory,
  sanOptions,
  setMockCurrentTime,
} from "./types.ts";

export function registerChannelTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  // -----------------------------------------------------------------------
  // ControllerState initial values
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] ControllerState initialises to GM defaults`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      const state = channel.state;

      // State values are stored in Float32Array → float32 precision, use 1e-6
      assertAlmostEquals(state.volumeMSB, 100 / 127, 1e-6, "volumeMSB default");
      assertAlmostEquals(state.panMSB, 64 / 127, 1e-6, "panMSB default");
      assertAlmostEquals(state.expressionMSB, 1, 1e-6, "expressionMSB default");
      assertAlmostEquals(
        state.modulationDepthMSB,
        0,
        1e-6,
        "modulation default",
      );
      assertAlmostEquals(state.sustainPedal, 0, 1e-6, "sustainPedal default");
      assertAlmostEquals(
        state.pitchWheelSensitivity,
        2 / 128,
        1e-6,
        "pitchWheelSensitivity default (2 semitones)",
      );
      assertAlmostEquals(
        state.pitchWheel,
        8192 / 16383,
        1e-6,
        "pitchWheel default (centre)",
      );
    },
  );

  // -----------------------------------------------------------------------
  // setPitchBend
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] setPitchBend(0) shifts detune negatively`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 1.0);
      const t = player.audioContext.currentTime;

      channel.setPitchBend(0, t);

      assertEquals(
        channel.detune < 0,
        true,
        "full downward bend must produce negative detune",
      );
    },
  );

  Deno.test(
    `[${label}] setPitchBend(16383) then setPitchBend(8192) returns detune to near-zero`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 2.0);
      const t = player.audioContext.currentTime;

      channel.setPitchBend(16383, t); // bend up
      channel.setPitchBend(8192, t); // back to centre

      // Should be very close to 0 (within float32 rounding)
      assertAlmostEquals(
        channel.detune,
        0,
        1,
        "setPitchBend back to centre must return detune near 0",
      );
    },
  );

  Deno.test(
    `[${label}] setPitchBend(16383) increases detune by pitchWheelSensitivity * 12800`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 3.0);
      const t = player.audioContext.currentTime;

      channel.setPitchBend(16383, t);

      const expected = channel.state.pitchWheelSensitivity * 12800;
      assertAlmostEquals(
        channel.detune,
        expected,
        1,
        "max pitch-up must shift detune by sensitivity * 12800",
      );
    },
  );

  // -----------------------------------------------------------------------
  // setProgramChange
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] setProgramChange updates programNumber`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];

      channel.setProgramChange(42);

      assertEquals(channel.programNumber, 42);
    },
  );

  // -----------------------------------------------------------------------
  // resetAllControllers
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] resetAllControllers restores pitchWheel to centre`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 4.0);
      const t = player.audioContext.currentTime;

      channel.setPitchBend(16383, t);
      channel.resetAllControllers(t);

      assertAlmostEquals(
        channel.state.pitchWheel,
        8192 / 16383,
        1e-6,
        "pitchWheel must be centred after reset",
      );
    },
  );

  Deno.test(
    `[${label}] resetAllControllers zeroes modulation`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 5.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(1, 127, t);
      channel.resetAllControllers(t);

      assertAlmostEquals(
        channel.state.modulationDepthMSB,
        0,
        1e-6,
        "modulation must be 0 after reset",
      );
    },
  );

  Deno.test(
    `[${label}] resetAllControllers restores expression to 1.0`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 6.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(11, 0, t);
      channel.resetAllControllers(t);

      assertAlmostEquals(
        channel.state.expressionMSB,
        1.0,
        1e-6,
        "expressionMSB must return to 1.0 after reset",
      );
    },
  );

  Deno.test(
    `[${label}] resetAllControllers resets rpnMSB and rpnLSB to 127`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 7.0);
      const t = player.audioContext.currentTime;

      channel.setRPNMSB(0);
      channel.setRPNLSB(0);
      channel.resetAllControllers(t);

      assertEquals(
        channel.rpnMSB,
        127,
        "rpnMSB must be 127 (null) after reset",
      );
      assertEquals(
        channel.rpnLSB,
        127,
        "rpnLSB must be 127 (null) after reset",
      );
    },
  );

  // -----------------------------------------------------------------------
  // processScheduledNotes
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] processScheduledNotes visits all non-ending notes`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 20.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(64, 80, t);

      let count = 0;
      await channel.processScheduledNotes(() => {
        count++;
      });
      assertEquals(count, 2, "must visit both active notes");
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // detune initial value
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] detune is 0 on channel construction`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];

      assertEquals(channel.detune, 0, "detune must be 0 on construction");
    },
  );

  // -----------------------------------------------------------------------
  // resetAllControllers — sustain
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] resetAllControllers resets sustainPedal to 0`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 8.0);
      const t = player.audioContext.currentTime;

      await channel.setSustainPedal(127, t);
      channel.resetAllControllers(t);

      assertEquals(
        channel.state.sustainPedal < 0.5,
        true,
        "sustainPedal must be cleared by resetAllControllers",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] channels[n].channelNumber equals n`,
    sanOptions,
    () => {
      const player = makePlayer();
      for (let i = 0; i < 16; i++) {
        assertEquals(
          player.channels[i].channelNumber,
          i,
          `channels[${i}].channelNumber must be ${i}`,
        );
      }
    },
  );

  Deno.test(
    `[${label}] processActiveNotes skips notes with ending=true`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 9.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      const stack = channel.activeNotes[60] as { ending: boolean }[];
      stack[0].ending = true;

      let called = 0;
      await channel.processActiveNotes(t, () => {
        called++;
      });
      assertEquals(
        called,
        0,
        "ending note must be skipped by processActiveNotes",
      );
      await flushNotePromises(player);
    },
  );
}
