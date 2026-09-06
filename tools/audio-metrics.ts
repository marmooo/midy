// Small, dependency-free audio analysis helpers for sanity-checking a
// single rendered note: is it roughly the right pitch, does it start near
// t=0, does it actually sustain for about as long as requested, does it
// decay afterward. Not a spectral-accuracy tool — just enough to catch
// "nothing played" / "wrong note" / "died instantly" class regressions
// mechanically instead of by ear.

/** Root-mean-square level of samples[fromFrame:toFrame). */
export function rms(
  samples: Float32Array,
  fromFrame: number,
  toFrame: number,
): number {
  const from = Math.max(0, fromFrame);
  const to = Math.min(samples.length, toFrame);
  if (to <= from) return 0;
  let sumSquares = 0;
  for (let i = from; i < to; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / (to - from));
}

export function toDb(linear: number): number {
  return linear <= 0 ? -Infinity : 20 * Math.log10(linear);
}

/**
 * First frame index whose absolute value exceeds `threshold` (searching
 * forward from `fromFrame`). Returns -1 if never exceeded.
 */
export function findOnsetFrame(
  samples: Float32Array,
  threshold: number,
  fromFrame = 0,
): number {
  for (let i = Math.max(0, fromFrame); i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) return i;
  }
  return -1;
}

/**
 * Last frame index whose absolute value exceeds `threshold` (searching
 * backward from `toFrame`, exclusive). Returns -1 if never exceeded.
 */
export function findOffsetFrame(
  samples: Float32Array,
  threshold: number,
  toFrame = samples.length,
): number {
  for (let i = Math.min(samples.length, toFrame) - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) > threshold) return i;
  }
  return -1;
}

/**
 * Estimate the fundamental frequency (Hz) of samples[fromFrame:toFrame)
 * via normalized autocorrelation, searching only lags corresponding to
 * [minHz, maxHz]. Returns null if no clear periodicity is found.
 */
export function estimatePitchHz(
  samples: Float32Array,
  sampleRate: number,
  fromFrame: number,
  toFrame: number,
  minHz = 60,
  maxHz = 2000,
): number | null {
  const from = Math.max(0, fromFrame);
  const to = Math.min(samples.length, toFrame);
  const frame = samples.subarray(from, to);
  const n = frame.length;
  if (n < 8) return null;

  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.min(n - 1, Math.ceil(sampleRate / minHz));
  if (maxLag <= minLag) return null;

  // Remove DC offset so autocorrelation isn't dominated by a constant term.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;

  const energy0 = (() => {
    let e = 0;
    for (let i = 0; i < n; i++) {
      const v = frame[i] - mean;
      e += v * v;
    }
    return e;
  })();
  if (energy0 <= 0) return null;

  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) {
      sum += (frame[i] - mean) * (frame[i + lag] - mean);
    }
    const normalized = sum / energy0;
    if (normalized > bestScore) {
      bestScore = normalized;
      bestLag = lag;
    }
  }

  // A real periodic tone should autocorrelate strongly with itself one
  // period later; a low best score means "no clear pitch found" (silence,
  // noise, or something too short/complex to call a fundamental on).
  if (bestLag <= 0 || bestScore < 0.3) return null;
  return sampleRate / bestLag;
}

/** MIDI note number -> frequency in Hz (A4 = MIDI 69 = 440Hz, equal temperament). */
export function midiNoteToHz(noteNumber: number): number {
  return 440 * Math.pow(2, (noteNumber - 69) / 12);
}
