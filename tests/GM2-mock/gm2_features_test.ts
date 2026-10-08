/**
 * GM2-only channel features not covered by the shared basic-mock suite.
 *
 * Covers: bank select, soft pedal, sostenuto, portamento switch/time,
 * reverb/chorus send, channel pressure, drum-channel guards.
 */
import {
  assertAlmostEquals,
  assertEquals,
  flushNotePromises,
  sanOptions,
  setMockCurrentTime,
  setupGM2Player,
} from "./setup.ts";
import type { Channel } from "./setup.ts";

Deno.test(
  "[GM2] CC#0 bankMSB / CC#32 bankLSB update channel banks",
  sanOptions,
  () => {
    const player = setupGM2Player();
    const channel = player.channels[0];
    setMockCurrentTime(player.audioContext, 1.0);
    const t = player.audioContext.currentTime;

    channel.setControlChange(0, 8, t);
    assertEquals(channel.bankMSB, 8);

    channel.setControlChange(32, 3, t);
    assertEquals(channel.bankLSB, 3);

    channel.setBankMSB(0);
    channel.setBankLSB(0);
    assertEquals(channel.bankMSB, 0);
    assertEquals(channel.bankLSB, 0);
  },
);

Deno.test(
  "[GM2] CC#67 softPedal updates state; ignored on drum channel",
  sanOptions,
  () => {
    const player = setupGM2Player();
    const melodic = player.channels[0];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 2.0);
    const t = player.audioContext.currentTime;

    melodic.setControlChange(67, 100, t);
    assertAlmostEquals(melodic.state.softPedal, 100 / 127, 1e-6);

    const prev = drum.state.softPedal;
    drum.setControlChange(67, 100, t);
    assertEquals(drum.state.softPedal, prev, "drum channel ignores soft pedal");
  },
);

Deno.test(
  "[GM2] CC#65 portamento switch updates state; ignored on drum",
  sanOptions,
  () => {
    const player = setupGM2Player();
    const melodic = player.channels[0];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 3.0);
    const t = player.audioContext.currentTime;

    melodic.setControlChange(65, 127, t);
    assertAlmostEquals(melodic.state.portamento, 1.0, 1e-6);

    const prev = drum.state.portamento;
    drum.setControlChange(65, 127, t);
    assertEquals(drum.state.portamento, prev);
  },
);

Deno.test(
  "[GM2] CC#5 portamento time updates state.portamentoTimeMSB",
  sanOptions,
  () => {
    const player = setupGM2Player();
    const channel = player.channels[0];
    setMockCurrentTime(player.audioContext, 4.0);
    const t = player.audioContext.currentTime;

    channel.setControlChange(5, 64, t);
    assertAlmostEquals(channel.state.portamentoTimeMSB, 64 / 127, 1e-6);
  },
);

Deno.test(
  "[GM2] CC#91 reverb / CC#93 chorus send levels",
  sanOptions,
  () => {
    const player = setupGM2Player();
    const channel = player.channels[0];
    setMockCurrentTime(player.audioContext, 5.0);
    const t = player.audioContext.currentTime;

    channel.setControlChange(91, 40, t);
    assertAlmostEquals(channel.state.reverbSendLevel, 40 / 127, 1e-6);

    channel.setControlChange(93, 80, t);
    assertAlmostEquals(channel.state.chorusSendLevel, 80 / 127, 1e-6);
  },
);

Deno.test(
  "[GM2] setChannelPressure updates state.channelPressure",
  sanOptions,
  () => {
    const player = setupGM2Player();
    const channel = player.channels[0];
    setMockCurrentTime(player.audioContext, 6.0);
    const t = player.audioContext.currentTime;

    channel.setChannelPressure(90, t);
    assertAlmostEquals(channel.state.channelPressure, 90 / 127, 1e-6);
  },
);

Deno.test(
  "[GM2] handleMessage channel pressure (0xD0)",
  sanOptions,
  () => {
    const player = setupGM2Player();
    setMockCurrentTime(player.audioContext, 7.0);
    const t = player.audioContext.currentTime;

    player.handleMessage(new Uint8Array([0xD0, 77]), t);
    assertAlmostEquals(player.channels[0].state.channelPressure, 77 / 127, 1e-6);

    // channel 2 (0xD2)
    player.handleMessage(new Uint8Array([0xD2, 10]), t);
    assertAlmostEquals(player.channels[2].state.channelPressure, 10 / 127, 1e-6);
  },
);

Deno.test(
  "[GM2] sostenuto captures active notes; noteOff is deferred",
  sanOptions,
  async () => {
    const player = setupGM2Player();
    const channel = player.channels[0] as Channel;
    setMockCurrentTime(player.audioContext, 10.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    await channel.noteOn(64, 100, t);
    await channel.setSostenutoPedal(127, t + 0.01);
    await flushNotePromises(player);

    assertEquals(
      channel.sostenutoNotes.length >= 2,
      true,
      "active notes captured into sostenutoNotes",
    );
    assertEquals(channel.state.sostenutoPedal >= 0.5, true);

    await channel.noteOff(60, 0, t + 0.1, false);
    await flushNotePromises(player);

    // Captured note must still be held (not ending).
    const stack60 = channel.activeNotes[60];
    assertEquals(
      stack60 !== undefined && stack60.length > 0 && !stack60[0].ending,
      true,
      "sostenuto must defer noteOff of captured notes",
    );
  },
);

Deno.test(
  "[GM2] sostenuto does not capture notes played after pedal down",
  sanOptions,
  async () => {
    const player = setupGM2Player();
    const channel = player.channels[0] as Channel;
    setMockCurrentTime(player.audioContext, 11.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    await channel.setSostenutoPedal(127, t + 0.01);
    await flushNotePromises(player);

    await channel.noteOn(67, 100, t + 0.02);
    await channel.noteOff(67, 0, t + 0.1, false);
    await flushNotePromises(player);

    const stack67 = channel.activeNotes[67];
    assertEquals(
      stack67 === undefined || stack67.length === 0 || stack67[0].ending,
      true,
      "notes started after sostenuto down are not held",
    );

    // Original captured note still held after its noteOff.
    await channel.noteOff(60, 0, t + 0.15, false);
    await flushNotePromises(player);
    const stack60 = channel.activeNotes[60];
    assertEquals(
      stack60 !== undefined && stack60.length > 0 && !stack60[0].ending,
      true,
      "pre-sostenuto note still held",
    );
  },
);

Deno.test(
  "[GM2] lifting sostenuto releases captured notes",
  sanOptions,
  async () => {
    const player = setupGM2Player();
    const channel = player.channels[0] as Channel;
    setMockCurrentTime(player.audioContext, 12.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    await channel.setSostenutoPedal(127, t + 0.01);
    await channel.noteOff(60, 0, t + 0.05, false);
    await flushNotePromises(player);

    assertEquals(channel.activeNotes[60]?.[0]?.ending, false);

    await channel.setSostenutoPedal(0, t + 0.1);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    assertEquals(
      stack === undefined || stack.length === 0 || stack[0].ending,
      true,
      "sostenuto up must release captured notes that already received noteOff",
    );
  },
);

Deno.test(
  "[GM2] drum channel ignores sostenuto pedal",
  sanOptions,
  async () => {
    const player = setupGM2Player();
    const channel = player.channels[9] as Channel;
    channel.isDrum = true;
    setMockCurrentTime(player.audioContext, 13.0);
    const t = player.audioContext.currentTime;

    const before = channel.state.sostenutoPedal;
    await channel.setSostenutoPedal(127, t);
    assertEquals(channel.state.sostenutoPedal, before);
    assertEquals(channel.sostenutoNotes.length, 0);
  },
);

Deno.test(
  "[GM2] resetAllControllers clears sostenuto / soft / portamento",
  sanOptions,
  async () => {
    const player = setupGM2Player();
    const channel = player.channels[0];
    setMockCurrentTime(player.audioContext, 14.0);
    const t = player.audioContext.currentTime;

    channel.setControlChange(65, 127, t);
    channel.setControlChange(67, 100, t);
    await channel.setSostenutoPedal(127, t);
    channel.resetAllControllers(t);

    assertAlmostEquals(channel.state.portamento, 0, 1e-6);
    assertAlmostEquals(channel.state.softPedal, 0, 1e-6);
    assertAlmostEquals(channel.state.sostenutoPedal, 0, 1e-6);
    await flushNotePromises(player);
  },
);

Deno.test(
  "[GM2] bank select is independent per channel",
  sanOptions,
  () => {
    const player = setupGM2Player();
    player.channels[0].setBankMSB(1);
    player.channels[1].setBankMSB(2);
    player.channels[0].setBankLSB(10);
    player.channels[1].setBankLSB(20);

    assertEquals(player.channels[0].bankMSB, 1);
    assertEquals(player.channels[1].bankMSB, 2);
    assertEquals(player.channels[0].bankLSB, 10);
    assertEquals(player.channels[1].bankLSB, 20);
  },
);

Deno.test(
  "[GM2] stacked notes under sostenuto: force noteOff still FIFO",
  sanOptions,
  async () => {
    const player = setupGM2Player();
    const channel = player.channels[0] as Channel;
    setMockCurrentTime(player.audioContext, 15.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 50, t);
    await channel.noteOn(60, 100, t + 0.01);
    // Sostenuto holds them so normal noteOff would defer; force bypasses.
    await channel.setSostenutoPedal(127, t + 0.02);
    await flushNotePromises(player);

    await channel.noteOff(60, 0, t + 0.1, true);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    // force releases oldest group even under sostenuto path differences;
    // remaining younger note (if any) stays.
    assertEquals(
      stack === undefined || stack.length <= 1,
      true,
      "force noteOff under sostenuto must not leave both notes active",
    );
  },
);
