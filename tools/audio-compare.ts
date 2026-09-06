// Compare two mono PCM streams (typically fluidsynth reference vs midy).
// Designed for conformance tests: time-align, gain-match, then measure
// residual error so absolute level / small onset lag differences do not
// dominate. Not a perceptual model — just enough to catch "wrong note",
// "missing cut-off", "envelope shape wildly different" class failures.
import {
  findOffsetFrame,
  findOnsetFrame,
  rms,
  toDb,
} from "./audio-metrics.ts";

export interface AlignResult {
  /** Sample lag of `candidate` relative to `reference` (positive = candidate late). */
  lagFrames: number;
  /** Peak normalized cross-correlation in [-1, 1]. */
  correlation: number;
}

export interface CompareResult {
  /** Peak abs amplitude of reference / candidate before gain match. */
  refPeak: number;
  candPeak: number;
  /** Linear gain applied to candidate so peaks match (cand * gain ≈ ref). */
  gain: number;
  align: AlignResult;
  /** After align + gain: RMS of residual / RMS of reference, as dB (negative = quieter residual). */
  residualDb: number;
  /** After align + gain: mean absolute error. */
  mae: number;
  /** Correlation of rectified envelopes (attack/decay shape), in [-1, 1]. */
  envelopeCorrelation: number;
  /** Onset times in seconds (from peak-relative threshold). */
  refOnsetSec: number;
  candOnsetSec: number;
  /** Offset (last audible) times in seconds. */
  refOffsetSec: number;
  candOffsetSec: number;
}

function peakAbs(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Coarse+fine lag search via normalized cross-correlation.
 * Searches lags in [-maxLagFrames, +maxLagFrames].
 */
export function alignByCrossCorrelation(
  reference: Float32Array,
  candidate: Float32Array,
  maxLagFrames: number,
): AlignResult {
  const n = Math.min(reference.length, candidate.length);
  if (n < 8) return { lagFrames: 0, correlation: 0 };

  // Use a window near the start (where onset energy lives) for speed.
  const window = Math.min(n, Math.max(2048, Math.floor(n * 0.25)));
  const ref = reference.subarray(0, window);
  const cand = candidate.subarray(0, Math.min(candidate.length, window + maxLagFrames));

  let refEnergy = 0;
  for (let i = 0; i < ref.length; i++) refEnergy += ref[i] * ref[i];
  if (refEnergy <= 0) return { lagFrames: 0, correlation: 0 };

  let bestLag = 0;
  let bestScore = -Infinity;
  const maxLag = Math.min(maxLagFrames, cand.length - 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0;
    let candEnergy = 0;
    let count = 0;
    for (let i = 0; i < ref.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= cand.length) continue;
      sum += ref[i] * cand[j];
      candEnergy += cand[j] * cand[j];
      count++;
    }
    if (count < 8 || candEnergy <= 0) continue;
    // Scale energies by the overlapping portion only.
    const score = sum / Math.sqrt(refEnergy * candEnergy);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return {
    lagFrames: bestLag,
    correlation: bestScore === -Infinity ? 0 : bestScore,
  };
}

/** Simple full-wave envelope via moving average of |x|. */
export function amplitudeEnvelope(
  samples: Float32Array,
  windowFrames: number,
): Float32Array {
  const w = Math.max(1, windowFrames | 0);
  const out = new Float32Array(samples.length);
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    run += Math.abs(samples[i]);
    if (i >= w) run -= Math.abs(samples[i - w]);
    out[i] = run / Math.min(w, i + 1);
  }
  return out;
}

function pearsonCorrelation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA <= 0 || denB <= 0) return 0;
  return num / Math.sqrt(denA * denB);
}

/**
 * Align candidate to reference, peak-normalize gain, then report residual
 * and envelope similarity. Sample rates of both streams must match.
 */
export function compareMono(
  reference: Float32Array,
  candidate: Float32Array,
  sampleRate: number,
  options?: {
    maxLagMs?: number;
    envelopeWindowMs?: number;
  },
): CompareResult {
  const maxLagMs = options?.maxLagMs ?? 50;
  const envelopeWindowMs = options?.envelopeWindowMs ?? 10;
  const maxLagFrames = Math.max(1, Math.round((maxLagMs / 1000) * sampleRate));

  const refPeak = peakAbs(reference);
  const candPeak = peakAbs(candidate);
  const gain = candPeak > 0 ? refPeak / candPeak : 1;

  const align = alignByCrossCorrelation(reference, candidate, maxLagFrames);

  // Build aligned, gain-matched candidate overlapping the reference length.
  const n = reference.length;
  const aligned = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i + align.lagFrames;
    if (j >= 0 && j < candidate.length) {
      aligned[i] = candidate[j] * gain;
    }
  }

  let errEnergy = 0;
  let refEnergy = 0;
  let absErr = 0;
  for (let i = 0; i < n; i++) {
    const r = reference[i];
    const d = aligned[i] - r;
    errEnergy += d * d;
    refEnergy += r * r;
    absErr += Math.abs(d);
  }
  const residualDb = refEnergy > 0
    ? toDb(Math.sqrt(errEnergy / refEnergy))
    : -Infinity;
  const mae = absErr / n;

  const envWin = Math.max(1, Math.round((envelopeWindowMs / 1000) * sampleRate));
  const refEnv = amplitudeEnvelope(reference, envWin);
  const candEnv = amplitudeEnvelope(aligned, envWin);
  const envelopeCorrelation = pearsonCorrelation(refEnv, candEnv);

  const onsetThresh = Math.max(refPeak * 0.05, 1e-4);
  const offsetThresh = Math.max(refPeak * 0.02, 1e-4);
  const refOnset = findOnsetFrame(reference, onsetThresh);
  const candOnset = findOnsetFrame(aligned, onsetThresh);
  const refOffset = findOffsetFrame(reference, offsetThresh);
  const candOffset = findOffsetFrame(aligned, offsetThresh);

  return {
    refPeak,
    candPeak,
    gain,
    align,
    residualDb,
    mae,
    envelopeCorrelation,
    refOnsetSec: refOnset >= 0 ? refOnset / sampleRate : -1,
    candOnsetSec: candOnset >= 0 ? candOnset / sampleRate : -1,
    refOffsetSec: refOffset >= 0 ? refOffset / sampleRate : -1,
    candOffsetSec: candOffset >= 0 ? candOffset / sampleRate : -1,
  };
}

/** RMS in a time window [startSec, endSec). */
export function windowRmsDb(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
): number {
  const from = Math.floor(startSec * sampleRate);
  const to = Math.floor(endSec * sampleRate);
  return toDb(rms(samples, from, to));
}

export function formatCompareResult(label: string, c: CompareResult): string {
  return (
    `  ${label}: residual=${c.residualDb.toFixed(1)}dB ` +
    `envCorr=${c.envelopeCorrelation.toFixed(3)} ` +
    `lag=${(c.align.lagFrames).toFixed(0)}f ` +
    `xcorr=${c.align.correlation.toFixed(3)} ` +
    `gain=${c.gain.toFixed(3)} ` +
    `onsetΔ=${((c.candOnsetSec - c.refOnsetSec) * 1000).toFixed(1)}ms ` +
    `offsetΔ=${((c.candOffsetSec - c.refOffsetSec) * 1000).toFixed(1)}ms`
  );
}
