// fluidsynth ↔ midy: polyphony scenarios.
//
// Covers simultaneous, staggered, wide-interval, multi-note chord, and
// cross-channel mixing. Residual floors are aligned with measured
// single-note / two-note residuals (~-10 dB after the ADS playbackRate fix).
//
// Usage:
//   deno test -A tools/compare-polyphony.test.ts
//
import {
  buildChordPolyphonyMidi,
  buildCrossChannelPolyphonyMidi,
  buildPolyphonyMidi,
  buildStaggeredPolyphonyMidi,
  buildWideIntervalPolyphonyMidi,
} from "./gen-midi-scenarios.ts";
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
// Shared thresholds (measured residual for healthy modes is ~-10…-20 dB)
// ---------------------------------------------------------------------------
const POLY_RESIDUAL_DB_MAX = -3;
const POLY_ENV_CORR_MIN = 0.8;

type PolyCheckWindow = { start: number; end: number };

async function runPolyphonyScenario(
  t: Deno.TestContext,
  options: {
    name: string;
    midiBytes: Uint8Array;
    midiFile: string;
    refWav: string;
    outPrefix: string;
    window: PolyCheckWindow;
  },
): Promise<void> {
  const { name, midiBytes, midiFile, refWav, outPrefix, window } = options;
  const midiPath = `${OUT_DIR}/${midiFile}`;

  await t.step(`generate ${name} MIDI`, async () => {
    await Deno.writeFile(midiPath, midiBytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFsBin();
  });

  const { mono: refMono, sampleRate: refRate } = await renderScenarioReference(
    t,
    midiPath,
    `${OUT_DIR}/${refWav}`,
    fluidsynthBin,
  );

  await t.step(`sanity-check fluidsynth ${name} level`, () => {
    const level = windowRmsDb(refMono, refRate, window.start, window.end);
    console.log(`  fluidsynth ${name}: level=${level.toFixed(1)}dB`);
    if (!Number.isFinite(level) || level < -50) {
      throw new Error(`fluidsynth ${name} effectively silent`);
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    outPrefix,
    (label, candMono, sr) => {
      const level = windowRmsDb(candMono, sr, window.start, window.end);
      const refLevel = windowRmsDb(refMono, refRate, window.start, window.end);
      console.log(
        `  ${label}: level=${level.toFixed(1)}dB (ref=${
          refLevel.toFixed(1)
        }dB)`,
      );
      if (!Number.isFinite(level) || level < -50) {
        throw new Error(`${label}: ${name} effectively silent`);
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
}

// ---------------------------------------------------------------------------
// 1. Two-note simultaneous (C major third) — baseline mix + ADS pitch bake
// ---------------------------------------------------------------------------
Deno.test("two-note polyphony vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runPolyphonyScenario(t, {
    name: "two-note polyphony",
    midiBytes: buildPolyphonyMidi({}),
    midiFile: "polyphony.mid",
    refWav: "fluidsynth-polyphony.wav",
    outPrefix: "midy-polyphony",
    window: { start: 0.15, end: 0.85 },
  });
});

// ---------------------------------------------------------------------------
// 2. Wide interval (C3 + C5) — different sample zones / root keys
// ---------------------------------------------------------------------------
Deno.test("wide-interval polyphony vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runPolyphonyScenario(t, {
    name: "wide-interval polyphony",
    midiBytes: buildWideIntervalPolyphonyMidi({}),
    midiFile: "polyphony-wide.mid",
    refWav: "fluidsynth-polyphony-wide.wav",
    outPrefix: "midy-polyphony-wide",
    window: { start: 0.15, end: 0.85 },
  });
});

// ---------------------------------------------------------------------------
// 3. Three-note chord (C major triad)
// ---------------------------------------------------------------------------
Deno.test("three-note chord polyphony vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runPolyphonyScenario(t, {
    name: "three-note chord",
    midiBytes: buildChordPolyphonyMidi({}),
    midiFile: "polyphony-chord.mid",
    refWav: "fluidsynth-polyphony-chord.wav",
    outPrefix: "midy-polyphony-chord",
    window: { start: 0.15, end: 0.85 },
  });
});

// ---------------------------------------------------------------------------
// 4. Staggered overlap — concurrent sustain without shared onset
// ---------------------------------------------------------------------------
Deno.test("staggered polyphony vs fluidsynth", async (t) => {
  await ensureOutDir();
  // Overlap window: note B has started (0.35) and note A still holds until 1.0
  await runPolyphonyScenario(t, {
    name: "staggered polyphony",
    midiBytes: buildStaggeredPolyphonyMidi({}),
    midiFile: "polyphony-staggered.mid",
    refWav: "fluidsynth-polyphony-staggered.wav",
    outPrefix: "midy-polyphony-staggered",
    window: { start: 0.45, end: 0.95 },
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-channel polyphony — independent channel buses
// ---------------------------------------------------------------------------
Deno.test("cross-channel polyphony vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runPolyphonyScenario(t, {
    name: "cross-channel polyphony",
    midiBytes: buildCrossChannelPolyphonyMidi({}),
    midiFile: "polyphony-cross-channel.mid",
    refWav: "fluidsynth-polyphony-cross-channel.wav",
    outPrefix: "midy-polyphony-cross-channel",
    window: { start: 0.15, end: 0.85 },
  });
});
