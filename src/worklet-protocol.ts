// Shared message protocol between main-thread Midy and the AudioWorkletProcessor.
// Keep this free of DOM/WebAudio types so the worklet source can mirror the shapes.

/** Processor registration name for AudioWorkletNode. */
export const MIDY_WORKLET_NAME = "midy-synth-processor";

/** Max concurrent voices inside the worklet (Phase 1). */
export const WORKLET_MAX_VOICES = 64;

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

export type WorkletMainToProcessorMsg =
  | WorkletLoadSampleMsg
  | WorkletNoteOnMsg
  | WorkletNoteOffMsg
  | WorkletStopMsg
  | WorkletAllSoundOffMsg
  | WorkletSetMasterGainMsg;

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

export type WorkletProcessorToMainMsg =
  | WorkletVoiceEndedMsg
  | WorkletReadyMsg;
