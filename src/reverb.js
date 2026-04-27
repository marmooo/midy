// Reverb algorithms for Web Audio API
// - Convolution Reverb (synthetic IR)
// - Schroeder (1962)

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
