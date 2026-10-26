// Shared message protocol between main-thread Midy and the AudioWorkletProcessor.
// Keep this free of DOM/WebAudio types so the worklet source can mirror the shapes.

/** Processor registration name for AudioWorkletNode. */
export const MIDY_WORKLET_NAME = "midy-synth-processor";

/**
 * Hard ceiling inside the AudioWorklet processor (safety valve only).
 * Artistic / match-other-modes limits are applied on the main thread via
 * Player.workletVoiceLimit + maxVoices — not by lowering this constant.
 */
export const WORKLET_MAX_VOICES = 1024;

// ---------------------------------------------------------------------------
// Main → Worklet
// ---------------------------------------------------------------------------

export type WorkletLoadSampleMsg = {
  type: "loadSample";
  /** Stable id (reuse getVoiceId / audioBufferId). */
  sampleId: number;
  /** Mono or left channel PCM (Float32, normalized). Transferred when possible. */
  pcmL: Float32Array;
  /** Optional right channel; omit for mono. */
  pcmR?: Float32Array;
  sampleRate: number;
  /** Loop points in samples (inclusive start, exclusive end). */
  loopStart: number;
  loopEnd: number;
  loop: boolean;
};

/**
 * Phase-2 noteOn: volume envelope + filter + modEnv + LFOs.
 * All times are seconds; depths are SF2 units (cents / cB as noted).
 */
export type WorkletNoteOnMsg = {
  type: "noteOn";
  voiceId: number;
  sampleId: number;
  /** AudioContext currentTime when the note should start. */
  when: number;
  /** Sample playback rate (already includes key + detune). */
  playbackRate: number;
  /** Linear amplitude after SF2 initialAttenuation (+ channel vol snapshot). */
  gain: number;
  /** Stereo pan in [-1, 1]. */
  pan: number;
  /** Volume envelope times in seconds (SF2-style). */
  delay: number;
  attack: number;
  hold: number;
  decay: number;
  /** Sustain level in linear amplitude relative to peak (0–1). */
  sustain: number;
  release: number;

  // --- Filter (Phase 2.1) ---
  /** Base cutoff in absolute cents (SF2 initialFilterFc). */
  filterFcCents: number;
  /** Linear Q (after sf2FilterQ conversion). */
  filterQ: number;
  /** DC gain compensation 1/√Q. */
  filterDcGain: number;

  // --- Modulation envelope (Phase 2.3) ---
  delayModEnv: number;
  attackModEnv: number;
  holdModEnv: number;
  decayModEnv: number;
  /** Sustain as 0–1 fraction of full scale (1 - sustainModEnv in SF2). */
  sustainModEnv: number;
  releaseModEnv: number;
  /** Pitch depth in cents (modEnvToPitch). */
  modEnvToPitch: number;
  /** Filter Fc depth in cents (modEnvToFilterFc). */
  modEnvToFilterFc: number;

  // --- Mod LFO (Phase 2.2) ---
  delayModLFO: number;
  /** Frequency in Hz. */
  freqModLFO: number;
  modLfoToPitch: number;
  modLfoToFilterFc: number;
  /** Depth in centibels (SF2 modLfoToVolume). */
  modLfoToVolume: number;

  // --- Vib LFO (Phase 2.2) ---
  delayVibLFO: number;
  /** Frequency in Hz. */
  freqVibLFO: number;
  vibLfoToPitch: number;
};

export type WorkletNoteOffMsg = {
  type: "noteOff";
  voiceId: number;
  when: number;
  /** Override release seconds; omit to use noteOn release. */
  release?: number;
};

export type WorkletStopMsg = {
  type: "stop";
  voiceId: number;
};

export type WorkletAllSoundOffMsg = {
  type: "allSoundOff";
};

export type WorkletSetMasterGainMsg = {
  type: "setMasterGain";
  value: number;
};

/** Soft polyphony cap inside the processor (0 = unlimited / hard ceiling only). */
export type WorkletSetVoiceLimitMsg = {
  type: "setVoiceLimit";
  value: number;
};

/** Dynamic per-voice gain / pan (channel volume / expression / pan). */
export type WorkletSetVoiceParamsMsg = {
  type: "setVoiceParams";
  voiceId: number;
  /** Absolute linear gain (replaces noteOn.gain). */
  gain?: number;
  /** Absolute pan in [-1, 1]. */
  pan?: number;
  /** Absolute playback rate (includes key + detune + pitch bend). */
  playbackRate?: number;
};

/** Enable/disable verbose processor→main debug posts. */
export type WorkletSetDebugMsg = {
  type: "setDebug";
  enabled: boolean;
};

/** Ask processor to post a one-shot stats snapshot. */
export type WorkletRequestStatsMsg = {
  type: "requestStats";
};

export type WorkletMainToProcessorMsg =
  | WorkletLoadSampleMsg
  | WorkletNoteOnMsg
  | WorkletNoteOffMsg
  | WorkletStopMsg
  | WorkletAllSoundOffMsg
  | WorkletSetMasterGainMsg
  | WorkletSetVoiceLimitMsg
  | WorkletSetVoiceParamsMsg
  | WorkletSetDebugMsg
  | WorkletRequestStatsMsg;

// ---------------------------------------------------------------------------
// Worklet → Main (optional diagnostics)
// ---------------------------------------------------------------------------

export type WorkletVoiceEndedMsg = {
  type: "voiceEnded";
  voiceId: number;
};

export type WorkletReadyMsg = {
  type: "ready";
};

export type WorkletDebugMsg = {
  type: "debug";
  message: string;
};

/** Periodic counters from the processor (always sent when debug is on). */
export type WorkletStatsMsg = {
  type: "stats";
  active: number;
  samples: number;
  noteOn: number;
  noteOff: number;
  stop: number;
  steal: number;
  missingSample: number;
  loadSample: number;
  ended: number;
  /** process() quantums since last stats */
  quantums: number;
};

export type WorkletProcessorToMainMsg =
  | WorkletVoiceEndedMsg
  | WorkletReadyMsg
  | WorkletDebugMsg
  | WorkletStatsMsg;
