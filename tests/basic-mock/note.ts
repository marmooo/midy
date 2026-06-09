// noteOn / noteOff channel mechanics.
import {
  assertEquals,
  assertNotEquals,
  flushNotePromises,
  PlayerFactory,
  sanOptions,
  setMockCurrentTime,
} from "./types.ts";

export function registerNoteTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  // -----------------------------------------------------------------------
  // noteOn
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] noteOn registers note in activeNotes`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 1.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);

      assertNotEquals(
        channel.activeNotes[60],
        undefined,
        "activeNotes[60] must be initialised",
      );
      assertEquals(
        (channel.activeNotes[60] as unknown[]).length,
        1,
        "exactly one note must be in the stack",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] noteOn returns a Note with correct properties`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 2.0);
      const t = player.audioContext.currentTime;

      const note = await channel.noteOn(64, 100, t) as {
        noteNumber: number;
        velocity: number;
        startTime: number;
      } | void;

      assertNotEquals(note, undefined, "noteOn must return a Note");
      assertEquals((note as { noteNumber: number }).noteNumber, 64);
      assertEquals((note as { velocity: number }).velocity, 100);
      assertEquals((note as { startTime: number }).startTime, t);
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] noteOn stacks two notes on the same noteNumber`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 3.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(60, 64, t);

      assertEquals(
        (channel.activeNotes[60] as unknown[]).length,
        2,
        "two notes must be stacked for the same pitch",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] noteOn without soundFont returns void`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      // Clear the soundfont so voice resolution fails.
      player.soundFontTable[0] = [];
      setMockCurrentTime(player.audioContext, 4.0);
      const t = player.audioContext.currentTime;

      const result = await channel.noteOn(60, 80, t);

      assertEquals(result, undefined, "must return void when no soundfont");
      assertEquals(
        channel.activeNotes[60],
        undefined,
        "activeNotes must remain empty",
      );
    },
  );

  Deno.test(
    `[${label}] note.ready resolves after noteOn completes`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 5.0);
      const t = player.audioContext.currentTime;

      const note = await channel.noteOn(60, 80, t) as
        | { ready: Promise<void> }
        | void;
      assertNotEquals(note, undefined);

      // If ready is not resolved this will hang (and Deno will time out).
      await (note as { ready: Promise<void> }).ready;
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // noteOff
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] noteOff removes note from activeNotes`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 10.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOff(60, 0, t, false);

      // The stack should be empty (shift() was called).
      const stack = channel.activeNotes[60] as unknown[] | undefined;
      assertEquals(
        stack === undefined || stack.length === 0,
        true,
        "activeNotes[60] must be empty after noteOff",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] noteOff on unknown noteNumber is a safe no-op`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 11.0);
      const t = player.audioContext.currentTime;

      // Should not throw.
      await channel.noteOff(60, 0, t, false);
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] noteOff with stacked notes only removes the oldest`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 12.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(60, 64, t);
      await channel.noteOff(60, 0, t, false);

      const stack = channel.activeNotes[60] as unknown[];
      assertEquals(stack.length, 1, "one note must remain after one noteOff");
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] drum channel noteOff does not start release`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[9];
      channel.isDrum = true;
      setMockCurrentTime(player.audioContext, 13.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(38, 100, t);
      // noteOff on drum should be silent (no promise added to notePromises).
      const promisesBefore = player.notePromises.length;
      await channel.noteOff(38, 0, t, false);
      assertEquals(
        player.notePromises.length,
        promisesBefore,
        "drum noteOff must not push to notePromises",
      );
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // processScheduledNotes / processActiveNotes
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] processScheduledNotes skips notes with ending=true`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 20.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      const stack = channel.activeNotes[60] as { ending: boolean }[];
      stack[0].ending = true;

      let called = 0;
      await channel.processScheduledNotes(() => {
        called++;
      });
      assertEquals(called, 0, "ending note must be skipped");
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] processActiveNotes skips notes whose startTime is in the future`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 100.0);
      const t = player.audioContext.currentTime; // 100.0

      // noteOn with startTime=200 (future).
      await channel.noteOn(60, 80, 200.0);

      let called = 0;
      // Pass scheduleTime=100 — the note's startTime (200) is after it.
      await channel.processActiveNotes(t, () => {
        called++;
      });
      assertEquals(called, 0, "future note must be skipped");
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // exclusiveClass mutual exclusion
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] exclusiveClass: second noteOn evicts the first note`,
    sanOptions,
    async () => {
      // exclusiveClass is read from note.voiceParams.exclusiveClass, which is
      // set via note.voice.getAllParams(). Pass exclusiveClass=1 to the factory
      // so the soundfont stub returns it correctly.
      const player = makePlayer(1);
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 30.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(64, 80, t); // same exclusiveClass → evicts note 60

      await flushNotePromises(player);

      const stack60 = channel.activeNotes[60] as
        | { ending: boolean }[]
        | undefined;
      assertEquals(
        stack60 === undefined || stack60.length === 0,
        true,
        "first note must be evicted from activeNotes by exclusiveClass",
      );
      await flushNotePromises(player);
    },
  );

  Deno.test(
    `[${label}] exclusiveClass=0 does not evict other notes`,
    sanOptions,
    async () => {
      const player = makePlayer(0);
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 31.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(64, 80, t);

      const stack60 = channel.activeNotes[60] as
        | { ending: boolean }[]
        | undefined;
      assertEquals(
        stack60 !== undefined && stack60.length > 0 && !stack60[0].ending,
        true,
        "exclusiveClass=0 must not evict other notes",
      );
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // velocity=0 noteOn
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] noteOn with velocity=0 does NOT act as noteOff at Channel level`,
    sanOptions,
    async () => {
      // velocity=0 → noteOff conversion happens in midi-file (byte9 flag) or
      // buildNoteOnDurations, NOT in Channel.noteOn. A direct call with
      // velocity=0 still produces a note.
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 32.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 80, t);
      await channel.noteOn(60, 0, t); // velocity=0 — still treated as noteOn

      const stack = channel.activeNotes[60] as unknown[] | undefined;
      assertEquals(
        stack !== undefined && stack.length === 2,
        true,
        "velocity=0 noteOn stacks a second note, not a noteOff",
      );
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // startTime defaulting
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] noteOn with startTime=undefined uses audioContext.currentTime`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 42.0);

      const note = await channel.noteOn(60, 80, undefined) as
        | { startTime: number }
        | void;
      assertNotEquals(note, undefined);
      assertEquals(
        (note as { startTime: number }).startTime,
        42.0,
        "startTime must default to audioContext.currentTime",
      );
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // noteOff before note.ready
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] noteOff before note.ready resolves does not throw`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 50.0);
      const t = player.audioContext.currentTime;

      // Fire noteOff immediately without awaiting noteOn.
      const onPromise = channel.noteOn(60, 80, t);
      const offPromise = channel.noteOff(60, 0, t + 0.01, false);
      await Promise.all([onPromise, offPromise]);
      await flushNotePromises(player);
    },
  );

  // -----------------------------------------------------------------------
  // processActiveNotes — ending=true skipped
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] processActiveNotes skips notes with ending=true`,
    sanOptions,
    async () => {
      const player = makePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 60.0);
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
