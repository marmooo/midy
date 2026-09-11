// fluidsynth ↔ midy: cymbal rapid-hit / "じゃーん vs ダダダダ" scenarios.
//
// Goal: catch the case where dense crash/ride/open-HH hits lose their long
// decay and become a dry machine-gun ("dadadada") instead of overlapping
// shimmer ("jaan jaan"). Chunk/segment tiling is especially interesting.
//
// Hard checks focus on *relative* energy vs fluidsynth:
//   - inter-hit gaps (energy between attacks)
//   - post-burst tail (ring after the last hit)
// Envelope correlation is a soft structural check; residual is logged only.
//
// Usage:
//   deno test -A tools/compare-drums.test.ts
//
import {
  buildCymbalAlternateMidi,
  buildDrumRapidHitsMidi,
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
// Shared metrics
// ---------------------------------------------------------------------------

function peakRmsDb(samples: Float32Array, sampleRate: number): number {
  const win = Math.max(1, Math.round(0.01 * sampleRate));
  let peak = 0;
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    run += x * x;
    if (i >= win) {
      const y = samples[i - win];
      run -= y * y;
    }
    const n = i < win ? i + 1 : win;
    const rms = Math.sqrt(run / n);
    if (rms > peak) peak = rms;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Mean of finite numbers; -Infinity if none. */
function meanDb(values: number[]): number {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : -Infinity;
}

interface CymbalBurstSpec {
  name: string;
  midiBytes: Uint8Array;
  midiFile: string;
  refWav: string;
  outPrefix: string;
  /** Onset times of each hit (seconds). */
  hitTimes: number[];
  /** Half-width of attack window after each onset (seconds). */
  attackHalfWin?: number;
  /**
   * How far past the last hit to measure the tail start/end.
   * Defaults: tail starts 0.4s after last onset, lasts 0.6s.
   */
  tailStartAfterLast?: number;
  tailDuration?: number;
}

// Relative to fluidsynth: midy gap/tail must not be this many dB *quieter*
// than the reference (over-damping → "dadadada"). Louder is OK (more layer).
const GAP_QUIETER_THAN_REF_MAX_DB = 8;
const TAIL_QUIETER_THAN_REF_MAX_DB = 10;
// Absolute: each attack must still be present.
const ATTACK_REL_DB = 25;
const ENV_CORR_MIN = 0.5;

interface BurstEnergy {
  peakDb: number;
  attackDbs: number[];
  /** RMS in the middle of each inter-hit gap. */
  gapDbs: number[];
  meanAttackDb: number;
  meanGapDb: number;
  /** gap - attack (negative = gaps quieter than attacks). */
  gapVsAttackDb: number;
  tailDb: number;
  /** tail - attack. */
  tailVsAttackDb: number;
}

function measureBurstEnergy(
  samples: Float32Array,
  sampleRate: number,
  hitTimes: number[],
  attackHalfWin: number,
  tailStartAfterLast: number,
  tailDuration: number,
): BurstEnergy {
  const peakDb = peakRmsDb(samples, sampleRate);
  const attackDbs = hitTimes.map((t0) =>
    windowRmsDb(samples, sampleRate, t0, t0 + attackHalfWin * 2)
  );
  const gapDbs: number[] = [];
  for (let i = 0; i < hitTimes.length - 1; i++) {
    const mid = (hitTimes[i] + hitTimes[i + 1]) / 2;
    const half = Math.min(0.015, (hitTimes[i + 1] - hitTimes[i]) / 4);
    gapDbs.push(windowRmsDb(samples, sampleRate, mid - half, mid + half));
  }
  const lastHit = hitTimes[hitTimes.length - 1] ?? 0;
  const tailStart = lastHit + tailStartAfterLast;
  const tailDb = windowRmsDb(
    samples,
    sampleRate,
    tailStart,
    tailStart + tailDuration,
  );
  const meanAttackDb = meanDb(attackDbs);
  const meanGapDb = meanDb(gapDbs);
  return {
    peakDb,
    attackDbs,
    gapDbs,
    meanAttackDb,
    meanGapDb,
    gapVsAttackDb: meanGapDb - meanAttackDb,
    tailDb,
    tailVsAttackDb: tailDb - meanAttackDb,
  };
}

function formatBurst(e: BurstEnergy): string {
  return (
    `peak=${e.peakDb.toFixed(1)} ` +
    `atk=[${e.attackDbs.map((a) => a.toFixed(1)).join(",")}] ` +
    `gap=[${e.gapDbs.map((g) => g.toFixed(1)).join(",")}] ` +
    `gapVsAtk=${e.gapVsAttackDb.toFixed(1)} ` +
    `tail=${e.tailDb.toFixed(1)} tailVsAtk=${e.tailVsAttackDb.toFixed(1)}`
  );
}

async function runCymbalBurstScenario(
  t: Deno.TestContext,
  spec: CymbalBurstSpec,
): Promise<void> {
  const attackHalf = spec.attackHalfWin ?? 0.035;
  const tailStartAfterLast = spec.tailStartAfterLast ?? 0.4;
  const tailDuration = spec.tailDuration ?? 0.6;
  const midiPath = `${OUT_DIR}/${spec.midiFile}`;

  await t.step(`generate ${spec.name} MIDI`, async () => {
    await Deno.writeFile(midiPath, spec.midiBytes);
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

  let refEnergy: BurstEnergy | null = null;
  await t.step(`sanity-check fluidsynth ${spec.name}`, () => {
    refEnergy = measureBurstEnergy(
      refMono,
      refRate,
      spec.hitTimes,
      attackHalf,
      tailStartAfterLast,
      tailDuration,
    );
    console.log(`  fluidsynth ${spec.name}: ${formatBurst(refEnergy)}`);
    if (!Number.isFinite(refEnergy.peakDb) || refEnergy.peakDb < -60) {
      throw new Error(`fluidsynth ${spec.name} effectively silent`);
    }
    for (let i = 0; i < refEnergy.attackDbs.length; i++) {
      if (refEnergy.attackDbs[i] < refEnergy.peakDb - ATTACK_REL_DB) {
        throw new Error(
          `fluidsynth ${spec.name}: hit ${i} attack missing`,
        );
      }
    }
  });

  await forEachCacheModeRender(
    t,
    midiPath,
    spec.outPrefix,
    (label, candMono, sr) => {
      if (!refEnergy) throw new Error("fluidsynth reference missing");
      const cand = measureBurstEnergy(
        candMono,
        sr,
        spec.hitTimes,
        attackHalf,
        tailStartAfterLast,
        tailDuration,
      );
      console.log(`  ${label}: ${formatBurst(cand)}`);

      if (!Number.isFinite(cand.peakDb) || cand.peakDb < -60) {
        throw new Error(`${label}: ${spec.name} effectively silent`);
      }
      for (let i = 0; i < cand.attackDbs.length; i++) {
        if (cand.attackDbs[i] < cand.peakDb - ATTACK_REL_DB) {
          throw new Error(
            `${label}: hit ${i} attack missing ` +
              `(${cand.attackDbs[i].toFixed(1)}dB vs peak ${
                cand.peakDb.toFixed(1)
              }dB)`,
          );
        }
      }

      // "dadadada" detector: inter-hit gaps much quieter than fluidsynth
      // relative to attack energy → previous hits were over-cut / not layered.
      const gapDelta = cand.gapVsAttackDb - refEnergy.gapVsAttackDb;
      // gapDelta < 0 means midy gaps are quieter relative to attacks than ref
      if (gapDelta < -GAP_QUIETER_THAN_REF_MAX_DB) {
        throw new Error(
          `${label}: inter-hit gaps ${
            (-gapDelta).toFixed(1)
          }dB quieter than fluidsynth ` +
            `(cand gapVsAtk=${cand.gapVsAttackDb.toFixed(1)} ` +
            `ref=${refEnergy.gapVsAttackDb.toFixed(1)}) — ` +
            `cymbal decay may be over-cut ("dadadada")`,
        );
      }

      const tailDelta = cand.tailVsAttackDb - refEnergy.tailVsAttackDb;
      if (tailDelta < -TAIL_QUIETER_THAN_REF_MAX_DB) {
        throw new Error(
          `${label}: post-burst tail ${
            (-tailDelta).toFixed(1)
          }dB quieter than fluidsynth ` +
            `(cand tailVsAtk=${cand.tailVsAttackDb.toFixed(1)} ` +
            `ref=${refEnergy.tailVsAttackDb.toFixed(1)}) — ` +
            `long cymbal ring missing`,
        );
      }

      console.log(
        `  ${label}: gapΔvsRef=${gapDelta.toFixed(1)}dB ` +
          `tailΔvsRef=${tailDelta.toFixed(1)}dB`,
      );

      const cmp = compareMono(refMono, candMono, sr, { maxLagMs: 50 });
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

// ---------------------------------------------------------------------------
// 1. Dense crash (49) × 6 @ 60ms — "dadadada" stress
// ---------------------------------------------------------------------------
Deno.test("dense crash cymbal rapid hits vs fluidsynth", async (t) => {
  await ensureOutDir();
  const interval = 0.06;
  const hitCount = 6;
  await runCymbalBurstScenario(t, {
    name: "dense crash",
    midiBytes: buildDrumRapidHitsMidi({
      noteNumber: 49,
      hitCount,
      interval,
      eachDuration: 0.5,
    }),
    midiFile: "drums-dense-crash.mid",
    refWav: "fluidsynth-drums-dense-crash.wav",
    outPrefix: "midy-drums-dense-crash",
    hitTimes: Array.from({ length: hitCount }, (_, i) => i * interval),
    tailStartAfterLast: 0.35,
    tailDuration: 0.7,
  });
});

// ---------------------------------------------------------------------------
// 2. Sparse crash (49) × 3 @ 400ms — control ("じゃーん じゃーん")
// ---------------------------------------------------------------------------
Deno.test("sparse crash cymbal hits vs fluidsynth", async (t) => {
  await ensureOutDir();
  const interval = 0.4;
  const hitCount = 3;
  await runCymbalBurstScenario(t, {
    name: "sparse crash",
    midiBytes: buildDrumRapidHitsMidi({
      noteNumber: 49,
      hitCount,
      interval,
      eachDuration: 0.35,
    }),
    midiFile: "drums-sparse-crash.mid",
    refWav: "fluidsynth-drums-sparse-crash.wav",
    outPrefix: "midy-drums-sparse-crash",
    hitTimes: Array.from({ length: hitCount }, (_, i) => i * interval),
    tailStartAfterLast: 0.5,
    tailDuration: 0.8,
  });
});

// ---------------------------------------------------------------------------
// 3. Dense open HH (46) × 6 @ 60ms — exclusive-class + long decay
// ---------------------------------------------------------------------------
Deno.test("dense open hi-hat rapid hits vs fluidsynth", async (t) => {
  await ensureOutDir();
  const interval = 0.06;
  const hitCount = 6;
  await runCymbalBurstScenario(t, {
    name: "dense open-hh",
    midiBytes: buildDrumRapidHitsMidi({
      noteNumber: 46,
      hitCount,
      interval,
      eachDuration: 0.5,
    }),
    midiFile: "drums-dense-open-hh.mid",
    refWav: "fluidsynth-drums-dense-open-hh.wav",
    outPrefix: "midy-drums-dense-open-hh",
    hitTimes: Array.from({ length: hitCount }, (_, i) => i * interval),
    tailStartAfterLast: 0.35,
    tailDuration: 0.7,
  });
});

// ---------------------------------------------------------------------------
// 4. Dense ride (51) × 6 @ 60ms
// ---------------------------------------------------------------------------
Deno.test("dense ride cymbal rapid hits vs fluidsynth", async (t) => {
  await ensureOutDir();
  const interval = 0.06;
  const hitCount = 6;
  await runCymbalBurstScenario(t, {
    name: "dense ride",
    midiBytes: buildDrumRapidHitsMidi({
      noteNumber: 51,
      hitCount,
      interval,
      eachDuration: 0.5,
    }),
    midiFile: "drums-dense-ride.mid",
    refWav: "fluidsynth-drums-dense-ride.wav",
    outPrefix: "midy-drums-dense-ride",
    hitTimes: Array.from({ length: hitCount }, (_, i) => i * interval),
    tailStartAfterLast: 0.35,
    tailDuration: 0.7,
  });
});

// ---------------------------------------------------------------------------
// 5. Crash ↔ Ride alternate dense — different notes, overlapping decays
// ---------------------------------------------------------------------------
Deno.test("dense crash/ride alternate vs fluidsynth", async (t) => {
  await ensureOutDir();
  const interval = 0.07;
  const hitCount = 6;
  await runCymbalBurstScenario(t, {
    name: "dense cymbal alt",
    midiBytes: buildCymbalAlternateMidi({
      noteA: 49,
      noteB: 51,
      hitCount,
      interval,
      eachDuration: 0.5,
    }),
    midiFile: "drums-dense-cymbal-alt.mid",
    refWav: "fluidsynth-drums-dense-cymbal-alt.wav",
    outPrefix: "midy-drums-dense-cymbal-alt",
    hitTimes: Array.from({ length: hitCount }, (_, i) => i * interval),
    tailStartAfterLast: 0.35,
    tailDuration: 0.7,
  });
});

// ---------------------------------------------------------------------------
// Single-hit absolute level (crash / ride / open HH)
// ---------------------------------------------------------------------------
// Dense-burst logs showed crash ≈ +7 dB and ride ≈ −7 dB vs fluidsynth.
// Measure one isolated hit so stacking cannot hide a per-sample gain error.
const SINGLE_ATTACK_START = 0.02;
const SINGLE_ATTACK_END = 0.12;
const SINGLE_BODY_START = 0.15;
const SINGLE_BODY_END = 0.45;
// Hard fail if |cand − ref| exceeds this on the attack window.
const SINGLE_LEVEL_ERR_MAX_DB = 3;
const SINGLE_ENV_CORR_MIN = 0.7;

interface SingleHitSpec {
  name: string;
  noteNumber: number;
  midiFile: string;
  refWav: string;
  outPrefix: string;
  velocity?: number;
  duration?: number;
}

async function runSingleCymbalLevel(
  t: Deno.TestContext,
  spec: SingleHitSpec,
): Promise<void> {
  const midiPath = `${OUT_DIR}/${spec.midiFile}`;
  const velocity = spec.velocity ?? 100;
  const duration = spec.duration ?? 1.0;

  await t.step(`generate ${spec.name} MIDI`, async () => {
    const bytes = buildDrumRapidHitsMidi({
      noteNumber: spec.noteNumber,
      hitCount: 1,
      interval: 1,
      eachDuration: duration,
      velocity,
      tailSilence: 2,
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
    refAttack = windowRmsDb(
      refMono,
      refRate,
      SINGLE_ATTACK_START,
      SINGLE_ATTACK_END,
    );
    refBody = windowRmsDb(
      refMono,
      refRate,
      SINGLE_BODY_START,
      SINGLE_BODY_END,
    );
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
      const attack = windowRmsDb(
        candMono,
        sr,
        SINGLE_ATTACK_START,
        SINGLE_ATTACK_END,
      );
      const body = windowRmsDb(
        candMono,
        sr,
        SINGLE_BODY_START,
        SINGLE_BODY_END,
      );
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
      if (Math.abs(attackDelta) > SINGLE_LEVEL_ERR_MAX_DB) {
        throw new Error(
          `${label}: attack level ${attackDelta.toFixed(1)}dB vs fluidsynth ` +
            `(cand=${attack.toFixed(1)} ref=${refAttack.toFixed(1)}; ` +
            `max |Δ|=${SINGLE_LEVEL_ERR_MAX_DB}dB)`,
        );
      }

      const cmp = compareMono(refMono, candMono, sr, { maxLagMs: 40 });
      console.log(formatCompareResult(`${label} waveform`, cmp));
      if (cmp.envelopeCorrelation < SINGLE_ENV_CORR_MIN) {
        throw new Error(
          `${label}: envelope correlation ${
            cmp.envelopeCorrelation.toFixed(3)
          } below min ${SINGLE_ENV_CORR_MIN}`,
        );
      }
    },
    refMono,
    refRate,
    { skipWaveformSoftCheck: true },
  );
}

// ---------------------------------------------------------------------------
// 6. Single Crash Cymbal 1 (49) — absolute level
// ---------------------------------------------------------------------------
Deno.test("single crash cymbal level vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runSingleCymbalLevel(t, {
    name: "single crash",
    noteNumber: 49,
    midiFile: "drums-single-crash.mid",
    refWav: "fluidsynth-drums-single-crash.wav",
    outPrefix: "midy-drums-single-crash",
  });
});

// ---------------------------------------------------------------------------
// 7. Single Ride Cymbal 1 (51) — absolute level
// ---------------------------------------------------------------------------
Deno.test("single ride cymbal level vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runSingleCymbalLevel(t, {
    name: "single ride",
    noteNumber: 51,
    midiFile: "drums-single-ride.mid",
    refWav: "fluidsynth-drums-single-ride.wav",
    outPrefix: "midy-drums-single-ride",
  });
});

// ---------------------------------------------------------------------------
// 8. Single Open Hi-Hat (46) — absolute level
// ---------------------------------------------------------------------------
Deno.test("single open hi-hat level vs fluidsynth", async (t) => {
  await ensureOutDir();
  await runSingleCymbalLevel(t, {
    name: "single open-hh",
    noteNumber: 46,
    midiFile: "drums-single-open-hh.mid",
    refWav: "fluidsynth-drums-single-open-hh.wav",
    outPrefix: "midy-drums-single-open-hh",
  });
});
