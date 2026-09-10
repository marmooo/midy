// fluidsynth ↔ midy: polyphony (WIP — expected to need deeper work).
//
// Not included in the main compare-*.test.ts suite on purpose: residual /
// envelope thresholds here are provisional and known to fail until voice
// mixing / gain staging is aligned more carefully with FluidSynth.
//
// Usage (run explicitly when working on polyphony):
//   deno test -A tools/compare-polyphony.test.ts
//
import { buildPolyphonyMidi } from "./gen-midi-scenarios.ts";
import {
  assertNonEmptyFile,
  compareMono,
  ensureFsBin,
  ensureOutDir,
  forEachCacheModeRender,
  formatCompareResult,
  OUT_DIR,
  renderScenarioReference,
  windowRmsDb,
} from "./compare-common.ts";

// ---------------------------------------------------------------------------
// Two-note polyphony — energy + envelope vs fluidsynth
// ---------------------------------------------------------------------------
const POLY_START = 0.15;
const POLY_END = 0.85;
// Provisional floors — tighten once midy mixing matches fluidsynth better.
const POLY_RESIDUAL_DB_MAX = -3;
const POLY_ENV_CORR_MIN = 0.8;

Deno.test("two-note polyphony vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/polyphony.mid`;

  await t.step("generate polyphony MIDI", async () => {
    const bytes = buildPolyphonyMidi({});
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
    `${OUT_DIR}/fluidsynth-polyphony.wav`,
    fluidsynthBin,
  );

  await t.step("sanity-check fluidsynth polyphony level", () => {
    const level = windowRmsDb(refMono, refRate, POLY_START, POLY_END);
    console.log(`  fluidsynth polyphony: level=${level.toFixed(1)}dB`);
    if (!Number.isFinite(level) || level < -50) {
      throw new Error(`fluidsynth polyphony effectively silent`);
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-polyphony",
    (label, candMono, sr) => {
      const level = windowRmsDb(candMono, sr, POLY_START, POLY_END);
      const refLevel = windowRmsDb(refMono, refRate, POLY_START, POLY_END);
      console.log(
        `  ${label}: level=${level.toFixed(1)}dB (ref=${
          refLevel.toFixed(1)
        }dB)`,
      );
      if (!Number.isFinite(level) || level < -50) {
        throw new Error(`${label}: polyphony effectively silent`);
      }
      const cmp = compareMono(refMono, candMono, sr, { maxLagMs: 40 });
      console.log(formatCompareResult(`${label} waveform`, cmp));
      if (cmp.residualDb > POLY_RESIDUAL_DB_MAX) {
        throw new Error(
          `${label}: residual ${
            cmp.residualDb.toFixed(1)
          }dB above max ${POLY_RESIDUAL_DB_MAX}dB`,
        );
      }
      if (cmp.envelopeCorrelation < POLY_ENV_CORR_MIN) {
        throw new Error(
          `${label}: envelope correlation ${
            cmp.envelopeCorrelation.toFixed(3)
          } ` +
            `below min ${POLY_ENV_CORR_MIN}`,
        );
      }
    },
    refMono,
    refRate,
    { skipWaveformSoftCheck: true },
  );
});
