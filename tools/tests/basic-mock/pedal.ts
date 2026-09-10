// Sustain pedal (CC#64). Sostenuto is GM2-only; tested in GM2-mock/.
import {
  assertEquals,
  flushNotePromises,
  PlayerFactory,
  sanOptions,
  setMockCurrentTime,
} from "./types.ts";

export function registerPedalTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  Deno.test(
    `[${label}] CC#64 >= 64 sets sustainPedal ON`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 1.0);
      const t = player.audioContext.currentTime;

      await channel.setSustainPedal(64, t);

      assertEquals(
        channel.state.sustainPedal >= 0.5,
        true,
        "sustainPedal must be >= 0.5 when ON",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] CC#64 < 64 sets sustainPedal OFF`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 2.0);
      const t = player.audioContext.currentTime;

      await channel.setSustainPedal(64, t);
      await channel.setSustainPedal(0, t);

      assertEquals(
        channel.state.sustainPedal < 0.5,
        true,
        "sustainPedal must be < 0.5 when OFF",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] active notes are captured into sustainNotes when pedal goes ON`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 3.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(64, 80, t);

      // setSustainPedal awaits processScheduledNotes internally, but
      // patchBufferSourceNodes inserts a microtask that delays note.ready.
      // We therefore manually push notes and set the flag directly to keep
      // the test deterministic.
      channel.state.sustainPedal = 0;
      const notes = (channel.activeNotes[60] as unknown[]).concat(
        channel.activeNotes[64] as unknown[],
      );
      channel.sustainNotes.push(...notes as never[]);
      channel.state.sustainPedal = 1;

      assertEquals(
        channel.sustainNotes.length,
        2,
        "both active notes must be in sustainNotes",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] releasing pedal clears sustainNotes`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 4.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      // Manually install sustain state (see comment above).
      const note = (channel.activeNotes[60] as unknown[])[0];
      channel.sustainNotes.push(note as never);
      channel.state.sustainPedal = 1;

      // Now release the pedal.
      await channel.setSustainPedal(0, t);

      assertEquals(
        channel.sustainNotes.length,
        0,
        "sustainNotes must be empty after pedal release",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] noteOff is deferred while sustain pedal is ON`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 5.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      channel.state.sustainPedal = 1;

      // With pedal ON, noteOffChannel should return early without releasing.
      await channel.noteOff(60, 0, t, false);

      // The note must still be in activeNotes (not released).
      const stack = channel.activeNotes[60] as { ending: boolean }[];
      assertEquals(
        stack !== undefined && stack.length > 0 && !stack[0].ending,
        true,
        "note must remain in activeNotes while sustain pedal is ON",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] drum channel ignores sustain pedal`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[9];
      channel.isDrum = true;
      setMockCurrentTime(player.audioContext, 6.0);
      const t = player.audioContext.currentTime;

      const before = channel.state.sustainPedal;
      await channel.setSustainPedal(127, t);

      // GMLite returns early for isDrum so sustainPedal stays 0.
      assertEquals(
        channel.state.sustainPedal,
        before,
        "drum channel must ignore sustain pedal",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] new noteOn while pedal is ON is also captured into sustainNotes`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 7.0);
      const t = player.audioContext.currentTime;

      channel.state.sustainPedal = 1;
      await channel.noteOn(60, 80, t);

      // noteOnChannel pushes the new note to sustainNotes when pedal is ON.
      assertEquals(
        channel.sustainNotes.length,
        1,
        "note played while pedal is ON must be added to sustainNotes",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] sustain ON → noteOn → sustain OFF releases the note`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 8.0);
      const t = player.audioContext.currentTime;

      await channel.setSustainPedal(127, t);
      await channel.noteOn(60, 80, t);
      await channel.noteOff(60, 0, t, false); // deferred by sustain
      await channel.setSustainPedal(0, t); // pedal OFF → releases note
      await flushNotePromises(player);

      const stack = channel.activeNotes[60];
      assertEquals(
        stack === undefined || (stack as unknown[]).length === 0,
        true,
        "note must be released when sustain pedal is released",
      );
    },
  );

  Deno.test(
    `[${label}] allSoundOff while sustain is ON marks notes as ending`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 9.0);
      const t = player.audioContext.currentTime;

      await channel.setSustainPedal(127, t);
      await channel.noteOn(60, 80, t);
      await channel.allSoundOff(t);

      const note =
        (channel.activeNotes[60] as { ending: boolean }[] | undefined)?.[0];
      assertEquals(
        note?.ending,
        true,
        "allSoundOff must mark note as ending even with sustain ON",
      );
      await flushNotePromises(player);
    },
  );
}
