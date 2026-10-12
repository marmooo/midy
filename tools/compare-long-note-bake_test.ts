// fluidsynth ↔ midy: long-note full-note offline bake path
// (perf: bake long note — longNoteBakedSet).
//
// Notes whose duration+releaseTail exceeds maxTiledNoteDuration (default 8s)
// are excluded from segment/chunk tiles and played via getNoteModeBuffer.
// This suite holds a melodic note past that threshold and checks that
// midy output still matches fluidsynth structurally (length + residual).
//
// Usage:
//   deno test -A tools/compare-long-note-bake_test.ts
//   MIDY_QUICK=1 deno test -A tools/compare-long-note-bake_test.ts
//
import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
import {
  assertNonEmptyFile,
  CACHE_MODES,
  type CacheMode,
  compareMono,
  ensureFsBin,
  ensureOutDir,
  formatCompareResult,
  HARNESS_DIR,
  OUT_DIR,
  readWav,
  renderMidyMode,
  renderWithFluidsynth,
  SAMPLE_RATE,
  SF2_PATH,
  toMono,
  windowRmsDb,
} from "./compare-common.ts";

/**
 * Must exceed Player.maxTiledNoteDuration (default 8) so segment/chunk
 * classification puts the note into longNoteBakedSet instead of tiledBakedSet.
 */
const LONG_BAKE_DURATION = 10;
/** Trailing silence so release tails are captured. */
const TAIL_SILENCE = 2;

/** Modes that exercise tile classification / long-note bake. */
const LONG_BAKE_MODES: CacheMode[] = (() => {
  const preferred: CacheMode[] = ["segment", "chunk", "note", "audio"];
  return preferred.filter((m) => (CACHE_MODES as string[]).includes(m));
})();

/** Residual ceiling after align + peak-gain match (same ballpark as single-note). */
const LONG_BAKE_RESIDUAL_DB_MAX = -4;

/** Early / mid / late sustain windows (seconds from song start). */
const EARLY = { start: 0.4, end: 0.6 };
const MID = { start: 4.5, end: 4.7 };
const LATE = { start: 8.5, end: 8.7 };

function analyzeWindows(
  label: string,
  mono: Float32Array,
  sampleRate: number,
): { early: number; mid: number; late: number } {
  const early = windowRmsDb(mono, sampleRate, EARLY.start, EARLY.end);
  const mid = windowRmsDb(mono, sampleRate, MID.start, MID.end);
  const late = windowRmsDb(mono, sampleRate, LATE.start, LATE.end);
  console.log(
    `  ${label}: early=${early.toFixed(1)}dB mid=${mid.toFixed(1)}dB ` +
      `late=${late.toFixed(1)}dB`,
  );
  return { early, mid, late };
}

function assertSustained(
  label: string,
  windows: { early: number; mid: number; late: number },
): void {
  // Mid and late must still have energy (not one-shot cutoff before 8s).
  if (!Number.isFinite(windows.mid) || windows.mid < -70) {
    throw new Error(
      `${label}: mid window silent (${windows.mid.toFixed(1)}dB) — ` +
        `long-note bake may have truncated the sustain`,
    );
  }
  if (!Number.isFinite(windows.late) || windows.late < -70) {
    throw new Error(
      `${label}: late window silent (${windows.late.toFixed(1)}dB) — ` +
        `expected activity near t=8.5s on a ${LONG_BAKE_DURATION}s note`,
    );
  }
  // Gradual decay is fine; abrupt drop from early to mid is not.
  if (windows.mid < windows.early - 40) {
    throw new Error(
      `${label}: mid is ${
        (windows.early - windows.mid).toFixed(1)
      }dB below early (early=${windows.early.toFixed(1)} mid=${
        windows.mid.toFixed(1)
      })`,
    );
  }
}

Deno.test(
  "long-note bake: >maxTiled duration vs fluidsynth (segment/chunk/note/audio)",
  async (t) => {
    await ensureOutDir();
    const midiPath = `${OUT_DIR}/long-note-bake.mid`;

    await t.step(
      "generate long melodic MIDI (> maxTiledNoteDuration)",
      async () => {
        const bytes = buildSingleNoteMidi({
          noteNumber: 60,
          velocity: 100,
          duration: LONG_BAKE_DURATION,
          tailSilence: TAIL_SILENCE,
          program: 0,
        });
        await Deno.writeFile(midiPath, bytes);
        await assertNonEmptyFile(midiPath);
      },
    );

    let fluidsynthBin = "";
    await t.step("build/ensure fluidsynth binary", async () => {
      fluidsynthBin = await ensureFsBin();
    });

    const fluidsynthWavPath = `${OUT_DIR}/fluidsynth-long-note-bake.wav`;
    let refMono: Float32Array | null = null;
    let refRate = SAMPLE_RATE;

    await t.step("render + analyze fluidsynth reference", async () => {
      await renderWithFluidsynth({
        fluidsynthBin,
        sf2Path: SF2_PATH,
        midiPath,
        wavPath: fluidsynthWavPath,
        sampleRate: SAMPLE_RATE,
      });
      await assertNonEmptyFile(fluidsynthWavPath);
      const bytes = await Deno.readFile(fluidsynthWavPath);
      const wav = readWav(bytes);
      refMono = toMono(wav);
      refRate = wav.sampleRate;
      const windows = analyzeWindows("fluidsynth", refMono, refRate);
      assertSustained("fluidsynth", windows);
    });

    if (LONG_BAKE_MODES.length === 0) {
      throw new Error(
        "No overlapping cache modes between LONG_BAKE_MODES and CACHE_MODES",
      );
    }

    for (const cacheMode of LONG_BAKE_MODES) {
      const midyWavPath = `${OUT_DIR}/midy-long-note-bake-${cacheMode}.wav`;

      await t.step(`render midy (cacheMode=${cacheMode})`, async () => {
        const wavBytes = await renderMidyMode({
          harnessDir: HARNESS_DIR,
          rootDir: ".",
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
        `sustain + compare midy (${cacheMode}) vs fluidsynth`,
        async () => {
          if (!refMono) throw new Error("fluidsynth reference missing");
          const bytes = await Deno.readFile(midyWavPath);
          const wav = readWav(bytes);
          const candMono = toMono(wav);
          const windows = analyzeWindows(
            `midy(${cacheMode})`,
            candMono,
            wav.sampleRate,
          );
          assertSustained(`midy(${cacheMode})`, windows);

          const cmp = compareMono(refMono, candMono, refRate, {
            maxLagMs: 40,
          });
          console.log(
            `  midy(${cacheMode}) vs fluidsynth: ${
              formatCompareResult(`midy(${cacheMode}) waveform`, cmp)
            }`,
          );
          if (cmp.residualDb > LONG_BAKE_RESIDUAL_DB_MAX) {
            throw new Error(
              `midy(${cacheMode}): residual ${cmp.residualDb.toFixed(1)}dB ` +
                `above max ${LONG_BAKE_RESIDUAL_DB_MAX}dB ` +
                `(long-note bake path diverges from fluidsynth)`,
            );
          }
        },
      );
    }
  },
);
