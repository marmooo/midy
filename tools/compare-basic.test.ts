// fluidsynth ↔ midy: basic note / exclusive-class scenarios.
//
// Usage:
//   deno test -A tools/compare-basic.test.ts
//
import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
import {
  buildClosedHatRetriggerMidi,
  buildHiHatExclusiveMidi,
} from "./gen-midi-scenarios.ts";
import {
  assertClosedHatRetrigger,
  assertExclusiveCut,
  assertNonEmptyFile,
  assertSingleNoteMatch,
  CACHE_MODES,
  checkSingleNoteWav,
  ensureFsBin,
  ensureOutDir,
  EXCL_ATTACK_END,
  EXCL_ATTACK_REL_DB,
  EXCL_ATTACK_START,
  EXCL_CLOSED_DURATION,
  EXCL_CLOSED_START,
  EXCL_OPEN_START,
  EXCL_POST_END,
  EXCL_POST_START,
  EXCL_PRE_END,
  EXCL_PRE_START,
  HARNESS_DIR,
  NOTE_DURATION,
  NOTE_NUMBER,
  NOTE_VELOCITY,
  OUT_DIR,
  peakRmsDb,
  readWav,
  renderMidyMode,
  renderWithFluidsynth,
  SAMPLE_RATE,
  SF2_PATH,
  type SingleNoteCheck,
  toMono,
  windowRmsDb,
} from "./compare-common.ts";

// ---------------------------------------------------------------------------
// Test 1: single melodic note
// ---------------------------------------------------------------------------
Deno.test("single-note GM2 conformance (sanity + fluidsynth compare)", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/single-note.mid`;

  await t.step("generate single-note MIDI", async () => {
    const bytes = buildSingleNoteMidi({
      noteNumber: NOTE_NUMBER,
      velocity: NOTE_VELOCITY,
      duration: NOTE_DURATION,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFsBin();
  });

  const fluidsynthWavPath = `${OUT_DIR}/fluidsynth-single.wav`;
  let refCheck: SingleNoteCheck | null = null;

  await t.step("render + sanity-check fluidsynth reference", async () => {
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath: fluidsynthWavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(fluidsynthWavPath);
    const bytes = await Deno.readFile(fluidsynthWavPath);
    refCheck = checkSingleNoteWav("fluidsynth", bytes);
    console.log(
      `  fluidsynth: onset=${refCheck.onsetTime.toFixed(3)}s sustain=${
        refCheck.sustainDb.toFixed(1)
      }dB pitch=${refCheck.pitchHz?.toFixed(1)}Hz (${
        refCheck.pitchCentsError?.toFixed(1)
      } cents)`,
    );
  });

  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/midy-single-${cacheMode}.wav`;

    await t.step(`render midy (cacheMode=${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        cacheMode,
        sampleRate: SAMPLE_RATE,
      });
      if (wavBytes.length === 0) {
        throw new Error(`midy (cacheMode=${cacheMode}) returned empty WAV`);
      }
      await Deno.writeFile(midyWavPath, wavBytes);
    });

    await t.step(
      `sanity + compare midy (${cacheMode}) vs fluidsynth`,
      async () => {
        const bytes = await Deno.readFile(midyWavPath);
        const cand = checkSingleNoteWav(`midy(${cacheMode})`, bytes);
        console.log(
          `  midy(${cacheMode}): onset=${cand.onsetTime.toFixed(3)}s sustain=${
            cand.sustainDb.toFixed(1)
          }dB pitch=${cand.pitchHz?.toFixed(1)}Hz (${
            cand.pitchCentsError?.toFixed(1)
          } cents)`,
        );
        if (!refCheck) throw new Error("fluidsynth reference missing");
        assertSingleNoteMatch(`midy(${cacheMode})`, refCheck, cand);
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Test 2: drum exclusive class (open HH cut by closed HH)
// ---------------------------------------------------------------------------
Deno.test("exclusive-class hi-hat cut vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/exclusive-hihat.mid`;

  await t.step("generate exclusive hi-hat MIDI", async () => {
    const bytes = buildHiHatExclusiveMidi({
      openStart: EXCL_OPEN_START,
      closedStart: EXCL_CLOSED_START,
      closedDuration: EXCL_CLOSED_DURATION,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFsBin();
  });

  const fluidsynthWavPath = `${OUT_DIR}/fluidsynth-exclusive.wav`;
  let refMono: Float32Array | null = null;
  let refRate = SAMPLE_RATE;

  await t.step("render + load fluidsynth reference", async () => {
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath: fluidsynthWavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(fluidsynthWavPath);
    const wav = readWav(await Deno.readFile(fluidsynthWavPath));
    refMono = toMono(wav);
    refRate = wav.sampleRate;
    const peakDb = peakRmsDb(refMono, refRate);
    const attack = windowRmsDb(
      refMono,
      refRate,
      EXCL_ATTACK_START,
      EXCL_ATTACK_END,
    );
    const pre = windowRmsDb(refMono, refRate, EXCL_PRE_START, EXCL_PRE_END);
    const post = windowRmsDb(refMono, refRate, EXCL_POST_START, EXCL_POST_END);
    // Open HH in GeneralUser is a short one-shot: only the attack is reliably
    // audible; by the pre-cut window fluidsynth is often already near silence.
    if (!Number.isFinite(peakDb) || peakDb < -80) {
      throw new Error(
        `fluidsynth exclusive reference is effectively silent (peak=${peakDb}dB)`,
      );
    }
    if (attack < peakDb - EXCL_ATTACK_REL_DB) {
      throw new Error(
        `fluidsynth exclusive reference: open-hat attack missing ` +
          `(attack=${attack.toFixed(1)}dB peak=${peakDb.toFixed(1)}dB)`,
      );
    }
    console.log(
      `  fluidsynth exclusive: attack=${attack.toFixed(1)}dB pre=${
        pre.toFixed(1)
      } post=${post.toFixed(1)} peak=${peakDb.toFixed(1)}`,
    );
  });

  // Exclusive is most sensitive on realtime-ish modes; still check all modes
  // so a regression in segment/chunk ghost notes is caught.
  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/midy-exclusive-${cacheMode}.wav`;

    await t.step(`render midy exclusive (cacheMode=${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        cacheMode,
        sampleRate: SAMPLE_RATE,
      });
      if (wavBytes.length === 0) {
        throw new Error(`midy exclusive (${cacheMode}) returned empty WAV`);
      }
      await Deno.writeFile(midyWavPath, wavBytes);
    });

    await t.step(`compare exclusive cut (${cacheMode})`, async () => {
      if (!refMono) throw new Error("fluidsynth reference missing");
      const wav = readWav(await Deno.readFile(midyWavPath));
      const candMono = toMono(wav);
      if (wav.sampleRate !== refRate) {
        throw new Error(
          `sample rate mismatch: midy=${wav.sampleRate} ref=${refRate}`,
        );
      }
      assertExclusiveCut(`midy(${cacheMode})`, refMono, candMono, refRate);
    });
  }
});

// ---------------------------------------------------------------------------
// Closed-hat same-note retrigger (exclusiveClass self-cut)
// ---------------------------------------------------------------------------
Deno.test("closed-hat retrigger exclusive cut vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/closed-hat-retrigger.mid`;

  await t.step("generate closed-hat retrigger MIDI", async () => {
    const bytes = buildClosedHatRetriggerMidi({});
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFsBin();
  });

  const fluidsynthWavPath = `${OUT_DIR}/fluidsynth-closed-hat-retrigger.wav`;
  let refMono: Float32Array | null = null;
  let refRate = SAMPLE_RATE;

  await t.step("render + load fluidsynth reference", async () => {
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath: fluidsynthWavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(fluidsynthWavPath);
    const wav = readWav(await Deno.readFile(fluidsynthWavPath));
    refMono = toMono(wav);
    refRate = wav.sampleRate;
    const peakDb = peakRmsDb(refMono, refRate);
    const a1 = windowRmsDb(refMono, refRate, 0.02, 0.12);
    const a2 = windowRmsDb(refMono, refRate, 0.27, 0.37);
    console.log(
      `  fluidsynth retrigger: a1=${a1.toFixed(1)}dB a2=${
        a2.toFixed(1)
      }dB peak=${peakDb.toFixed(1)}`,
    );
    if (!Number.isFinite(peakDb) || peakDb < -80) {
      throw new Error(
        `fluidsynth retrigger reference silent (peak=${peakDb}dB)`,
      );
    }
  });

  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/midy-closed-hat-retrigger-${cacheMode}.wav`;

    await t.step(`render midy retrigger (cacheMode=${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        cacheMode,
        sampleRate: SAMPLE_RATE,
      });
      if (wavBytes.length === 0) {
        throw new Error(`midy retrigger (${cacheMode}) returned empty WAV`);
      }
      await Deno.writeFile(midyWavPath, wavBytes);
    });

    await t.step(`compare closed-hat retrigger (${cacheMode})`, async () => {
      if (!refMono) throw new Error("fluidsynth reference missing");
      const wav = readWav(await Deno.readFile(midyWavPath));
      const candMono = toMono(wav);
      if (wav.sampleRate !== refRate) {
        throw new Error(
          `sample rate mismatch: midy=${wav.sampleRate} ref=${refRate}`,
        );
      }
      assertClosedHatRetrigger(
        `midy(${cacheMode})`,
        refMono,
        candMono,
        refRate,
      );
    });
  }
});
