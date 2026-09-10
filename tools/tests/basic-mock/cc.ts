// Control Change handlers (CC#1, #7, #10, #11, #120, #121, #123).
import {
  assertAlmostEquals,
  assertEquals,
  flushNotePromises,
  PlayerFactory,
  sanOptions,
  setMockCurrentTime,
} from "./types.ts";

export function registerCCTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  Deno.test(
    `[${label}] CC#7 (volume) updates state.volumeMSB`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 1.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(7, 100, t);

      // state values are stored in Float32Array → float32 precision, use 1e-6
      assertAlmostEquals(
        channel.state.volumeMSB,
        100 / 127,
        1e-6,
        "volumeMSB must be value/127",
      );
    },
  );

  Deno.test(
    `[${label}] CC#10 (pan) updates state.panMSB`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 2.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(10, 0, t);

      assertAlmostEquals(
        channel.state.panMSB,
        0 / 127,
        1e-9,
        "panMSB must be 0/127 for hard-left pan",
      );
    },
  );

  Deno.test(
    `[${label}] CC#11 (expression) updates state.expressionMSB`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 3.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(11, 64, t);

      assertAlmostEquals(
        channel.state.expressionMSB,
        64 / 127,
        1e-6,
        "expressionMSB must be value/127",
      );
    },
  );

  Deno.test(
    `[${label}] CC#1 (modulation) updates state.modulationDepthMSB`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 4.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(1, 127, t);

      assertAlmostEquals(
        channel.state.modulationDepthMSB,
        1.0,
        1e-6,
        "modulationDepthMSB must be 1.0 at maximum",
      );
    },
  );

  Deno.test(
    `[${label}] CC#120 (allSoundOff) marks all notes as ending`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 5.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(64, 80, t);

      // allSoundOff calls soundOffNote which sets ending=true;
      // it does NOT synchronously clear activeNotes.
      await channel.allSoundOff(t);

      const note60 =
        (channel.activeNotes[60] as { ending: boolean }[] | undefined)?.[0];
      const note64 =
        (channel.activeNotes[64] as { ending: boolean }[] | undefined)?.[0];
      assertEquals(
        note60?.ending,
        true,
        "note 60 must be marked ending after allSoundOff",
      );
      assertEquals(
        note64?.ending,
        true,
        "note 64 must be marked ending after allSoundOff",
      );

      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] CC#121 (resetAllControllers) resets pitchWheel and modulation`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 6.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(1, 100, t); // modulation
      channel.setPitchBend(16383, t); // max pitch bend

      channel.setControlChange(121, 0, t);

      assertAlmostEquals(
        channel.state.modulationDepthMSB,
        0,
        1e-6,
        "modulationDepthMSB must be 0 after reset",
      );
      assertAlmostEquals(
        channel.state.pitchWheel,
        8192 / 16383,
        1e-6,
        "pitchWheel must return to centre after reset",
      );
    },
  );

  Deno.test(
    `[${label}] CC#123 (allNotesOff) empties activeNotes`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 7.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      channel.setControlChange(123, 0, t);
      await flushNotePromises(player);

      const stack = channel.activeNotes[60];
      assertEquals(
        stack === undefined || (stack as unknown[]).length === 0,
        true,
        "activeNotes[60] must be empty after allNotesOff",
      );
    },
  );

  Deno.test(
    `[${label}] unknown CC does not throw`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 8.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(99, 42, t);
    },
  );

  Deno.test(
    `[${label}] CC#121 (resetAllControllers) resets sustainPedal`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 9.0);
      const t = player.audioContext.currentTime;

      await channel.setSustainPedal(127, t);
      channel.setControlChange(121, 0, t);

      assertEquals(
        channel.state.sustainPedal < 0.5,
        true,
        "sustainPedal must be cleared by resetAllControllers",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] CC#123 (allNotesOff) releases sustain-held notes (RP-015)`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 10.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      channel.state.sustainPedal = 1;
      channel.sustainNotes.push(
        (channel.activeNotes[60] as unknown[])[0] as never,
      );

      channel.setControlChange(123, 0, t);
      await flushNotePromises(player);

      const stack = channel.activeNotes[60];
      assertEquals(
        stack === undefined || (stack as unknown[]).length === 0,
        true,
        "allNotesOff must release sustain-held notes per RP-015",
      );
    },
  );
}
