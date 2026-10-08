// Note length / sustain parity across cache modes.
//
// Regression for cacheMode=none truncating looped SF2 samples to one-shot
// length (e.g. GeneralUser Grand Piano-C4 ≈ 2.0s while MIDI note is longer).
//
// Usage:
//   deno test -A tools/compare-note-length_test.ts
//
import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
import {
  assertNonEmptyFile,
  CACHE_MODES,
  type CacheMode,
  ensureOutDir,
  HARNESS_DIR,
  OUT_DIR,
  readWav,
  renderMidyMode,
  SAMPLE_RATE,
  SF2_PATH,
  toMono,
} from "./compare-common.ts";

/** Held note longer than typical piano sample one-shot (~2s on GeneralUser). */
const LONG_NOTE_DURATION = 4;
/** Trailing silence so release tails are captured. */
const TAIL_SILENCE = 2;
/** Window for RMS measurements (seconds). */
const WIN_SEC = 0.08;
/**
 * Absolute amplitude floor: below this the region is treated as silent.
 * Sustain can be quiet (high SF2 sustainVolEnv) but one-shot cutoff is zeros.
 */
const ACTIVE_ABS = 1e-4;
/**
 * Late-window level must not be more than this many dB below the early
 * sustain window (catches abrupt one-shot cutoff vs gradual envelope decay).
 */
const LATE_VS_EARLY_MAX_DROP_DB = 45;
/**
 * Last time energy stays above ACTIVE_ABS must reach at least this fraction
 * of the MIDI note duration (0..1). One-shot at ~2s on a 4s note fails.
 */
const MIN_ACTIVE_FRACTION_OF_NOTE = 0.85;

function windowRms(
  mono: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
): number {
  const a = Math.max(0, Math.floor(startSec * sampleRate));
  const b = Math.min(mono.length, Math.floor(endSec * sampleRate));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += mono[i] * mono[i];
  return Math.sqrt(sum / (b - a));
}

function toDb(x: number): number {
  return 10 * Math.log10(x * x + 1e-20);
}

/** Last time (seconds) where |sample| exceeds threshold in any WIN_SEC window. */
function lastActiveTime(
  mono: Float32Array,
  sampleRate: number,
  threshold = ACTIVE_ABS,
): number {
  const win = Math.max(1, Math.floor(WIN_SEC * sampleRate));
  let last = 0;
  for (let i = 0; i < mono.length; i += win) {
    let peak = 0;
    const end = Math.min(i + win, mono.length);
    for (let j = i; j < end; j++) {
      const a = Math.abs(mono[j]);
      if (a > peak) peak = a;
    }
    if (peak > threshold) last = end / sampleRate;
  }
  return last;
}

interface LengthReport {
  cacheMode: CacheMode;
  lastActiveSec: number;
  earlyDb: number;
  midDb: number;
  lateDb: number;
  mono: Float32Array;
  sampleRate: number;
}

function analyzeLength(
  cacheMode: CacheMode,
  bytes: Uint8Array,
  noteDuration: number,
): LengthReport {
  const wav = readWav(bytes);
  const mono = toMono(wav);
  const sr = wav.sampleRate;
  const lastActiveSec = lastActiveTime(mono, sr);
  const earlyDb = toDb(windowRms(mono, sr, 0.3, 0.3 + WIN_SEC));
  const midDb = toDb(
    windowRms(mono, sr, noteDuration * 0.5, noteDuration * 0.5 + WIN_SEC),
  );
  const lateDb = toDb(
    windowRms(mono, sr, noteDuration - 0.35, noteDuration - 0.35 + WIN_SEC),
  );
  return {
    cacheMode,
    lastActiveSec,
    earlyDb,
    midDb,
    lateDb,
    mono,
    sampleRate: sr,
  };
}

function assertSustainsThroughNote(
  label: string,
  report: LengthReport,
  noteDuration: number,
): void {
  const minActive = noteDuration * MIN_ACTIVE_FRACTION_OF_NOTE;
  if (report.lastActiveSec < minActive) {
    throw new Error(
      `${label}: last active energy at ${report.lastActiveSec.toFixed(3)}s, ` +
        `expected >= ${minActive.toFixed(3)}s (${
          (MIN_ACTIVE_FRACTION_OF_NOTE * 100).toFixed(0)
        }% of ` +
        `${noteDuration}s note). Likely one-shot (loop disabled) — sample ends early.`,
    );
  }
  if (report.earlyDb > -40 && report.lateDb < -90) {
    throw new Error(
      `${label}: late window is silent (${report.lateDb.toFixed(1)}dB) while ` +
        `early was ${
          report.earlyDb.toFixed(1)
        }dB — abrupt cutoff before note-off.`,
    );
  }
  const drop = report.earlyDb - report.lateDb;
  if (report.earlyDb > -40 && drop > LATE_VS_EARLY_MAX_DROP_DB) {
    throw new Error(
      `${label}: early→late drop ${drop.toFixed(1)}dB exceeds ` +
        `${LATE_VS_EARLY_MAX_DROP_DB}dB (early=${
          report.earlyDb.toFixed(1)
        }dB ` +
        `late=${report.lateDb.toFixed(1)}dB).`,
    );
  }
}

async function renderLongNote(
  midiPath: string,
  cacheMode: CacheMode,
  outWav: string,
): Promise<Uint8Array> {
  const bytes = await renderMidyMode({
    harnessDir: HARNESS_DIR,
    rootDir: ".",
    midiPath,
    soundFontPath: SF2_PATH,
    cacheMode,
    sampleRate: SAMPLE_RATE,
  });
  await Deno.writeFile(outWav, bytes);
  await assertNonEmptyFile(outWav);
  return bytes;
}

// ---------------------------------------------------------------------------
// Long piano note: every cache mode must sustain past typical sample length
// ---------------------------------------------------------------------------
Deno.test("note length: long piano sustain across cache modes", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/long-piano.mid`;
  const program = 0;
  const noteNumber = 60;

  await t.step("generate long piano MIDI", async () => {
    const bytes = buildSingleNoteMidi({
      noteNumber,
      velocity: 100,
      duration: LONG_NOTE_DURATION,
      tailSilence: TAIL_SILENCE,
      program,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  const reports: LengthReport[] = [];

  for (const cacheMode of CACHE_MODES) {
    await t.step(`render + length check (${cacheMode})`, async () => {
      const outWav = `${OUT_DIR}/long-piano-${cacheMode}.wav`;
      const bytes = await renderLongNote(midiPath, cacheMode, outWav);
      const report = analyzeLength(cacheMode, bytes, LONG_NOTE_DURATION);
      console.log(
        `  ${cacheMode}: lastActive=${report.lastActiveSec.toFixed(3)}s ` +
          `early=${report.earlyDb.toFixed(1)}dB mid=${
            report.midDb.toFixed(1)
          }dB ` +
          `late=${report.lateDb.toFixed(1)}dB`,
      );
      assertSustainsThroughNote(
        `long-piano/${cacheMode}`,
        report,
        LONG_NOTE_DURATION,
      );
      reports.push(report);
    });
  }

  await t.step("none vs note: last-active parity", () => {
    const none = reports.find((r) => r.cacheMode === "none");
    const note = reports.find((r) => r.cacheMode === "note");
    if (!none || !note) {
      throw new Error("missing none or note mode report");
    }
    const delta = Math.abs(none.lastActiveSec - note.lastActiveSec);
    if (delta > 0.4) {
      throw new Error(
        `none lastActive=${none.lastActiveSec.toFixed(3)}s vs ` +
          `note lastActive=${note.lastActiveSec.toFixed(3)}s (Δ=${
            delta.toFixed(3)
          }s > 0.4s)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Program 88 (Pad 2 / warm): multi-layer looped pad — must not die at ~1s
// ---------------------------------------------------------------------------
Deno.test("note length: program 88 pad sustain across cache modes", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/long-prog88.mid`;
  const padDuration = 3;

  await t.step("generate long program-88 MIDI", async () => {
    const bytes = buildSingleNoteMidi({
      noteNumber: 60,
      velocity: 100,
      duration: padDuration,
      tailSilence: TAIL_SILENCE,
      program: 88,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  for (const cacheMode of CACHE_MODES) {
    await t.step(`render + length check prog88 (${cacheMode})`, async () => {
      const outWav = `${OUT_DIR}/long-prog88-${cacheMode}.wav`;
      const bytes = await renderLongNote(midiPath, cacheMode, outWav);
      const report = analyzeLength(cacheMode, bytes, padDuration);
      console.log(
        `  prog88/${cacheMode}: lastActive=${
          report.lastActiveSec.toFixed(3)
        }s ` +
          `early=${report.earlyDb.toFixed(1)}dB mid=${
            report.midDb.toFixed(1)
          }dB ` +
          `late=${report.lateDb.toFixed(1)}dB`,
      );
      const minActive = Math.max(1.8, padDuration * 0.7);
      if (report.lastActiveSec < minActive) {
        throw new Error(
          `prog88/${cacheMode}: last active ${
            report.lastActiveSec.toFixed(3)
          }s ` +
            `< ${minActive.toFixed(2)}s — pad layers may not be looping`,
        );
      }
      if (report.earlyDb > -50 && report.lateDb < -100) {
        throw new Error(
          `prog88/${cacheMode}: late silent (${report.lateDb.toFixed(1)}dB) ` +
            `after early ${report.earlyDb.toFixed(1)}dB`,
        );
      }
    });
  }
});
