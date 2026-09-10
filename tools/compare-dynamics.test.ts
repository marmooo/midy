// fluidsynth ↔ midy: velocity dynamics.
//
// Usage:
//   deno test -A tools/compare-dynamics.test.ts
//
import { buildVelocityDynamicsMidi } from "./gen-midi-scenarios.ts";
import {
  assertNonEmptyFile,
  ensureFsBin,
  ensureOutDir,
  forEachCacheModeRender,
  OUT_DIR,
  renderScenarioReference,
  windowRmsDb,
} from "./compare-common.ts";

// ---------------------------------------------------------------------------
// Velocity dynamics (soft vs loud)
// ---------------------------------------------------------------------------
const VEL_SOFT_START = 0.1;
const VEL_SOFT_END = 0.45;
const VEL_LOUD_START = 1.0;
const VEL_LOUD_END = 1.35;
const VEL_RATIO_MIN_DB = 4; // loud must be clearly louder than soft
// Soft/loud ratio is dominated by SF2 velocity→attenuation (correct to ~0.1dB
// vs the formula) plus velocity→filterFc. Web Audio BiquadFilterNode and
// FluidSynth's biquad disagree by ~10–13dB of RMS on GeneralUser piano at
// very low soft-zone cutoffs, so allow that residual rather than forcing a
// bit-identical filter model.
const VEL_RATIO_ERR_MAX_DB = 15;

Deno.test("velocity soft vs loud vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/velocity-dynamics.mid`;

  await t.step("generate velocity-dynamics MIDI", async () => {
    const bytes = buildVelocityDynamicsMidi({});
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
    `${OUT_DIR}/fluidsynth-velocity-dynamics.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth velocity ratio", () => {
    const soft = windowRmsDb(refMono, refRate, VEL_SOFT_START, VEL_SOFT_END);
    const loud = windowRmsDb(refMono, refRate, VEL_LOUD_START, VEL_LOUD_END);
    const ratio = loud - soft;
    console.log(
      `  fluidsynth velocity: soft=${soft.toFixed(1)}dB loud=${
        loud.toFixed(1)
      }dB ratio=${ratio.toFixed(1)}dB`,
    );
    if (ratio < VEL_RATIO_MIN_DB) {
      throw new Error(
        `fluidsynth velocity ratio only ${
          ratio.toFixed(1)
        }dB — vel may be ignored`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-velocity-dynamics",
    (label, candMono, sr) => {
      const soft = windowRmsDb(candMono, sr, VEL_SOFT_START, VEL_SOFT_END);
      const loud = windowRmsDb(candMono, sr, VEL_LOUD_START, VEL_LOUD_END);
      const ratio = loud - soft;
      const refSoft = windowRmsDb(
        refMono,
        refRate,
        VEL_SOFT_START,
        VEL_SOFT_END,
      );
      const refLoud = windowRmsDb(
        refMono,
        refRate,
        VEL_LOUD_START,
        VEL_LOUD_END,
      );
      const refRatio = refLoud - refSoft;
      const err = Math.abs(ratio - refRatio);
      console.log(
        `  ${label}: soft=${soft.toFixed(1)}dB loud=${loud.toFixed(1)}dB ` +
          `ratio=${ratio.toFixed(1)}dB (ref ratio=${refRatio.toFixed(1)} err=${
            err.toFixed(1)
          })`,
      );
      if (ratio < VEL_RATIO_MIN_DB) {
        throw new Error(
          `${label}: velocity ratio only ${
            ratio.toFixed(1)
          }dB — vel may be ignored`,
        );
      }
      if (err > VEL_RATIO_ERR_MAX_DB) {
        throw new Error(
          `${label}: velocity ratio diverges from fluidsynth by ${
            err.toFixed(1)
          }dB`,
        );
      }
    },
    refMono,
    refRate,
  );
});
