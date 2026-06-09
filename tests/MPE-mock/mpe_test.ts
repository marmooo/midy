/**
 * MPE zone and routing tests
 *
 * Covers: zone activation/deactivation, mpeState.channelToNotes lifecycle,
 * noteOn/noteOff MPE routing, pedal behaviour on member channels,
 * manager-to-member propagation of pitchBend/channelPressure/programChange.
 *
 * What is NOT covered here:
 *   - Basic noteOn/noteOff lifecycle   → tests/MPE-mock/note_test.ts
 *   - Non-MPE pedal behaviour          → tests/MPE-mock/pedal_test.ts
 *   - Channel CC state updates         → tests/MPE-mock/channel_test.ts
 */
import {
  activateLowerMPEZone,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  flushNotePromises,
  sanOptions,
  setMockCurrentTime,
  setupMidyPlayer,
} from "./setup.ts";

Deno.test(
  "Case 1: MPE — same note on two member channels stays isolated",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    player.mpeEnabled = true;
    const ch1 = player.channels[1];
    const ch2 = player.channels[2];
    ch1.isMPEMember = true;
    ch2.isMPEMember = true;
    setMockCurrentTime(player.audioContext, 20.0);
    const t = player.audioContext.currentTime;

    await Promise.all([
      ch1.noteOn(60, 100, t),
      ch2.noteOn(60, 110, t + 0.002),
    ]);
    ch1.setPitchBend(9000, t + 0.001);
    ch2.setPitchBend(4000, t + 0.003);

    assertEquals(ch1.activeNotes[60]?.length ?? 0, 1);
    assertEquals(ch2.activeNotes[60]?.length ?? 0, 1);
    assertNotEquals(ch1.state.pitchWheel, ch2.state.pitchWheel);
  },
);

Deno.test(
  "Case 2: MPE — player.noteOn registers note in mpeState.channelToNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 100.0);

    await player.noteOn(1, 60, 100, player.audioContext.currentTime);
    await flushNotePromises(player);

    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(notes, undefined);
    assertEquals(notes!.size, 1);
    const [note] = notes!;
    assertEquals(note.noteNumber, 60);
    assertEquals(note.ending, false);
  },
);

Deno.test(
  "Case 3: MPE — player.noteOff cleans up mpeState.channelToNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 110.0);
    const t = player.audioContext.currentTime;

    await player.noteOn(1, 60, 100, t);
    await player.noteOff(1, 60, 0, t + 0.1, false);
    await flushNotePromises(player);

    assertEquals(player.mpeState.channelToNotes.has(1), false);
  },
);

Deno.test(
  "Case 4: MPE — player.noteOff before audio load still marks note as ending",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 120.0);
    const t = player.audioContext.currentTime;

    const noteOnPromise = player.noteOn(1, 64, 90, t);
    await player.noteOff(1, 64, 0, t + 0.001, false);
    await noteOnPromise;
    await flushNotePromises(player);

    assertEquals(player.mpeState.channelToNotes.has(1), false);
    const stack = player.channels[1].activeNotes[64];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
  },
);

Deno.test(
  "Case 5: MPE — noteOff on ch1 does not affect the note on ch2",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 130.0);
    const t = player.audioContext.currentTime;

    await Promise.all([
      player.noteOn(1, 60, 100, t),
      player.noteOn(2, 60, 110, t + 0.001),
    ]);
    await player.noteOff(1, 60, 0, t + 0.1, false);
    await flushNotePromises(player);

    assertEquals(player.mpeState.channelToNotes.has(1), false);
    const ch2Notes = player.mpeState.channelToNotes.get(2);
    assertNotEquals(ch2Notes, undefined);
    assertEquals(ch2Notes!.size, 1);
    const [ch2Note] = ch2Notes!;
    assertEquals(ch2Note.ending, false);
  },
);

Deno.test(
  "Case 6: MPE zone activation flags channels correctly",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);

    assertEquals(player.mpeEnabled, true);
    assertEquals(player.channels[0].isMPEManager, true);
    assertEquals(player.channels[0].isMPEMember, false);
    for (let ch = 1; ch <= 3; ch++) {
      assertEquals(player.channels[ch].isMPEMember, true);
      assertEquals(player.channels[ch].isMPEManager, false);
    }
    for (let ch = 4; ch <= 15; ch++) {
      assertEquals(player.channels[ch].isMPEMember, false);
      assertEquals(player.channels[ch].isMPEManager, false);
    }
  },
);

Deno.test(
  "Case 7: MPE zone deactivation clears all channel flags",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    player.setMIDIPolyphonicExpression(0, 0);

    assertEquals(player.mpeEnabled, false);
    for (let ch = 0; ch < 16; ch++) {
      assertEquals(player.channels[ch].isMPEMember, false);
      assertEquals(player.channels[ch].isMPEManager, false);
    }
  },
);

Deno.test(
  "Case 8: MPE — sustain pedal on member channel defers player.noteOff",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 140.0);
    const t = player.audioContext.currentTime;

    await player.channels[1].setSustainPedal(127, t);
    await player.noteOn(1, 60, 100, t);
    await player.noteOff(1, 60, 0, t + 0.05, false);
    await flushNotePromises(player);

    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(notes, undefined);
    const [note] = notes!;
    assertEquals(note.ending, false);
  },
);

Deno.test(
  "Case 9: Upper MPE zone flags ch 15 as manager and ch 13-14 as members",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    player.setMIDIPolyphonicExpression(15, 3);

    assertEquals(player.mpeEnabled, true);
    assertEquals(player.channels[15].isMPEManager, true);
    assertEquals(player.channels[15].isMPEMember, false);
    for (let ch = 13; ch <= 14; ch++) {
      assertEquals(player.channels[ch].isMPEMember, true);
      assertEquals(player.channels[ch].isMPEManager, false);
    }
    for (let ch = 0; ch <= 12; ch++) {
      assertEquals(player.channels[ch].isMPEMember, false);
      assertEquals(player.channels[ch].isMPEManager, false);
    }
  },
);

Deno.test(
  "Case 10: Lower and upper MPE zones can be active simultaneously",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    player.setMIDIPolyphonicExpression(0, 2);
    player.setMIDIPolyphonicExpression(15, 2);

    assertEquals(player.channels[0].isMPEManager, true);
    assertEquals(player.channels[15].isMPEManager, true);
    for (const ch of [1, 2]) {
      assertEquals(player.channels[ch].isMPEMember, true);
    }
    assertEquals(player.channels[14].isMPEMember, true);
    for (const ch of [3, 4, 11, 12, 13]) {
      assertEquals(player.channels[ch].isMPEMember, false);
    }
  },
);

Deno.test(
  "Case 11: MPE — noteOff for wrong note number leaves active note untouched",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 190.0);
    const t = player.audioContext.currentTime;

    await player.noteOn(1, 60, 100, t);
    await player.noteOff(1, 64, 0, t + 0.05, false);
    await flushNotePromises(player);

    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(notes, undefined);
    const [note] = notes!;
    assertEquals(note.noteNumber, 60);
    assertEquals(note.ending, false);
  },
);

Deno.test(
  "Case 12: resetAllStates clears mpeState.channelToNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 200.0);
    const t = player.audioContext.currentTime;

    await Promise.all([
      player.noteOn(1, 60, 100, t),
      player.noteOn(2, 64, 100, t),
    ]);
    player.resetAllStates();

    assertEquals(player.mpeState.channelToNotes.size, 0);
  },
);

Deno.test(
  "Case 13: MPE — noteOff targets the non-ending note in a multi-entry Set",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 210.0);
    const t = player.audioContext.currentTime;

    await player.noteOn(1, 60, 100, t);
    const notesSet = player.mpeState.channelToNotes.get(1)!;
    const [firstNote] = notesSet;
    firstNote.ending = true;

    await player.noteOn(1, 60, 110, t + 0.01);
    await player.noteOff(1, 60, 0, t + 0.1, false);
    await flushNotePromises(player);

    const remaining = player.mpeState.channelToNotes.get(1);
    const hasNonEnding = remaining
      ? [...remaining].some((n) => !n.ending)
      : false;
    assertEquals(hasNonEnding, false);
  },
);

Deno.test(
  "Case 14: pitchBend on MPE manager channel propagates to all member channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 230.0);
    const t = player.audioContext.currentTime;

    const defaultPitch = player.channels[0].state.pitchWheel;
    player.setPitchBend(0, 10000, t);

    const expected = 10000 / 16383;
    for (let ch = 0; ch <= 3; ch++) {
      assertAlmostEquals(player.channels[ch].state.pitchWheel, expected, 1e-6);
    }
    for (let ch = 4; ch <= 15; ch++) {
      assertAlmostEquals(
        player.channels[ch].state.pitchWheel,
        defaultPitch,
        1e-6,
      );
    }
  },
);

Deno.test(
  "Case 15: pitchBend on MPE member channel does not propagate to other channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 240.0);
    const t = player.audioContext.currentTime;

    const defaultPitch = player.channels[0].state.pitchWheel;
    player.setPitchBend(2, 6000, t);

    assertAlmostEquals(player.channels[2].state.pitchWheel, 6000 / 16383, 1e-6);
    for (const ch of [0, 1, 3]) {
      assertAlmostEquals(
        player.channels[ch].state.pitchWheel,
        defaultPitch,
        1e-6,
      );
    }
  },
);

Deno.test(
  "Case 16: MPE — player.noteOff with force=true ignores sustain pedal",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 330.0);
    const t = player.audioContext.currentTime;

    await player.channels[1].setSustainPedal(127, t);
    await player.noteOn(1, 60, 100, t);
    await player.noteOff(1, 60, 0, t + 0.05, true);
    await flushNotePromises(player);

    const stack = player.channels[1].activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
    assertEquals(player.mpeState.channelToNotes.has(1), false);
  },
);

Deno.test(
  "Case 17: MPE — sostenutoPedal defers player.noteOff on member channel",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 390.0);
    const t = player.audioContext.currentTime;

    player.channels[1].state.sostenutoPedal = 1;
    await player.noteOn(1, 60, 100, t);
    await player.noteOff(1, 60, 0, t + 0.05, false);
    await flushNotePromises(player);

    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(notes, undefined);
    const [note] = notes!;
    assertEquals(note.ending, false);
  },
);

Deno.test(
  "Case 18: MPE — player.setProgramChange on manager propagates to members",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);

    player.setProgramChange(0, 42);

    for (let ch = 0; ch <= 3; ch++) {
      assertEquals(player.channels[ch].programNumber, 42);
    }
    for (let ch = 4; ch <= 15; ch++) {
      assertNotEquals(player.channels[ch].programNumber, 42);
    }
  },
);

Deno.test(
  "Case 19: MPE — player.setChannelPressure on manager propagates to members",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 450.0);
    const t = player.audioContext.currentTime;

    player.setChannelPressure(0, 64, t);

    for (let ch = 0; ch <= 3; ch++) {
      assertAlmostEquals(
        player.channels[ch].state.channelPressure,
        64 / 127,
        1e-6,
      );
    }
    for (let ch = 4; ch <= 15; ch++) {
      assertNotEquals(player.channels[ch].state.channelPressure, 64 / 127);
    }
  },
);
