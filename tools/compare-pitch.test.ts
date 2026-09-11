// fluidsynth ↔ midy: pitch bend + RPN pitch-bend range.
//
// Usage:
//   deno test -A tools/compare-pitch.test.ts
//
import {
  buildPitchBendMidi,
  buildPitchBendRangeMidi,
} from "./gen-midi-scenarios.ts";
import {
  assertNonEmptyFile,
  ensureFsBin,
  ensureOutDir,
  estimatePitchHz,
  forEachCacheModeRender,
  midiNoteToHz,
  OUT_DIR,
  pitchInWindow,
  renderScenarioReference,
} from "./compare-common.ts";

// ---------------------------------------------------------------------------
// Test 3: pitch bend
// ---------------------------------------------------------------------------
const PB_NOTE = 60;
// Acoustic Grand: single-note test already shows midy F0≈262 Hz.
// Program 80 (Square Lead) measured ~330 Hz on midy vs 262 on fluidsynth —
// a separate scaleTuning/root-key issue; keep bend tests on a known-good preset.
const PB_PROGRAM = 0;
const PB_BEFORE_START = 0.12;
const PB_BEFORE_END = 0.32;
const PB_AFTER_START = 0.55;
const PB_AFTER_END = 0.95;
// Default GM pitch-bend range is ±2 semitones; max-up ≈ +2 semitones.
const PB_CENTS_TOLERANCE = 80; // vs fluidsynth measured pitch, not ideal ET

Deno.test("pitch-bend up (+2 semitones) vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/pitch-bend.mid`;
  const expectedHz = midiNoteToHz(PB_NOTE);
  // Narrow bands around unbent F0 and +2 semitones so piano partials cannot
  // steal the autocorrelation peak (previously locked near 331 Hz).
  const beforeMinHz = expectedHz * 0.85;
  const beforeMaxHz = expectedHz * 1.12;
  const afterMinHz = expectedHz * 1.05;
  const afterMaxHz = expectedHz * Math.pow(2, 2.5 / 12);

  await t.step("generate pitch-bend MIDI", async () => {
    const bytes = buildPitchBendMidi({
      noteNumber: PB_NOTE,
      program: PB_PROGRAM,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
    // midi-file stores pitch bend as signed [-8192, 8191]. Log so a
    // signed/absolute mixup in the player is obvious from the test output.
    const { parseMidi } = await import("midi-file");
    const parsed = parseMidi(bytes);
    const pbs = parsed.tracks[0].filter((e) => e.type === "pitchBend");
    console.log(
      `  midi pitchBends: ${
        pbs.map((e) => {
          const pb = e as { channel?: number; value?: number };
          return `ch${pb.channel} v=${pb.value}`;
        }).join(", ")
      }`,
    );
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFsBin();
  });

  const { mono: refMono, sampleRate: refRate } = await renderScenarioReference(
    t,
    midiPath,
    `${OUT_DIR}/fluidsynth-pitch-bend.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth bend", () => {
    const before = pitchInWindow(
      refMono,
      refRate,
      PB_BEFORE_START,
      PB_BEFORE_END,
      beforeMinHz,
      beforeMaxHz,
    );
    const after = pitchInWindow(
      refMono,
      refRate,
      PB_AFTER_START,
      PB_AFTER_END,
      afterMinHz,
      afterMaxHz,
    );
    if (before === null || after === null) {
      throw new Error(
        `fluidsynth pitch undetectable before=${before} after=${after}`,
      );
    }
    const cents = 1200 * Math.log2(after / before);
    console.log(
      `  fluidsynth bend: before=${before.toFixed(1)}Hz after=${
        after.toFixed(1)
      }Hz (Δ=${cents.toFixed(0)} cents)`,
    );
    // Expect roughly +200 cents (±2 semitones); allow wide tolerance on SF.
    if (cents < 100 || cents > 350) {
      throw new Error(
        `fluidsynth bend Δ=${cents.toFixed(0)} cents not near +200`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-pitch-bend",
    (label, candMono, sr) => {
      const before = pitchInWindow(
        candMono,
        sr,
        PB_BEFORE_START,
        PB_BEFORE_END,
        beforeMinHz,
        beforeMaxHz,
      );
      const after = pitchInWindow(
        candMono,
        sr,
        PB_AFTER_START,
        PB_AFTER_END,
        afterMinHz,
        afterMaxHz,
      );
      const refBefore = pitchInWindow(
        refMono,
        refRate,
        PB_BEFORE_START,
        PB_BEFORE_END,
        beforeMinHz,
        beforeMaxHz,
      );
      const refAfter = pitchInWindow(
        refMono,
        refRate,
        PB_AFTER_START,
        PB_AFTER_END,
        afterMinHz,
        afterMaxHz,
      );
      if (before === null || after === null) {
        // Unconstrained estimate for diagnosis (may lock onto a partial).
        const rawBefore = estimatePitchHz(
          candMono,
          sr,
          Math.floor(PB_BEFORE_START * sr),
          Math.floor(PB_BEFORE_END * sr),
        );
        const rawAfter = estimatePitchHz(
          candMono,
          sr,
          Math.floor(PB_AFTER_START * sr),
          Math.floor(PB_AFTER_END * sr),
        );
        throw new Error(
          `${label}: pitch undetectable before=${before} after=${after}` +
            ` (raw before=${rawBefore?.toFixed(1)} after=${
              rawAfter?.toFixed(1)
            })`,
        );
      }
      if (refBefore === null || refAfter === null) {
        throw new Error(`${label}: fluidsynth pitch missing`);
      }
      const candCents = 1200 * Math.log2(after / before);
      const refCents = 1200 * Math.log2(refAfter / refBefore);
      const err = Math.abs(candCents - refCents);
      console.log(
        `  ${label}: before=${before.toFixed(1)}Hz after=${
          after.toFixed(1)
        }Hz Δ=${candCents.toFixed(0)}c (ref Δ=${refCents.toFixed(0)}c err=${
          err.toFixed(0)
        }c)`,
      );
      if (candCents < 80) {
        throw new Error(
          `${label}: pitch barely rose (Δ=${
            candCents.toFixed(0)
          }c) — bend may be ignored`,
        );
      }
      if (err > PB_CENTS_TOLERANCE) {
        throw new Error(
          `${label}: bend amount diverges from fluidsynth by ${
            err.toFixed(0)
          } cents`,
        );
      }
      // Also check absolute after-pitch vs fluidsynth.
      const afterErr = Math.abs(1200 * Math.log2(after / refAfter));
      if (afterErr > PB_CENTS_TOLERANCE) {
        throw new Error(
          `${label}: after-bend pitch ${after.toFixed(1)}Hz vs ref ${
            refAfter.toFixed(1)
          }Hz (err ${afterErr.toFixed(0)}c)`,
        );
      }
    },
    refMono,
    refRate,
  );
});

// ---------------------------------------------------------------------------
// Test 8: RPN pitch-bend range (12 semitones → +1 octave at max)
// ---------------------------------------------------------------------------
const PBR_NOTE = 60;
const PBR_PROGRAM = 0;
const PBR_RANGE = 12; // semitones
const PBR_BEFORE_START = 0.12;
const PBR_BEFORE_END = 0.32;
const PBR_AFTER_START = 0.55;
const PBR_AFTER_END = 0.95;
const PBR_CENTS_TOLERANCE = 120; // octave jump is large; allow SF variance

Deno.test("RPN pitch-bend range (+12 semitones) vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/pitch-bend-range.mid`;
  const expectedHz = midiNoteToHz(PBR_NOTE);
  // Unbent F0 band; after-band centred near +1 octave.
  const beforeMinHz = expectedHz * 0.85;
  const beforeMaxHz = expectedHz * 1.12;
  const afterMinHz = expectedHz * 1.6;
  const afterMaxHz = expectedHz * 2.4;

  await t.step("generate RPN pitch-bend-range MIDI", async () => {
    const bytes = buildPitchBendRangeMidi({
      noteNumber: PBR_NOTE,
      program: PBR_PROGRAM,
      rangeSemitones: PBR_RANGE,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFsBin();
  });

  const { mono: refMono, sampleRate: refRate } = await renderScenarioReference(
    t,
    midiPath,
    `${OUT_DIR}/fluidsynth-pitch-bend-range.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth octave bend", () => {
    const before = pitchInWindow(
      refMono,
      refRate,
      PBR_BEFORE_START,
      PBR_BEFORE_END,
      beforeMinHz,
      beforeMaxHz,
    );
    const after = pitchInWindow(
      refMono,
      refRate,
      PBR_AFTER_START,
      PBR_AFTER_END,
      afterMinHz,
      afterMaxHz,
    );
    if (before === null || after === null) {
      throw new Error(
        `fluidsynth pitch undetectable before=${before} after=${after}`,
      );
    }
    const cents = 1200 * Math.log2(after / before);
    console.log(
      `  fluidsynth range12: before=${before.toFixed(1)}Hz after=${
        after.toFixed(1)
      }Hz (Δ=${cents.toFixed(0)} cents)`,
    );
    // Expect roughly +1200 cents (±12 semitones).
    if (cents < 800 || cents > 1500) {
      throw new Error(
        `fluidsynth range12 Δ=${cents.toFixed(0)} cents not near +1200`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-pitch-bend-range",
    (label, candMono, sr) => {
      const before = pitchInWindow(
        candMono,
        sr,
        PBR_BEFORE_START,
        PBR_BEFORE_END,
        beforeMinHz,
        beforeMaxHz,
      );
      const after = pitchInWindow(
        candMono,
        sr,
        PBR_AFTER_START,
        PBR_AFTER_END,
        afterMinHz,
        afterMaxHz,
      );
      const refBefore = pitchInWindow(
        refMono,
        refRate,
        PBR_BEFORE_START,
        PBR_BEFORE_END,
        beforeMinHz,
        beforeMaxHz,
      );
      const refAfter = pitchInWindow(
        refMono,
        refRate,
        PBR_AFTER_START,
        PBR_AFTER_END,
        afterMinHz,
        afterMaxHz,
      );
      if (before === null || after === null) {
        const rawBefore = estimatePitchHz(
          candMono,
          sr,
          Math.floor(PBR_BEFORE_START * sr),
          Math.floor(PBR_BEFORE_END * sr),
        );
        const rawAfter = estimatePitchHz(
          candMono,
          sr,
          Math.floor(PBR_AFTER_START * sr),
          Math.floor(PBR_AFTER_END * sr),
        );
        throw new Error(
          `${label}: pitch undetectable before=${before} after=${after}` +
            ` (raw before=${rawBefore?.toFixed(1)} after=${
              rawAfter?.toFixed(1)
            })`,
        );
      }
      if (refBefore === null || refAfter === null) {
        throw new Error(`${label}: fluidsynth pitch missing`);
      }
      const candCents = 1200 * Math.log2(after / before);
      const refCents = 1200 * Math.log2(refAfter / refBefore);
      const err = Math.abs(candCents - refCents);
      console.log(
        `  ${label}: before=${before.toFixed(1)}Hz after=${
          after.toFixed(1)
        }Hz Δ=${candCents.toFixed(0)}c (ref Δ=${refCents.toFixed(0)}c err=${
          err.toFixed(0)
        }c)`,
      );
      if (candCents < 700) {
        throw new Error(
          `${label}: bend barely rose (Δ=${
            candCents.toFixed(0)
          }c) — RPN range may be ignored`,
        );
      }
      if (err > PBR_CENTS_TOLERANCE) {
        throw new Error(
          `${label}: range12 bend diverges from fluidsynth by ${
            err.toFixed(0)
          } cents`,
        );
      }
    },
    refMono,
    refRate,
  );
});
