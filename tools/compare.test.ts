// Runs the whole single-note GM2 comparison pipeline as `deno test -A
// tools/compare.test.ts`: generate the MIDI once, render the fluidsynth
// reference, then render midy for every cacheMode — each as its own
// reportable `t.step`, so a failure at any stage names exactly which stage
// failed instead of a bare pass/fail on the whole thing.
//
// Usage:
//   deno test -A tools/compare.test.ts
//
// Output WAVs land in OUT_DIR (edit the constants below to change any of
// this) for follow-up inspection/diffing — this step only generates them
// and sanity-checks they're non-empty; it doesn't compare them against each
// other yet.
import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
import {
  ensureFluidsynthBinary,
  renderWithFluidsynth,
} from "./render-fluidsynth.ts";
import { type CacheMode, renderMidyMode } from "./render-midy-headless.ts";
import { readWav, toMono } from "./wav.ts";
import {
  estimatePitchHz,
  findOnsetFrame,
  midiNoteToHz,
  rms,
  toDb,
} from "./audio-metrics.ts";

const OUT_DIR = "/tmp/midy-gm2-check";
const SF2_PATH = "tools/GeneralUser_GS_v1.472.sf3";
const HARNESS_DIR = "tools";
const SAMPLE_RATE = 48000;
const FLUIDSYNTH_VERSION = "v2.6.0";

const NOTE_NUMBER = 60;
const NOTE_VELOCITY = 100;
const NOTE_DURATION = 1; // seconds
const EXPECTED_FREQ_HZ = midiNoteToHz(NOTE_NUMBER);

// How far into the note the attack transient/onset detection noise is
// assumed to have settled, and how close to note-off we stop measuring to
// avoid the release ramp — both relative to the detected onset time.
const SUSTAIN_START_OFFSET = 0.15;
const SUSTAIN_END_MARGIN = 0.1;

// Cents (1/100 semitone) of pitch drift we tolerate before calling a render
// "wrong note" rather than "slightly off due to autocorrelation quantization
// or a soundfont's fine-tune". 50 cents = quarter of a semitone.
const PITCH_TOLERANCE_CENTS = 50;

const CACHE_MODES: CacheMode[] = [
  "none",
  "ads",
  "adsr",
  "note",
  "segment",
  "chunk",
  "audio",
];

async function assertNonEmptyFile(path: string): Promise<void> {
  const stat = await Deno.stat(path);
  if (stat.size === 0) {
    throw new Error(`${path} exists but is empty`);
  }
}

interface SingleNoteCheck {
  onsetTime: number;
  sustainRms: number;
  sustainDb: number;
  pitchHz: number | null;
  pitchCentsError: number | null;
}

/**
 * Mechanically sanity-check a single-note WAV: does it start near t=0, does
 * it actually sustain audible sound for roughly NOTE_DURATION seconds, and
 * is the sustained pitch close to the expected MIDI note. Throws with a
 * descriptive message on any failure; returns the measurements otherwise.
 */
function checkSingleNoteWav(label: string, bytes: Uint8Array): SingleNoteCheck {
  const wav = readWav(bytes);
  const mono = toMono(wav);

  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = Math.abs(mono[i]);
    if (v > peak) peak = v;
  }
  if (peak <= 0) {
    throw new Error(`${label}: file is silent (peak amplitude is 0)`);
  }
  const onsetThreshold = Math.max(peak * 0.05, 1e-4);

  const onsetFrame = findOnsetFrame(mono, onsetThreshold);
  if (onsetFrame < 0) {
    throw new Error(`${label}: no onset found above threshold`);
  }
  const onsetTime = onsetFrame / wav.sampleRate;
  if (onsetTime > 0.2) {
    throw new Error(
      `${label}: onset at ${
        onsetTime.toFixed(3)
      }s, expected near 0s (note-on is scheduled at t=0)`,
    );
  }

  const sustainStart = Math.floor(
    (onsetTime + SUSTAIN_START_OFFSET) * wav.sampleRate,
  );
  const sustainEnd = Math.floor(
    (onsetTime + NOTE_DURATION - SUSTAIN_END_MARGIN) * wav.sampleRate,
  );
  if (sustainEnd <= sustainStart) {
    throw new Error(
      `${label}: NOTE_DURATION too short for SUSTAIN_START_OFFSET/SUSTAIN_END_MARGIN — nothing to measure`,
    );
  }
  const sustainRmsValue = rms(mono, sustainStart, sustainEnd);
  const sustainDb = toDb(sustainRmsValue);
  // -50dBFS is "clearly not silence" without being so strict that a quiet
  // patch/soundfont trips a false failure.
  if (sustainDb < -50) {
    throw new Error(
      `${label}: note is not sustaining — RMS in [${
        (sustainStart / wav.sampleRate).toFixed(2)
      }s, ${(sustainEnd / wav.sampleRate).toFixed(2)}s] is ${
        sustainDb.toFixed(1)
      }dB (expected a sustained tone for ~${NOTE_DURATION}s)`,
    );
  }

  const pitchHz = estimatePitchHz(
    mono,
    wav.sampleRate,
    sustainStart,
    sustainEnd,
  );
  if (pitchHz === null) {
    throw new Error(
      `${label}: could not detect a clear pitch during the sustain window`,
    );
  }
  const pitchCentsError = 1200 * Math.log2(pitchHz / EXPECTED_FREQ_HZ);
  if (Math.abs(pitchCentsError) > PITCH_TOLERANCE_CENTS) {
    throw new Error(
      `${label}: pitch is ${pitchHz.toFixed(1)}Hz, expected ~${
        EXPECTED_FREQ_HZ.toFixed(1)
      }Hz ` +
        `(MIDI note ${NOTE_NUMBER}) — off by ${
          pitchCentsError.toFixed(1)
        } cents, ` +
        `tolerance is ${PITCH_TOLERANCE_CENTS} cents`,
    );
  }

  return {
    onsetTime,
    sustainRms: sustainRmsValue,
    sustainDb,
    pitchHz,
    pitchCentsError,
  };
}

Deno.test("single-note GM2 conformance render pipeline", async (t) => {
  await Deno.mkdir(OUT_DIR, { recursive: true });
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
    fluidsynthBin = await ensureFluidsynthBinary({
      version: FLUIDSYNTH_VERSION,
    });
  });

  const fluidsynthWavPath = `${OUT_DIR}/fluidsynth.wav`;
  await t.step("render reference WAV via fluidsynth", async () => {
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath: fluidsynthWavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(fluidsynthWavPath);
  });

  await t.step("sanity-check the fluidsynth reference itself", async () => {
    const bytes = await Deno.readFile(fluidsynthWavPath);
    const result = checkSingleNoteWav("fluidsynth", bytes);
    console.log(
      `  fluidsynth: onset=${result.onsetTime.toFixed(3)}s sustain=${
        result.sustainDb.toFixed(1)
      }dB pitch=${result.pitchHz?.toFixed(1)}Hz (${
        result.pitchCentsError?.toFixed(1)
      } cents)`,
    );
  });

  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/midy-${cacheMode}.wav`;

    await t.step(`render midy WAV (cacheMode=${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        cacheMode,
        sampleRate: SAMPLE_RATE,
      });
      if (wavBytes.length === 0) {
        throw new Error(`midy (cacheMode=${cacheMode}) returned an empty WAV`);
      }
      await Deno.writeFile(midyWavPath, wavBytes);
    });

    await t.step(`check midy WAV (cacheMode=${cacheMode})`, async () => {
      const bytes = await Deno.readFile(midyWavPath);
      const result = checkSingleNoteWav(`midy(${cacheMode})`, bytes);
      console.log(
        `  midy(${cacheMode}): onset=${result.onsetTime.toFixed(3)}s sustain=${
          result.sustainDb.toFixed(1)
        }dB pitch=${result.pitchHz?.toFixed(1)}Hz (${
          result.pitchCentsError?.toFixed(1)
        } cents)`,
      );
    });
  }
});
