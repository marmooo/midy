/**
 * Note lifecycle tests
 *
 * Covers: noteOn/noteOff basic lifecycle, race conditions, stacking, drums.
 *
 * What is NOT covered here (see other files):
 *   - Pedal interaction during noteOff  → tests/MPE-mock/pedal_test.ts
 *   - MPE routing of noteOn/noteOff     → tests/MPE-mock/mpe_test.ts
 *   - exclusiveClass eviction           → tests/MPE-mock/channel_test.ts
 */
import {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  flushNotePromises,
  sanOptions,
  setMockCurrentTime,
  setupMidyPlayer,
} from "./setup.ts";

Deno.test(
  "Case 1: noteOff immediately after noteOn triggers release on the note",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 10.0);
    const t = player.audioContext.currentTime;

    const noteOnPromise = channel.noteOn(60, 100, t);
    const noteOffPromise = channel.noteOff(60, 0, t + 0.001);
    await Promise.all([noteOnPromise, noteOffPromise]);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
  },
);

Deno.test(
  "Case 2: noteOff before audio load completes still marks note as ending",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[2];
    setMockCurrentTime(player.audioContext, 15.0);
    const t = player.audioContext.currentTime;

    const noteOnPromise = channel.noteOn(64, 90, t);
    await channel.noteOff(64, 0, t + 0.002);
    await noteOnPromise;
    await flushNotePromises(player);

    const stack = channel.activeNotes[64];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
  },
);

Deno.test(
  "Case 3: Re-trigger after noteOff creates a fresh non-ending note",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[3];
    setMockCurrentTime(player.audioContext, 30.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(72, 100, t);
    await channel.noteOff(72, 0, t + 0.1);
    await flushNotePromises(player);
    await channel.noteOn(72, 110, t + 0.105);
    await flushNotePromises(player);

    const stack = channel.activeNotes[72];
    assertNotEquals(stack, undefined);
    assertEquals(stack![stack!.length - 1].ending, false);
  },
);

Deno.test(
  "Case 4: Polyphonic same-note stacking — two notes on the same pitch",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[6];
    setMockCurrentTime(player.audioContext, 60.0);
    const t = player.audioContext.currentTime;

    await Promise.all([
      channel.noteOn(60, 80, t),
      channel.noteOn(60, 90, t + 0.01),
    ]);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    assertNotEquals(stack, undefined);
    assertEquals(stack!.length, 2);
    assertEquals(stack![0].ending, false);
    assertEquals(stack![1].ending, false);
  },
);

Deno.test(
  "Case 5: noteOff with no active note is a safe no-op",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 180.0);

    await channel.noteOff(60, 0, player.audioContext.currentTime);
    await flushNotePromises(player);

    assertEquals(channel.activeNotes[60], undefined);
  },
);

Deno.test(
  "Case 6: Drum channel noteOff removes note immediately (no release path)",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[9];
    channel.isDrum = true;
    player.soundFontTable[0][128] = 0;
    setMockCurrentTime(player.audioContext, 220.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(38, 100, t);
    channel.setSustainPedal(127, t);
    channel.noteOff(38, 0, t + 0.01);
    await flushNotePromises(player);

    const alive = (channel.activeNotes[38] ?? []).filter((n) => !n.ending);
    assertEquals(alive.length, 0);
  },
);

Deno.test(
  "Case 7: Stacked same-pitch notes are released in FIFO order",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 350.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 80, t);
    await channel.noteOn(60, 90, t + 0.01);
    const [first, second] = channel.activeNotes[60]!;

    await channel.noteOff(60, 0, t + 0.1);
    await flushNotePromises(player);
    assertEquals(first.ending, true);
    assertEquals(second.ending, false);

    await channel.noteOff(60, 0, t + 0.2);
    await flushNotePromises(player);
    assertEquals(second.ending, true);
  },
);

Deno.test(
  "Case 8: noteOn with velocity 0 creates a note in activeNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 550.0);

    await channel.noteOn(60, 0, player.audioContext.currentTime);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    assertNotEquals(stack, undefined);
    assertEquals(stack!.length, 1);
    assertEquals(stack![0].velocity, 0);
    assertEquals(stack![0].ending, false);
  },
);

Deno.test(
  "Case 9: setPortamentoNoteNumber sets portamentoControl and portamentoNoteNumber state",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];

    assertEquals(
      channel.portamentoControl,
      false,
      "portamentoControl must start false",
    );
    channel.setPortamentoNoteNumber(60);
    assertEquals(
      channel.portamentoControl,
      true,
      "portamentoControl must be true after setPortamentoNoteNumber",
    );
    assertAlmostEquals(
      channel.state.portamentoNoteNumber,
      60 / 127,
      1e-6,
      "portamentoNoteNumber state must be updated",
    );
    // Note: portamentoControl is consumed inside setPortamentoDetune which is
    // called via applyVoiceParams — not reachable in the mock environment.
  },
);
