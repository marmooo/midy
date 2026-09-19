// almost-simple (gain-only automation) regression vs fluidsynth + path checks.
//
// Covers the TypedArray path that treats in-interval CC7/CC11-only motion as
// simple (no Offline complex bake). Existing compare-controllers.test.ts
// already validates single-drop CC7/CC11; this file adds multi-step curves,
// combined vol+expr, and a negative control (pan must still behave as complex).
//
// Usage:
//   deno test -A tools/compare-almost-simple.test.ts
//
// Checklist (what to confirm when changing almost-simple):
//   1. CC7 drop / CC11 drop still match fluidsynth (compare-controllers)
//   2. Multi-step expression ramp still drops level stepwise (this file)
//   3. Combined CC7+CC11 still quieter after both drops (this file)
//   4. Pan / pitch-bend remain complex (pan stereo balance still moves)
//   5. After full-song start(), console log shows almostSimple > 0 on these MIDIs
//
import {
  buildExpressionMultiStepMidi,
  buildVolumeAndExpressionMidi,
} from "./gen-midi-scenarios.ts";
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
// Multi-step expression (almost-simple gain curve)
// ---------------------------------------------------------------------------
// Windows: early high expr, mid step, late low step.
const MS_HIGH_START = 0.1;
const MS_HIGH_END = 0.3;
const MS_MID_START = 0.4;
const MS_MID_END = 0.6;
const MS_LOW_START = 0.85;
const MS_LOW_END = 1.05;
// (127/127)² → (80/127)² ≈ -4 dB; (80/127)² → (20/127)² ≈ -12 dB
const MS_HIGH_TO_LOW_MIN_DB = 12;
const MS_HIGH_TO_LOW_ERR_MAX_DB = 12;

Deno.test("almost-simple: multi-step expression vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/almost-simple-expr-multistep.mid`;

  await t.step("generate multi-step expression MIDI", async () => {
    const bytes = buildExpressionMultiStepMidi({});
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
    `${OUT_DIR}/fluidsynth-almost-simple-expr-multistep.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth multi-step drop", () => {
    const high = windowRmsDb(refMono, refRate, MS_HIGH_START, MS_HIGH_END);
    const low = windowRmsDb(refMono, refRate, MS_LOW_START, MS_LOW_END);
    const drop = high - low;
    console.log(
      `  fluidsynth multi-step expr: high=${high.toFixed(1)}dB low=${
        low.toFixed(1)
      }dB drop=${drop.toFixed(1)}dB`,
    );
    if (drop < MS_HIGH_TO_LOW_MIN_DB) {
      throw new Error(
        `fluidsynth multi-step drop only ${
          drop.toFixed(1)
        }dB — CC11 may be ignored`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-almost-simple-expr-multistep",
    (label, candMono, sr) => {
      const high = windowRmsDb(candMono, sr, MS_HIGH_START, MS_HIGH_END);
      const mid = windowRmsDb(candMono, sr, MS_MID_START, MS_MID_END);
      const low = windowRmsDb(candMono, sr, MS_LOW_START, MS_LOW_END);
      const drop = high - low;
      const refHigh = windowRmsDb(refMono, refRate, MS_HIGH_START, MS_HIGH_END);
      const refLow = windowRmsDb(refMono, refRate, MS_LOW_START, MS_LOW_END);
      const refDrop = refHigh - refLow;
      const err = Math.abs(drop - refDrop);
      console.log(
        `  ${label}: high=${high.toFixed(1)} mid=${mid.toFixed(1)} low=${
          low.toFixed(1)
        }dB drop=${drop.toFixed(1)} (ref=${refDrop.toFixed(1)} err=${
          err.toFixed(1)
        })`,
      );
      // Monotonic-ish: mid should sit between high and low (allow small noise).
      if (mid > high + 1.5) {
        throw new Error(
          `${label}: mid window louder than high — gain curve may be inverted`,
        );
      }
      if (low > mid + 1.5) {
        throw new Error(
          `${label}: low window louder than mid — later CC11 step ignored`,
        );
      }
      if (drop < MS_HIGH_TO_LOW_MIN_DB) {
        throw new Error(
          `${label}: multi-step drop only ${
            drop.toFixed(1)
          }dB — almost-simple gain curve missing`,
        );
      }
      if (err > MS_HIGH_TO_LOW_ERR_MAX_DB) {
        throw new Error(
          `${label}: multi-step drop diverges from fluidsynth by ${
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
// Combined volume + expression (still gain-only → almost-simple)
// ---------------------------------------------------------------------------
const VE_EARLY_START = 0.1;
const VE_EARLY_END = 0.3;
const VE_LATE_START = 0.85;
const VE_LATE_END = 1.05;
// After both drops, level should fall substantially (x² × x²).
const VE_DROP_MIN_DB = 15;
const VE_DROP_ERR_MAX_DB = 12;

Deno.test("almost-simple: volume+expression vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/almost-simple-vol-expr.mid`;

  await t.step("generate volume+expression MIDI", async () => {
    const bytes = buildVolumeAndExpressionMidi({});
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
    `${OUT_DIR}/fluidsynth-almost-simple-vol-expr.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth combined drop", () => {
    const early = windowRmsDb(refMono, refRate, VE_EARLY_START, VE_EARLY_END);
    const late = windowRmsDb(refMono, refRate, VE_LATE_START, VE_LATE_END);
    const drop = early - late;
    console.log(
      `  fluidsynth vol+expr: early=${early.toFixed(1)}dB late=${
        late.toFixed(1)
      }dB drop=${drop.toFixed(1)}dB`,
    );
    if (drop < VE_DROP_MIN_DB) {
      throw new Error(
        `fluidsynth combined drop only ${drop.toFixed(1)}dB`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-almost-simple-vol-expr",
    (label, candMono, sr) => {
      const early = windowRmsDb(candMono, sr, VE_EARLY_START, VE_EARLY_END);
      const late = windowRmsDb(candMono, sr, VE_LATE_START, VE_LATE_END);
      const drop = early - late;
      const refEarly = windowRmsDb(
        refMono,
        refRate,
        VE_EARLY_START,
        VE_EARLY_END,
      );
      const refLate = windowRmsDb(refMono, refRate, VE_LATE_START, VE_LATE_END);
      const refDrop = refEarly - refLate;
      const err = Math.abs(drop - refDrop);
      console.log(
        `  ${label}: early=${early.toFixed(1)} late=${late.toFixed(1)}dB ` +
          `drop=${drop.toFixed(1)} (ref=${refDrop.toFixed(1)} err=${
            err.toFixed(1)
          })`,
      );
      if (drop < VE_DROP_MIN_DB) {
        throw new Error(
          `${label}: combined drop only ${
            drop.toFixed(1)
          }dB — vol/expr curve not applied`,
        );
      }
      if (err > VE_DROP_ERR_MAX_DB) {
        throw new Error(
          `${label}: combined drop diverges from fluidsynth by ${
            err.toFixed(1)
          }dB`,
        );
      }
    },
    refMono,
    refRate,
  );
});

// Negative control for pan / pitch-bend is already covered by:
//   tools/compare-controllers.test.ts  (CC10 pan left→right)
//   tools/compare-pitch.test.ts         (pitch bend)
// Those must keep failing if almost-simple accidentally swallows non-gain CCs.
