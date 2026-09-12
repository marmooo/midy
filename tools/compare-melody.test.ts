// fluidsynth ↔ midy: melody-side level, release, and velocity-zone conformance.
//
// Complements compare-drums.test.ts (percussion absolute levels) with pitched
// instruments so the EMU static-attenuation scale and unity master gain are
// verified outside the drum kit as well.
//
// Usage:
//   deno test -A tools/compare-melody.test.ts
//   deno test -A tools/compare-melody.test.ts --filter "piano"
//
import {
  buildMelodyReleaseMidi,
  buildMelodySingleNoteMidi,
  buildVelocityZoneMidi,
} from "./gen-midi-scenarios.ts";
import {
  assertNonEmptyFile,
  compareMono,
  ensureFsBin,
  ensureOutDir,
  forEachCacheModeRender,
  formatCompareResult,
  OUT_DIR,
  peakRmsDb,
  renderScenarioReference,
  windowRmsDb,
} from "./compare-common.ts";

// ---------------------------------------------------------------------------
// Shared windows / tolerances (melody)
// ---------------------------------------------------------------------------
const ATTACK_START = 0.02;
const ATTACK_END = 0.12;
const BODY_START = 0.2;
const BODY_END = 0.45;
const LEVEL_ERR_MAX_DB = 3;
const ATTACK_REL_DB = 12;
const ENV_CORR_MIN = 0.85;

// Release windows measured from note-off (hold ends at HOLD_SEC).
const HOLD_SEC = 0.5;
const REL_EARLY_START = HOLD_SEC + 0.05;
const REL_EARLY_END = HOLD_SEC + 0.25;
const REL_LATE_START = HOLD_SEC + 0.4;
const REL_LATE_END = HOLD_SEC + 0.7;
const RELEASE_ERR_MAX_DB = 4;
// Late window must be quieter than early (decay progressing).
const RELEASE_DROP_MIN_DB = 1;

// Velocity-zone soft/loud windows (must match buildVelocityZoneMidi defaults).
const SOFT_ATTACK_START = 0.02;
const SOFT_ATTACK_END = 0.12;
const LOUD_AT = 1.2;
const LOUD_ATTACK_START = LOUD_AT + 0.02;
const LOUD_ATTACK_END = LOUD_AT + 0.12;
const VEL_RATIO_ERR_MAX_DB = 3;
const VEL_RATIO_MIN_DB = 3; // loud must be clearly louder than soft on piano

// ---------------------------------------------------------------------------
// 1. Melody single-note absolute level
// ---------------------------------------------------------------------------
interface MelodyLevelSpec {
  name: string;
  program: number;
  noteNumber: number;
  velocity: number;
  duration: number;
  midiFile: string;
  refWav: string;
  outPrefix: string;
}

async function runMelodyLevel(
  t: Deno.TestContext,
  spec: MelodyLevelSpec,
): Promise<void> {
  const midiPath = `${OUT_DIR}/${spec.midiFile}`;

  await t.step(`generate ${spec.name} MIDI`, async () => {
    const bytes = buildMelodySingleNoteMidi({
      noteNumber: spec.noteNumber,
      velocity: spec.velocity,
      duration: spec.duration,
      program: spec.program,
    });
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
    `${OUT_DIR}/${spec.refWav}`,
    fluidsynthBin,
  );

  let refAttack = 0;
  let refBody = 0;
  let refPeak = 0;
  await t.step(`sanity-check fluidsynth ${spec.name}`, () => {
    refAttack = windowRmsDb(refMono, refRate, ATTACK_START, ATTACK_END);
    refBody = windowRmsDb(refMono, refRate, BODY_START, BODY_END);
    refPeak = peakRmsDb(refMono, refRate);
    console.log(
      `  fluidsynth ${spec.name}: peak=${refPeak.toFixed(1)}dB ` +
        `attack=${refAttack.toFixed(1)}dB body=${refBody.toFixed(1)}dB`,
    );
    if (!Number.isFinite(refPeak) || refPeak < -60) {
      throw new Error(`fluidsynth ${spec.name} effectively silent`);
    }
    if (refAttack < refPeak - ATTACK_REL_DB) {
      throw new Error(
        `fluidsynth ${spec.name}: attack missing ` +
          `(${refAttack.toFixed(1)} vs peak ${refPeak.toFixed(1)})`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    spec.outPrefix,
    (label, candMono, sr) => {
      const attack = windowRmsDb(candMono, sr, ATTACK_START, ATTACK_END);
      const body = windowRmsDb(candMono, sr, BODY_START, BODY_END);
      const peak = peakRmsDb(candMono, sr);
      const attackDelta = attack - refAttack;
      const bodyDelta = body - refBody;
      const peakDelta = peak - refPeak;
      console.log(
        `  ${label}: peak=${peak.toFixed(1)}dB (Δ${peakDelta.toFixed(1)}) ` +
          `attack=${attack.toFixed(1)}dB (Δ${attackDelta.toFixed(1)}) ` +
          `body=${body.toFixed(1)}dB (Δ${bodyDelta.toFixed(1)})`,
      );

      if (!Number.isFinite(peak) || peak < -60) {
        throw new Error(`${label}: ${spec.name} effectively silent`);
      }
      if (attack < peak - ATTACK_REL_DB) {
        throw new Error(
          `${label}: attack missing (${attack.toFixed(1)} vs peak ${
            peak.toFixed(1)
          })`,
        );
      }
      if (Math.abs(attackDelta) > LEVEL_ERR_MAX_DB) {
        throw new Error(
          `${label}: attack level ${attackDelta.toFixed(1)}dB vs fluidsynth ` +
            `(cand=${attack.toFixed(1)} ref=${refAttack.toFixed(1)}; ` +
            `max |Δ|=${LEVEL_ERR_MAX_DB}dB)`,
        );
      }
      if (Math.abs(bodyDelta) > LEVEL_ERR_MAX_DB) {
        throw new Error(
          `${label}: body level ${bodyDelta.toFixed(1)}dB vs fluidsynth ` +
            `(cand=${body.toFixed(1)} ref=${refBody.toFixed(1)}; ` +
            `max |Δ|=${LEVEL_ERR_MAX_DB}dB)`,
        );
      }

      const cmp = compareMono(refMono, candMono, sr, { maxLagMs: 40 });
      console.log(formatCompareResult(`${label} waveform`, cmp));
      if (cmp.envelopeCorrelation < ENV_CORR_MIN) {
        throw new Error(
          `${label}: envelope correlation ${
            cmp.envelopeCorrelation.toFixed(3)
          } below min ${ENV_CORR_MIN}`,
        );
      }
    },
    refMono,
    refRate,
    { skipWaveformSoftCheck: true },
  );
}

Deno.test("single piano level vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runMelodyLevel(t, {
    name: "piano C4",
    program: 0, // Acoustic Grand Piano
    noteNumber: 60,
    velocity: 100,
    duration: 1.0,
    midiFile: "melody-single-piano.mid",
    refWav: "fluidsynth-melody-single-piano.wav",
    outPrefix: "midy-melody-single-piano",
  });
});

Deno.test("single strings level vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runMelodyLevel(t, {
    name: "strings C4",
    program: 48, // String Ensemble 1
    noteNumber: 60,
    velocity: 100,
    duration: 1.0,
    midiFile: "melody-single-strings.mid",
    refWav: "fluidsynth-melody-single-strings.wav",
    outPrefix: "midy-melody-single-strings",
  });
});

// ---------------------------------------------------------------------------
// 2. Release curve after note-off
// ---------------------------------------------------------------------------
interface ReleaseSpec {
  name: string;
  program: number;
  noteNumber: number;
  velocity: number;
  holdDuration: number;
  midiFile: string;
  refWav: string;
  outPrefix: string;
}

async function runMelodyRelease(
  t: Deno.TestContext,
  spec: ReleaseSpec,
): Promise<void> {
  const midiPath = `${OUT_DIR}/${spec.midiFile}`;
  const hold = spec.holdDuration;

  await t.step(`generate ${spec.name} release MIDI`, async () => {
    const bytes = buildMelodyReleaseMidi({
      noteNumber: spec.noteNumber,
      velocity: spec.velocity,
      holdDuration: hold,
      program: spec.program,
    });
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
    `${OUT_DIR}/${spec.refWav}`,
    fluidsynthBin,
  );

  const earlyStart = hold + 0.05;
  const earlyEnd = hold + 0.25;
  const lateStart = hold + 0.4;
  const lateEnd = hold + 0.7;

  let refEarly = 0;
  let refLate = 0;
  await t.step(`sanity-check fluidsynth ${spec.name} release`, () => {
    refEarly = windowRmsDb(refMono, refRate, earlyStart, earlyEnd);
    refLate = windowRmsDb(refMono, refRate, lateStart, lateEnd);
    const drop = refEarly - refLate;
    console.log(
      `  fluidsynth ${spec.name} release: early=${refEarly.toFixed(1)}dB ` +
        `late=${refLate.toFixed(1)}dB drop=${drop.toFixed(1)}dB`,
    );
    if (!Number.isFinite(refEarly) || refEarly < -70) {
      throw new Error(`fluidsynth ${spec.name}: early release silent`);
    }
    // Sustained instruments should still be decaying; one-shots may already
    // be near floor — only require drop when early is clearly audible.
    if (refEarly > -50 && drop < RELEASE_DROP_MIN_DB) {
      throw new Error(
        `fluidsynth ${spec.name}: release not decaying ` +
          `(drop ${drop.toFixed(1)}dB < ${RELEASE_DROP_MIN_DB}dB)`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    spec.outPrefix,
    (label, candMono, sr) => {
      const early = windowRmsDb(candMono, sr, earlyStart, earlyEnd);
      const late = windowRmsDb(candMono, sr, lateStart, lateEnd);
      const earlyDelta = early - refEarly;
      const lateDelta = late - refLate;
      const drop = early - late;
      console.log(
        `  ${label}: early=${early.toFixed(1)}dB (Δ${earlyDelta.toFixed(1)}) ` +
          `late=${late.toFixed(1)}dB (Δ${lateDelta.toFixed(1)}) ` +
          `drop=${drop.toFixed(1)}dB`,
      );

      if (Math.abs(earlyDelta) > RELEASE_ERR_MAX_DB) {
        throw new Error(
          `${label}: early release ${earlyDelta.toFixed(1)}dB vs fluidsynth ` +
            `(cand=${early.toFixed(1)} ref=${refEarly.toFixed(1)}; ` +
            `max |Δ|=${RELEASE_ERR_MAX_DB}dB)`,
        );
      }
      // Late window is quieter and more sensitive to envelope curve / floor;
      // allow the same absolute tolerance.
      if (Number.isFinite(refLate) && refLate > -70) {
        if (Math.abs(lateDelta) > RELEASE_ERR_MAX_DB) {
          throw new Error(
            `${label}: late release ${lateDelta.toFixed(1)}dB vs fluidsynth ` +
              `(cand=${late.toFixed(1)} ref=${refLate.toFixed(1)}; ` +
              `max |Δ|=${RELEASE_ERR_MAX_DB}dB)`,
          );
        }
      }
      if (early > -50 && drop < RELEASE_DROP_MIN_DB) {
        throw new Error(
          `${label}: release not decaying (drop ${drop.toFixed(1)}dB)`,
        );
      }

      const cmp = compareMono(refMono, candMono, sr, { maxLagMs: 40 });
      console.log(formatCompareResult(`${label} waveform`, cmp));
      if (cmp.envelopeCorrelation < ENV_CORR_MIN) {
        throw new Error(
          `${label}: envelope correlation ${
            cmp.envelopeCorrelation.toFixed(3)
          } below min ${ENV_CORR_MIN}`,
        );
      }
    },
    refMono,
    refRate,
    { skipWaveformSoftCheck: true },
  );
}

Deno.test("piano release curve vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runMelodyRelease(t, {
    name: "piano",
    program: 0,
    noteNumber: 60,
    velocity: 100,
    holdDuration: HOLD_SEC,
    midiFile: "melody-release-piano.mid",
    refWav: "fluidsynth-melody-release-piano.wav",
    outPrefix: "midy-melody-release-piano",
  });
});

Deno.test("strings release curve vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runMelodyRelease(t, {
    name: "strings",
    program: 48,
    noteNumber: 60,
    velocity: 100,
    holdDuration: HOLD_SEC,
    midiFile: "melody-release-strings.mid",
    refWav: "fluidsynth-melody-release-strings.wav",
    outPrefix: "midy-melody-release-strings",
  });
});

// ---------------------------------------------------------------------------
// 3. Velocity-zone / multi-layer switch
// ---------------------------------------------------------------------------
Deno.test("piano velocity zone soft/loud vs fluidsynth", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/melody-velzone-piano.mid`;

  await t.step("generate piano velocity-zone MIDI", async () => {
    const bytes = buildVelocityZoneMidi({
      noteNumber: 60,
      softVelocity: 40,
      loudVelocity: 100,
      softDuration: 0.7,
      loudDuration: 0.7,
      loudAt: LOUD_AT,
      program: 0,
    });
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
    `${OUT_DIR}/fluidsynth-melody-velzone-piano.wav`,
    fluidsynthBin,
  );

  let refSoft = 0;
  let refLoud = 0;
  let refRatio = 0;
  await t.step("sanity-check fluidsynth velocity zones", () => {
    refSoft = windowRmsDb(
      refMono,
      refRate,
      SOFT_ATTACK_START,
      SOFT_ATTACK_END,
    );
    refLoud = windowRmsDb(
      refMono,
      refRate,
      LOUD_ATTACK_START,
      LOUD_ATTACK_END,
    );
    refRatio = refLoud - refSoft;
    console.log(
      `  fluidsynth velzone: soft=${refSoft.toFixed(1)}dB ` +
        `loud=${refLoud.toFixed(1)}dB ratio=${refRatio.toFixed(1)}dB`,
    );
    if (!Number.isFinite(refSoft) || refSoft < -60) {
      throw new Error("fluidsynth soft zone effectively silent");
    }
    if (!Number.isFinite(refLoud) || refLoud < -60) {
      throw new Error("fluidsynth loud zone effectively silent");
    }
    if (refRatio < VEL_RATIO_MIN_DB) {
      throw new Error(
        `fluidsynth soft/loud ratio only ${refRatio.toFixed(1)}dB — ` +
          `velocity layers may be ignored`,
      );
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    "midy-melody-velzone-piano",
    (label, candMono, sr) => {
      const soft = windowRmsDb(
        candMono,
        sr,
        SOFT_ATTACK_START,
        SOFT_ATTACK_END,
      );
      const loud = windowRmsDb(
        candMono,
        sr,
        LOUD_ATTACK_START,
        LOUD_ATTACK_END,
      );
      const ratio = loud - soft;
      const softDelta = soft - refSoft;
      const loudDelta = loud - refLoud;
      const ratioDelta = ratio - refRatio;
      console.log(
        `  ${label}: soft=${soft.toFixed(1)}dB (Δ${softDelta.toFixed(1)}) ` +
          `loud=${loud.toFixed(1)}dB (Δ${loudDelta.toFixed(1)}) ` +
          `ratio=${ratio.toFixed(1)}dB (Δ${ratioDelta.toFixed(1)})`,
      );

      if (!Number.isFinite(soft) || soft < -60) {
        throw new Error(`${label}: soft zone effectively silent`);
      }
      if (!Number.isFinite(loud) || loud < -60) {
        throw new Error(`${label}: loud zone effectively silent`);
      }
      if (Math.abs(softDelta) > LEVEL_ERR_MAX_DB) {
        throw new Error(
          `${label}: soft level ${softDelta.toFixed(1)}dB vs fluidsynth ` +
            `(max |Δ|=${LEVEL_ERR_MAX_DB}dB)`,
        );
      }
      if (Math.abs(loudDelta) > LEVEL_ERR_MAX_DB) {
        throw new Error(
          `${label}: loud level ${loudDelta.toFixed(1)}dB vs fluidsynth ` +
            `(max |Δ|=${LEVEL_ERR_MAX_DB}dB)`,
        );
      }
      if (Math.abs(ratioDelta) > VEL_RATIO_ERR_MAX_DB) {
        throw new Error(
          `${label}: soft/loud ratio ${
            ratioDelta.toFixed(1)
          }dB vs fluidsynth ` +
            `(cand=${ratio.toFixed(1)} ref=${refRatio.toFixed(1)}; ` +
            `max |Δ|=${VEL_RATIO_ERR_MAX_DB}dB)`,
        );
      }

      const cmp = compareMono(refMono, candMono, sr, { maxLagMs: 40 });
      console.log(formatCompareResult(`${label} waveform`, cmp));
      if (cmp.envelopeCorrelation < ENV_CORR_MIN) {
        throw new Error(
          `${label}: envelope correlation ${
            cmp.envelopeCorrelation.toFixed(3)
          } below min ${ENV_CORR_MIN}`,
        );
      }
    },
    refMono,
    refRate,
    { skipWaveformSoftCheck: true },
  );
});
