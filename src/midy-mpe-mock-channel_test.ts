/**
 * Channel state, CC, and reset tests
 *
 * Covers: allNotesOff, resetAllStates, resetAllControllers, exclusiveClass,
 * setChannelPressure, setProgramChange, setPolyphonicKeyPressure,
 * setModulationDepth, setBankMSB/LSB, setExpression, setSoftPedal,
 * setFineTuning, setCoarseTuning, setVolume, setPan, setPortamento,
 * setReverbSendLevel, setChorusSendLevel, setPortamentoNoteNumber,
 * resetChannelStates.
 *
 * What is NOT covered here:
 *   - Pedal lifecycle          → midy-mpe-mock-pedal_test.ts
 *   - MPE-specific propagation → midy-mpe-mock-mpe_test.ts
 *   - RPN/data entry           → midy-mpe-mock-rpn_test.ts
 */
import {
  assertEquals,
  assertAlmostEquals,
  assertNotEquals,
  flushNotePromises,
  makeDefaultVoiceParams,
  sanOptions,
  setMockCurrentTime,
  setupMidyPlayer,
} from "./midy-mpe-mock-setup.ts";

Deno.test(
  "Case 1: allNotesOff clears all active notes on the channel",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[4];
    setMockCurrentTime(player.audioContext, 40.0);
    const t = player.audioContext.currentTime;

    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
      channel.noteOn(67, 100, t),
    ]);
    await channel.allNotesOff(t + 0.1);
    await flushNotePromises(player);

    for (let n = 0; n < 128; n++) {
      for (const note of channel.activeNotes[n] ?? []) {
        assertEquals(note.ending, true);
      }
    }
  },
);

Deno.test(
  "Case 2: resetAllStates clears activeNotes, sustainNotes, and sostenutoNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const ch1 = player.channels[1];
    const ch2 = player.channels[2];
    setMockCurrentTime(player.audioContext, 260.0);
    const t = player.audioContext.currentTime;

    await ch1.setSustainPedal(127, t);
    await ch1.noteOn(60, 100, t);
    ch2.state.sostenutoPedal = 1;
    await ch2.noteOn(64, 100, t);

    player.resetAllStates();

    for (let ch = 0; ch < 16; ch++) {
      const channel = player.channels[ch];
      let hasNote = false;
      for (let n = 0; n < 128; n++) {
        if (channel.activeNotes[n]) { hasNote = true; break; }
      }
      assertEquals(hasNote, false);
      assertEquals(channel.sustainNotes.length, 0);
      assertEquals(channel.sostenutoNotes.length, 0);
    }
  },
);

Deno.test(
  "Case 3: exclusiveClass — new note forces previous same-class note to end",
  sanOptions,
  async () => {
    const player = setupMidyPlayer(1);
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 270.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    const firstNote = channel.activeNotes[60]?.[0];
    assertNotEquals(firstNote, undefined);

    await channel.noteOn(62, 100, t + 0.05);
    await flushNotePromises(player);

    assertEquals(firstNote!.ending, true);
    assertEquals(channel.activeNotes[62]?.[0]?.ending, false);
  },
);

Deno.test(
  "Case 4: resetAllControllers restores sustainPedal, sostenutoPedal, and pitchWheel to defaults",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 300.0);
    const t = player.audioContext.currentTime;

    channel.setSustainPedal(127, t);
    channel.setPitchBend(10000, t);
    channel.resetAllControllers(t);

    assertEquals(channel.state.sustainPedal, 0);
    assertEquals(channel.state.sostenutoPedal, 0);
    assertAlmostEquals(channel.state.pitchWheel, 8192 / 16383, 1e-6);
  },
);

Deno.test(
  "Case 5: setChannelPressure updates state and ignores drum channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const melodic = player.channels[1];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 310.0);
    const t = player.audioContext.currentTime;

    melodic.setChannelPressure(64, t);
    assertAlmostEquals(melodic.state.channelPressure, 64 / 127, 1e-6);

    const prevDrum = drum.state.channelPressure;
    drum.setChannelPressure(64, t);
    assertEquals(drum.state.channelPressure, prevDrum);
  },
);

Deno.test(
  "Case 6: setProgramChange updates channel programNumber",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];

    channel.setProgramChange(42);
    assertEquals(channel.programNumber, 42);

    channel.setProgramChange(0);
    assertEquals(channel.programNumber, 0);
  },
);

Deno.test(
  "Case 7: exclusiveClass eviction works across different channels",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    player.soundFonts[0] = {
      getVoice: () => ({
        generators: { instrument: 0, sampleID: 0 },
        getParams: () => ({}),
        getAllParams: () => makeDefaultVoiceParams(2),
      }),
    } as unknown as import("@marmooo/soundfont-parser").SoundFont;

    setMockCurrentTime(player.audioContext, 320.0);
    const t = player.audioContext.currentTime;

    await player.channels[1].noteOn(60, 100, t);
    const firstNote = player.channels[1].activeNotes[60]?.[0];
    assertNotEquals(firstNote, undefined);

    await player.channels[2].noteOn(64, 100, t + 0.05);
    await flushNotePromises(player);

    assertEquals(firstNote!.ending, true);
    assertEquals(player.channels[2].activeNotes[64]?.[0]?.ending, false);
  },
);

Deno.test(
  "Case 8: setPolyphonicKeyPressure updates pressure on the target note only",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 360.0);
    const t = player.audioContext.currentTime;

    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
    ]);
    channel.setPolyphonicKeyPressure(60, 80, t);
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(channel.activeNotes[60]?.[0]?.pressure, 80);
    assertEquals(channel.activeNotes[64]?.[0]?.pressure, 0);
  },
);

Deno.test(
  "Case 9: setModulationDepth updates state and ignores drum channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const melodic = player.channels[1];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 370.0);
    const t = player.audioContext.currentTime;

    melodic.setModulationDepth(64, t);
    assertAlmostEquals(melodic.state.modulationDepthMSB, Math.trunc(64) / 127, 1e-6);

    const prev = drum.state.modulationDepthMSB;
    drum.setModulationDepth(64, t);
    assertEquals(drum.state.modulationDepthMSB, prev);
  },
);

Deno.test(
  "Case 10: setBankMSB updates channel bankMSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    player.channels[1].setBankMSB(8);
    assertEquals(player.channels[1].bankMSB, 8);
    player.channels[1].setBankMSB(0);
    assertEquals(player.channels[1].bankMSB, 0);
  },
);

Deno.test(
  "Case 11: setBankLSB updates channel bankLSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    player.channels[1].setBankLSB(3);
    assertEquals(player.channels[1].bankLSB, 3);
    player.channels[1].setBankLSB(0);
    assertEquals(player.channels[1].bankLSB, 0);
  },
);

Deno.test(
  "Case 12: setExpression updates expressionMSB state",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 400.0);
    const t = player.audioContext.currentTime;

    channel.setExpression(64, t);
    assertAlmostEquals(channel.state.expressionMSB, Math.trunc(64) / 127, 1e-6);
    assertAlmostEquals(channel.state.expressionLSB, 64 - Math.trunc(64), 1e-9);
  },
);

Deno.test(
  "Case 13: setSoftPedal updates state and ignores drum channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const melodic = player.channels[1];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 410.0);
    const t = player.audioContext.currentTime;

    melodic.setSoftPedal(64, t);
    assertAlmostEquals(melodic.state.softPedal, 64 / 127, 1e-6);

    const prev = drum.state.softPedal;
    drum.setSoftPedal(64, t);
    assertEquals(drum.state.softPedal, prev);
  },
);

Deno.test(
  "Case 14: setFineTuning accumulates correctly into channel detune",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 420.0);
    const t = player.audioContext.currentTime;
    const base = channel.detune;

    channel.setFineTuning(50, t);
    assertAlmostEquals(channel.fineTuning, 50, 1e-9);
    assertAlmostEquals(channel.detune, base + 50, 1e-9);

    channel.setFineTuning(30, t);
    assertAlmostEquals(channel.fineTuning, 30, 1e-9);
    assertAlmostEquals(channel.detune, base + 30, 1e-9);

    const drum = player.channels[9];
    drum.isDrum = true;
    const prevDrum = drum.detune;
    drum.setFineTuning(50, t);
    assertEquals(drum.detune, prevDrum);
  },
);

Deno.test(
  "Case 15: setCoarseTuning accumulates correctly into channel detune",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 430.0);
    const t = player.audioContext.currentTime;
    const base = channel.detune;

    channel.setCoarseTuning(100, t);
    assertAlmostEquals(channel.coarseTuning, 100, 1e-9);
    assertAlmostEquals(channel.detune, base + 100, 1e-9);

    channel.setCoarseTuning(-200, t);
    assertAlmostEquals(channel.coarseTuning, -200, 1e-9);
    assertAlmostEquals(channel.detune, base - 200, 1e-9);

    const drum = player.channels[9];
    drum.isDrum = true;
    const prevDrum = drum.detune;
    drum.setCoarseTuning(100, t);
    assertEquals(drum.detune, prevDrum);
  },
);

Deno.test(
  "Case 16: setVolume updates volumeMSB and volumeLSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 470.0);
    channel.setVolume(64, player.audioContext.currentTime);
    assertAlmostEquals(channel.state.volumeMSB, Math.trunc(64) / 127, 1e-6);
    assertAlmostEquals(channel.state.volumeLSB, 64 - Math.trunc(64), 1e-9);
  },
);

Deno.test(
  "Case 17: setPan updates panMSB and panLSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 480.0);
    channel.setPan(96, player.audioContext.currentTime);
    assertAlmostEquals(channel.state.panMSB, Math.trunc(96) / 127, 1e-6);
    assertAlmostEquals(channel.state.panLSB, 96 - Math.trunc(96), 1e-9);
  },
);

Deno.test(
  "Case 18: setPortamento updates state and ignores drum channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const melodic = player.channels[1];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 490.0);
    const t = player.audioContext.currentTime;

    melodic.setPortamento(64, t);
    assertAlmostEquals(melodic.state.portamento, 64 / 127, 1e-6);

    const prev = drum.state.portamento;
    drum.setPortamento(64, t);
    assertEquals(drum.state.portamento, prev);
  },
);

Deno.test(
  "Case 19: setReverbSendLevel updates reverbSendLevel state",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 500.0);
    channel.setReverbSendLevel(100, player.audioContext.currentTime);
    assertAlmostEquals(channel.state.reverbSendLevel, 100 / 127, 1e-6);
  },
);

Deno.test(
  "Case 20: setChorusSendLevel updates chorusSendLevel state",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 510.0);
    channel.setChorusSendLevel(80, player.audioContext.currentTime);
    assertAlmostEquals(channel.state.chorusSendLevel, 80 / 127, 1e-6);
  },
);

Deno.test(
  "Case 21: setPortamentoNoteNumber sets portamentoControl flag and note number",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];

    assertEquals(channel.portamentoControl, false);
    channel.setPortamentoNoteNumber(60);
    assertEquals(channel.portamentoControl, true);
    assertAlmostEquals(channel.state.portamentoNoteNumber, 60 / 127, 1e-6);
  },
);

Deno.test(
  "Case 22: resetChannelStates resets detune, programNumber, fineTuning, and coarseTuning",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 520.0);
    const t = player.audioContext.currentTime;

    // bankMSB and bankLSB are NOT in channelSettings so resetChannelStates
    // does not touch them — that is by design (bank selection persists).
    channel.setProgramChange(42);
    channel.setFineTuning(50, t);
    channel.setCoarseTuning(100, t);

    channel.resetChannelStates();

    assertEquals(channel.programNumber, 0, "programNumber must be reset to 0");
    assertAlmostEquals(channel.fineTuning, 0, 1e-9, "fineTuning must be reset to 0");
    assertAlmostEquals(channel.coarseTuning, 0, 1e-9, "coarseTuning must be reset to 0");
    assertAlmostEquals(channel.detune, 0, 1e-9, "detune must be reset to 0");
  },
);
