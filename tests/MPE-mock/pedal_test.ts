/**
 * Pedal tests
 *
 * Covers: sustain pedal defer/release, sostenuto pedal capture/release,
 * allSoundOff vs allNotesOff with pedal, resetAllControllers + pedal.
 *
 * What is NOT covered here:
 *   - MPE-specific pedal behaviour  → tests/MPE-mock/mpe_test.ts
 *   - Pedal state after reset        → tess/MPE-mock/channel_test.ts
 */
import {
  assertEquals,
  assertNotEquals,
  captureSostenutoNotes,
  flushNotePromises,
  Note,
  sanOptions,
  setMockCurrentTime,
  setupMidyPlayer,
} from "./setup.ts";
Deno.test(
  "Case 1: Sustain pedal defers noteOff (note stays alive)",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[5];
    setMockCurrentTime(player.audioContext, 50.0);
    const t = player.audioContext.currentTime;

    await channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    await channel.noteOff(60, 0, t + 0.05);
    await flushNotePromises(player);

    const note = channel.activeNotes[60]?.[0];
    assertNotEquals(note, undefined);
    assertEquals(note?.ending, false);
  },
);

Deno.test(
  "Case 2: Forced noteOff terminates note regardless of sustain pedal",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[7];
    setMockCurrentTime(player.audioContext, 70.0);
    const t = player.audioContext.currentTime;

    await channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    await channel.noteOff(60, 0, t + 0.05, true);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
  },
);

Deno.test(
  "Case 3: Lifting sustain pedal releases deferred note",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 150.0);
    const t = player.audioContext.currentTime;

    await channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    await channel.noteOff(60, 0, t + 0.05);
    assertEquals(channel.activeNotes[60]?.[0]?.ending, false);

    channel.setSustainPedal(0, t + 0.1);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
  },
);

Deno.test(
  "Case 4: Sostenuto pedal holds pre-existing notes but not new ones",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 160.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    await captureSostenutoNotes(channel, t + 0.01);

    await channel.noteOn(64, 100, t + 0.02);
    await channel.noteOff(60, 0, t + 0.1);
    await channel.noteOff(64, 0, t + 0.1);
    await flushNotePromises(player);

    assertEquals(channel.activeNotes[60]?.[0]?.ending, false);
    const stack64 = channel.activeNotes[64];
    const last64 = stack64 ? stack64[stack64.length - 1] : undefined;
    assertEquals(last64 ? last64.ending : true, true);
  },
);

Deno.test(
  "Case 5: allSoundOff cuts notes even while sustain pedal is held",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 170.0);
    const t = player.audioContext.currentTime;

    await channel.setSustainPedal(127, t);
    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
    ]);
    await channel.allSoundOff(t + 0.05);
    await flushNotePromises(player);

    for (let n = 0; n < 128; n++) {
      for (const note of channel.activeNotes[n] ?? []) {
        assertEquals(note.ending, true);
      }
    }
  },
);

Deno.test(
  "Case 6: Lifting sostenuto pedal releases captured notes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 250.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    await captureSostenutoNotes(channel, t + 0.01);

    await channel.noteOff(60, 0, t + 0.05);
    await flushNotePromises(player);
    assertEquals(channel.activeNotes[60]?.[0]?.ending, false);

    const before = player.notePromises.length;
    channel.setSostenutoPedal(0, t + 0.1);
    await Promise.resolve();
    await Promise.allSettled(player.notePromises.slice(before));
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
  },
);

Deno.test(
  "Case 7: allNotesOff releases sustain-held notes (RP-015)",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 340.0);
    const t = player.audioContext.currentTime;
    await channel.setSustainPedal(127, t);
    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
    ]);
    await channel.allNotesOff(t + 0.1);
    await flushNotePromises(player);
    for (const nn of [60, 64]) {
      const stack = channel.activeNotes[nn];
      assertEquals(
        stack === undefined || stack.length === 0,
        true,
        `note ${nn} must be released by allNotesOff per RP-015`,
      );
    }
  },
);

Deno.test(
  "Case 8: resetAllControllers releases sustainNotes by resetting the pedal",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 380.0);
    const t = player.audioContext.currentTime;

    await channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    await channel.noteOff(60, 0, t + 0.05);
    assertEquals(channel.activeNotes[60]?.[0]?.ending, false);

    channel.resetAllControllers(t + 0.1);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(lastNote ? lastNote.ending : true, true);
  },
);

Deno.test(
  "Case 9: sustainNotes is populated when pedal is pressed after noteOn",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 460.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    await channel.setSustainPedal(127, t + 0.01);

    assertEquals(
      channel.sustainNotes.some((n: Note) => n.noteNumber === 60),
      true,
    );
  },
);

Deno.test(
  "Case 10: Double sustain pedal press does not duplicate sustainNotes entries",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 540.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);
    await channel.setSustainPedal(127, t + 0.01);
    const countAfterFirst =
      channel.sustainNotes.filter((n: Note) => n.noteNumber === 60).length;

    await channel.setSustainPedal(127, t + 0.02);
    const countAfterSecond =
      channel.sustainNotes.filter((n: Note) => n.noteNumber === 60).length;

    assertEquals(countAfterFirst, 1);
    assertEquals(countAfterSecond, 1);
  },
);

Deno.test(
  "Case 11: setSostenutoPedal on drum channel is ignored",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 560.0);
    const t = player.audioContext.currentTime;

    await drum.noteOn(38, 100, t);
    await drum.setSostenutoPedal(127, t + 0.01);

    // Drum must have no sostenuto notes captured.
    assertEquals(
      drum.sostenutoNotes.length,
      0,
      "drum must not capture sostenutoNotes",
    );
    assertEquals(
      drum.state.sostenutoPedal,
      0,
      "drum sostenutoPedal state must remain 0",
    );
  },
);

Deno.test(
  "Case 12: sostenuto + sustain held — sustain release does not affect sostenuto notes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 570.0);
    const t = player.audioContext.currentTime;

    // Start note 60, press sostenuto to capture it.
    await channel.noteOn(60, 100, t);
    await captureSostenutoNotes(channel, t + 0.01);

    // Also press sustain — note 60 enters sustainNotes too.
    await channel.setSustainPedal(127, t + 0.02);

    // Start note 64 after both pedals are held — captured by sustain only.
    await channel.noteOn(64, 100, t + 0.03);

    // Release both notes.
    await channel.noteOff(60, 0, t + 0.1);
    await channel.noteOff(64, 0, t + 0.1);
    await flushNotePromises(player);

    // Both notes still alive (held by their respective pedals).
    assertEquals(
      channel.activeNotes[60]?.[0]?.ending,
      false,
      "note 60 held by sostenuto",
    );
    assertEquals(
      channel.activeNotes[64]?.[0]?.ending,
      false,
      "note 64 held by sustain",
    );

    // Lift sustain only — note 64 must release, note 60 must stay
    // because releaseSustainPedal skips notes that are also in sostenutoNotes.
    channel.setSustainPedal(0, t + 0.2);
    await flushNotePromises(player);

    const stack64 = channel.activeNotes[64];
    const last64 = stack64 ? stack64[stack64.length - 1] : undefined;
    assertEquals(
      last64 ? last64.ending : true,
      true,
      "note 64 must release when sustain lifted",
    );
    assertEquals(
      channel.activeNotes[60]?.[0]?.ending,
      false,
      "note 60 must stay while sostenuto held",
    );
  },
);
