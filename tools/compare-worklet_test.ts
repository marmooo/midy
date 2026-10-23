// Worklet-mode audio quality checks (tools/).
//
// Worklet cannot use OfflineAudioContext / player.render(), so capture goes
// through tools/render-midy-worklet-headless.ts (realtime AudioWorklet).
//
// Compares fluidsynth reference vs midy worklet on a single melodic note:
//   - non-silent / finite PCM
//   - pitch within tolerance
//   - residual + envelope correlation (thresholds looser than none-mode)
//
// Usage (repo root, dist/midy.js built, Chrome available):
//   deno test -A tools/compare-worklet_test.ts
//
//   MIDY_QUICK=1         → 24 kHz (via compare-common)
//   MIDY_SKIP_WORKLET=1  → skip (no Chrome / CI without browser)
//   MIDY_SAMPLE_RATE=…   → override rate

import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
import {
  assertNonEmptyFile,
  checkSingleNoteWav,
  ensureFsBin,
  ensureOutDir,
  HARNESS_DIR,
  NOTE_DURATION,
  NOTE_NUMBER,
  NOTE_VELOCITY,
  OUT_DIR,
  readWav,
  renderWithFluidsynth,
  SAMPLE_RATE,
  SF2_PATH,
  toMono,
} from "./compare-common.ts";
import { renderMidyWorklet } from "./render-midy-worklet-headless.ts";
import { compareMono, formatCompareResult } from "./audio-compare.ts";

function envTruthy(name: string): boolean {
  const v = Deno.env.get(name);
  return v === "1" || v === "true" || v === "yes";
}

const SKIP = envTruthy("MIDY_SKIP_WORKLET");

// Looser than SINGLE_NOTE_RESIDUAL_DB_MAX (-6): Phase-2 worklet is approximate.
const WORKLET_RESIDUAL_DB_MAX = 3.0;
const WORKLET_ENV_CORR_MIN = 0.50;
const WORKLET_PITCH_CENTS = 80;

async function distMidyExists(): Promise<boolean> {
  try {
    await Deno.stat("dist/midy.js");
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name: "worklet single-note quality vs fluidsynth",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    if (!(await distMidyExists())) {
      console.warn(
        "[compare-worklet] dist/midy.js missing — skip (run deno task build)",
      );
      return;
    }

    await ensureOutDir();
    const midiPath = `${OUT_DIR}/worklet-single-note.mid`;

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
    await t.step("ensure fluidsynth", async () => {
      fluidsynthBin = await ensureFsBin();
    });

    const refWavPath = `${OUT_DIR}/fluidsynth-worklet-ref.wav`;
    await t.step("render fluidsynth reference", async () => {
      await renderWithFluidsynth({
        fluidsynthBin,
        sf2Path: SF2_PATH,
        midiPath,
        wavPath: refWavPath,
        sampleRate: SAMPLE_RATE,
      });
      await assertNonEmptyFile(refWavPath);
      const bytes = await Deno.readFile(refWavPath);
      const check = checkSingleNoteWav("fluidsynth", bytes);
      console.log(
        `  fluidsynth: onset=${check.onsetTime.toFixed(3)}s ` +
          `sustain=${check.sustainDb.toFixed(1)}dB pitch=${
            check.pitchHz?.toFixed(1)
          }Hz`,
      );
    });

    const workletWavPath = `${OUT_DIR}/midy-worklet-single.wav`;
    let workletBytes: Uint8Array | null = null;

    await t.step("render midy worklet (realtime capture)", async () => {
      workletBytes = await renderMidyWorklet({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        sampleRate: SAMPLE_RATE,
        tailSec: 0.5,
      });
      await Deno.writeFile(workletWavPath, workletBytes);
      await assertNonEmptyFile(workletWavPath);
      console.log(
        `  wrote ${workletWavPath} (${workletBytes.byteLength} bytes)`,
      );
    });

    await t.step("sanity: non-silent + pitch in range", async () => {
      if (!workletBytes) throw new Error("no worklet bytes");
      const check = checkSingleNoteWav("worklet", workletBytes);
      console.log(
        `  worklet: onset=${check.onsetTime.toFixed(3)}s ` +
          `sustain=${check.sustainDb.toFixed(1)}dB pitch=${
            check.pitchHz?.toFixed(1)
          }Hz (${check.pitchCentsError?.toFixed(1)} cents)`,
      );
      if (check.sustainDb < -60) {
        throw new Error(
          `worklet output too quiet: sustain ${check.sustainDb.toFixed(1)} dB`,
        );
      }
      if (
        check.pitchCentsError != null &&
        Math.abs(check.pitchCentsError) > WORKLET_PITCH_CENTS
      ) {
        throw new Error(
          `worklet pitch error ${check.pitchCentsError.toFixed(1)} cents ` +
            `exceeds ±${WORKLET_PITCH_CENTS}`,
        );
      }
    });

    await t.step("compare residual / envelope vs fluidsynth", async () => {
      if (!workletBytes) throw new Error("no worklet bytes");
      const refBytes = await Deno.readFile(refWavPath);
      const refWav = readWav(refBytes);
      const candWav = readWav(workletBytes);
      const refMono = toMono(refWav);
      const candMono = toMono(candWav);

      const cmp = compareMono(refMono, candMono, SAMPLE_RATE, {
        maxLagMs: 80,
      });
      console.log(formatCompareResult("worklet", cmp));

      if (cmp.residualDb > WORKLET_RESIDUAL_DB_MAX) {
        throw new Error(
          `worklet residual ${cmp.residualDb.toFixed(2)} dB > ` +
            `${WORKLET_RESIDUAL_DB_MAX} dB (too unlike fluidsynth)`,
        );
      }
      if (cmp.envelopeCorrelation < WORKLET_ENV_CORR_MIN) {
        throw new Error(
          `worklet env correlation ${cmp.envelopeCorrelation.toFixed(3)} < ` +
            `${WORKLET_ENV_CORR_MIN}`,
        );
      }
    });
  },
});

Deno.test({
  name: "worklet capture produces finite PCM (smoke)",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!(await distMidyExists())) {
      console.warn("[compare-worklet] dist/midy.js missing — skip smoke");
      return;
    }
    await ensureOutDir();
    const midiPath = `${OUT_DIR}/worklet-smoke.mid`;
    const bytes = buildSingleNoteMidi({
      noteNumber: 64,
      velocity: 90,
      duration: 0.5,
    });
    await Deno.writeFile(midiPath, bytes);

    const wavBytes = await renderMidyWorklet({
      harnessDir: HARNESS_DIR,
      midiPath,
      soundFontPath: SF2_PATH,
      sampleRate: SAMPLE_RATE,
      tailSec: 0.3,
    });
    const wav = readWav(wavBytes);
    const mono = toMono(wav);
    let peak = 0;
    let finite = true;
    for (let i = 0; i < mono.length; i++) {
      const s = mono[i];
      if (!Number.isFinite(s)) {
        finite = false;
        break;
      }
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    if (!finite) throw new Error("worklet PCM contains non-finite samples");
    if (peak < 1e-6) throw new Error("worklet smoke render is silent");
    console.log(`  smoke peak=${peak.toFixed(4)} frames=${mono.length}`);
  },
});
