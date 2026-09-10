// fluidsynth ↔ midy: continuous controllers + all-off.
//
// Usage:
//   deno test -A tools/compare-controllers.test.ts
//
import {
  buildAllOffMidi,
  buildExpressionCcMidi,
  buildModulationCcMidi,
  buildPanCcMidi,
  buildSustainPedalMidi,
  buildVolumeCcMidi,
} from "./gen-midi-scenarios.ts";
import {
  assertNonEmptyFile,
  CACHE_MODES,
  compareMono,
  ensureFsBin,
  ensureOutDir,
  forEachCacheModeRender,
  formatCompareResult,
  HARNESS_DIR,
  OUT_DIR,
  readWav,
  renderMidyMode,
  renderScenarioReference,
  renderWithFluidsynth,
  SAMPLE_RATE,
  SF2_PATH,
  stereoBalance,
  toMono,
  windowRmsDb,
} from "./compare-common.ts";

// ---------------------------------------------------------------------------
// Test 4: CC7 volume
// ---------------------------------------------------------------------------
const VOL_HIGH_START = 0.15;
const VOL_HIGH_END = 0.4;
const VOL_LOW_START = 0.7;
const VOL_LOW_END = 1.0;
// CC7 100→20 under GM x² curve ≈ -28dB; fluidsynth measures ~32dB on this SF.
// After midy adopts the same x² mapping, drops should land in the same ballpark.
const VOL_DROP_MIN_DB = 20;
const VOL_DROP_ERR_MAX_DB = 10;

Deno.test("CC7 volume drop vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/volume-cc.mid`;

  await t.step("generate volume-CC MIDI", async () => {
    const bytes = buildVolumeCcMidi({});
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
    `${OUT_DIR}/fluidsynth-volume-cc.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth volume drop", () => {
    const high = windowRmsDb(refMono, refRate, VOL_HIGH_START, VOL_HIGH_END);
    const low = windowRmsDb(refMono, refRate, VOL_LOW_START, VOL_LOW_END);
    const drop = high - low;
    console.log(
      `  fluidsynth volume: high=${high.toFixed(1)}dB low=${
        low.toFixed(1)
      }dB drop=${drop.toFixed(1)}dB`,
    );
    if (drop < VOL_DROP_MIN_DB) {
      throw new Error(
        `fluidsynth volume drop only ${drop.toFixed(1)}dB — CC7 may be ignored`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-volume-cc",
    (label, candMono, sr) => {
      const high = windowRmsDb(candMono, sr, VOL_HIGH_START, VOL_HIGH_END);
      const low = windowRmsDb(candMono, sr, VOL_LOW_START, VOL_LOW_END);
      const drop = high - low;
      const refHigh = windowRmsDb(
        refMono,
        refRate,
        VOL_HIGH_START,
        VOL_HIGH_END,
      );
      const refLow = windowRmsDb(refMono, refRate, VOL_LOW_START, VOL_LOW_END);
      const refDrop = refHigh - refLow;
      const err = Math.abs(drop - refDrop);
      console.log(
        `  ${label}: high=${high.toFixed(1)}dB low=${low.toFixed(1)}dB ` +
          `drop=${drop.toFixed(1)}dB (ref drop=${refDrop.toFixed(1)} err=${
            err.toFixed(1)
          })`,
      );
      if (drop < VOL_DROP_MIN_DB) {
        throw new Error(
          `${label}: volume drop only ${
            drop.toFixed(1)
          }dB — CC7 may be ignored`,
        );
      }
      if (err > VOL_DROP_ERR_MAX_DB) {
        throw new Error(
          `${label}: volume drop diverges from fluidsynth by ${
            err.toFixed(1)
          }dB`,
        );
      }
    },
    refMono,
    refRate,
  );
});

// ---------------------------------------------------------------------------
// Test 5: sustain pedal
// ---------------------------------------------------------------------------
const SUS_HELD_START = 0.5; // after note-off at 0.4, pedal still down
const SUS_HELD_END = 0.9;
const SUS_RELEASE_START = 1.4; // after pedal up at 1.0
const SUS_RELEASE_END = 1.8;
const SUS_HELD_MIN_DB = -45; // must still be audible while pedal down
const SUS_RELEASE_DROP_DB = 6; // must quiet after pedal up vs held window

Deno.test("sustain pedal holds note after note-off vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/sustain-pedal.mid`;

  await t.step("generate sustain-pedal MIDI", async () => {
    const bytes = buildSustainPedalMidi({});
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
    `${OUT_DIR}/fluidsynth-sustain.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth sustain", () => {
    const held = windowRmsDb(refMono, refRate, SUS_HELD_START, SUS_HELD_END);
    const released = windowRmsDb(
      refMono,
      refRate,
      SUS_RELEASE_START,
      SUS_RELEASE_END,
    );
    console.log(
      `  fluidsynth sustain: held=${held.toFixed(1)}dB released=${
        Number.isFinite(released) ? released.toFixed(1) : "-inf"
      }dB`,
    );
    if (held < SUS_HELD_MIN_DB) {
      throw new Error(
        `fluidsynth not holding under sustain (held=${held.toFixed(1)}dB)`,
      );
    }
    if (!(held - released >= SUS_RELEASE_DROP_DB / 2)) {
      // Soft check on reference only
      console.log(
        `  warn: fluidsynth release drop small (${
          (held - released).toFixed(1)
        }dB)`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-sustain",
    (label, candMono, sr) => {
      const held = windowRmsDb(candMono, sr, SUS_HELD_START, SUS_HELD_END);
      const released = windowRmsDb(
        candMono,
        sr,
        SUS_RELEASE_START,
        SUS_RELEASE_END,
      );
      const refHeld = windowRmsDb(
        refMono,
        refRate,
        SUS_HELD_START,
        SUS_HELD_END,
      );
      console.log(
        `  ${label}: held=${held.toFixed(1)}dB released=${
          Number.isFinite(released) ? released.toFixed(1) : "-inf"
        }dB (ref held=${refHeld.toFixed(1)})`,
      );
      if (held < SUS_HELD_MIN_DB) {
        throw new Error(
          `${label}: silent after note-off while sustain down ` +
            `(held=${held.toFixed(1)}dB) — pedal may be ignored`,
        );
      }
      if (held - released < SUS_RELEASE_DROP_DB) {
        throw new Error(
          `${label}: did not decay after pedal up ` +
            `(held=${held.toFixed(1)} released=${released.toFixed(1)})`,
        );
      }
      // Held level should be in the same ballpark as fluidsynth (after the
      // usual ~20dB midy-hotter offset, compare relative to each peak is hard;
      // just require both are clearly audible).
      if (refHeld < SUS_HELD_MIN_DB) {
        throw new Error(`${label}: fluidsynth held level unexpectedly low`);
      }
    },
    refMono,
    refRate,
  );
});

// ---------------------------------------------------------------------------
// Test 6: CC11 expression
// ---------------------------------------------------------------------------
// Same squared curve as CC7: (expr/127)² with volume held fixed.
const EXPR_HIGH_START = 0.15;
const EXPR_HIGH_END = 0.4;
const EXPR_LOW_START = 0.7;
const EXPR_LOW_END = 1.0;
const EXPR_DROP_MIN_DB = 20;
const EXPR_DROP_ERR_MAX_DB = 10;

Deno.test("CC11 expression drop vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/expression-cc.mid`;

  await t.step("generate expression-CC MIDI", async () => {
    const bytes = buildExpressionCcMidi({});
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
    `${OUT_DIR}/fluidsynth-expression-cc.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth expression drop", () => {
    const high = windowRmsDb(refMono, refRate, EXPR_HIGH_START, EXPR_HIGH_END);
    const low = windowRmsDb(refMono, refRate, EXPR_LOW_START, EXPR_LOW_END);
    const drop = high - low;
    console.log(
      `  fluidsynth expression: high=${high.toFixed(1)}dB low=${
        low.toFixed(1)
      }dB drop=${drop.toFixed(1)}dB`,
    );
    if (drop < EXPR_DROP_MIN_DB) {
      throw new Error(
        `fluidsynth expression drop only ${
          drop.toFixed(1)
        }dB — CC11 may be ignored`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-expression-cc",
    (label, candMono, sr) => {
      const high = windowRmsDb(candMono, sr, EXPR_HIGH_START, EXPR_HIGH_END);
      const low = windowRmsDb(candMono, sr, EXPR_LOW_START, EXPR_LOW_END);
      const drop = high - low;
      const refHigh = windowRmsDb(
        refMono,
        refRate,
        EXPR_HIGH_START,
        EXPR_HIGH_END,
      );
      const refLow = windowRmsDb(
        refMono,
        refRate,
        EXPR_LOW_START,
        EXPR_LOW_END,
      );
      const refDrop = refHigh - refLow;
      const err = Math.abs(drop - refDrop);
      console.log(
        `  ${label}: high=${high.toFixed(1)}dB low=${low.toFixed(1)}dB ` +
          `drop=${drop.toFixed(1)}dB (ref drop=${refDrop.toFixed(1)} err=${
            err.toFixed(1)
          })`,
      );
      if (drop < EXPR_DROP_MIN_DB) {
        throw new Error(
          `${label}: expression drop only ${
            drop.toFixed(1)
          }dB — CC11 may be ignored`,
        );
      }
      if (err > EXPR_DROP_ERR_MAX_DB) {
        throw new Error(
          `${label}: expression drop diverges from fluidsynth by ${
            err.toFixed(1)
          }dB`,
        );
      }
    },
    refMono,
    refRate,
  );
});

// ---------------------------------------------------------------------------
// Test 7: CC10 pan
// ---------------------------------------------------------------------------
const PAN_LEFT_START = 0.15;
const PAN_LEFT_END = 0.4;
const PAN_RIGHT_START = 0.7;
const PAN_RIGHT_END = 1.0;
// Balance = (R - L) / (R + L) in linear RMS space; hard L ≈ -1, hard R ≈ +1.
const PAN_BALANCE_MIN_SHIFT = 0.8; // must flip clearly left→right
const PAN_BALANCE_ERR_MAX = 0.35; // vs fluidsynth balance delta

Deno.test("CC10 pan left→right vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/pan-cc.mid`;

  await t.step("generate pan-CC MIDI", async () => {
    const bytes = buildPanCcMidi({});
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFsBin();
  });

  let refLeft: Float32Array | null = null;
  let refRight: Float32Array | null = null;
  let refRate = SAMPLE_RATE;

  await t.step("render fluidsynth reference", async () => {
    const wavPath = `${OUT_DIR}/fluidsynth-pan-cc.wav`;
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(wavPath);
    const wav = readWav(await Deno.readFile(wavPath));
    if (wav.numChannels < 2) {
      throw new Error(
        `fluidsynth pan reference is mono (${wav.numChannels} ch) — need stereo`,
      );
    }
    refLeft = wav.channelData[0];
    refRight = wav.channelData[1];
    refRate = wav.sampleRate;
  });
  if (!refLeft || !refRight) {
    throw new Error("fluidsynth pan reference missing");
  }

  await t.step("sanity-check fluidsynth pan shift", () => {
    const leftBal = stereoBalance(
      refLeft!,
      refRight!,
      refRate,
      PAN_LEFT_START,
      PAN_LEFT_END,
    );
    const rightBal = stereoBalance(
      refLeft!,
      refRight!,
      refRate,
      PAN_RIGHT_START,
      PAN_RIGHT_END,
    );
    const shift = rightBal - leftBal;
    console.log(
      `  fluidsynth pan: leftBal=${leftBal.toFixed(3)} rightBal=${
        rightBal.toFixed(3)
      } shift=${shift.toFixed(3)}`,
    );
    if (leftBal > -0.2) {
      throw new Error(
        `fluidsynth left window not left-heavy (bal=${leftBal.toFixed(3)})`,
      );
    }
    if (rightBal < 0.2) {
      throw new Error(
        `fluidsynth right window not right-heavy (bal=${rightBal.toFixed(3)})`,
      );
    }
    if (shift < PAN_BALANCE_MIN_SHIFT) {
      throw new Error(
        `fluidsynth pan shift only ${shift.toFixed(3)} — CC10 may be ignored`,
      );
    }
  });

  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/midy-pan-cc-${cacheMode}.wav`;
    await t.step(`render midy (${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        cacheMode,
        sampleRate: SAMPLE_RATE,
      });
      if (wavBytes.length === 0) {
        throw new Error(`midy (${cacheMode}) returned empty WAV`);
      }
      await Deno.writeFile(midyWavPath, wavBytes);
    });
    await t.step(`check midy (${cacheMode})`, async () => {
      const wav = readWav(await Deno.readFile(midyWavPath));
      if (wav.numChannels < 2) {
        throw new Error(
          `midy(${cacheMode}) pan render is mono — need stereo for CC10`,
        );
      }
      const left = wav.channelData[0];
      const right = wav.channelData[1];
      const leftBal = stereoBalance(
        left,
        right,
        wav.sampleRate,
        PAN_LEFT_START,
        PAN_LEFT_END,
      );
      const rightBal = stereoBalance(
        left,
        right,
        wav.sampleRate,
        PAN_RIGHT_START,
        PAN_RIGHT_END,
      );
      const shift = rightBal - leftBal;
      const refLeftBal = stereoBalance(
        refLeft!,
        refRight!,
        refRate,
        PAN_LEFT_START,
        PAN_LEFT_END,
      );
      const refRightBal = stereoBalance(
        refLeft!,
        refRight!,
        refRate,
        PAN_RIGHT_START,
        PAN_RIGHT_END,
      );
      const refShift = refRightBal - refLeftBal;
      const err = Math.abs(shift - refShift);
      const label = `midy(${cacheMode})`;
      console.log(
        `  ${label}: leftBal=${leftBal.toFixed(3)} rightBal=${
          rightBal.toFixed(3)
        } shift=${shift.toFixed(3)} (ref shift=${refShift.toFixed(3)} err=${
          err.toFixed(3)
        })`,
      );
      if (leftBal > -0.15) {
        throw new Error(
          `${label}: left window not left-heavy (bal=${leftBal.toFixed(3)})`,
        );
      }
      if (rightBal < 0.15) {
        throw new Error(
          `${label}: right window not right-heavy (bal=${rightBal.toFixed(3)})`,
        );
      }
      if (shift < PAN_BALANCE_MIN_SHIFT) {
        throw new Error(
          `${label}: pan shift only ${shift.toFixed(3)} — CC10 may be ignored`,
        );
      }
      if (err > PAN_BALANCE_ERR_MAX) {
        throw new Error(
          `${label}: pan shift diverges from fluidsynth by ${err.toFixed(3)}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Test 9: All Sound Off (CC120) / All Notes Off (CC123)
// ---------------------------------------------------------------------------
const ALLOFF_ACTIVE_START = 0.15;
const ALLOFF_ACTIVE_END = 0.35;
const ALLOFF_AFTER_START = 0.55;
const ALLOFF_AFTER_END = 0.9;
// Sound off should drop hard; notes off may leave a short release tail.
const ASO_DROP_MIN_DB = 20;
const ANO_DROP_MIN_DB = 8;
const ALLOFF_DROP_ERR_MAX_DB = 15;

async function runAllOffTest(
  t: Deno.TestContext,
  kind: "sound" | "notes",
): Promise<void> {
  const controllerType = kind === "sound" ? 120 : 123;
  const dropMin = kind === "sound" ? ASO_DROP_MIN_DB : ANO_DROP_MIN_DB;
  const midiPath = `${OUT_DIR}/all-${kind}-off.mid`;
  const outPrefix = `midy-all-${kind}-off`;
  const refWav = `${OUT_DIR}/fluidsynth-all-${kind}-off.wav`;

  await t.step(`generate All ${kind} Off MIDI`, async () => {
    const bytes = buildAllOffMidi({ controllerType });
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
    refWav,
    fluidsynthBin,
  );

  await t.step(`sanity-check fluidsynth All ${kind} Off`, () => {
    const active = windowRmsDb(
      refMono,
      refRate,
      ALLOFF_ACTIVE_START,
      ALLOFF_ACTIVE_END,
    );
    const after = windowRmsDb(
      refMono,
      refRate,
      ALLOFF_AFTER_START,
      ALLOFF_AFTER_END,
    );
    const drop = active - after;
    console.log(
      `  fluidsynth all-${kind}-off: active=${active.toFixed(1)}dB after=${
        after.toFixed(1)
      }dB drop=${drop.toFixed(1)}dB`,
    );
    if (drop < dropMin) {
      throw new Error(
        `fluidsynth all-${kind}-off drop only ${drop.toFixed(1)}dB`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    outPrefix,
    (label, candMono, sr) => {
      const active = windowRmsDb(
        candMono,
        sr,
        ALLOFF_ACTIVE_START,
        ALLOFF_ACTIVE_END,
      );
      const after = windowRmsDb(
        candMono,
        sr,
        ALLOFF_AFTER_START,
        ALLOFF_AFTER_END,
      );
      const drop = active - after;
      const refActive = windowRmsDb(
        refMono,
        refRate,
        ALLOFF_ACTIVE_START,
        ALLOFF_ACTIVE_END,
      );
      const refAfter = windowRmsDb(
        refMono,
        refRate,
        ALLOFF_AFTER_START,
        ALLOFF_AFTER_END,
      );
      const refDrop = refActive - refAfter;
      const err = Math.abs(drop - refDrop);
      console.log(
        `  ${label}: active=${active.toFixed(1)}dB after=${
          after.toFixed(1)
        }dB drop=${drop.toFixed(1)}dB (ref drop=${refDrop.toFixed(1)} err=${
          err.toFixed(1)
        })`,
      );
      if (drop < dropMin) {
        throw new Error(
          `${label}: all-${kind}-off drop only ${
            drop.toFixed(1)
          }dB — CC may be ignored`,
        );
      }
      if (err > ALLOFF_DROP_ERR_MAX_DB) {
        throw new Error(
          `${label}: all-${kind}-off drop diverges from fluidsynth by ${
            err.toFixed(1)
          }dB`,
        );
      }
    },
    refMono,
    refRate,
  );
}

Deno.test("All Sound Off (CC120) vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runAllOffTest(t, "sound");
});

Deno.test("All Notes Off (CC123) vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runAllOffTest(t, "notes");
});

// ---------------------------------------------------------------------------
// CC1 modulation wheel — depth change should match fluidsynth envelope shape
// ---------------------------------------------------------------------------
const MOD_QUIET_START = 0.15;
const MOD_QUIET_END = 0.4;
const MOD_ACTIVE_START = 0.7;
const MOD_ACTIVE_END = 1.1;
// Modulation is LFO-driven vibrato. FluidSynth and Web Audio disagree on
// phase / depth mapping, and "audio" cache mode bakes the whole song so the
// live LFO path diverges further. Measured envelope correlation on GeneralUser
// piano sits ~0.695 in audio mode — keep the floor just under that.
const MOD_ENV_CORR_MIN = 0.65;

Deno.test("CC1 modulation wheel vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/modulation-cc.mid`;

  await t.step("generate modulation-CC MIDI", async () => {
    const bytes = buildModulationCcMidi({});
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
    `${OUT_DIR}/fluidsynth-modulation-cc.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth modulation energy", () => {
    const quiet = windowRmsDb(refMono, refRate, MOD_QUIET_START, MOD_QUIET_END);
    const active = windowRmsDb(
      refMono,
      refRate,
      MOD_ACTIVE_START,
      MOD_ACTIVE_END,
    );
    console.log(
      `  fluidsynth modulation: quiet=${quiet.toFixed(1)}dB active=${
        active.toFixed(1)
      }dB`,
    );
    // Note remains audible in both windows (mod is LFO, not a mute).
    if (!Number.isFinite(quiet) || quiet < -60) {
      throw new Error(`fluidsynth modulation quiet window silent`);
    }
    if (!Number.isFinite(active) || active < -60) {
      throw new Error(`fluidsynth modulation active window silent`);
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-modulation-cc",
    (label, candMono, sr) => {
      const quiet = windowRmsDb(candMono, sr, MOD_QUIET_START, MOD_QUIET_END);
      const active = windowRmsDb(
        candMono,
        sr,
        MOD_ACTIVE_START,
        MOD_ACTIVE_END,
      );
      console.log(
        `  ${label}: quiet=${quiet.toFixed(1)}dB active=${active.toFixed(1)}dB`,
      );
      if (!Number.isFinite(quiet) || quiet < -60) {
        throw new Error(`${label}: quiet window silent — note may be missing`);
      }
      if (!Number.isFinite(active) || active < -60) {
        throw new Error(`${label}: active window silent after CC1`);
      }
    },
    refMono,
    refRate,
    { minEnvelopeCorrelation: MOD_ENV_CORR_MIN },
  );
});
