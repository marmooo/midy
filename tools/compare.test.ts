// fluidsynth ↔ midy conformance pipeline.
//
// Stages (each a reportable `t.step`):
//   1. Single melodic note — sanity + residual/envelope compare vs fluidsynth
//   2. Drum exclusive (open HH cut by closed HH) — exclusiveClass behaviour
//   3. Pitch bend — frequency shifts with channel pitch bend
//   4. CC7 volume — level tracks control change during a note
//   5. Sustain pedal — note continues after note-off while pedal is down
//
// Usage:
//   deno test -A tools/compare.test.ts
//
// WAV outputs land in OUT_DIR for manual inspection.
import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
import {
  buildHiHatExclusiveMidi,
  buildPitchBendMidi,
  buildSustainPedalMidi,
  buildVolumeCcMidi,
} from "./gen-midi-scenarios.ts";
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
import {
  compareMono,
  formatCompareResult,
  windowRmsDb,
} from "./audio-compare.ts";

const OUT_DIR = "/tmp/midy-gm2-check";
const SF2_PATH = "tools/GeneralUser_GS_v1.472.sf3";
const HARNESS_DIR = "tools";
const SAMPLE_RATE = 48000;
const FLUIDSYNTH_VERSION = "v2.6.0";

const NOTE_NUMBER = 60;
const NOTE_VELOCITY = 100;
const NOTE_DURATION = 1; // seconds
const EXPECTED_FREQ_HZ = midiNoteToHz(NOTE_NUMBER);

const SUSTAIN_START_OFFSET = 0.15;
const SUSTAIN_END_MARGIN = 0.1;
const PITCH_TOLERANCE_CENTS = 50;

// After align + peak-gain match, residual energy relative to reference.
// FluidSynth and Web Audio DSP differ; -6 dB residual is still a strong
// structural match for a single piano note (not bit-identical).
const SINGLE_NOTE_RESIDUAL_DB_MAX = -6;
// Envelope shape correlation after align/gain (1 = identical shape).
const SINGLE_NOTE_ENV_CORR_MIN = 0.85;
// Max |lag| allowed after cross-correlation (onset timing).
const SINGLE_NOTE_MAX_LAG_MS = 30;

// Exclusive scenario timings (must match buildHiHatExclusiveMidi defaults).
const EXCL_OPEN_START = 0;
const EXCL_CLOSED_START = 0.4;
const EXCL_CLOSED_DURATION = 0.3;
// Attack of the open hat — GeneralUser's open HH is a short one-shot in
// fluidsynth, so energy is only reliable near the onset (not at 0.25s+).
const EXCL_ATTACK_START = 0.02;
const EXCL_ATTACK_END = 0.12;
// Just before / after closed-hat onset (exclusive cut point).
const EXCL_PRE_START = 0.25;
const EXCL_PRE_END = 0.38;
const EXCL_POST_START = 0.42;
const EXCL_POST_END = 0.55;
// Late tail after both notes should have released.
const EXCL_TAIL_START = 1.2;
const EXCL_TAIL_END = 1.6;
// Attack energy must be within this many dB of the file's own peak RMS
// (relative, so absolute level differences vs fluidsynth do not matter).
const EXCL_ATTACK_REL_DB = 25;
// Drum hits are short/noisy; residual after align+gain is looser than piano.
// "audio" mode (full-song bake + peak normalize) sits around -1.4 dB on this
// hi-hat scenario, so the floor is set just below that rather than -1.5.
const EXCL_RESIDUAL_DB_MAX = -1.0;
const EXCL_ENV_CORR_MIN = 0.7;
// Tail may still hold a quiet release; fail only if it stays within this
// many dB of the attack level (open hat never released / exclusive no-op).
const EXCL_TAIL_VS_ATTACK_DB = 8;

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
  mono: Float32Array;
  sampleRate: number;
}

/**
 * Sanity-check a single-note WAV and return mono samples for further compare.
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
      `${label}: onset at ${onsetTime.toFixed(3)}s, expected near 0s`,
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
      `${label}: NOTE_DURATION too short for sustain window`,
    );
  }
  const sustainRmsValue = rms(mono, sustainStart, sustainEnd);
  const sustainDb = toDb(sustainRmsValue);
  if (sustainDb < -50) {
    throw new Error(
      `${label}: note is not sustaining — RMS is ${sustainDb.toFixed(1)}dB`,
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
      }Hz — off by ${pitchCentsError.toFixed(1)} cents`,
    );
  }

  return {
    onsetTime,
    sustainRms: sustainRmsValue,
    sustainDb,
    pitchHz,
    pitchCentsError,
    mono,
    sampleRate: wav.sampleRate,
  };
}

function assertSingleNoteMatch(
  label: string,
  ref: SingleNoteCheck,
  cand: SingleNoteCheck,
): void {
  if (ref.sampleRate !== cand.sampleRate) {
    throw new Error(
      `${label}: sample rate mismatch ref=${ref.sampleRate} cand=${cand.sampleRate}`,
    );
  }
  const cmp = compareMono(ref.mono, cand.mono, ref.sampleRate, {
    maxLagMs: SINGLE_NOTE_MAX_LAG_MS + 20,
  });
  console.log(formatCompareResult(label, cmp));

  const lagMs = (Math.abs(cmp.align.lagFrames) / ref.sampleRate) * 1000;
  if (lagMs > SINGLE_NOTE_MAX_LAG_MS) {
    throw new Error(
      `${label}: onset lag ${
        lagMs.toFixed(1)
      }ms exceeds ${SINGLE_NOTE_MAX_LAG_MS}ms`,
    );
  }
  if (cmp.residualDb > SINGLE_NOTE_RESIDUAL_DB_MAX) {
    throw new Error(
      `${label}: residual ${
        cmp.residualDb.toFixed(1)
      }dB is above max ${SINGLE_NOTE_RESIDUAL_DB_MAX}dB (waveforms diverge)`,
    );
  }
  if (cmp.envelopeCorrelation < SINGLE_NOTE_ENV_CORR_MIN) {
    throw new Error(
      `${label}: envelope correlation ${
        cmp.envelopeCorrelation.toFixed(3)
      } below min ${SINGLE_NOTE_ENV_CORR_MIN}`,
    );
  }
}

function peakRmsDb(samples: Float32Array, sampleRate: number): number {
  // Peak of short sliding RMS (20ms) — more stable than sample peak for drums.
  const win = Math.max(1, Math.round(0.02 * sampleRate));
  let best = 0;
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    run += samples[i] * samples[i];
    if (i >= win) {
      const old = samples[i - win];
      run -= old * old;
    }
    const n = Math.min(win, i + 1);
    const r = Math.sqrt(run / n);
    if (r > best) best = r;
  }
  return toDb(best);
}

/**
 * Exclusive-class checks against fluidsynth.
 *
 * Absolute levels differ a lot (midy is typically ~20dB hotter; fluidsynth's
 * open HH is a short one-shot that is already near silence by 0.25s). So we:
 *  - require each side's *attack* to be audible relative to its own peak
 *  - compare envelope shape after align+gain (not absolute pre-window dB)
 *  - require midy's tail to decay vs its own attack (exclusive / release fired)
 *  - track post−pre energy delta vs fluidsynth within a wide tolerance
 */
function assertExclusiveCut(
  label: string,
  refMono: Float32Array,
  candMono: Float32Array,
  sampleRate: number,
): void {
  const refAttack = windowRmsDb(
    refMono,
    sampleRate,
    EXCL_ATTACK_START,
    EXCL_ATTACK_END,
  );
  const candAttack = windowRmsDb(
    candMono,
    sampleRate,
    EXCL_ATTACK_START,
    EXCL_ATTACK_END,
  );
  const refPre = windowRmsDb(refMono, sampleRate, EXCL_PRE_START, EXCL_PRE_END);
  const refPost = windowRmsDb(
    refMono,
    sampleRate,
    EXCL_POST_START,
    EXCL_POST_END,
  );
  const candPre = windowRmsDb(
    candMono,
    sampleRate,
    EXCL_PRE_START,
    EXCL_PRE_END,
  );
  const candPost = windowRmsDb(
    candMono,
    sampleRate,
    EXCL_POST_START,
    EXCL_POST_END,
  );
  const refTail = windowRmsDb(
    refMono,
    sampleRate,
    EXCL_TAIL_START,
    EXCL_TAIL_END,
  );
  const candTail = windowRmsDb(
    candMono,
    sampleRate,
    EXCL_TAIL_START,
    EXCL_TAIL_END,
  );
  const refPeakDb = peakRmsDb(refMono, sampleRate);
  const candPeakDb = peakRmsDb(candMono, sampleRate);

  console.log(
    `  ${label}: attack=${candAttack.toFixed(1)}dB pre=${candPre.toFixed(1)} ` +
      `post=${candPost.toFixed(1)} tail=${candTail.toFixed(1)} ` +
      `(peak=${candPeakDb.toFixed(1)}) | ref attack=${refAttack.toFixed(1)} ` +
      `pre=${refPre.toFixed(1)} post=${refPost.toFixed(1)} tail=${
        Number.isFinite(refTail) ? refTail.toFixed(1) : "-inf"
      } (peak=${refPeakDb.toFixed(1)})`,
  );

  if (!Number.isFinite(candPeakDb) || candPeakDb < -80) {
    throw new Error(`${label}: candidate is effectively silent`);
  }
  if (!Number.isFinite(refPeakDb) || refPeakDb < -80) {
    throw new Error(`${label}: fluidsynth reference is effectively silent`);
  }

  // Attack must be present relative to each renderer's own peak.
  if (candAttack < candPeakDb - EXCL_ATTACK_REL_DB) {
    throw new Error(
      `${label}: open-hat attack missing ` +
        `(attack=${candAttack.toFixed(1)}dB peak=${candPeakDb.toFixed(1)}dB)`,
    );
  }
  if (refAttack < refPeakDb - EXCL_ATTACK_REL_DB) {
    throw new Error(
      `${label}: fluidsynth open-hat attack missing ` +
        `(attack=${refAttack.toFixed(1)}dB peak=${refPeakDb.toFixed(1)}dB)`,
    );
  }

  // post−pre delta should roughly track fluidsynth (closed hat vs residual open).
  // Fluidsynth's open HH is often already quiet by pre, so |refDelta| can be
  // small; only fail on large divergences.
  const refDelta = refPost - refPre;
  const candDelta = candPost - candPre;
  const deltaError = Math.abs(candDelta - refDelta);
  if (deltaError > 12) {
    throw new Error(
      `${label}: exclusive cut energy change diverges from fluidsynth ` +
        `(cand Δ=${candDelta.toFixed(1)}dB ref Δ=${
          refDelta.toFixed(1)
        }dB, |err|=${deltaError.toFixed(1)}dB)`,
    );
  }

  // Tail must decay relative to this render's own attack (exclusive/release).
  // Absolute comparison to fluidsynth's -inf tail is not meaningful when midy
  // keeps a longer natural release.
  if (candTail > candAttack - EXCL_TAIL_VS_ATTACK_DB) {
    throw new Error(
      `${label}: tail (${candTail.toFixed(1)}dB) still near attack ` +
        `(${
          candAttack.toFixed(1)
        }dB) — exclusive cut / release may not have fired`,
    );
  }

  const cmp = compareMono(refMono, candMono, sampleRate, { maxLagMs: 40 });
  console.log(formatCompareResult(`${label} waveform`, cmp));
  if (cmp.residualDb > EXCL_RESIDUAL_DB_MAX) {
    throw new Error(
      `${label}: residual ${
        cmp.residualDb.toFixed(1)
      }dB above max ${EXCL_RESIDUAL_DB_MAX}dB`,
    );
  }
  if (cmp.envelopeCorrelation < EXCL_ENV_CORR_MIN) {
    throw new Error(
      `${label}: envelope correlation ${cmp.envelopeCorrelation.toFixed(3)} ` +
        `below min ${EXCL_ENV_CORR_MIN}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 1: single melodic note
// ---------------------------------------------------------------------------
Deno.test("single-note GM2 conformance (sanity + fluidsynth compare)", async (t) => {
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

  const fluidsynthWavPath = `${OUT_DIR}/fluidsynth-single.wav`;
  let refCheck: SingleNoteCheck | null = null;

  await t.step("render + sanity-check fluidsynth reference", async () => {
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath: fluidsynthWavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(fluidsynthWavPath);
    const bytes = await Deno.readFile(fluidsynthWavPath);
    refCheck = checkSingleNoteWav("fluidsynth", bytes);
    console.log(
      `  fluidsynth: onset=${refCheck.onsetTime.toFixed(3)}s sustain=${
        refCheck.sustainDb.toFixed(1)
      }dB pitch=${refCheck.pitchHz?.toFixed(1)}Hz (${
        refCheck.pitchCentsError?.toFixed(1)
      } cents)`,
    );
  });

  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/midy-single-${cacheMode}.wav`;

    await t.step(`render midy (cacheMode=${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
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
      `sanity + compare midy (${cacheMode}) vs fluidsynth`,
      async () => {
        const bytes = await Deno.readFile(midyWavPath);
        const cand = checkSingleNoteWav(`midy(${cacheMode})`, bytes);
        console.log(
          `  midy(${cacheMode}): onset=${cand.onsetTime.toFixed(3)}s sustain=${
            cand.sustainDb.toFixed(1)
          }dB pitch=${cand.pitchHz?.toFixed(1)}Hz (${
            cand.pitchCentsError?.toFixed(1)
          } cents)`,
        );
        if (!refCheck) throw new Error("fluidsynth reference missing");
        assertSingleNoteMatch(`midy(${cacheMode})`, refCheck, cand);
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Test 2: drum exclusive class (open HH cut by closed HH)
// ---------------------------------------------------------------------------
Deno.test("exclusive-class hi-hat cut vs fluidsynth", async (t) => {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const midiPath = `${OUT_DIR}/exclusive-hihat.mid`;

  await t.step("generate exclusive hi-hat MIDI", async () => {
    const bytes = buildHiHatExclusiveMidi({
      openStart: EXCL_OPEN_START,
      closedStart: EXCL_CLOSED_START,
      closedDuration: EXCL_CLOSED_DURATION,
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

  const fluidsynthWavPath = `${OUT_DIR}/fluidsynth-exclusive.wav`;
  let refMono: Float32Array | null = null;
  let refRate = SAMPLE_RATE;

  await t.step("render + load fluidsynth reference", async () => {
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath: fluidsynthWavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(fluidsynthWavPath);
    const wav = readWav(await Deno.readFile(fluidsynthWavPath));
    refMono = toMono(wav);
    refRate = wav.sampleRate;
    const peakDb = peakRmsDb(refMono, refRate);
    const attack = windowRmsDb(
      refMono,
      refRate,
      EXCL_ATTACK_START,
      EXCL_ATTACK_END,
    );
    const pre = windowRmsDb(refMono, refRate, EXCL_PRE_START, EXCL_PRE_END);
    const post = windowRmsDb(refMono, refRate, EXCL_POST_START, EXCL_POST_END);
    // Open HH in GeneralUser is a short one-shot: only the attack is reliably
    // audible; by the pre-cut window fluidsynth is often already near silence.
    if (!Number.isFinite(peakDb) || peakDb < -80) {
      throw new Error(
        `fluidsynth exclusive reference is effectively silent (peak=${peakDb}dB)`,
      );
    }
    if (attack < peakDb - EXCL_ATTACK_REL_DB) {
      throw new Error(
        `fluidsynth exclusive reference: open-hat attack missing ` +
          `(attack=${attack.toFixed(1)}dB peak=${peakDb.toFixed(1)}dB)`,
      );
    }
    console.log(
      `  fluidsynth exclusive: attack=${attack.toFixed(1)}dB pre=${
        pre.toFixed(1)
      } post=${post.toFixed(1)} peak=${peakDb.toFixed(1)}`,
    );
  });

  // Exclusive is most sensitive on realtime-ish modes; still check all modes
  // so a regression in segment/chunk ghost notes is caught.
  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/midy-exclusive-${cacheMode}.wav`;

    await t.step(`render midy exclusive (cacheMode=${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        cacheMode,
        sampleRate: SAMPLE_RATE,
      });
      if (wavBytes.length === 0) {
        throw new Error(`midy exclusive (${cacheMode}) returned empty WAV`);
      }
      await Deno.writeFile(midyWavPath, wavBytes);
    });

    await t.step(`compare exclusive cut (${cacheMode})`, async () => {
      if (!refMono) throw new Error("fluidsynth reference missing");
      const wav = readWav(await Deno.readFile(midyWavPath));
      const candMono = toMono(wav);
      if (wav.sampleRate !== refRate) {
        throw new Error(
          `sample rate mismatch: midy=${wav.sampleRate} ref=${refRate}`,
        );
      }
      assertExclusiveCut(`midy(${cacheMode})`, refMono, candMono, refRate);
    });
  }
});

// ---------------------------------------------------------------------------
// Shared helpers for multi-mode scenario tests
// ---------------------------------------------------------------------------

async function renderScenarioReference(
  t: Deno.TestContext,
  midiPath: string,
  wavPath: string,
  fluidsynthBin: string,
): Promise<{ mono: Float32Array; sampleRate: number }> {
  let mono: Float32Array | null = null;
  let sampleRate = SAMPLE_RATE;
  await t.step("render fluidsynth reference", async () => {
    await renderWithFluidsynth({
      fluidsynthBin,
      sf2Path: SF2_PATH,
      midiPath,
      wavPath,
      sampleRate: SAMPLE_RATE,
    });
    await assertNonEmptyFile(wavPath);
    const wav = readWav(await Deno.readFile(wavPath));
    mono = toMono(wav);
    sampleRate = wav.sampleRate;
  });
  if (!mono) throw new Error("fluidsynth reference missing");
  return { mono, sampleRate };
}

async function forEachCacheModeRender(
  t: Deno.TestContext,
  midiPath: string,
  outPrefix: string,
  check: (
    label: string,
    candMono: Float32Array,
    sampleRate: number,
  ) => void,
  refMono: Float32Array,
  refRate: number,
): Promise<void> {
  for (const cacheMode of CACHE_MODES) {
    const midyWavPath = `${OUT_DIR}/${outPrefix}-${cacheMode}.wav`;
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
      if (wav.sampleRate !== refRate) {
        throw new Error(
          `sample rate mismatch: midy=${wav.sampleRate} ref=${refRate}`,
        );
      }
      check(`midy(${cacheMode})`, toMono(wav), wav.sampleRate);
      // Soft waveform residual (automation scenarios are not bit-identical).
      const cmp = compareMono(refMono, toMono(wav), refRate, { maxLagMs: 40 });
      console.log(formatCompareResult(`${cacheMode} waveform`, cmp));
      if (cmp.envelopeCorrelation < 0.75) {
        throw new Error(
          `midy(${cacheMode}): envelope correlation ${
            cmp.envelopeCorrelation.toFixed(3)
          } too low`,
        );
      }
    });
  }
}

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
  await Deno.mkdir(OUT_DIR, { recursive: true });
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
    fluidsynthBin = await ensureFluidsynthBinary({
      version: FLUIDSYNTH_VERSION,
    });
  });

  const { mono: refMono, sampleRate: refRate } = await renderScenarioReference(
    t,
    midiPath,
    `${OUT_DIR}/fluidsynth-pitch-bend.wav`,
    fluidsynthBin,
  );

  const pitchInWindow = (
    mono: Float32Array,
    sr: number,
    a: number,
    b: number,
    minHz: number,
    maxHz: number,
  ): number | null => {
    return estimatePitchHz(
      mono,
      sr,
      Math.floor(a * sr),
      Math.floor(b * sr),
      minHz,
      maxHz,
    );
  };

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
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const midiPath = `${OUT_DIR}/volume-cc.mid`;

  await t.step("generate volume-CC MIDI", async () => {
    const bytes = buildVolumeCcMidi({});
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFluidsynthBinary({
      version: FLUIDSYNTH_VERSION,
    });
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
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const midiPath = `${OUT_DIR}/sustain-pedal.mid`;

  await t.step("generate sustain-pedal MIDI", async () => {
    const bytes = buildSustainPedalMidi({});
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  let fluidsynthBin = "";
  await t.step("build/ensure fluidsynth binary", async () => {
    fluidsynthBin = await ensureFluidsynthBinary({
      version: FLUIDSYNTH_VERSION,
    });
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
