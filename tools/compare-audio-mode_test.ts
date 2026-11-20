// cacheMode "audio" must match the chunk offline path (playback parity)
// and must not fall back to live scheduling after bake.
//
// Usage:
//   deno test -A tools/compare-audio-mode_test.ts
//
import { buildMelodySingleNoteMidi } from "./gen-midi-scenarios.ts";
import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
import {
  assertNonEmptyFile,
  compareMono,
  ensureOutDir,
  formatCompareResult,
  HARNESS_DIR,
  OUT_DIR,
  readWav,
  renderMidyMode,
  SAMPLE_RATE,
  SF2_PATH,
  toMono,
} from "./compare-common.ts";

const ENV_CORR_MIN = 0.98;
const RESIDUAL_MAX_DB = -25;

async function renderMode(
  midiPath: string,
  cacheMode: "audio" | "chunk",
  outName: string,
): Promise<{ mono: Float32Array; sampleRate: number; durationSec: number }> {
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
  const outPath = `${OUT_DIR}/${outName}`;
  await Deno.writeFile(outPath, wavBytes);
  await assertNonEmptyFile(outPath);
  const wav = readWav(wavBytes);
  return {
    mono: toMono(wav),
    sampleRate: wav.sampleRate,
    durationSec: wav.numFrames / wav.sampleRate,
  };
}

function assertAudioMatchesChunk(
  label: string,
  chunkMono: Float32Array,
  audioMono: Float32Array,
  sampleRate: number,
): void {
  const cmp = compareMono(chunkMono, audioMono, sampleRate, { maxLagMs: 20 });
  console.log(formatCompareResult(`${label} audio↔chunk`, cmp));
  if (cmp.envelopeCorrelation < ENV_CORR_MIN) {
    throw new Error(
      `${label}: envelope correlation ${cmp.envelopeCorrelation.toFixed(4)} ` +
        `< ${ENV_CORR_MIN} (audio must match chunk)`,
    );
  }
  if (cmp.residualDb > RESIDUAL_MAX_DB) {
    throw new Error(
      `${label}: residual ${cmp.residualDb.toFixed(2)} dB ` +
        `> ${RESIDUAL_MAX_DB} dB (audio must match chunk after gain match)`,
    );
  }
}

Deno.test("audio mode matches chunk (single note)", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/audio-mode-single.mid`;

  await t.step("generate single-note MIDI", async () => {
    const bytes = buildSingleNoteMidi({
      noteNumber: 60,
      velocity: 100,
      duration: 0.5,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let chunk: { mono: Float32Array; sampleRate: number; durationSec: number };
  await t.step("render chunk", async () => {
    chunk = await renderMode(midiPath, "chunk", "audio-mode-single-chunk.wav");
  });

  let audio: { mono: Float32Array; sampleRate: number; durationSec: number };
  await t.step("render audio", async () => {
    audio = await renderMode(midiPath, "audio", "audio-mode-single-audio.wav");
  });

  await t.step("compare audio vs chunk", () => {
    if (chunk!.sampleRate !== audio!.sampleRate) {
      throw new Error(
        `sample rate mismatch chunk=${chunk!.sampleRate} audio=${
          audio!.sampleRate
        }`,
      );
    }
    // Both paths should produce a non-trivial buffer (not an empty/truncated bake).
    if (audio!.durationSec < 0.2) {
      throw new Error(`audio bake too short: ${audio!.durationSec}s`);
    }
    assertAudioMatchesChunk(
      "single-note",
      chunk!.mono,
      audio!.mono,
      chunk!.sampleRate,
    );
  });
});

Deno.test("audio mode matches chunk (melody piano)", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/audio-mode-melody.mid`;

  await t.step("generate melody MIDI", async () => {
    const bytes = buildMelodySingleNoteMidi({
      noteNumber: 60,
      velocity: 96,
      duration: 0.8,
      program: 0,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let chunk: { mono: Float32Array; sampleRate: number; durationSec: number };
  await t.step("render chunk", async () => {
    chunk = await renderMode(midiPath, "chunk", "audio-mode-melody-chunk.wav");
  });

  let audio: { mono: Float32Array; sampleRate: number; durationSec: number };
  await t.step("render audio", async () => {
    audio = await renderMode(midiPath, "audio", "audio-mode-melody-audio.wav");
  });

  await t.step("compare audio vs chunk", () => {
    assertAudioMatchesChunk(
      "melody-piano",
      chunk!.mono,
      audio!.mono,
      chunk!.sampleRate,
    );
  });
});
