// Reverb algorithms for Web Audio API
// - Convolution Reverb
// - Schroeder (1962)
// - Moorer (1979)
// - FDN (1992)
// - Dattorro (1997)
// - Freeverb (1999)
// - Velvet Noise Reverb (2012)

// Convolution Reverb
export function createConvolutionReverbImpulse(audioContext, decay, preDecay) {
  const sampleRate = audioContext.sampleRate;
  const length = sampleRate * decay;
  const impulse = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  const preDecayLength = Math.min(sampleRate * preDecay, length);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const channelData = impulse.getChannelData(channel);
    for (let i = 0; i < preDecayLength; i++) {
      channelData[i] = Math.random() * 2 - 1;
    }
    const attenuationFactor = 1 / (sampleRate * decay);
    for (let i = preDecayLength; i < length; i++) {
      const attenuation = Math.exp(-(i - preDecayLength) * attenuationFactor);
      channelData[i] = (Math.random() * 2 - 1) * attenuation;
    }
  }
  return impulse;
}

export function createConvolutionReverb(audioContext, impulse) {
  const convolverNode = new ConvolverNode(audioContext, { buffer: impulse });
  return { input: convolverNode, output: convolverNode };
}

export function createCombFilter(audioContext, input, delay, feedback) {
  const delayNode = new DelayNode(audioContext, {
    maxDelayTime: delay,
    delayTime: delay,
  });
  const feedbackGain = new GainNode(audioContext, { gain: feedback });
  input.connect(delayNode);
  delayNode.connect(feedbackGain);
  feedbackGain.connect(delayNode);
  return delayNode;
}

// Schroeder allpass approximation for Web Audio API.
// Exact H(z) = (-g + z^-d) / (1 - g·z^-d) requires a feedforward path
// that causes zero-delay loops in the Web Audio API graph, which is unstable.
// This approximation omits the feedforward term and returns only the delay output.
export function createAllpassFilter(audioContext, input, delay, feedback) {
  const delayNode = new DelayNode(audioContext, {
    maxDelayTime: delay,
    delayTime: delay,
  });
  const feedbackGain = new GainNode(audioContext, { gain: feedback });
  const passGain = new GainNode(audioContext, { gain: 1 - feedback });
  input.connect(delayNode);
  delayNode.connect(feedbackGain);
  feedbackGain.connect(delayNode);
  delayNode.connect(passGain);
  return passGain;
}

// LPF comb filter (Freeverb / Moorer):
// feedback loop contains a one-pole lowpass to simulate air absorption.
// damping=0: bright tail, damping=1: dark tail
export function createLPFCombFilter(
  audioContext,
  input,
  delayTime,
  feedback,
  damping,
) {
  const delayNode = new DelayNode(audioContext, {
    maxDelayTime: delayTime,
    delayTime,
  });
  const feedbackGain = new GainNode(audioContext, { gain: feedback });
  const damp = Math.max(0, Math.min(1, damping));
  // y[n] = (1-d)*x[n] + d*y[n-1]
  const lpf = new IIRFilterNode(audioContext, {
    feedforward: [1 - damp],
    feedback: [1, -damp],
  });
  input.connect(delayNode);
  delayNode.connect(lpf);
  lpf.connect(feedbackGain);
  feedbackGain.connect(delayNode);
  return delayNode;
}

// Schroeder Reverb (1962)
// https://hajim.rochester.edu/ece/sites/zduan/teaching/ece472/reading/Schroeder_1962.pdf
//   M.R.Schroeder, "Natural Sounding Artificial Reverberation",
//   J. Audio Eng. Soc., vol.10, p.219, 1962

export function createSchroederReverb(
  audioContext,
  combFeedbacks,
  combDelays,
  allpassFeedbacks,
  allpassDelays,
) {
  const input = new GainNode(audioContext);
  const mergerGain = new GainNode(audioContext);
  for (let i = 0; i < combDelays.length; i++) {
    const comb = createCombFilter(
      audioContext,
      input,
      combDelays[i],
      combFeedbacks[i],
    );
    comb.connect(mergerGain);
  }
  const allpasses = [];
  for (let i = 0; i < allpassDelays.length; i++) {
    const src = i === 0 ? mergerGain : allpasses.at(-1);
    const ap = createAllpassFilter(
      audioContext,
      src,
      allpassDelays[i],
      allpassFeedbacks[i],
    );
    allpasses.push(ap);
  }
  return { input, output: allpasses.at(-1) };
}

// Moorer Reverb (1979)
// http://articles.ircam.fr/textes/Moorer78b/
//   J.A.Moorer, "About this Reverberation Business",
//   Computer Music Journal, vol.3, no.2, 1979
//
// Adds two things over Schroeder:
//   1. Early reflections as a tapped delay line (FIR)
//   2. LPF-comb filters instead of plain combs

export function createMoorerReverb(
  audioContext,
  earlyTaps,
  earlyGains,
  combDelays,
  combFeedbacks,
  damping,
  allpassDelays,
  allpassFeedbacks,
) {
  const input = new GainNode(audioContext);
  const earlySum = new GainNode(audioContext);
  for (let i = 0; i < earlyTaps.length; i++) {
    const tapDelay = new DelayNode(audioContext, {
      maxDelayTime: earlyTaps[i],
      delayTime: earlyTaps[i],
    });
    const tapGain = new GainNode(audioContext, { gain: earlyGains[i] });
    input.connect(tapDelay);
    tapDelay.connect(tapGain);
    tapGain.connect(earlySum);
  }
  // Late reverberation: LPF-comb filters
  const lateSum = new GainNode(audioContext);
  for (let i = 0; i < combDelays.length; i++) {
    const comb = createLPFCombFilter(
      audioContext,
      earlySum,
      combDelays[i],
      combFeedbacks[i],
      damping,
    );
    comb.connect(lateSum);
  }
  // Allpass diffusers
  const allpasses = [];
  for (let i = 0; i < allpassDelays.length; i++) {
    const src = i === 0 ? lateSum : allpasses.at(-1);
    const ap = createAllpassFilter(
      audioContext,
      src,
      allpassDelays[i],
      allpassFeedbacks[i],
    );
    allpasses.push(ap);
  }
  // Mix early + late to output
  const output = new GainNode(audioContext);
  earlySum.connect(output);
  allpasses.at(-1).connect(output);
  return { input, output };
}

// Sensible defaults for Moorer at 44100 Hz
export function createMoorerReverbDefault(audioContext, {
  rt60 = 2.0,
  damping = 0.3,
} = {}) {
  const sr = audioContext.sampleRate;

  // Early reflection taps (ms -> seconds), gains chosen for natural sounding
  const earlyTaps = [0.0043, 0.0215, 0.0225, 0.0268, 0.0270, 0.0298, 0.0458];
  const earlyGains = [0.841, 0.504, 0.491, 0.379, 0.380, 0.346, 0.289];

  // RT60 -> comb feedback: g = 10^(-3 * delay / rt60)
  const combSamples = [1309, 1635, 1811, 1926, 2053, 2667];
  const combDelays = combSamples.map((s) => s / sr);
  const combFeedbacks = combDelays.map((d) => Math.pow(10, -3 * d / rt60));
  const allpassDelays = [0.005, 0.0017];
  const allpassFeedbacks = [0.7, 0.7];
  return createMoorerReverb(
    audioContext,
    earlyTaps,
    earlyGains,
    combDelays,
    combFeedbacks,
    damping,
    allpassDelays,
    allpassFeedbacks,
  );
}

// FDN - Feedback Delay Network (1992)
// https://ccrma.stanford.edu/~jos/Reverb/Reverb.pdf
//   J.-M.Jot, A.Chaigne, "Digital Delay Networks for Designing
//   Artificial Reverberators", AES 90th Convention, 1991
//
// N delay lines connected via a unitary feedback matrix.
// Using the normalized 4×4 Hadamard matrix for energy preservation.
//
// modulation: each delay line is driven by a low-frequency oscillator at a
// slightly different frequency and phase, breaking up the periodic ringing
// that fixed delay lengths produce. Set to 0 to disable.

export function createFDN(
  audioContext,
  delayTimes,
  gains,
  damping = 0.2,
  modulation = 0.0005,
) {
  const N = delayTimes.length;

  // Normalized 4×4 Hadamard matrix (only N=4 supported here)
  // H4 = (1/2) * [[1,1,1,1],[1,-1,1,-1],[1,1,-1,-1],[1,-1,-1,1]]
  // Any unitary matrix works; Hadamard is convenient and mixes all lines equally.
  if (N !== 4) {
    throw new Error("createFDN: only N=4 is supported (4x4 Hadamard)");
  }
  const H = [
    [0.5, 0.5, 0.5, 0.5],
    [0.5, -0.5, 0.5, -0.5],
    [0.5, 0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5, 0.5],
  ];

  const input = new GainNode(audioContext);
  const output = new GainNode(audioContext);

  // Create delay lines with headroom for modulation depth
  const delays = delayTimes.map((t) =>
    new DelayNode(audioContext, {
      maxDelayTime: t + modulation,
      delayTime: t,
    })
  );
  // Per-line LPF for damping (air absorption)
  const lpfs = delays.map(() => {
    const damp = Math.max(0, Math.min(1, damping));
    return new IIRFilterNode(audioContext, {
      feedforward: [1 - damp],
      feedback: [1, -damp],
    });
  });
  // Per-line attenuation gains (RT60 control)
  const attenuations = gains.map((g) =>
    new GainNode(audioContext, { gain: g })
  );
  // Delay modulation: slightly different LFO per line to avoid coherent artifacts
  if (modulation > 0) {
    delays.forEach((delayNode, i) => {
      const osc = new OscillatorNode(audioContext, {
        frequency: 0.3 + i * 0.07, // 0.30, 0.37, 0.44, 0.51 Hz
      });
      const oscGain = new GainNode(audioContext, { gain: modulation });
      osc.connect(oscGain);
      oscGain.connect(delayNode.delayTime);
      osc.start();
    });
  }
  // Input injection: feed input into all delay lines equally
  const inputScale = new GainNode(audioContext, { gain: 1 / N });
  input.connect(inputScale);
  delays.forEach((d) => inputScale.connect(d));
  // Feedback matrix: for each output delay line j,
  // sum over all input lines i: H[j][i] * attenuation[i] * lpf[i]
  // Signal flow per line i:
  //   delay[i] -> lpf[i] -> attenuation[i] -> (distributed via H to all delay[j] inputs)
  // We implement H as N×N individual GainNodes (N^2 = 16 for N=4).
  for (let i = 0; i < N; i++) {
    delays[i].connect(lpfs[i]);
    lpfs[i].connect(attenuations[i]);
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (H[j][i] === 0) continue;
      const matrixGain = new GainNode(audioContext, { gain: H[j][i] });
      attenuations[i].connect(matrixGain);
      matrixGain.connect(delays[j]);
    }
    delays[j].connect(output);
  }
  return { input, output };
}

// Sensible defaults for FDN
export function createFDNDefault(
  audioContext,
  { rt60 = 2.0, damping = 0.2, modulation = 0.0005 } = {},
) {
  const sr = audioContext.sampleRate;
  // Mutually prime delay lengths (samples) — avoids periodicity artifacts
  const delaySamples = [1049, 1327, 1601, 1873];
  const delayTimes = delaySamples.map((s) => s / sr);
  // Attenuation from RT60: g = 10^(-3 * delayTime / rt60)
  const gains = delayTimes.map((d) => Math.pow(10, -3 * d / rt60));
  return createFDN(audioContext, delayTimes, gains, damping, modulation);
}

// Dattorro Reverb (1997)
// https://ccrma.stanford.edu/~dattorro/EffectDesignPart1.pdf
//   J.Dattorro, "Effect Design Part 1: Reverberator and Other Filters",
//   J. Audio Eng. Soc., vol.45, no.9, 1997
//
// Figure-of-eight allpass loop with pre-diffusion stage.
// Topology:
//   input -> pre-LPF -> 4×allpass (pre-diffusion)
//         -> split into two "tank" loops (left / right)
//   each loop: AP -> delay1 -> LPF -> delay2 -> decayGain -> cross-feed
//   output tapped at multiple points from both loops

export function createDattorroReverb(audioContext, {
  decay = 0.7,
  damping = 0.0005,
  bandwidth = 0.9995,
} = {}) {
  const sr = audioContext.sampleRate;

  // Pre-filter (bandwidth)
  // One-pole LPF on input: y[n] = (1-bw)*x[n] + bw*y[n-1]
  const bw = Math.max(0, Math.min(1, bandwidth));
  const preLPF = new IIRFilterNode(audioContext, {
    feedforward: [1 - bw],
    feedback: [1, -bw],
  });
  // Pre-diffusion: 4 allpass filters in series
  // Delay lengths from Dattorro Table 1 (normalized to 29761 Hz, rescaled)
  const scale = sr / 29761;
  const preDiffSamples = [142, 107, 379, 277];
  const preDiffFeedbacks = [0.75, 0.75, 0.625, 0.625];

  const input = new GainNode(audioContext);
  input.connect(preLPF);
  const preDiffs = [];
  for (let i = 0; i < preDiffSamples.length; i++) {
    const src = i === 0 ? preLPF : preDiffs.at(-1);
    const ap = createAllpassFilter(
      audioContext,
      src,
      (preDiffSamples[i] * scale) / sr,
      preDiffFeedbacks[i],
    );
    preDiffs.push(ap);
  }
  const preDiffOut = preDiffs.at(-1);

  // Tank: two cross-coupled loops
  // Each tank: AP(modulated) -> delay1 -> LPF -> AP -> delay2 -> decayGain -> cross-feed
  // Sample counts from Dattorro Table 1
  const tankAPSamples = [672, 908];
  const tankAPFeedbacks = [0.5, 0.5];
  const tankDelay1Samples = [4453, 4217];
  const tankDelay2Samples = [3720, 3163];
  const damp = Math.max(0, Math.min(1, damping));

  const loopInput = [new GainNode(audioContext), new GainNode(audioContext)];
  preDiffOut.connect(loopInput[0]);
  preDiffOut.connect(loopInput[1]);

  const loopOutput = [];
  for (let t = 0; t < 2; t++) {
    // AP -> delay1 -> LPF -> AP -> delay2 -> decayGain
    const ap1 = createAllpassFilter(
      audioContext,
      loopInput[t],
      (tankAPSamples[t] * scale) / sr,
      tankAPFeedbacks[t],
    );
    const d1 = new DelayNode(audioContext, {
      maxDelayTime: (tankDelay1Samples[t] * scale) / sr,
      delayTime: (tankDelay1Samples[t] * scale) / sr,
    });
    const tankLPF = new IIRFilterNode(audioContext, {
      feedforward: [1 - damp],
      feedback: [1, -damp],
    });
    const d2 = new DelayNode(audioContext, {
      maxDelayTime: (tankDelay2Samples[t] * scale) / sr,
      delayTime: (tankDelay2Samples[t] * scale) / sr,
    });
    const decayGain = new GainNode(audioContext, { gain: decay });
    ap1.connect(d1);
    d1.connect(tankLPF);
    tankLPF.connect(d2);
    d2.connect(decayGain);
    loopOutput.push(decayGain);
  }
  // Cross-feed: decayGain of each tank feeds the other tank's loopInput
  loopOutput[0].connect(loopInput[1]);
  loopOutput[1].connect(loopInput[0]);
  // Output: mix both tanks
  const output = new GainNode(audioContext, { gain: 0.5 });
  loopOutput[0].connect(output);
  loopOutput[1].connect(output);
  return { input, output };
}

// Freeverb (1999)
// https://github.com/sinshu/freeverb
//   Jezar at Dreampoint, 1999

const FREEVERB_COMB_SAMPLES_L = [
  1116,
  1188,
  1277,
  1356,
  1422,
  1491,
  1557,
  1617,
];
const FREEVERB_STEREO_SPREAD = 23; // samples
const FREEVERB_ALLPASS_SAMPLES = [225, 341, 441, 556];
const FREEVERB_ALLPASS_FEEDBACK = 0.5;

export function createFreeverb(
  audioContext,
  { roomSize = 0.84, damping = 0.2 } = {},
) {
  const sr = audioContext.sampleRate;
  const feedback = roomSize * 0.28 + 0.7; // maps [0,1] -> [0.7, 0.98]

  const buildChannel = (sampleOffsetPerComb) => {
    const inputGain = new GainNode(audioContext);
    const sumGain = new GainNode(audioContext);
    for (const samples of FREEVERB_COMB_SAMPLES_L) {
      const delayTime = (samples + sampleOffsetPerComb) / sr;
      const comb = createLPFCombFilter(
        audioContext,
        inputGain,
        delayTime,
        feedback,
        damping,
      );
      comb.connect(sumGain);
    }
    const allpasses = [];
    for (let i = 0; i < FREEVERB_ALLPASS_SAMPLES.length; i++) {
      const src = i === 0 ? sumGain : allpasses.at(-1);
      const ap = createAllpassFilter(
        audioContext,
        src,
        FREEVERB_ALLPASS_SAMPLES[i] / sr,
        FREEVERB_ALLPASS_FEEDBACK,
      );
      allpasses.push(ap);
    }
    return { input: inputGain, output: allpasses.at(-1) };
  };

  const L = buildChannel(0);
  const R = buildChannel(FREEVERB_STEREO_SPREAD);
  return {
    inputL: L.input,
    inputR: R.input,
    outputL: L.output,
    outputR: R.output,
  };
}

// Velvet Noise Reverb (2012)
// https://aaltodoc.aalto.fi/server/api/core/bitstreams/97ed04a8-cb88-461f-b1a3-e72da5129256/content
//   V.Välimäki et al., "Fifty Years of Artificial Reverberation",
//   IEEE Trans. Audio Speech Lang. Process., vol.20, no.5, 2012

export function createVelvetNoiseImpulse(audioContext, decay, density = 2000) {
  const sampleRate = audioContext.sampleRate;
  const length = Math.ceil(sampleRate * decay);
  const impulse = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  const interval = Math.max(1, Math.round(sampleRate / density));

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i += interval) {
      // Randomize position within the interval (velvet noise definition)
      const idx = i + Math.floor(Math.random() * interval);
      if (idx < length) {
        const env = Math.exp(-idx / (sampleRate * decay * 0.3));
        data[idx] = (Math.random() > 0.5 ? 1 : -1) * env;
      }
    }
  }
  return impulse;
}

export function createVelvetNoiseReverb(audioContext, decay, density) {
  const impulse = createVelvetNoiseImpulse(audioContext, decay, density);
  return createConvolutionReverb(audioContext, impulse);
}
