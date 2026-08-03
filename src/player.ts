import { type MidiData, type MidiSetTempoEvent, parseMidi } from "midi-file";
import {
  AudioData,
  parse,
  SoundFont,
  Voice,
  type VoiceParams,
} from "@marmooo/soundfont-parser";
import { OggVorbisDecoderWebWorker } from "@wasm-audio-decoders/ogg-vorbis";

// Cache mode
// - "none"    for full real-time control (dynamic CC, LFO, pitch)
// - "ads"     for real-time playback with higher cache hit rate
// - "adsr"    for real-time playback with accurate release envelope
// - "note"    for efficient playback when note behavior is fixed
// - "segment" for heavy polyphony with low CPU and live channel mixing
// - "chunk"   for heavy polyphony, merging all channels into one offline render
// - "audio"   for fully pre-rendered playback (lowest CPU)
//
// "none"
//   No caching. Envelope processing is done in real time on every note.
//   Uses Web Audio API nodes directly, so LFO and pitch envelope are
//   fully supported. Higher CPU usage.
// "ads"
//   Pre-renders the ADS (Attack-Decay-Sustain) phase into an
//   OfflineAudioContext and caches the result. The sustain tail is
//   aligned to the loop boundary as a fixed buffer. Release is
//   handled by fading volumeNode gain to 0 at note-off.
//   LFO effects (modLfoToPitch, modLfoToFilterFc, modLfoToVolume,
//   vibLfoToPitch) are applied in real time after playback starts.
// "adsr"
//   Pre-renders the full ADSR envelope (Attack-Decay-Sustain-Release)
//   into an OfflineAudioContext. The cache key includes the note
//   duration in ticks (tempo-independent) and the volRelease parameter,
//   so notes with the same duration and release shape share a buffer.
//   LFO effects are applied in real time after playback starts,
//   same as "ads" mode. Higher cache hit rate than "note" mode
//   because LFO variations do not produce separate cache entries.
// "note"
//   Renders the full noteOn-to-noteOff duration per note in an
//   OfflineAudioContext. All events during the note (volume,
//   expression, pitch bend, LFO, CC#1) are baked into the buffer,
//   so no real-time processing is needed during playback. Greatly
//   reduces CPU load for songs with many simultaneous notes.
//   MIDI file playback only — does not respond to real-time CC changes.
// "segment"
//   Groups simultaneously-sounding notes per channel into short
//   (segmentDuration-second) buffers instead of one AudioBufferSourceNode
//   per note. All notes belonging to one segment are baked together in a
//   single OfflineAudioContext / startRendering() call (each note still
//   gets its own full envelope/pitch-bend/LFO/CC#1 bake, same as "note"
//   mode), so segment creation pays the offline-render setup cost once
//   per segment rather than once per note. Channel volume/pan/expression
//   are deliberately left out of the bake so they keep responding in real
//   time through channel.gainL/gainR, like "ads"/"adsr" mode does. This
//   bounds the number of simultaneously active AudioBufferSourceNodes to
//   roughly one per channel (occasionally a couple more while a long
//   release tail overlaps the next segment), regardless of how dense the
//   polyphony gets. Notes whose ring time exceeds maxSegmentNoteDuration,
//   or that have a non-zero exclusiveClass (e.g. hi-hat choke groups), are
//   excluded from tiling and fall back to normal per-note real-time
//   ("ads"-style) scheduling so they can still be cut off early.
//   MIDI file playback only, same as "note"/"adsr" mode. Automatically
//   uses lookAhead + maxSegmentNoteDuration as its effective lookahead
//   (see lookAhead doc comment) instead of plain lookAhead, since a
//   segment's worst-case render cost scales with how long a single note
//   in it can ring, not just lookAhead's note-discovery window. Watch the
//   console for "missed its scheduled start" warnings; raise
//   maxSegmentNoteDuration's tier (or lookAhead) if they appear, at the
//   cost of added playback latency.
// "chunk"
//   Like "segment" mode, but merges ALL channels into a single
//   OfflineAudioContext / startRendering() call per time window instead of
//   one call per channel per window. Each note still gets its own full
//   envelope/pitch-bend/LFO/CC#1 bake (same fidelity as "segment" mode).
//   Channel volume/pan/expression ARE baked into the combined buffer
//   (unlike "segment" mode), so the result is a stereo mix ready to
//   connect straight to masterVolume — there is no per-channel gainL/gainR
//   live mixing. This halves the number of startRendering() calls (from
//   one per active channel per window to one per window), reducing
//   OfflineAudioContext setup overhead further. The trade-off is that
//   channel volume/pan/expression changes are not reflected after the
//   chunk is baked; they are snapshotted at chunk-open time.
//   Same MIDI-file-only restriction as "segment" mode.
// "audio"
//   Renders the entire MIDI file into a single AudioBuffer offline.
//   Call render() to complete rendering before calling start().
//   Playback simply streams an AudioBufferSourceNode, so CPU usage
//   is near zero. Seek and tempo changes are handled in real time.
//   A "rendering" event is dispatched when rendering starts, and a
//   "rendered" event is dispatched when rendering completes.
export const DEFAULT_CACHE_MODE = "segment";
type CacheMode =
  | "none"
  | "ads"
  | "adsr"
  | "note"
  | "segment"
  | "chunk"
  | "audio";

const _f64Buf = new ArrayBuffer(8);
const _f64Array = new Float64Array(_f64Buf);
const _u64Array = new BigUint64Array(_f64Buf);
export function f64ToBigInt(value: number): bigint {
  _f64Array[0] = value;
  return _u64Array[0];
}

let decoderPromise: Promise<OggVorbisDecoderWebWorker> | null = null;
let decoderQueue: Promise<void> = Promise.resolve();

function initDecoder(): Promise<OggVorbisDecoderWebWorker> {
  if (!decoderPromise) {
    const instance = new OggVorbisDecoderWebWorker();
    decoderPromise = instance.ready.then(() => instance);
  }
  return decoderPromise;
}

export class Note {
  // Widened to unknown so GM2/Midy can declare a more specific player
  // subtype (a generic Player<TNote,TChannel> can't be soundly widened to
  // a fixed Player<Note,Channel<Note>> here because subclass methods take
  // TNote/TChannel contravariantly). Access via the local casts below.
  player?: unknown;
  noteNumber: number;
  velocity: number;
  startTime: number;
  ready: Promise<void>;
  resolveReady!: () => void;
  voice: Voice | null = null;
  voiceParams: VoiceParams | null = null;
  adjustedBaseFreq: number = 20000;
  index: number = -1;
  ending: boolean = false;
  bufferSource: AudioBufferSourceNode | null = null;
  volumeNode: GainNode | null = null;
  timelineIndex: number | null = null;
  renderedBuffer: RenderedBuffer | null = null;
  fullCacheVoiceId: number | null = null;
  filterEnvelopeNode: BiquadFilterNode | null = null;
  volumeEnvelopeNode: GainNode | null = null;
  modLfo: OscillatorNode | null = null;
  modLfoToPitch: GainNode | null = null;
  modLfoToFilterFc: GainNode | null = null;
  modLfoToVolume: GainNode | null = null;
  // "segment" mode
  isSegmentGhost: boolean = false;
  segmentNoteDuration: number = 0;
  audioBufferId?: number;
  // Polyphonic key pressure (MIDI poly aftertouch), 0-127. Only meaningful
  // for subclasses (e.g. Midy's) whose Channel actually tracks/updates it
  // via setPolyphonicKeyPressure; stays 0 and unused otherwise.
  pressure: number = 0;

  constructor(noteNumber: number, velocity: number, startTime: number) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
}

type ChannelSettings = typeof Player.channelSettings;
type ChannelAudioNodes = ReturnType<Player["createChannelAudioNodes"]>;

export class Channel<TNote extends Note = Note> {
  // See Note.player above for why this is unknown rather than
  // Player<TNote, Channel<TNote>>.
  player!: unknown;
  // Every Channel<TNote> is always constructed by, and only by, a matching
  // Player<TNote, ...> (see Player.createChannels / createChannelInstance),
  // so this cast is safe by construction even though TypeScript can't prove
  // it generically. This is the single place that assertion is made; every
  // other place that needs the owning player (in this class, its
  // subclasses, or the default handlers below) should read
  // `channel.typedPlayer` instead of casting `channel.player` itself.
  get typedPlayer(): Player<TNote, Channel<TNote>> {
    return this.player as Player<TNote, Channel<TNote>>;
  }
  gainL!: GainNode;
  gainR!: GainNode;
  merger!: ChannelMergerNode;
  isDrum: boolean = false;
  channelNumber: number = 0;
  programNumber: number = 0;
  detune: number = 0;
  dataMSB: number = 0;
  dataLSB: number = 0;
  rpnMSB: number = 127;
  rpnLSB: number = 127;
  modulationDepthRange: number = 50;
  activeNotes: (TNote[] | undefined)[] = new Array(128);
  sustainNotes: TNote[] = [];
  state!: ControllerState;

  constructor(
    channelNumber: number,
    settings: ChannelSettings,
    audioNodes?: ChannelAudioNodes,
  ) {
    this.channelNumber = channelNumber;
    Object.assign(this, settings);
    this.state = new ControllerState();
    if (audioNodes) Object.assign(this, audioNodes);
  }

  resetSettings(settings: ChannelSettings): void {
    Object.assign(this, settings);
  }

  processScheduledNotes(
    callback: (note: TNote) => void | Promise<void>,
  ): Promise<void[]> {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 128; i++) {
      const stack = this.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        if (note.ending) continue;
        tasks.push(note.ready.then(() => callback(note)));
      }
    }
    return Promise.all(tasks);
  }

  processActiveNotes(
    scheduleTime: number,
    callback: (note: TNote) => void | Promise<void>,
  ): Promise<void[]> {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 128; i++) {
      const stack = this.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        if (note.ending) continue;
        if (scheduleTime < note.startTime) continue;
        tasks.push(note.ready.then(() => callback(note)));
      }
    }
    return Promise.all(tasks);
  }

  async noteOn(
    noteNumber: number,
    velocity: number,
    startTime: number | undefined,
    note?: TNote,
  ): Promise<TNote | void> {
    return await this.typedPlayer.noteOnChannel(
      this,
      noteNumber,
      velocity,
      startTime,
      note,
    );
  }

  async noteOff(
    noteNumber: number,
    velocity: number,
    endTime: number | undefined,
    force: boolean = false,
  ): Promise<void> {
    const player = this.typedPlayer;
    const t: number = endTime ?? player.audioContext.currentTime;
    return await player.noteOffChannel(this, noteNumber, velocity, t, force);
  }

  setProgramChange(programNumber: number): void {
    this.programNumber = programNumber;
  }

  setPitchBend(value: number, scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const state = this.state;
    const prev = state.pitchWheel * 2 - 1;
    const next = (value - 8192) / 8192;
    state.pitchWheel = value / 16383;
    this.detune += (next - prev) * state.pitchWheelSensitivity * 12800;
    player.updateChannelDetune(this, t);
    player.applyVoiceParams(this, 14, t);
  }

  setControlChange(
    controllerType: number,
    value: number,
    scheduleTime?: number,
  ): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const handler = player.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(player, this, value, t);
      player.applyVoiceParams(this, controllerType + 128, t);
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`,
      );
    }
  }

  setModulationDepth(value: number, scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.modulationDepthMSB = value / 127;
    player.updateModulation(this, t);
  }

  setVolume(value: number, scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.volumeMSB = value / 127;
    player.updateChannelVolume(this, t);
  }

  setPan(value: number, scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.panMSB = value / 127;
    player.updateChannelVolume(this, t);
  }

  setExpression(value: number, scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.expressionMSB = value / 127;
    player.updateChannelVolume(this, t);
  }

  async setSustainPedal(value: number, scheduleTime?: number): Promise<void> {
    const player = this.typedPlayer;
    if (this.isDrum) return;
    const state = this.state;
    const prevValue = state.sustainPedal;
    state.sustainPedal = value / 127;
    if (64 <= value) {
      if (prevValue < 0.5) {
        await this.processScheduledNotes((note) => {
          this.sustainNotes.push(note);
        });
      }
    } else {
      const t: number = scheduleTime ?? player.audioContext.currentTime;
      player.releaseSustainPedal(this, value, t);
    }
  }

  dataEntryMSB(value: number, scheduleTime?: number): void {
    this.dataMSB = value;
    this.handleRPN(scheduleTime);
  }

  dataEntryLSB(value: number, scheduleTime?: number): void {
    this.dataLSB = value;
    this.handleRPN(scheduleTime);
  }

  setRPNMSB(value: number): void {
    this.rpnMSB = value;
  }

  setRPNLSB(value: number): void {
    this.rpnLSB = value;
  }

  handleRPN(scheduleTime?: number): void {
    const rpn = this.rpnMSB * 128 + this.rpnLSB;
    switch (rpn) {
      case 0:
        this.handlePitchBendRangeRPN(scheduleTime);
        break;
      case 16383: // NULL
        break;
      default:
        console.warn(
          `Channel ${this.channelNumber}: Unsupported RPN MSB=${this.rpnMSB} LSB=${this.rpnLSB}`,
        );
    }
  }

  limitData(
    minMSB: number,
    maxMSB: number,
    minLSB: number,
    maxLSB: number,
  ): void {
    if (maxLSB < this.dataLSB) {
      this.dataMSB++;
      this.dataLSB = minLSB;
    } else if (this.dataLSB < 0) {
      this.dataMSB--;
      this.dataLSB = maxLSB;
    }
    if (maxMSB < this.dataMSB) {
      this.dataMSB = maxMSB;
      this.dataLSB = maxLSB;
    } else if (this.dataMSB < 0) {
      this.dataMSB = minMSB;
      this.dataLSB = minLSB;
    }
  }

  handlePitchBendRangeRPN(scheduleTime?: number): void {
    this.limitData(0, 127, 0, 127);
    const pitchBendRange = (this.dataMSB + this.dataLSB / 128) * 100;
    this.setPitchBendRange(pitchBendRange, scheduleTime);
  }

  setPitchBendRange(value: number, scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const state = this.state;
    const prev = state.pitchWheelSensitivity;
    const next = value / 12800;
    state.pitchWheelSensitivity = next;
    this.detune += (state.pitchWheel * 2 - 1) * (next - prev) * 12800;
    player.updateChannelDetune(this, t);
    player.applyVoiceParams(this, 16, t);
  }

  allSoundOff(scheduleTime?: number): Promise<void[]> {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const promises: Promise<void>[] = [];
    this.processActiveNotes(t, (note) => {
      promises.push(player.soundOffNote(note, t));
    });
    return Promise.all(promises);
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
  resetAllControllers(scheduleTime?: number): void {
    const player = this.typedPlayer;
    const keys = [
      "pitchWheel",
      "expressionMSB",
      "modulationDepthMSB",
      "sustainPedal",
    ] as const;
    const state = this.state;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const { type, defaultValue } = defaultControllerState[key];
      if (128 <= type) {
        this.setControlChange(
          type - 128,
          Math.ceil(defaultValue * 127),
          scheduleTime,
        );
      } else {
        state[key] = defaultValue;
      }
    }
    this.setPitchBend(8192, scheduleTime);
    const settingTypes = ["rpnMSB", "rpnLSB"] as const;
    const channelSettings =
      (player.constructor as typeof Player).channelSettings;
    for (let i = 0; i < settingTypes.length; i++) {
      const key = settingTypes[i];
      this[key] = channelSettings[key];
    }
  }

  resetChannelStates(scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const state = this.state;
    const entries = Object.entries(defaultControllerState) as [
      keyof typeof defaultControllerState,
      { type: number; defaultValue: number },
    ][];
    for (const [key, { type, defaultValue }] of entries) {
      if (128 <= type) {
        this.setControlChange(
          type - 128,
          Math.ceil(defaultValue * 127),
          t,
        );
      } else {
        state[key] = defaultValue;
      }
    }
    this.resetSettings(
      (player.constructor as typeof Player).channelSettings,
    );
  }

  allNotesOff(scheduleTime?: number): Promise<void[]> {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const promises: (Promise<void> | void)[] = [];
    this.processActiveNotes(t, (note) => {
      // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
      const promise = this.noteOff(note.noteNumber, 0, t, true);
      if (promise !== undefined) promises.push(promise);
    });
    this.sustainNotes = [];
    return Promise.all(
      promises.filter((p) => p !== undefined) as Promise<void>[],
    );
  }
}

// Default GM drum-map exclusive groups (hi-hat, whistle, guiro, cuica, triangle).
// Exposed as an instance field on Player so subclasses can replace or clear
// the table (MidyGM1 uses an all-zero table and relies only on SF2 exclusiveClass).
const DEFAULT_DRUM_EXCLUSIVE_CLASS_COUNT = 5;
function createDefaultDrumExclusiveClasses(): Uint8Array {
  const t = new Uint8Array(128);
  t[42] = 1;
  t[44] = 1;
  t[46] = 1; // HH
  t[71] = 2;
  t[72] = 2; // Whistle
  t[73] = 3;
  t[74] = 3; // Guiro
  t[78] = 4;
  t[79] = 4; // Cuica
  t[80] = 5;
  t[81] = 5; // Triangle
  return t;
}

// normalized to 0-1 for use with the SF2 modulator model
const defaultControllerState = {
  noteOnVelocity: { type: 2, defaultValue: 0 },
  noteOnKeyNumber: { type: 3, defaultValue: 0 },
  pitchWheel: { type: 14, defaultValue: 8192 / 16383 },
  pitchWheelSensitivity: { type: 16, defaultValue: 2 / 128 },
  link: { type: 127, defaultValue: 0 },
  modulationDepthMSB: { type: 128 + 1, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volumeMSB: { type: 128 + 7, defaultValue: 100 / 127 },
  panMSB: { type: 128 + 10, defaultValue: 64 / 127 },
  expressionMSB: { type: 128 + 11, defaultValue: 1 },
  // dataLSB: { type: 128 + 38, defaultValue: 0, },
  sustainPedal: { type: 128 + 64, defaultValue: 0 },
  // rpnLSB: { type: 128 + 100, defaultValue: 127 },
  // rpnMSB: { type: 128 + 101, defaultValue: 127 },
  // allSoundOff: { type: 128 + 120, defaultValue: 0 },
  // resetAllControllers: { type: 128 + 121, defaultValue: 0 },
  // allNotesOff: { type: 128 + 123, defaultValue: 0 },
};

const defaultControllerStateArray = new Float32Array(256);
for (const { type, defaultValue } of Object.values(defaultControllerState)) {
  defaultControllerStateArray[type] = defaultValue;
}

export class ControllerState {
  array: Float32Array = new Float32Array(256);

  get noteOnVelocity(): number {
    return this.array[2];
  }
  set noteOnVelocity(value: number) {
    this.array[2] = value;
  }

  get noteOnKeyNumber(): number {
    return this.array[3];
  }
  set noteOnKeyNumber(value: number) {
    this.array[3] = value;
  }

  get pitchWheel(): number {
    return this.array[14];
  }
  set pitchWheel(value: number) {
    this.array[14] = value;
  }

  get pitchWheelSensitivity(): number {
    return this.array[16];
  }
  set pitchWheelSensitivity(value: number) {
    this.array[16] = value;
  }

  get link(): number {
    return this.array[127];
  }
  set link(value: number) {
    this.array[127] = value;
  }

  get modulationDepthMSB(): number {
    return this.array[128 + 1];
  }
  set modulationDepthMSB(value: number) {
    this.array[128 + 1] = value;
  }

  get volumeMSB(): number {
    return this.array[128 + 7];
  }
  set volumeMSB(value: number) {
    this.array[128 + 7] = value;
  }

  get panMSB(): number {
    return this.array[128 + 10];
  }
  set panMSB(value: number) {
    this.array[128 + 10] = value;
  }

  get expressionMSB(): number {
    return this.array[128 + 11];
  }
  set expressionMSB(value: number) {
    this.array[128 + 11] = value;
  }

  get sustainPedal(): number {
    return this.array[128 + 64];
  }
  set sustainPedal(value: number) {
    this.array[128 + 64] = value;
  }

  constructor() {
    this.array.set(defaultControllerStateArray);
  }
}

const volumeEnvelopeKeys = [
  "volDelay",
  "volAttack",
  "volHold",
  "volDecay",
  "volSustain",
  "volRelease",
  "initialAttenuation",
];
export const volumeEnvelopeKeySet = new Set(volumeEnvelopeKeys);
const filterEnvelopeKeys = [
  "modEnvToPitch",
  "initialFilterFc",
  "modEnvToFilterFc",
  "modDelay",
  "modAttack",
  "modHold",
  "modDecay",
  "modSustain",
];
export const filterEnvelopeKeySet = new Set(filterEnvelopeKeys);
const pitchEnvelopeKeys = [
  "modEnvToPitch",
  "modDelay",
  "modAttack",
  "modHold",
  "modDecay",
  "modSustain",
  "playbackRate",
];
export const pitchEnvelopeKeySet = new Set(pitchEnvelopeKeys);

export class RenderedBuffer {
  buffer: AudioBuffer;
  isLoop: boolean;
  isFull: boolean;
  adsDuration?: number;
  loopStart?: number;
  loopDuration?: number;
  noteDuration?: number;
  releaseDuration?: number;

  constructor(buffer: AudioBuffer, meta: {
    isLoop?: boolean;
    isFull?: boolean;
    adsDuration?: number;
    loopStart?: number;
    loopDuration?: number;
    noteDuration?: number;
    releaseDuration?: number;
  } = {}) {
    this.buffer = buffer;
    this.isLoop = meta.isLoop ?? false;
    this.isFull = meta.isFull ?? false;
    this.adsDuration = meta.adsDuration;
    this.loopStart = meta.loopStart;
    this.loopDuration = meta.loopDuration;
    this.noteDuration = meta.noteDuration;
    this.releaseDuration = meta.releaseDuration;
  }
}

export function cbToRatio(cb: number): number {
  return Math.pow(10, cb / 200);
}

// https://www.synthfont.com/sfspec24.pdf
// SF2 spec (decayVolEnv/decayModEnv/releaseVolEnv/releaseModEnv):
// both the decay and release phase timecent values are defined as
// "the time ... for a 100dB decrease in level, or a 100% decrease in
// filter cutoff frequency ... from the maximum value to the minimum
// value" (decay), and "the time spent in release phase until 100dB
// attenuation [or, for the Modulation Envelope, zero value] were reached"
// starting from full scale (release). Both reference the same 100dB/100%
// change from full scale, so decay and release share one curve constant
// — used identically across every cache mode ("none"/"ads"/"adsr"/
// "segment"/"full") for both the Volume and Modulation envelopes.
export const envelopeCurve = 1 / (-Math.log(cbToRatio(-1000)));

// https://www.synthfont.com/sfspec24.pdf
// SF2 spec's defined maximum (and default) value for the initialFilterFc
// generator: 13500 cents (≈19913Hz via centToHz, see clampCutoffFrequency).
// The spec treats this as "no filtering" / fully open by convention
export const FULLY_OPEN_FILTER_CENTS = 13500;

export interface TimelineEvent {
  type: string;
  ticks: number;
  startTime: number;
  channel?: number;
  noteNumber?: number;
  velocity?: number;
  controllerType?: number;
  programNumber?: number;
  value?: number;
  data?: ArrayLike<number>;
  microsecondsPerBeat?: number;
}

export interface CacheEntry {
  audioBuffer: RenderedBuffer;
  maxCount: number;
  counter: number;
}
export interface NoteOnEventEntry {
  duration: number;
  durationTicks: number;
  startTime: number;
  events: TimelineEvent[];
}
export interface NoteOnEntry {
  idx: number;
  startTime: number;
  startTicks: number;
  events: TimelineEvent[];
}
export interface PendingOffItem {
  t: number;
  ticks: number;
}

// "segment" mode
export interface SegmentNoteEntry {
  offset: number;
  noteNumber: number;
  velocity: number;
  voiceParams: VoiceParams;
  noteDuration: number;
  noteEvent: NoteOnEventEntry | undefined;
  audioBufferId?: number;
  voice?: Voice;
}
export interface OpenSegment {
  segmentStart: number;
  notes: SegmentNoteEntry[];
  // Snapshot of channel.detune / channel.state.array taken at segment-open
  // time (the first note's onset), not segment-close time. scheduleTimelineEvents
  // applies every CC/pitchBend event to the realtime channel as the timeline
  // is walked, regardless of segment mode, so by the time closeSegment()
  // runs, the realtime channel.detune already reflects every event that
  // happened inside this segment. renderSegmentBuffer replays those same
  // events (copied per-note into noteEvents by buildNoteOnDurations) onto
  // dstChannel to bake each note's pitch bend correctly relative to its own
  // onset. Seeding dstChannel from the post-segment realtime value and then
  // replaying the segment's own events on top of it double-applies those
  // events' effect (e.g. channel.setPitchBend's `+=` accumulation),
  // corrupting pitch. Seeding from the pre-segment snapshot instead means
  // the replay starts from the correct baseline.
  channelDetune: number;
  channelStateArray: Float32Array;
  programNumber: number;
}
export interface PendingSegment {
  segmentStart: number;
  buffer: AudioBuffer | null;
  bufferReady: boolean;
  bufferPromise: Promise<AudioBuffer | null>;
  source: AudioBufferSourceNode | null;
  done: boolean;
  // Tags which segmentGeneration this render belongs to. Compared against
  // the player's current segmentGeneration when the render resolves: if
  // they no longer match, a seek/stop/loop happened while this segment was
  // still rendering, so the result is stale and gets discarded instead of
  // being scheduled. See closeSegment()/stopSegmentSources() doc comments.
  generation: number;
}
export interface SegmentChannelState {
  openSegment: OpenSegment | null;
  pending: PendingSegment[];
}

// "chunk" mode
// ChunkNoteEntry mirrors SegmentNoteEntry, with a channelNumber added so
// the renderer knows which channel each note belongs to.
export interface ChunkNoteEntry {
  channelNumber: number;
  offset: number;
  noteNumber: number;
  velocity: number;
  voiceParams: VoiceParams;
  noteDuration: number;
  noteEvent: NoteOnEventEntry | undefined;
  audioBufferId?: number;
  voice?: Voice;
  // Snapshot of per-channel state at the time this note was appended.
  // Channel volume/pan/expression are baked into the chunk buffer so
  // they must be captured here (before later events on the same channel
  // change them).
  channelDetune: number;
  channelStateArray: Float32Array;
  programNumber: number;
  isDrum: boolean;
}
export interface OpenChunk {
  chunkStart: number;
  notes: ChunkNoteEntry[];
}
export interface PendingChunk {
  chunkStart: number;
  buffer: AudioBuffer | null;
  bufferReady: boolean;
  bufferPromise: Promise<AudioBuffer | null>;
  source: AudioBufferSourceNode | null;
  done: boolean;
  generation: number;
}
export interface ChunkState {
  openChunk: OpenChunk | null;
  pending: PendingChunk[];
}

export type MessageHandler = (bytes: Uint8Array, time: number) => void;
export type ControlChangeHandler<
  TNote extends Note = Note,
  TChannel extends Channel<TNote> = Channel<TNote>,
> = (
  ch: TChannel,
  v: number,
  t: number,
) => void;
type VoiceParamsHandler<
  TNote extends Note = Note,
  TChannel extends Channel<TNote> = Channel<TNote>,
> = (
  channel: TChannel,
  note: TNote,
  scheduleTime: number,
) => void;

const voiceParamsHandlers: Record<string, VoiceParamsHandler> = {
  modLfoToPitch: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.typedPlayer.setModLfoToPitch(channel, note, t);
    }
  },
  vibLfoToPitch: (_channel, _note, _t) => {},
  modLfoToFilterFc: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.typedPlayer.setModLfoToFilterFc(channel, note, t);
    }
  },
  modLfoToVolume: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.typedPlayer.setModLfoToVolume(channel, note, t);
    }
  },
  chorusEffectsSend: (_channel, _note, _t) => {},
  reverbEffectsSend: (_channel, _note, _t) => {},
  delayModLFO: (channel, note, _t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.typedPlayer.setDelayModLFO(note);
    }
  },
  freqModLFO: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.typedPlayer.setFreqModLFO(note, t);
    }
  },
  delayVibLFO: (_channel, _note, _t) => {},
  freqVibLFO: (_channel, _note, _t) => {},
  detune: (channel, note, t) => channel.typedPlayer.setDetune(channel, note, t),
};

const controlChangeHandlers: ControlChangeHandler[] = new Array(128);
controlChangeHandlers[1] = (ch, v, t) => ch.setModulationDepth(v, t);
controlChangeHandlers[6] = (ch, v, t) => ch.dataEntryMSB(v, t);
controlChangeHandlers[7] = (ch, v, t) => ch.setVolume(v, t);
controlChangeHandlers[10] = (ch, v, t) => ch.setPan(v, t);
controlChangeHandlers[11] = (ch, v, t) => ch.setExpression(v, t);
controlChangeHandlers[38] = (ch, v, t) => ch.dataEntryLSB(v, t);
controlChangeHandlers[64] = (ch, v, t) => ch.setSustainPedal(v, t);
controlChangeHandlers[100] = (ch, v, _t) => ch.setRPNLSB(v);
controlChangeHandlers[101] = (ch, v, _t) => ch.setRPNMSB(v);
controlChangeHandlers[120] = (ch, _v, t) => ch.allSoundOff(t);
controlChangeHandlers[121] = (ch, _v, t) => ch.resetAllControllers(t);
controlChangeHandlers[123] = (ch, _v, t) => ch.allNotesOff(t);

export class Player<
  TNote extends Note = Note,
  TChannel extends Channel<TNote> = Channel<TNote>,
> extends EventTarget {
  // https://pmc.ncbi.nlm.nih.gov/articles/PMC4191557/
  // https://pubmed.ncbi.nlm.nih.gov/12488797/
  // Gap detection studies indicate humans detect temporal discontinuities
  // around 2–3 ms. Smoothing over ~4 ms is perceived as continuous.
  perceptualSmoothingTime: number = 0.004;
  mode: string = "GM1";
  numChannels: number = 16;
  ticksPerBeat: number = 120;
  totalTime: number = 0;
  noteCheckInterval: number = 0.1;
  drainTimeoutMs: number = 5000;
  // How far ahead (in seconds) notes are scheduled/prepared before their
  // actual start time, for every cache mode. Must comfortably exceed
  // however long note/segment preparation can take on this device
  // (sample decode, envelope baking, or — for "segment" mode — a whole
  // renderSegmentBuffer offline render covering every note in the
  // segment): AudioBufferSourceNode.start(t) with a t that has already
  // passed by the time start() runs doesn't wait for the right moment, it
  // just starts immediately, so under-preparing makes notes/segments play
  // late/at the wrong moment instead of on time. Watch the console for
  // "missed its scheduled start" warnings and raise this if they appear,
  // at the cost of added playback latency. "segment" mode automatically
  // uses lookAhead + maxSegmentNoteDuration as its effective lookahead
  // (for both note discovery and segment-close timing), since a segment's
  // worst-case render cost scales with how long a single note in it can
  // ring; raise maxSegmentNoteDuration's tier instead of lookAhead itself
  // if warnings only appear in segment mode.
  lookAhead: number = 1;
  startDelay: number = 0.5;
  startTime: number = 0;
  resumeTime: number = 0;
  soundFonts: SoundFont[] = [];
  soundFontTable: number[][] = Array.from({ length: 128 }, () => []);
  voiceCounter: Map<number, number> = new Map();
  voiceCache: Map<number, CacheEntry> = new Map();
  realtimeVoiceCache: Map<number, RenderedBuffer> = new Map();
  rawAudioBufferCache: Map<number, AudioBuffer | Promise<AudioBuffer>> =
    new Map();
  decodeMethod: string = "wasm-audio-decoders";
  isPlaying: boolean = false;
  isPausing: boolean = false;
  isPaused: boolean = false;
  isStopping: boolean = false;
  isSeeking: boolean = false;
  totalTimeEventTypes: Set<string> = new Set(["noteOff"]);
  tempo: number = 1;
  loop: boolean = false;
  playPromise?: Promise<void>;
  timeline: TimelineEvent[] = [];
  notePromises: Promise<void>[] = [];
  soundingNotes: Set<TNote> = new Set();
  instruments: Set<string> = new Set();
  exclusiveClassNotes: ([TNote, TChannel] | null)[] = new Array(128);
  // GM drum-map exclusive groups. Subclasses may replace with
  // `new Uint8Array(128)` to disable (all zeros → no drum-map choking).
  drumExclusiveClasses: Uint8Array = createDefaultDrumExclusiveClasses();
  drumExclusiveClassNotes: (TNote | null)[] = new Array(
    16 * DEFAULT_DRUM_EXCLUSIVE_CLASS_COUNT,
  );
  // When true (default), Note Off on a drum channel for *live* MIDI input
  // only drops the note from activeNotes and does not run the release
  // envelope — matching one-shot drum behaviour. MIDI-file notes (those
  // with a timelineIndex) always release on Note Off so their decay matches
  // segment/chunk offline bakes, which force-release drums. Subclasses that
  // should also release live drums on Note Off (historical MidyGM1) set
  // this to false.
  ignoreDrumNoteOff: boolean = true;
  noteAudioBufferIds: (number | undefined)[] = [];
  // "adsr" mode
  adsrVoiceCache: Map<
    number,
    Map<bigint, RenderedBuffer | Promise<RenderedBuffer>>
  > = new Map();
  // "note" mode
  noteOnDurations: number[] = [];
  noteOnEvents: (NoteOnEventEntry | undefined)[] = [];
  fullVoiceCache: Map<
    number,
    Map<number, RenderedBuffer | Promise<RenderedBuffer>>
  > = new Map();
  // "audio" mode
  renderedAudioBuffer: AudioBuffer | null = null;
  isRendering: boolean = false;
  audioModeBufferSource: AudioBufferSourceNode | null = null;
  // "segment" mode
  segmentDuration: number = 1;
  maxSegmentNoteDuration: number = 8;
  segmentBakedSet: Set<number> = new Set();
  segmentChannelStates: (SegmentChannelState | null)[] = [];
  segmentVoiceParams: (VoiceParams | null)[] = [];
  segmentVoices: (Voice | null)[] = [];
  preloadEntries: { audioBufferId: number; voiceParams: VoiceParams }[] = [];
  // Bumped on every seek/stop/loop/pause. renderSegmentBuffer() calls are
  // tagged with the generation active when they started; if it no longer
  // matches this value once a render finishes, that render started before
  // a seek (or stop/loop) and is stale, so its result is discarded instead
  // of being scheduled or replacing a newer in-flight render's slot. This
  // also matters under load: OfflineAudioContext.startRendering() calls
  // are serialized by the browser, so a backlog of now-useless renders
  // left over from before a seek can otherwise delay the fresh segments
  // that should be playing now, pushing them past lookAhead and causing
  // them to start late/at the wrong moment (see warnIfStartTimeMissed).
  segmentGeneration: number = 0;
  // "chunk" mode
  // Same segmentDuration / maxSegmentNoteDuration / segmentBakedSet /
  // segmentVoiceParams / segmentVoices are reused from segment mode —
  // the per-note classification logic is identical.
  chunkState: ChunkState = { openChunk: null, pending: [] };
  // Same generation-stamp mechanism as segmentGeneration.
  chunkGeneration: number = 0;

  audioContext: AudioContext | OfflineAudioContext;
  cacheMode: CacheMode;
  masterVolume: GainNode;
  masterVolumeLocked: boolean = false;
  scheduler: GainNode | null;
  schedulerBuffer: AudioBuffer | null;
  pendingSchedulerSources: Set<AudioBufferSourceNode> = new Set();
  channels: TChannel[];
  messageHandlers: MessageHandler[];
  voiceParamsHandlers: Record<string, VoiceParamsHandler<TNote, TChannel>>;
  controlChangeHandlers: ControlChangeHandler<TNote, TChannel>[];

  static channelSettings = {
    detune: 0,
    programNumber: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    modulationDepthRange: 50, // cent
  };

  constructor(
    audioContext: AudioContext | OfflineAudioContext,
    options?: { activeChannelNumbers?: Iterable<number> },
  ) {
    super();
    this.audioContext = audioContext;
    this.cacheMode = DEFAULT_CACHE_MODE;
    this.masterVolume = new GainNode(audioContext);
    const isOffline = audioContext instanceof OfflineAudioContext;
    if (isOffline) {
      this.scheduler = null;
      this.schedulerBuffer = null;
      this.messageHandlers = [];
    } else {
      this.scheduler = new GainNode(audioContext, { gain: 0 });
      this.schedulerBuffer = new AudioBuffer({
        length: 1,
        sampleRate: audioContext.sampleRate,
      });
      this.messageHandlers = this.createMessageHandlers();
    }
    this.voiceParamsHandlers = voiceParamsHandlers as unknown as Record<
      string,
      VoiceParamsHandler<TNote, TChannel>
    >;
    this.controlChangeHandlers =
      controlChangeHandlers as unknown as ControlChangeHandler<
        TNote,
        TChannel
      >[];
    const activeChannelNumbers = options?.activeChannelNumbers
      ? new Set(options.activeChannelNumbers)
      : undefined;
    this.channels = this.createChannels(activeChannelNumbers);
  }

  // Not called automatically by this constructor: subclasses that add their
  // own fields (e.g. Midy's reverb/chorus/delay effects, extra handler
  // tables) need those ready *before* this runs, since it wires the audio
  // graph to the destination and, for realtime contexts, fires
  // GM1SystemOn() — which, via the subclass's own override, may already
  // depend on those extra fields. So every concrete subclass's constructor
  // (MidyGMLite's, Midy's, ...) calls this itself as its last step.
  protected finishConstruction(
    audioContext: AudioContext | OfflineAudioContext,
    isOffline: boolean,
  ): void {
    this.masterVolume.connect(audioContext.destination);
    if (!isOffline) {
      this.scheduler!.connect(audioContext.destination);
      this.GM1SystemOn(audioContext.currentTime);
    } else {
      if (this.channels[9]) this.channels[9].isDrum = true;
    }
  }

  addSoundFont(soundFont: SoundFont): void {
    const index = this.soundFonts.length;
    this.soundFonts.push(soundFont);
    const presetHeaders = soundFont.parsed.presetHeaders;
    const soundFontTable = this.soundFontTable;
    for (let i = 0; i < presetHeaders.length; i++) {
      const { preset, bank } = presetHeaders[i];
      soundFontTable[preset][bank] = index;
    }
  }

  async toUint8Array(input: string | Uint8Array): Promise<Uint8Array> {
    if (typeof input === "string") {
      const response = await fetch(input);
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } else if (input instanceof Uint8Array) {
      return input;
    }
    throw new TypeError("input must be a URL string or Uint8Array");
  }

  async loadSoundFont(
    input: string | Uint8Array | (string | Uint8Array)[],
  ): Promise<void> {
    this.voiceCounter.clear();
    this.rawAudioBufferCache = new Map();
    if (Array.isArray(input)) {
      const promises = new Array(input.length);
      for (let i = 0; i < input.length; i++) {
        promises[i] = this.toUint8Array(input[i]);
      }
      const uint8Arrays = await Promise.all(promises);
      for (let i = 0; i < uint8Arrays.length; i++) {
        const parsed = parse(uint8Arrays[i]);
        const soundFont = new SoundFont(parsed);
        this.addSoundFont(soundFont);
      }
    } else {
      const uint8Array = await this.toUint8Array(input);
      const parsed = parse(uint8Array);
      const soundFont = new SoundFont(parsed);
      this.addSoundFont(soundFont);
    }
  }

  async loadMIDI(input: string | Uint8Array): Promise<void> {
    if (this.isPlaying || this.isPaused) {
      await this.stop();
    }
    this.voiceCounter.clear();
    this.clearPlaybackCaches();
    this.renderedAudioBuffer = null;
    this.noteAudioBufferIds = [];
    this.preloadEntries = [];
    this.segmentBakedSet.clear();
    this.segmentVoiceParams = [];
    this.segmentVoices = [];
    this.noteOnDurations = [];
    this.noteOnEvents = [];
    this.resumeTime = 0;
    this.isPaused = false;

    const uint8Array = await this.toUint8Array(input);
    const midi = parseMidi(uint8Array);
    this.ticksPerBeat = midi.header.ticksPerBeat ?? 480;
    const midiData = this.extractMidiData(midi);
    this.instruments = midiData.instruments;
    this.timeline = midiData.timeline;
    this.totalTime = this.calcTotalTime();
    if (this.cacheMode === "audio") {
      await this.render();
    }
  }

  buildNoteOnDurations(): void {
    const { timeline, totalTime, noteOnDurations, noteOnEvents, numChannels } =
      this;
    noteOnDurations.length = 0;
    noteOnEvents.length = 0;
    noteOnDurations.length = timeline.length;
    noteOnEvents.length = timeline.length;
    const inverseTempo = 1 / this.tempo;
    const sustainPedal = new Uint8Array(numChannels);
    const activeNotes = new Map<number, NoteOnEntry[]>();
    const pendingOff = new Map<number, PendingOffItem[]>();
    const finalizeEntry = (
      entry: NoteOnEntry,
      endTime: number,
      endTicks: number | null,
    ): void => {
      const duration = Math.max(0, endTime - entry.startTime);
      const durationTicks = (endTicks == null || endTicks === Infinity)
        ? Infinity
        : Math.max(0, endTicks - entry.startTicks);
      noteOnDurations[entry.idx] = duration;
      noteOnEvents[entry.idx] = {
        duration,
        durationTicks,
        startTime: entry.startTime,
        events: entry.events,
      };
    };
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const t = event.startTime * inverseTempo;
      switch (event.type) {
        case "noteOn": {
          const ch = event.channel ?? 0;
          const key = event.noteNumber! * numChannels + ch;
          if (!activeNotes.has(key)) activeNotes.set(key, []);
          activeNotes.get(key)!.push({
            idx: i,
            startTime: t,
            startTicks: event.ticks,
            events: [],
          });
          const pendingStack = pendingOff.get(key);
          if (pendingStack && pendingStack.length > 0) pendingStack.shift();
          break;
        }
        case "noteOff": {
          const ch = event.channel ?? 0;
          const key = event.noteNumber! * numChannels + ch;
          if (sustainPedal[ch]) {
            if (!pendingOff.has(key)) pendingOff.set(key, []);
            pendingOff.get(key)!.push({ t, ticks: event.ticks });
          } else {
            const stack = activeNotes.get(key);
            if (stack && stack.length > 0) {
              finalizeEntry(stack.shift()!, t, event.ticks);
              if (stack.length === 0) activeNotes.delete(key);
            }
          }
          break;
        }
        case "controller": {
          const ch = event.channel ?? 0;
          for (const [key, entries] of activeNotes) {
            if (key % numChannels !== ch) continue;
            for (const entry of entries) entry.events.push(event);
          }
          switch (event.controllerType) {
            case 64: { // Sustain Pedal
              const on = event.value! >= 64;
              sustainPedal[ch] = on ? 1 : 0;
              if (!on) {
                for (const [key, offItems] of pendingOff) {
                  if (key % numChannels !== ch) continue;
                  const activeStack = activeNotes.get(key);
                  for (const { t: offTime, ticks: offTicks } of offItems) {
                    if (activeStack && activeStack.length > 0) {
                      finalizeEntry(activeStack.shift()!, offTime, offTicks);
                      if (activeStack.length === 0) activeNotes.delete(key);
                    }
                  }
                  pendingOff.delete(key);
                }
              }
              break;
            }
            case 121: // Reset All Controllers
              sustainPedal[ch] = 0;
              break;
            case 120: // All Sound Off
            case 123: { // All Notes Off
              for (const [key, stack] of activeNotes) {
                if (key % numChannels !== ch) continue;
                for (const entry of stack) finalizeEntry(entry, t, event.ticks);
                activeNotes.delete(key);
              }
              for (const key of pendingOff.keys()) {
                if (key % numChannels === ch) pendingOff.delete(key);
              }
              break;
            }
          }
          break;
        }
        case "sysEx": {
          const data = event.data!;
          if (data[0] === 126 && data[1] === 9 && data[2] === 3) {
            // GM1 System On
            if (data[3] === 1) {
              sustainPedal.fill(0);
              pendingOff.clear();
              for (const [, stack] of activeNotes) {
                for (const entry of stack) finalizeEntry(entry, t, event.ticks);
              }
              activeNotes.clear();
            }
          } else {
            for (const [, entries] of activeNotes) {
              for (const entry of entries) entry.events.push(event);
            }
          }
          break;
        }
        case "pitchBend":
        case "programChange": {
          const ch = event.channel;
          for (const [key, entries] of activeNotes) {
            if (key % numChannels !== ch) continue;
            for (const entry of entries) entry.events.push(event);
          }
        }
      }
    }
    for (const [, stack] of activeNotes) {
      for (const entry of stack) finalizeEntry(entry, totalTime, Infinity);
    }
  }

  cacheVoiceIds(): void {
    const { channels, timeline, voiceCounter, cacheMode } = this;
    const isSegmentMode = cacheMode === "segment";
    const isChunkMode = cacheMode === "chunk";
    const needsSegmentData = isSegmentMode || isChunkMode;
    const segmentVoiceParams: (VoiceParams | null)[] = needsSegmentData
      ? new Array(timeline.length).fill(null)
      : [];
    const segmentVoices: (Voice | null)[] = needsSegmentData
      ? new Array(timeline.length).fill(null)
      : [];
    const noteAudioBufferIds: (number | undefined)[] = new Array(
      timeline.length,
    );
    const preloadEntries: {
      audioBufferId: number;
      voiceParams: VoiceParams;
    }[] = [];
    const seenPreloadIds = new Set<number>();
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "noteOn": {
          const channel = channels[event.channel!];
          const audioBufferId = this.getVoiceId(
            channel,
            event.noteNumber!,
            event.velocity!,
          );
          voiceCounter.set(
            audioBufferId!,
            (voiceCounter.get(audioBufferId!) ?? 0) + 1,
          );
          // finalizeSegmentClassification() runs after this loop, at which point
          // channel.programNumber reflects the last programChange in the song, not
          // the one in effect at each individual note. So voiceParams must be
          // resolved and snapshotted here, while programNumber is still correct.
          //
          // Drum exclusive class notes are also excluded from segmentVoiceParams:
          // the kit lookup needs the current programNumber, and segmenting them
          // would bring no benefit anyway since exclusive class guarantees at most
          // one note of the same class sounds at a time.
          const isExcludedDrum = channel.isDrum &&
            this.drumExclusiveClasses[event.noteNumber!] !== 0;
          // Exclusive class drum notes are excluded from segmentVoiceParams
          // (and therefore from segment/chunk notes) because segmenting them would
          // bring no benefit — exclusive class guarantees at most one note of
          // the same class sounds at a time, so they're scheduled via the
          // normal noteOnChannel path instead. However they still need their
          // raw sample decoded and cached so that noteOnChannel path doesn't
          // pay a decode penalty on first encounter. Preload them unconditionally.
          if (audioBufferId !== undefined) {
            noteAudioBufferIds[i] = audioBufferId;
            const voice = this.resolveVoice(
              channel,
              event.noteNumber!,
              event.velocity!,
            );
            if (voice) {
              const controllerState = this.getControllerState(
                channel,
                event.noteNumber!,
                event.velocity!,
                0,
              );
              const voiceParams = voice.getAllParams(controllerState);
              if (needsSegmentData && !isExcludedDrum) {
                segmentVoiceParams[i] = voiceParams;
                segmentVoices[i] = voice;
              }
              if (!seenPreloadIds.has(audioBufferId)) {
                seenPreloadIds.add(audioBufferId);
                preloadEntries.push({ audioBufferId, voiceParams });
              }
            }
          }
          break;
        }
        case "programChange":
          channels[event.channel!].setProgramChange(event.programNumber!);
      }
    }
    this.noteAudioBufferIds = noteAudioBufferIds;
    this.preloadEntries = preloadEntries;
    for (const [audioBufferId, count] of voiceCounter) {
      if (count === 1) voiceCounter.delete(audioBufferId);
    }
    this.GM1SystemOn(this.audioContext.currentTime);
    if (
      cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio" ||
      cacheMode === "segment" || cacheMode === "chunk"
    ) {
      this.buildNoteOnDurations();
    }
    if (needsSegmentData) {
      this.segmentVoiceParams = segmentVoiceParams;
      this.segmentVoices = segmentVoices;
      this.finalizeSegmentClassification();
    }
  }

  getVoiceId(
    channel: TChannel,
    noteNumber: number,
    velocity: number,
  ): number | undefined {
    const resolved = this.resolveVoiceResult(channel, noteNumber, velocity);
    if (!resolved) return;
    const { instrument, sampleID } = resolved.voice.generators;
    return resolved.soundFontIndex * (2 ** 31) + instrument * (2 ** 24) +
      (sampleID << 8);
  }

  // Overridden by subclasses (e.g. Midy) that instantiate Player<TChannel,
  // TNote> with a richer TChannel/TNote subclass, so that base methods
  // shared via inheritance (createChannels, scheduleTimelineEvents,
  // renderChunkBuffer, renderSegmentBuffer, ...) still construct the right
  // runtime type instead of the base one.
  createChannelInstance(
    channelNumber: number,
    settings: ChannelSettings,
    audioNodes?: ChannelAudioNodes,
  ): TChannel {
    return new Channel(channelNumber, settings, audioNodes) as TChannel;
  }

  createNoteInstance(
    noteNumber: number,
    velocity: number,
    startTime: number,
  ): TNote {
    return new Note(noteNumber, velocity, startTime) as TNote;
  }

  createChannelAudioNodes(
    audioContext: AudioContext | OfflineAudioContext,
  ): { gainL: GainNode; gainR: GainNode; merger: ChannelMergerNode } {
    const { gainLeft, gainRight } = this.panToGain(
      defaultControllerState.panMSB.defaultValue,
    );
    const gainL = new GainNode(audioContext, { gain: gainLeft });
    const gainR = new GainNode(audioContext, { gain: gainRight });
    const merger = new ChannelMergerNode(audioContext, { numberOfInputs: 2 });
    gainL.connect(merger, 0, 0);
    gainR.connect(merger, 0, 1);
    merger.connect(this.masterVolume);
    return { gainL, gainR, merger };
  }

  createUnusedChannelAudioNodes(
    audioContext: AudioContext | OfflineAudioContext,
  ): { gainL: GainNode; gainR: GainNode; merger: ChannelMergerNode } {
    return {
      gainL: new GainNode(audioContext),
      gainR: new GainNode(audioContext),
      merger: new ChannelMergerNode(audioContext, { numberOfInputs: 2 }),
    };
  }

  createChannels(activeChannelNumbers?: Set<number>): TChannel[] {
    const settings = (this.constructor as typeof Player).channelSettings;
    const audioContext = this.audioContext;
    if (audioContext instanceof OfflineAudioContext) {
      return Array.from(
        { length: this.numChannels },
        (_, ch) => {
          const isActive = !activeChannelNumbers ||
            activeChannelNumbers.has(ch);
          const audioNodes = isActive
            ? this.createChannelAudioNodes(audioContext)
            : undefined;
          const channel = this.createChannelInstance(ch, settings, audioNodes);
          channel.player = this;
          return channel;
        },
      );
    } else {
      let unusedAudioNodes: ChannelAudioNodes | null = null;
      return Array.from(
        { length: this.numChannels },
        (_, ch) => {
          const audioNodes =
            !activeChannelNumbers || activeChannelNumbers.has(ch)
              ? this.createChannelAudioNodes(audioContext)
              : (unusedAudioNodes ??= this.createUnusedChannelAudioNodes(
                audioContext,
              ));
          const channel = this.createChannelInstance(ch, settings, audioNodes);
          channel.player = this;
          return channel;
        },
      );
    }
  }

  decodeOggVorbis(sample: AudioData): Promise<AudioBuffer> {
    const task = decoderQueue.then(async () => {
      const decoder = await initDecoder();
      const slice = sample.data.slice();
      const { channelData, sampleRate, errors } = await decoder.decodeFile(
        slice,
      );
      if (0 < errors.length) {
        throw new Error(errors.join(", "));
      }
      const audioBuffer = new AudioBuffer({
        numberOfChannels: channelData.length,
        length: channelData[0].length,
        sampleRate,
      });
      for (let ch = 0; ch < channelData.length; ch++) {
        audioBuffer.getChannelData(ch).set(channelData[ch]);
      }
      return audioBuffer;
    });
    decoderQueue = task.then((): void => {}, (): void => {});
    return task;
  }

  async createAudioBuffer(voiceParams: VoiceParams): Promise<AudioBuffer> {
    const sample = voiceParams.sample;
    if (sample.type === "compressed") {
      switch (this.decodeMethod) {
        case "decodeAudioData": {
          // https://jakearchibald.com/2016/sounds-fun/
          // https://github.com/WebAudio/web-audio-api/issues/1091
          //   decodeAudioData() has priming issues on Safari
          const arrayBuffer = sample.data.slice().buffer;
          return await this.audioContext.decodeAudioData(arrayBuffer);
        }
        case "wasm-audio-decoders":
          return await this.decodeOggVorbis(sample);
        default:
          throw new Error(`Unknown decodeMethod: ${this.decodeMethod}`);
      }
    } else {
      const data = sample.data;
      const end = data.length + voiceParams.end;
      const subarray = data.subarray(voiceParams.start, end);
      const pcm = sample.decodePCM(subarray);
      const audioBuffer = new AudioBuffer({
        numberOfChannels: 1,
        length: pcm.length,
        sampleRate: sample.sampleHeader.sampleRate,
      });
      audioBuffer.getChannelData(0).set(pcm);
      return audioBuffer;
    }
  }

  async getRawAudioBuffer(
    audioBufferId: number,
    voiceParams: VoiceParams,
  ): Promise<AudioBuffer> {
    const cached = this.rawAudioBufferCache.get(audioBufferId);
    if (cached !== undefined) return cached;
    const promise = this.createAudioBuffer(voiceParams);
    this.rawAudioBufferCache.set(audioBufferId, promise);
    const buffer = await promise;
    this.rawAudioBufferCache.set(audioBufferId, buffer);
    return buffer;
  }

  createBufferSource(
    channel: TChannel,
    _noteNumber: number,
    voiceParams: VoiceParams,
    renderedOrRaw: RenderedBuffer | AudioBuffer,
  ): AudioBufferSourceNode {
    const isRendered = renderedOrRaw instanceof RenderedBuffer;
    const audioBuffer = isRendered ? renderedOrRaw.buffer : renderedOrRaw;
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    const isDrumLoop = channel.isDrum
      ? false
      : voiceParams.sampleModes % 2 !== 0;
    const isLoop = isRendered ? renderedOrRaw.isLoop : isDrumLoop;
    bufferSource.loop = isLoop;
    if (bufferSource.loop) {
      if (isRendered && renderedOrRaw.adsDuration != null) {
        bufferSource.loopStart = renderedOrRaw.loopStart!;
        bufferSource.loopEnd = renderedOrRaw.loopStart! +
          renderedOrRaw.loopDuration!;
      } else {
        bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
        bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
      }
    }
    return bufferSource;
  }

  processTimelineEvent(event: TimelineEvent, scheduleTime: number, {
    channels = this.channels,
    onNoteOn = null,
    onNoteOff = null,
  }: {
    channels?: TChannel[];
    onNoteOn?:
      | ((
        channel: TChannel,
        event: TimelineEvent,
        scheduleTime: number,
      ) => void)
      | null;
    onNoteOff?:
      | ((
        channel: TChannel,
        event: TimelineEvent,
        scheduleTime: number,
      ) => void)
      | null;
  } = {}): void {
    const channel = channels[event.channel!];
    switch (event.type) {
      case "noteOn":
        onNoteOn?.(channel, event, scheduleTime);
        break;
      case "noteOff":
        onNoteOff?.(channel, event, scheduleTime);
        break;
      case "controller":
        channel.setControlChange(
          event.controllerType!,
          event.value!,
          scheduleTime,
        );
        break;
      case "programChange":
        channel.setProgramChange(event.programNumber!);
        break;
      case "pitchBend":
        channel.setPitchBend(event.value! + 8192, scheduleTime);
        break;
      case "sysEx":
        this.handleSysEx(new Uint8Array(event.data!), scheduleTime, channels);
    }
  }

  scheduleTimelineEvents(scheduleTime: number, queueIndex: number): number {
    const timeOffset = this.resumeTime - this.startTime;
    const isSegmentMode = this.cacheMode === "segment";
    const isChunkMode = this.cacheMode === "chunk";
    // Segment/chunk mode needs notes discovered far enough ahead that
    // closeSegment/closeChunk + render have time to finish before each
    // segment/chunk's scheduled start time. The worst case render length scales
    // with how long a single note in the segment can ring
    // (maxSegmentNoteDuration), on top of the segment's own discovery
    // window (lookAhead), so segment/chunk mode adds the two rather than reusing
    // the plain lookAhead other cache modes use for note-on scheduling.
    const effectiveLookAhead = (isSegmentMode || isChunkMode)
      ? this.lookAhead + this.maxSegmentNoteDuration
      : this.lookAhead;
    const lookAheadCheckTime = scheduleTime + timeOffset + effectiveLookAhead;
    const schedulingOffset = this.startDelay - timeOffset;
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    while (queueIndex < timeline.length) {
      const event = timeline[queueIndex];
      const t = event.startTime * inverseTempo;
      if (lookAheadCheckTime < t) break;
      const startTime = t + schedulingOffset;
      this.processTimelineEvent(event, startTime, {
        onNoteOn: (channel, event, startTime) => {
          const note = this.createNoteInstance(
            event.noteNumber!,
            event.velocity!,
            startTime,
          );
          note.timelineIndex = queueIndex;
          note.audioBufferId = this.noteAudioBufferIds[queueIndex];
          const isSegmentNote = isSegmentMode &&
            this.segmentBakedSet.has(queueIndex);
          const isChunkNote = isChunkMode &&
            this.segmentBakedSet.has(queueIndex);
          if (isSegmentNote || isChunkNote) {
            note.isSegmentGhost = true;
            note.segmentNoteDuration = this.noteOnDurations[queueIndex] ?? 0;
          }
          channel.noteOn(
            event.noteNumber!,
            event.velocity!,
            startTime,
            note,
          );
          if (isSegmentNote) {
            this.appendToSegmentQueue(
              channel.channelNumber,
              t,
              queueIndex,
              event.noteNumber!,
              event.velocity!,
            );
          }
          if (isChunkNote) {
            this.appendToChunkQueue(
              channel,
              t,
              queueIndex,
              event.noteNumber!,
              event.velocity!,
            );
          }
        },
        onNoteOff: (channel, event, startTime) => {
          channel.noteOff(event.noteNumber!, event.velocity!, startTime, false);
        },
      });
      queueIndex++;
    }
    return queueIndex;
  }

  getQueueIndex(second: number): number {
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    for (let i = 0; i < timeline.length; i++) {
      if (second <= timeline[i].startTime * inverseTempo) {
        return i;
      }
    }
    return 0;
  }

  clearPlaybackCaches(): void {
    this.voiceCache.clear();
    this.realtimeVoiceCache.clear();
    this.adsrVoiceCache.clear();
    this.fullVoiceCache.clear();
  }

  resetChannels(
    channels: TChannel[] = this.channels,
    scheduleTime?: number,
  ): void {
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.activeNotes = new Array(128);
      channel.sustainNotes = [];
      channel.isDrum = false;
      channel.resetChannelStates(scheduleTime);
    }
    if (channels[9]) channels[9].isDrum = true;
  }

  resetAllStates(): void {
    this.soundingNotes.clear();
    this.clearPlaybackCaches();
    this.GM1SystemOn(this.audioContext.currentTime, this.channels);
  }

  updateStates(queueIndex: number, nextQueueIndex: number): void {
    const { timeline, resumeTime } = this;
    const inverseTempo = 1 / this.tempo;
    const now = this.audioContext.currentTime;
    if (nextQueueIndex < queueIndex) queueIndex = 0;
    for (let i = queueIndex; i < nextQueueIndex; i++) {
      const event = timeline[i];
      const t = now - resumeTime + event.startTime * inverseTempo;
      this.processTimelineEvent(event, Math.max(now, t));
    }
  }

  async playAudioBuffer(): Promise<void> {
    const audioContext = this.audioContext;
    const paused = this.isPaused;
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = audioContext.currentTime;
    if (paused) {
      this.dispatchEvent(new Event("resumed"));
    } else {
      this.dispatchEvent(new Event("started"));
    }
    let exitReason: string | undefined;
    outer: while (true) {
      const buffer = this.renderedAudioBuffer;
      const bufferSource = new AudioBufferSourceNode(audioContext, { buffer });
      bufferSource.playbackRate.value = this.tempo;
      bufferSource.connect(this.masterVolume);
      const offset = Math.min(Math.max(this.resumeTime, 0), buffer!.duration);
      bufferSource.start(audioContext.currentTime, offset);
      this.audioModeBufferSource = bufferSource;
      let naturalEnded = false;
      bufferSource.onended = () => {
        naturalEnded = true;
      };
      while (true) {
        const now = audioContext.currentTime;
        await this.scheduleTask(() => {}, now + this.noteCheckInterval);
        if (naturalEnded || this.currentTime() >= this.totalTime) {
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          if (this.loop) {
            this.resumeTime = 0;
            this.startTime = audioContext.currentTime;
            this.dispatchEvent(new Event("looped"));
            continue outer;
          }
          await this.suspendAudioContext();
          exitReason = "ended";
          break outer;
        }
        if (this.isPausing) {
          this.cancelScheduledTasks();
          this.resumeTime = this.currentTime();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          // await this.suspendAudioContext();
          this.isPausing = false;
          exitReason = "paused";
          break outer;
        } else if (this.isStopping) {
          this.cancelScheduledTasks();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          await this.suspendAudioContext();
          this.isStopping = false;
          exitReason = "stopped";
          break outer;
        } else if (this.isSeeking) {
          this.cancelScheduledTasks();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          this.startTime = audioContext.currentTime;
          this.isSeeking = false;
          this.dispatchEvent(new Event("seeked"));
          continue outer;
        }
      }
    }
    this.isPlaying = false;
    if (exitReason === "paused") {
      this.isPaused = true;
      this.dispatchEvent(new Event("paused"));
    } else if (exitReason !== undefined) {
      this.isPaused = false;
      this.dispatchEvent(new Event(exitReason));
    }
  }

  suspendAudioContext(): Promise<void> {
    if (this.audioContext instanceof AudioContext) {
      return this.audioContext.suspend();
    }
    return Promise.resolve();
  }

  async playNotes(): Promise<void> {
    const audioContext = this.audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (this.cacheMode === "audio" && this.renderedAudioBuffer) {
      return await this.playAudioBuffer();
    }
    const paused = this.isPaused;
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = audioContext.currentTime;
    if (paused) {
      this.dispatchEvent(new Event("resumed"));
    } else {
      this.dispatchEvent(new Event("started"));
    }
    let queueIndex = this.getQueueIndex(this.resumeTime);
    if (this.cacheMode === "segment") this.initSegmentPipeline();
    if (this.cacheMode === "chunk") this.initChunkPipeline();
    let exitReason: string | undefined;
    this.notePromises = [];
    while (true) {
      const now = audioContext.currentTime;
      if (
        this.totalTime < this.currentTime() &&
        this.timeline.length <= queueIndex
      ) {
        const pendingPromises = this.notePromises.slice();
        this.notePromises = [];
        await Promise.allSettled(pendingPromises);
        if (this.loop) {
          this.resetAllStates();
          this.startTime = audioContext.currentTime;
          this.resumeTime = 0;
          queueIndex = 0;
          if (this.cacheMode === "segment") {
            this.segmentGeneration++;
            this.initSegmentPipeline();
          }
          if (this.cacheMode === "chunk") {
            this.chunkGeneration++;
            this.initChunkPipeline();
          }
          this.dispatchEvent(new Event("looped"));
          continue;
        } else {
          if (this.cacheMode === "segment") await this.drainSegmentPipeline();
          if (this.cacheMode === "chunk") await this.drainChunkPipeline();
          await this.stopNotes(now);
          await this.suspendAudioContext();
          exitReason = "ended";
          break;
        }
      }
      if (this.isPausing) {
        this.cancelScheduledTasks();
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
        await this.stopNotes(now);
        // await this.suspendAudioContext();
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        this.cancelScheduledTasks();
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
        await this.stopNotes(now);
        await this.suspendAudioContext();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
        this.startTime = audioContext.currentTime;
        const nextQueueIndex = this.getQueueIndex(this.resumeTime);
        this.updateStates(queueIndex, nextQueueIndex);
        queueIndex = nextQueueIndex;
        if (this.cacheMode === "segment") this.initSegmentPipeline();
        if (this.cacheMode === "chunk") this.initChunkPipeline();
        this.isSeeking = false;
        this.dispatchEvent(new Event("seeked"));
        continue;
      }
      queueIndex = this.scheduleTimelineEvents(now, queueIndex);
      if (this.cacheMode === "segment") {
        const timeOffset = this.resumeTime - this.startTime;
        this.updateSegmentPipeline(
          now + timeOffset + this.lookAhead + this.maxSegmentNoteDuration,
        );
      }
      if (this.cacheMode === "chunk") {
        const timeOffset = this.resumeTime - this.startTime;
        this.updateChunkPipeline(
          now + timeOffset + this.lookAhead + this.maxSegmentNoteDuration,
        );
      }
      const waitTime = now + this.noteCheckInterval;
      await this.scheduleTask(() => {}, waitTime);
    }
    if (exitReason !== "paused") {
      this.resetAllStates();
    }
    this.isPlaying = false;
    if (exitReason === "paused") {
      this.isPaused = true;
      this.dispatchEvent(new Event("paused"));
    } else {
      this.isPaused = false;
      this.dispatchEvent(new Event(exitReason));
    }
  }

  ticksToSecond(ticks: number, secondsPerBeat: number): number {
    return ticks * secondsPerBeat / this.ticksPerBeat;
  }

  secondToTicks(second: number, secondsPerBeat: number): number {
    return second * this.ticksPerBeat / secondsPerBeat;
  }

  getSoundFontId(channel: TChannel): string {
    const programNumber = channel.programNumber;
    const bank = channel.isDrum ? "128" : "000";
    const program = programNumber.toString().padStart(3, "0");
    return `${bank}:${program}`;
  }

  extractMidiData(
    midi: MidiData,
  ): { instruments: Set<string>; timeline: TimelineEvent[] } {
    const instruments = new Set<string>();
    const timeline: TimelineEvent[] = [];
    const channels = this.channels;
    for (let i = 0; i < midi.tracks.length; i++) {
      const track = midi.tracks[i];
      let currentTicks = 0;
      for (let j = 0; j < track.length; j++) {
        const midiEvent = track[j];
        const { deltaTime, ...rest } = midiEvent;
        currentTicks += deltaTime;
        const event: TimelineEvent = {
          ...rest,
          ticks: currentTicks,
          startTime: 0,
        };
        switch (midiEvent.type) {
          case "noteOn": {
            const channel = channels[midiEvent.channel];
            if (channel) instruments.add(this.getSoundFontId(channel));
            break;
          }
          case "programChange": {
            const channel = channels[midiEvent.channel];
            if (channel) {
              channel.setProgramChange(midiEvent.programNumber);
              instruments.add(this.getSoundFontId(channel));
            }
            break;
          }
          case "sysEx":
          case "endSysEx":
            event.data = midiEvent.data;
        }
        timeline.push(event);
      }
    }
    const priority: { [key: string]: number } = {
      controller: 0,
      programChange: 0,
      sysEx: 0,
    };
    timeline.sort((a, b) => {
      if (a.ticks !== b.ticks) return a.ticks - b.ticks;
      return (priority[a.type] ?? 1) - (priority[b.type] ?? 1);
    });
    let prevTempoTime = 0;
    let prevTempoTicks = 0;
    let secondsPerBeat = 0.5;
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const timeFromPrevTempo = this.ticksToSecond(
        event.ticks - prevTempoTicks,
        secondsPerBeat,
      );
      event.startTime = prevTempoTime + timeFromPrevTempo;
      if (event.type === "setTempo") {
        prevTempoTime += this.ticksToSecond(
          event.ticks - prevTempoTicks,
          secondsPerBeat,
        );
        const tempoEvent = event as TimelineEvent & MidiSetTempoEvent;
        secondsPerBeat = tempoEvent.microsecondsPerBeat / 1000000;
        prevTempoTicks = event.ticks;
      }
    }
    return { instruments, timeline };
  }

  async stopChannelNotes(
    channel: TChannel,
    scheduleTime: number,
  ): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 128; i++) {
      const stack = channel.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        if (note.isSegmentGhost) continue;
        // Set the 'ending' flag beforehand to prevent start() from being called after getAudioBuffer() completes.
        // Waiting for 'note.ready' could cause a hang during decoding or offline rendering,
        // so we only call soundOff() for nodes that already exist.
        note.ending = true;
        if (note.bufferSource || note.volumeNode) {
          promises.push(this.soundOffNote(note, scheduleTime));
        } else {
          this.soundingNotes.delete(note);
        }
      }
    }
    await Promise.all(promises);
    channel.activeNotes = new Array(128);
    channel.sustainNotes = [];
  }

  async stopNotes(scheduleTime: number): Promise<void[]> {
    const channels = this.channels;
    const channelPromises = new Array<Promise<void>>(channels.length);
    for (let ch = 0; ch < channels.length; ch++) {
      channelPromises[ch] = this.stopChannelNotes(channels[ch], scheduleTime);
    }
    await Promise.all(channelPromises);

    // Drum one-shot that has dropped out of activeNotes / release tail
    const residual = Array.from(this.soundingNotes);
    const residualPromises = new Array<Promise<void>>(residual.length);
    for (let i = 0; i < residual.length; i++) {
      residualPromises[i] = this.soundOffNote(residual[i], scheduleTime);
    }
    this.soundingNotes.clear();

    // Discard the 'onended' wait queued by releaseNote
    // Since soundOffNote overwrites 'onended', waiting would result in it never finishing.
    this.notePromises = [];

    return Promise.all(residualPromises);
  }

  // "segment" mode: per-channel pipeline that groups segment-baked notes into
  // short combined buffers instead of one AudioBufferSourceNode per note.
  //
  // Grouping happens eagerly, in onNoteOn, in exact timeline order: a new
  // segment opens at the first baked note's onset and stays open for up to
  // segmentDuration seconds, after which the next baked note (or, if none
  // arrives in time, the next updateSegmentPipeline tick) closes it. Notes
  // are queued as plain data (offset/noteNumber/velocity/voiceParams/
  // duration/events) — no rendering happens yet at this point. Once the
  // segment closes, all of its notes are baked together in renderSegmentBuffer
  // using a single OfflineAudioContext / startRendering() call (each note
  // still gets its own full envelope/pitch-bend/LFO/CC#1 bake, like "note"
  // mode, but without channel volume/pan/expression so the combined segment
  // can still be mixed live through channel.gainL/gainR), then the resulting
  // buffer is scheduled as a single AudioBufferSourceNode.

  initSegmentPipeline(): void {
    this.segmentChannelStates = Array.from(
      { length: this.numChannels },
      () => ({ openSegment: null, pending: [] }),
    );
  }

  async drainSegmentPipeline(): Promise<void> {
    const channels = this.channels;
    const states = this.segmentChannelStates;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      if (state.openSegment) {
        this.closeSegment(state, channels[ch]);
      }
    }
    const allBufferPromises: Promise<AudioBuffer | null>[] = [];
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        allBufferPromises.push(pending[i].bufferPromise);
      }
    }
    await Promise.allSettled(allBufferPromises);
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        if (!pending[i].source && pending[i].bufferReady) {
          this.startPendingSegment(channels[ch], pending[i]);
        }
      }
    }
    await this.waitForPendingSources("drainSegmentPipeline", () => {
      const result: PendingSegment[] = [];
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (!state) continue;
        const pending = state.pending;
        for (let i = 0; i < pending.length; i++) result.push(pending[i]);
      }
      return result;
    });
  }

  stopSegmentSources(): void {
    // Invalidate any renderSegmentBuffer() calls still in flight. They keep
    // running in the background (OfflineAudioContext has no cancel API),
    // but closeSegment()'s completion handler checks this generation and
    // discards stale results instead of scheduling them or re-adding them
    // to state.pending. Without this, a backlog of now-irrelevant renders
    // from before a seek/stop/loop can play at the wrong moment once they
    // finally finish, and — since startRendering() is serialized by the
    // browser — can delay the fresh segments that should render next,
    // pushing them past lookAhead too.
    this.segmentGeneration++;
    for (const state of this.segmentChannelStates) {
      if (!state) continue;
      for (const pending of state.pending) {
        if (pending.source) {
          try {
            pending.source.stop();
          } catch {
            // already stopped/ended
          }
          // disconnect is handled by the source's onended handler
          pending.source = null;
        }
      }
      state.pending = [];
      state.openSegment = null;
    }
  }

  appendToSegmentQueue(
    channelNumber: number,
    t: number,
    timelineIndex: number,
    noteNumber: number,
    velocity: number,
  ): void {
    const state = this.segmentChannelStates[channelNumber];
    if (!state) return;
    const voiceParams = this.segmentVoiceParams[timelineIndex];
    if (!voiceParams) return;
    const channel = this.channels[channelNumber];
    if (
      state.openSegment &&
      this.segmentDuration <= t - state.openSegment.segmentStart
    ) {
      this.closeSegment(state, channel);
    }
    if (!state.openSegment) {
      state.openSegment = {
        segmentStart: t,
        notes: [],
        channelDetune: channel.detune,
        channelStateArray: channel.state.array.slice(),
        programNumber: channel.programNumber,
      };
    }
    state.openSegment.notes.push({
      offset: t - state.openSegment.segmentStart,
      noteNumber,
      velocity,
      voiceParams,
      noteDuration: this.noteOnDurations[timelineIndex] ?? 0,
      noteEvent: this.noteOnEvents[timelineIndex],
      audioBufferId: this.noteAudioBufferIds[timelineIndex],
      voice: this.segmentVoices[timelineIndex] ?? undefined,
    });
  }

  closeSegment(state: SegmentChannelState, channel: TChannel): void {
    const segment = state.openSegment;
    state.openSegment = null;
    if (!segment || segment.notes.length === 0) return;
    const generation = this.segmentGeneration;
    const pending: PendingSegment = {
      segmentStart: segment.segmentStart,
      buffer: null,
      bufferReady: false,
      source: null,
      done: false,
      bufferPromise: Promise.resolve(null),
      generation,
    };
    pending.bufferPromise = this.renderSegmentBuffer(channel, segment)
      .then((buffer) => {
        if (this.segmentGeneration !== generation) {
          // A seek/stop/loop happened while this segment was rendering.
          // Drop the result: scheduling it now would play audio at the
          // wrong moment (its absoluteStart was computed against a
          // startTime/resumeTime that's no longer current), and letting
          // it linger in state.pending would let updateSegmentPipeline
          // start it later regardless. Also remove it from state.pending
          // in case it's a newer SegmentChannelState array than the one
          // this closure captured (initSegmentPipeline replaces the whole
          // array on seek), so it can't be picked up from there either.
          const idx = state.pending.indexOf(pending);
          if (idx !== -1) state.pending.splice(idx, 1);
          pending.done = true;
          return null;
        }
        pending.buffer = buffer;
        pending.bufferReady = true;
        return buffer;
      })
      .catch((err) => {
        console.warn("segment render failed", err);
        pending.bufferReady = true;
        return null;
      });
    state.pending.push(pending);
  }

  startPendingSegment(channel: TChannel, pending: PendingSegment): void {
    if (!pending.buffer) {
      pending.done = true;
      return;
    }
    const timeOffset = this.resumeTime - this.startTime;
    const schedulingOffset = this.startDelay - timeOffset;
    const nominalStart = pending.segmentStart + schedulingOffset;
    const absoluteStart = Math.max(0, nominalStart);
    this.warnIfStartTimeMissed(
      `segment (channel ${channel.channelNumber})`,
      nominalStart,
    );
    const source = new AudioBufferSourceNode(this.audioContext, {
      buffer: pending.buffer,
    });
    source.connect(channel.gainL);
    source.connect(channel.gainR);
    source.onended = () => {
      pending.done = true;
      source.disconnect();
    };
    source.start(absoluteStart);
    pending.source = source;
  }

  // A still-open segment whose nominal window ends at or before
  // lookAheadCheckTime can be safely closed: onNoteOn has already run for
  // every channel up to that point, so no baked note that could still
  // belong to it has been left unprocessed.
  updateSegmentPipeline(lookAheadCheckTime: number): void {
    const channels = this.channels;
    const states = this.segmentChannelStates;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      if (
        state.openSegment &&
        state.openSegment.segmentStart + this.segmentDuration <=
          lookAheadCheckTime
      ) {
        this.closeSegment(state, channels[ch]);
      }
      state.pending = state.pending.filter((pending) => !pending.done);
      for (const pending of state.pending) {
        if (!pending.source && pending.bufferReady) {
          this.startPendingSegment(channels[ch], pending);
        }
      }
    }
  }

  // "chunk" mode: same window-based grouping as "segment", but all active
  // channels are merged into a SINGLE OfflineAudioContext per time window
  // instead of one context per channel. TChannel volume/pan/expression are
  // baked into the combined stereo buffer (snapshotted at chunk-open time),
  // so the resulting AudioBufferSourceNode connects straight to masterVolume
  // with no per-channel gainL/gainR mixing needed at playback time.

  initChunkPipeline(): void {
    this.chunkState = { openChunk: null, pending: [] };
  }

  async drainChunkPipeline(): Promise<void> {
    const state = this.chunkState;
    if (state.openChunk) {
      this.closeChunk(state);
    }
    const allBufferPromises = state.pending.map((p) => p.bufferPromise);
    await Promise.allSettled(allBufferPromises);
    for (const pending of state.pending) {
      if (!pending.source && pending.bufferReady) {
        this.startPendingChunk(pending);
      }
    }
    await this.waitForPendingSources("drainChunkPipeline", () => state.pending);
  }

  stopChunkSources(): void {
    // Invalidate in-flight renderChunkBuffer() calls (same rationale as
    // stopSegmentSources — stale renders must not be scheduled after a
    // seek/stop/loop).
    this.chunkGeneration++;
    const state = this.chunkState;
    for (const pending of state.pending) {
      if (pending.source) {
        try {
          pending.source.stop();
        } catch {
          // already stopped/ended
        }
        // disconnect is handled by the source's onended handler
        pending.source = null;
      }
    }
    state.pending = [];
    state.openChunk = null;
  }

  appendToChunkQueue(
    channel: TChannel,
    t: number,
    timelineIndex: number,
    noteNumber: number,
    velocity: number,
  ): void {
    const state = this.chunkState;
    const voiceParams = this.segmentVoiceParams[timelineIndex];
    if (!voiceParams) return;

    if (
      state.openChunk &&
      this.segmentDuration <= t - state.openChunk.chunkStart
    ) {
      this.closeChunk(state);
    }
    if (!state.openChunk) {
      state.openChunk = { chunkStart: t, notes: [] };
    }
    state.openChunk.notes.push({
      channelNumber: channel.channelNumber,
      offset: t - state.openChunk.chunkStart,
      noteNumber,
      velocity,
      voiceParams,
      noteDuration: this.noteOnDurations[timelineIndex] ?? 0,
      noteEvent: this.noteOnEvents[timelineIndex],
      audioBufferId: this.noteAudioBufferIds[timelineIndex],
      voice: this.segmentVoices[timelineIndex] ?? undefined,
      // Snapshot per-channel state now — channel volume/pan/expression
      // are baked into the buffer so they must be captured at note-append
      // time before subsequent events on the same channel change them.
      channelDetune: channel.detune,
      channelStateArray: channel.state.array.slice(),
      programNumber: channel.programNumber,
      isDrum: channel.isDrum,
    });
  }

  closeChunk(state: ChunkState): void {
    const chunk = state.openChunk;
    state.openChunk = null;
    if (!chunk || chunk.notes.length === 0) return;
    const generation = this.chunkGeneration;
    const pending: PendingChunk = {
      chunkStart: chunk.chunkStart,
      buffer: null,
      bufferReady: false,
      source: null,
      done: false,
      bufferPromise: Promise.resolve(null),
      generation,
    };
    pending.bufferPromise = this.renderChunkBuffer(chunk)
      .then((buffer) => {
        if (this.chunkGeneration !== generation) {
          const idx = state.pending.indexOf(pending);
          if (idx !== -1) state.pending.splice(idx, 1);
          pending.done = true;
          return null;
        }
        pending.buffer = buffer;
        pending.bufferReady = true;
        return buffer;
      })
      .catch((err) => {
        console.warn("chunk render failed", err);
        pending.bufferReady = true;
        return null;
      });
    state.pending.push(pending);
  }

  startPendingChunk(pending: PendingChunk): void {
    if (!pending.buffer) {
      pending.done = true;
      return;
    }
    const timeOffset = this.resumeTime - this.startTime;
    const schedulingOffset = this.startDelay - timeOffset;
    const nominalStart = pending.chunkStart + schedulingOffset;
    const absoluteStart = Math.max(0, nominalStart);
    this.warnIfStartTimeMissed("chunk", nominalStart);
    const source = new AudioBufferSourceNode(this.audioContext, {
      buffer: pending.buffer,
    });
    // chunk buffers are stereo and already include channel volume/pan,
    // so connect directly to masterVolume (bypassing per-channel gainL/R).
    source.connect(this.masterVolume);
    source.onended = () => {
      pending.done = true;
      source.disconnect();
    };
    source.start(absoluteStart);
    pending.source = source;
  }

  updateChunkPipeline(lookAheadCheckTime: number): void {
    const state = this.chunkState;
    if (
      state.openChunk &&
      state.openChunk.chunkStart + this.segmentDuration <= lookAheadCheckTime
    ) {
      this.closeChunk(state);
    }
    state.pending = state.pending.filter((p) => !p.done);
    for (const pending of state.pending) {
      if (!pending.source && pending.bufferReady) {
        this.startPendingChunk(pending);
      }
    }
  }

  // Renders all notes from all channels within one chunk window into a
  // single stereo AudioBuffer. Unlike renderSegmentBuffer (which renders
  // one channel at a time and leaves volume/pan for real-time gainL/R),
  // this method:
  //   1. Creates one OfflineAudioContext for the whole chunk (stereo, 2 ch).
  //   2. For each note, creates a per-channel offlinePlayer seeded from
  //      the per-note channel snapshot (volume/pan/expression baked in).
  //   3. Wires each note's volumeNode → channel gainL/gainR → merger →
  //      offlineContext.destination so the stereo pan is baked correctly.
  //   4. Returns the resulting stereo buffer ready to feed masterVolume.
  async renderChunkBuffer(chunk: OpenChunk): Promise<AudioBuffer | null> {
    const notes = chunk.notes;
    if (notes.length === 0) return null;

    // Compute total duration across all notes in all channels.
    let totalDuration = 0;
    for (const n of notes) {
      const releaseEnd = n.voiceParams.volRelease * envelopeCurve * 5;
      const end = n.offset + n.noteDuration + releaseEnd;
      if (end > totalDuration) totalDuration = end;
    }
    if (totalDuration <= 0) return null;

    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );

    // Build a lightweight offlinePlayer that shares soundFont/cache data.
    // We need channel audio nodes wired to the offline destination, so we
    // create a full Player instance against the offline context but
    // immediately override suspend/resume so they don't throw.
    const allChannelNumbers = [...new Set(notes.map((n) => n.channelNumber))];
    const offlinePlayer = new (this.constructor as new (
      audioContext: AudioContext | OfflineAudioContext,
      options?: { activeChannelNumbers?: Iterable<number> },
    ) => Player<TNote, TChannel>)(
      offlineContext as unknown as AudioContext,
      { activeChannelNumbers: allChannelNumbers },
    );
    offlinePlayer.cacheMode = "none";
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    offlinePlayer.rawAudioBufferCache = this.rawAudioBufferCache;

    // Seed each channel from its per-note snapshot.  Multiple notes on the
    // same channel may carry different snapshots (if a CC event fell between
    // them); we seed once from the first note and let per-note event replay
    // (below) handle any intra-chunk CC changes on shared state correctly.
    // The appliedEvents dedup set below handles double-application just as
    // renderSegmentBuffer does.
    const seededChannels = new Set<number>();
    for (const n of notes) {
      const ch = n.channelNumber;
      if (seededChannels.has(ch)) continue;
      seededChannels.add(ch);
      const dstChannel = offlinePlayer.channels[ch];
      dstChannel.state.array.set(n.channelStateArray);
      dstChannel.isDrum = n.isDrum;
      dstChannel.programNumber = n.programNumber;
      dstChannel.modulationDepthRange = this.channels[ch].modulationDepthRange;
      dstChannel.detune = n.channelDetune;
      // Apply channel volume/pan/expression so the offline gainL/gainR
      // nodes are set correctly before any notes start.
      offlinePlayer.updateChannelVolume(dstChannel, 0);
    }

    // Pre-fetch raw sample buffers in parallel (same optimisation as
    // renderSegmentBuffer — avoids serialising decode latency).
    const prefetchTasks: Promise<unknown>[] = [];
    const seenAudioBufferIds = new Set<number>();
    for (const n of notes) {
      const id = n.audioBufferId !== undefined
        ? n.audioBufferId
        : offlinePlayer.getVoiceId(
          offlinePlayer.channels[n.channelNumber],
          n.noteNumber,
          n.velocity,
        );
      if (id === undefined || seenAudioBufferIds.has(id)) continue;
      seenAudioBufferIds.add(id);
      prefetchTasks.push(
        offlinePlayer.getRawAudioBuffer(id, n.voiceParams),
      );
    }
    if (prefetchTasks.length > 0) await Promise.all(prefetchTasks);

    // Same double-application guard as renderSegmentBuffer.
    const appliedEvents = new Set<TimelineEvent>();

    // Schedule all notes.
    const promises = notes.map((n) => {
      const dstChannel = offlinePlayer.channels[n.channelNumber];
      const preNote = offlinePlayer.createNoteInstance(
        n.noteNumber,
        n.velocity,
        n.offset,
      );
      preNote.voiceParams = n.voiceParams;
      preNote.voice = n.voice ?? null;
      preNote.audioBufferId = n.audioBufferId;
      return offlinePlayer.noteOnChannel(
        dstChannel,
        n.noteNumber,
        n.velocity,
        n.offset,
        preNote,
      );
    });
    const offlineNotes = await Promise.all(promises);

    // Replay per-note CC/pitchBend events and schedule noteOff.
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const offlineNote = offlineNotes[i] as TNote | undefined;
      const dstChannel = offlinePlayer.channels[n.channelNumber];
      const { startTime: noteStartTime = 0, events: noteEvents = [] } =
        n.noteEvent ?? {};
      for (const event of noteEvents) {
        if (appliedEvents.has(event)) continue;
        if (event.type === "programChange") continue;
        const t = (event.startTime as number) / this.tempo - noteStartTime;
        if (t < 0 || t > n.noteDuration) continue;
        appliedEvents.add(event);
        offlinePlayer.processTimelineEvent(event, n.offset + t, {
          channels: offlinePlayer.channels,
        });
      }
      // volumeNode is already connected to dstChannel.gainL/gainR (which
      // includes baked channel volume/pan), so no rewiring needed unlike
      // renderSegmentBuffer. The stereo mixer flows:
      //   volumeNode → gainL/gainR → merger → masterVolume (offline dest)
      if (offlineNote?.volumeNode) {
        // Already wired by noteOnChannel → setNoteRouting; nothing to do.
      }
      offlinePlayer.noteOffChannel(
        dstChannel,
        n.noteNumber,
        0,
        n.offset + n.noteDuration,
        true,
      );
    }
    await Promise.resolve();
    return await offlineContext.startRendering();
  }

  tryGetVoice(
    bank: number,
    programNumber: number,
    noteNumber: number,
    velocity: number,
  ): {
    voice: Voice;
    soundFontIndex: number;
    bank: number;
    programNumber: number;
  } | null {
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return null;
    const soundFontIndex = bankTable[bank];
    if (soundFontIndex === undefined) return null;
    const voice = this.soundFonts[soundFontIndex].getVoice(
      bank,
      programNumber,
      noteNumber,
      velocity,
    );
    if (!voice) return null;
    return { voice, soundFontIndex, bank, programNumber };
  }

  // GM instrument families are groups of 8 (0–7 Piano, 8–15 Chromatic, …).
  // Returns other programs in the same family, closest to `program` first.
  static gmFamilyCandidates(program: number): number[] {
    const base = program & ~7;
    const end = base + 7;
    const candidates: number[] = [];
    for (let dist = 1; dist <= 7; dist++) {
      const lo = program - dist;
      const hi = program + dist;
      if (lo >= base) candidates.push(lo);
      if (hi <= end) candidates.push(hi);
    }
    return candidates;
  }

  findFirstPresetVoice(
    noteNumber: number,
    velocity: number,
    drumOnly: boolean,
  ): {
    voice: Voice;
    soundFontIndex: number;
    bank: number;
    programNumber: number;
  } | null {
    for (let sfIndex = 0; sfIndex < this.soundFonts.length; sfIndex++) {
      const headers = this.soundFonts[sfIndex].parsed.presetHeaders;
      for (let i = 0; i < headers.length; i++) {
        const { preset, bank } = headers[i];
        if (drumOnly) {
          if (bank !== 128) continue;
        } else if (bank === 128) {
          continue;
        }
        const voice = this.soundFonts[sfIndex].getVoice(
          bank,
          preset,
          noteNumber,
          velocity,
        );
        if (voice) {
          return {
            voice,
            soundFontIndex: sfIndex,
            bank,
            programNumber: preset,
          };
        }
      }
    }
    return null;
  }

  // Fallback order (melodic):
  //   1. bank 0 + same program (GM)
  //   2. bank 0 + closest program in the same GM family of 8
  //   3. bank 0, program 0 (Acoustic Grand Piano)
  //   4. first melodic preset found across loaded soundfonts
  //   5. null (silence)
  // Fallback order (drum):
  //   1. bank 128 + program
  //   2. bank 128, program 0 (Standard Kit)
  //   3. first drum preset (bank 128) found across loaded soundfonts
  //   4. null (silence)
  resolveVoiceResult(
    channel: TChannel,
    noteNumber: number,
    velocity: number,
  ): {
    voice: Voice;
    soundFontIndex: number;
    bank: number;
    programNumber: number;
  } | null {
    const programNumber = channel.programNumber;
    if (channel.isDrum) {
      let result = this.tryGetVoice(128, programNumber, noteNumber, velocity);
      if (result) return result;
      if (programNumber !== 0) {
        result = this.tryGetVoice(128, 0, noteNumber, velocity);
        if (result) return result;
      }
      return this.findFirstPresetVoice(noteNumber, velocity, true);
    }

    let result = this.tryGetVoice(0, programNumber, noteNumber, velocity);
    if (result) return result;
    const family = Player.gmFamilyCandidates(programNumber);
    for (let i = 0; i < family.length; i++) {
      result = this.tryGetVoice(0, family[i], noteNumber, velocity);
      if (result) return result;
    }
    if (programNumber !== 0) {
      result = this.tryGetVoice(0, 0, noteNumber, velocity);
      if (result) return result;
    }
    return this.findFirstPresetVoice(noteNumber, velocity, false);
  }

  resolveVoice(
    channel: TChannel,
    noteNumber: number,
    velocity: number,
  ): Voice | null {
    return this.resolveVoiceResult(channel, noteNumber, velocity)?.voice ??
      null;
  }

  async render(): Promise<AudioBuffer | undefined> {
    if (this.isRendering) return;
    if (this.timeline.length === 0) return;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    this.isRendering = true;
    this.renderedAudioBuffer = null;
    this.dispatchEvent(new Event("rendering"));

    // Build a single OpenChunk covering the entire song, then delegate to
    // renderChunkBuffer() — the same path used by "chunk" mode's per-window
    // batching.  This replaces the old approach of calling
    // createFullRenderedBuffer() (= one OfflineAudioContext per note,
    // awaited serially) and then mixing the results into a second
    // OfflineAudioContext.  The new approach pays the OfflineAudioContext +
    // startRendering() setup cost exactly once regardless of note count,
    // and all raw-sample decodes are parallelised via the prefetch step
    // inside renderChunkBuffer().
    const settings = (this.constructor as typeof Player).channelSettings;
    const renderChannels = Array.from({ length: this.numChannels }, (_, ch) => {
      const channel = new Channel(ch, settings) as unknown as TChannel;
      channel.player = this;
      return channel;
    });
    renderChannels[9].isDrum = true;

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const notes: ChunkNoteEntry[] = [];

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const offset = event.startTime * inverseTempo + this.startDelay;
      this.processTimelineEvent(event, -1, {
        channels: renderChannels,
        onNoteOn: (renderChannel: TChannel, event: TimelineEvent) => {
          const noteEvent = this.noteOnEvents[i];
          const noteDuration = noteEvent?.duration ??
            this.noteOnDurations[i] ?? 0;
          if (noteDuration <= 0) return;
          const { noteNumber, velocity } = event;
          const voice = this.resolveVoice(
            renderChannel,
            noteNumber!,
            velocity!,
          );
          if (!voice) return;
          const voiceParams = voice.getAllParams(
            this.getControllerState(renderChannel, noteNumber!, velocity!, 0),
          );
          notes.push({
            channelNumber: renderChannel.channelNumber,
            offset,
            noteNumber: noteNumber!,
            velocity: velocity!,
            voiceParams,
            noteDuration,
            noteEvent,
            audioBufferId: this.noteAudioBufferIds[i],
            voice,
            channelDetune: renderChannel.detune,
            channelStateArray: renderChannel.state.array.slice(),
            programNumber: renderChannel.programNumber,
            isDrum: renderChannel.isDrum,
          });
        },
      });
    }
    const chunk: OpenChunk = { chunkStart: 0, notes };
    this.renderedAudioBuffer = await this.renderChunkBuffer(chunk);
    this.isRendering = false;
    this.dispatchEvent(new Event("rendered"));
    return this.renderedAudioBuffer ?? undefined;
  }

  async preloadSamples(): Promise<void> {
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    const entries = this.preloadEntries;
    const tasks: Promise<AudioBuffer>[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (this.rawAudioBufferCache.has(entry.audioBufferId)) continue;
      tasks.push(
        this.getRawAudioBuffer(entry.audioBufferId, entry.voiceParams),
      );
    }
    await Promise.all(tasks);
  }

  async start({ preload = true }: { preload?: boolean } = {}): Promise<void> {
    if (this.isPlaying) return;
    if (this.isPaused) {
      await this.resume();
      return;
    }
    this.resumeTime = 0;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    if (preload) await this.preloadSamples();
    this.playPromise = this.playNotes();
    await this.playPromise;
  }

  async stop(): Promise<void> {
    if (this.isPlaying) {
      this.isStopping = true;
      this.cancelScheduledTasks();
      await this.playPromise;
      return;
    }
    if (this.isPaused) {
      const now = this.audioContext.currentTime;
      await this.stopNotes(now);
      if (this.cacheMode === "segment") this.stopSegmentSources();
      if (this.cacheMode === "chunk") this.stopChunkSources();
      if (this.audioModeBufferSource) {
        try {
          this.audioModeBufferSource.stop();
        } catch { /* already stopped */ }
        this.audioModeBufferSource.disconnect();
        this.audioModeBufferSource = null;
      }
      this.resetAllStates();
      this.resumeTime = 0;
      this.isPaused = false;
      this.dispatchEvent(new Event("stopped"));
    }
  }

  async pause(): Promise<void> {
    if (!this.isPlaying || this.isPaused) return;
    const now = this.audioContext.currentTime;
    this.resumeTime = now + this.resumeTime - this.startTime;
    this.startTime = now;
    this.isPausing = true;
    this.cancelScheduledTasks();
    await this.playPromise;
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    if (this.isPlaying) return;
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    this.playPromise = this.playNotes();
    await this.playPromise;
  }

  seekTo(second: number): void {
    this.resumeTime = second;
    if (this.isPlaying) {
      this.isSeeking = true;
      this.cancelScheduledTasks();
    }
  }

  tempoChange(tempo: number): void {
    const cacheMode = this.cacheMode;
    const timeScale = this.tempo / tempo;
    this.resumeTime = this.resumeTime * timeScale;
    this.tempo = tempo;
    this.totalTime = this.calcTotalTime();
    this.seekTo(this.currentTime() * timeScale);
    if (
      cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio" ||
      cacheMode === "segment" || cacheMode === "chunk"
    ) {
      this.buildNoteOnDurations();
      this.fullVoiceCache.clear();
      this.adsrVoiceCache.clear();
    }
    if (cacheMode === "segment" || cacheMode === "chunk") {
      this.finalizeSegmentClassification();
    }
    if (cacheMode === "audio") {
      if (this.audioModeBufferSource) {
        this.audioModeBufferSource.playbackRate.setValueAtTime(
          this.tempo,
          this.audioContext.currentTime,
        );
      }
    }
    this.dispatchEvent(new Event("tempoChanged"));
  }

  calcTotalTime(): number {
    const totalTimeEventTypes = this.totalTimeEventTypes;
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    let totalTime = 0;
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      if (!totalTimeEventTypes.has(event.type)) continue;
      const t = event.startTime * inverseTempo;
      if (totalTime < t) totalTime = t;
    }
    return totalTime + this.startDelay;
  }

  currentTime(): number {
    if (!this.isPlaying) return this.resumeTime;
    const now = this.audioContext.currentTime;
    if (this.cacheMode === "audio") {
      return this.resumeTime + (now - this.startTime) * this.tempo;
    }
    return now + this.resumeTime - this.startTime;
  }

  rateToCent(rate: number): number {
    return 1200 * Math.log2(rate);
  }

  centToRate(cent: number): number {
    return Math.pow(2, cent / 1200);
  }

  centToHz(cent: number): number {
    return 8.176 * this.centToRate(cent);
  }

  calcChannelDetune(channel: TChannel): number {
    const pitchWheel = channel.state.pitchWheel * 2 - 1;
    const pitchWheelSensitivity = channel.state.pitchWheelSensitivity * 12800;
    return pitchWheel * pitchWheelSensitivity;
  }

  updateChannelDetune(channel: TChannel, scheduleTime: number): void {
    channel.processScheduledNotes((note) => {
      if (note.renderedBuffer?.isFull || note.isSegmentGhost) return;
      this.setDetune(channel, note, scheduleTime);
    });
  }

  calcNoteDetune(channel: TChannel, note: TNote): number {
    return channel.detune + (note.voiceParams?.detune || 0);
  }

  setVolumeEnvelope(
    _channel: TChannel,
    note: TNote,
    scheduleTime: number,
  ): void {
    if (!note.volumeEnvelopeNode) return;
    const { voiceParams, startTime } = note;
    if (!voiceParams) return;
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume *
      cbToRatio(-1000 * voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(0, startTime)
      .setValueAtTime(1e-6, volDelay)
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .exponentialRampToValueAtTime(sustainVolume, volHold + decayDuration);
  }

  setDetune(channel: TChannel, note: TNote, scheduleTime: number): void {
    const detune = this.calcNoteDetune(channel, note);
    const timeConstant = this.perceptualSmoothingTime / 5;
    (note.bufferSource as AudioBufferSourceNode).detune
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(detune, scheduleTime, timeConstant);
  }

  setPitchEnvelope(note: TNote, scheduleTime: number): void {
    const { bufferSource, voiceParams } = note;
    if (!voiceParams || !bufferSource) return;
    const baseRate = voiceParams.playbackRate;
    bufferSource.playbackRate
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(baseRate, scheduleTime);
    const modEnvToPitch = voiceParams.modEnvToPitch;
    if (modEnvToPitch === 0) return;
    const peekRate = baseRate * this.centToRate(modEnvToPitch);
    const sustainRate = baseRate *
      this.centToRate(modEnvToPitch * (1 - voiceParams.modSustain));
    const modDelay = note.startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const decayDuration = voiceParams.modDecay;
    bufferSource.playbackRate
      .setValueAtTime(baseRate, modDelay)
      .exponentialRampToValueAtTime(peekRate, modAttack)
      .setValueAtTime(peekRate, modHold)
      .exponentialRampToValueAtTime(sustainRate, modHold + decayDuration);
  }

  clampCutoffFrequency(frequency: number): number {
    const minFrequency = 20;
    const maxFrequency = 20000;
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
  }

  setFilterEnvelope(
    _channel: TChannel,
    note: TNote,
    scheduleTime: number,
  ): void {
    if (!note.filterEnvelopeNode) return;
    const { voiceParams, startTime } = note;
    if (!voiceParams) return;
    const modEnvToFilterFc = voiceParams.modEnvToFilterFc;
    const baseCent = voiceParams.initialFilterFc;
    const peekCent = baseCent + modEnvToFilterFc;
    const sustainCent = baseCent +
      modEnvToFilterFc * (1 - voiceParams.modSustain);
    const baseFreq = this.centToHz(baseCent);
    const peekFreq = this.centToHz(peekCent);
    const sustainFreq = this.centToHz(sustainCent);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedPeekFreq = this.clampCutoffFrequency(peekFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const modDelay = startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const decayDuration = voiceParams.modDecay;
    note.adjustedBaseFreq = adjustedBaseFreq;
    note.filterEnvelopeNode.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .exponentialRampToValueAtTime(adjustedPeekFreq, modAttack)
      .setValueAtTime(adjustedPeekFreq, modHold)
      .exponentialRampToValueAtTime(
        adjustedSustainFreq,
        modHold + decayDuration,
      );
  }

  startModulation(channel: TChannel, note: TNote, scheduleTime: number): void {
    const audioContext = this.audioContext;
    const { voiceParams } = note;
    if (!voiceParams) return;
    note.modLfo = new OscillatorNode(audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO),
    });
    note.modLfoToPitch = new GainNode(audioContext);
    note.modLfoToVolume = new GainNode(audioContext);
    if (note.filterEnvelopeNode) {
      note.modLfoToFilterFc = new GainNode(audioContext, {
        gain: voiceParams.modLfoToFilterFc,
      });
    } else {
      note.modLfoToFilterFc = null;
    }
    this.setModLfoToPitch(channel, note, scheduleTime);
    this.setModLfoToVolume(channel, note, scheduleTime);

    note.modLfo!.start(note.startTime + voiceParams.delayModLFO);
    if (note.modLfoToFilterFc) {
      note.modLfo!.connect(note.modLfoToFilterFc);
      note.modLfoToFilterFc.connect(note.filterEnvelopeNode!.frequency);
    }
    note.modLfo!.connect(note.modLfoToPitch);
    note.modLfoToPitch.connect(note.bufferSource!.detune);
    note.modLfo!.connect(note.modLfoToVolume);
    const volumeTarget = note.volumeEnvelopeNode ?? note.volumeNode;
    if (volumeTarget) note.modLfoToVolume.connect(volumeTarget.gain);
  }

  async createAdsRenderedBuffer(
    _channel: TChannel,
    note: TNote,
    voiceParams: VoiceParams,
    audioBuffer: AudioBuffer,
    isDrum = false,
  ): Promise<RenderedBuffer> {
    const isLoop = isDrum ? false : (voiceParams.sampleModes % 2 !== 0);
    const volAttack = voiceParams.volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    const adsDuration = volHold + decayDuration;
    const sampleLoopStart = voiceParams.loopStart / voiceParams.sampleRate;
    const sampleLoopDuration = isLoop
      ? (voiceParams.loopEnd - voiceParams.loopStart) / voiceParams.sampleRate
      : 0;
    const playbackRate = voiceParams.playbackRate;
    const outputLoopStart = sampleLoopStart / playbackRate;
    const outputLoopDuration = sampleLoopDuration / playbackRate;
    const loopCount = isLoop && adsDuration > outputLoopStart
      ? Math.ceil((adsDuration - outputLoopStart) / outputLoopDuration)
      : 0;
    const alignedLoopStart = outputLoopStart + loopCount * outputLoopDuration;
    const renderDuration = isLoop
      ? alignedLoopStart + outputLoopDuration
      : audioBuffer.duration / playbackRate;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      Math.ceil(renderDuration * sampleRate),
      sampleRate,
    );
    const bufferSource = new AudioBufferSourceNode(offlineContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.playbackRate.value = playbackRate;
    bufferSource.loop = isLoop;
    if (isLoop) {
      bufferSource.loopStart = sampleLoopStart;
      bufferSource.loopEnd = sampleLoopStart + sampleLoopDuration;
    }
    const initialFreq = this.clampCutoffFrequency(
      this.centToHz(voiceParams.initialFilterFc),
    );
    const filterIsAudible = voiceParams.modEnvToFilterFc !== 0 ||
      voiceParams.initialFilterFc < FULLY_OPEN_FILTER_CENTS;
    const filterEnvelopeNode = filterIsAudible
      ? new BiquadFilterNode(offlineContext, {
        type: "lowpass",
        Q: voiceParams.initialFilterQ / 10,
        frequency: initialFreq,
      })
      : null;
    const volumeEnvelopeNode = new GainNode(offlineContext);
    const offlineNote = Object.assign(
      new Note(note.noteNumber, note.velocity, 0),
      {
        voiceParams: note.voiceParams,
        filterEnvelopeNode,
        volumeEnvelopeNode,
        adjustedBaseFreq: note.adjustedBaseFreq,
      },
    ) as unknown as TNote;
    this.setVolumeEnvelope(_channel, offlineNote, 0);
    if (filterEnvelopeNode) {
      this.setFilterEnvelope(_channel, offlineNote, 0);
      bufferSource.connect(filterEnvelopeNode);
      filterEnvelopeNode.connect(volumeEnvelopeNode);
    } else {
      bufferSource.connect(volumeEnvelopeNode);
    }
    volumeEnvelopeNode.connect(offlineContext.destination);
    if (voiceParams.sample.type === "compressed") {
      bufferSource.start(0, voiceParams.start / audioBuffer.sampleRate);
    } else {
      bufferSource.start(0);
    }
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop,
      adsDuration,
      loopStart: alignedLoopStart,
      loopDuration: outputLoopDuration,
    });
  }

  async createAdsrRenderedBuffer(
    _channel: TChannel,
    note: TNote,
    voiceParams: VoiceParams,
    audioBuffer: AudioBuffer,
    noteDuration: number,
    isDrum = false,
  ): Promise<RenderedBuffer> {
    const isLoop = isDrum ? false : (voiceParams.sampleModes % 2 !== 0);
    const volAttack = voiceParams.volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    const adsDuration = volHold + decayDuration;
    const releaseDuration = voiceParams.volRelease;
    const loopStartTime = voiceParams.loopStart / voiceParams.sampleRate;
    const loopDuration = isLoop
      ? (voiceParams.loopEnd - voiceParams.loopStart) / voiceParams.sampleRate
      : 0;
    const noteLoopCount = isLoop && noteDuration > loopStartTime
      ? Math.ceil((noteDuration - loopStartTime) / loopDuration)
      : 0;
    const alignedNoteEnd = isLoop
      ? loopStartTime + noteLoopCount * loopDuration
      : noteDuration;
    const noteOffTime = alignedNoteEnd;
    const totalDuration = noteOffTime + releaseDuration;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const bufferSource = new AudioBufferSourceNode(offlineContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.playbackRate.value = voiceParams.playbackRate;
    bufferSource.loop = isLoop;
    if (isLoop) {
      bufferSource.loopStart = loopStartTime;
      bufferSource.loopEnd = loopStartTime + loopDuration;
    }
    const initialFreq = this.clampCutoffFrequency(
      this.centToHz(voiceParams.initialFilterFc),
    );
    const filterIsAudible = voiceParams.modEnvToFilterFc !== 0 ||
      voiceParams.initialFilterFc < FULLY_OPEN_FILTER_CENTS;
    const filterEnvelopeNode = filterIsAudible
      ? new BiquadFilterNode(offlineContext, {
        type: "lowpass",
        Q: voiceParams.initialFilterQ / 10,
        frequency: initialFreq,
      })
      : null;
    const volumeEnvelopeNode = new GainNode(offlineContext);
    const offlineNote = Object.assign(
      new Note(note.noteNumber, note.velocity, 0),
      {
        voiceParams: note.voiceParams,
        filterEnvelopeNode,
        volumeEnvelopeNode,
        adjustedBaseFreq: note.adjustedBaseFreq,
      },
    ) as unknown as TNote;
    this.setVolumeEnvelope(_channel, offlineNote, 0);
    this.setFilterEnvelope(_channel, offlineNote, 0);

    const attackVolume = cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume *
      cbToRatio(-1000 * voiceParams.volSustain);
    const volDelayTime = voiceParams.volDelay;
    const volAttackTime = volDelayTime + voiceParams.volAttack;
    const volHoldTime = volAttackTime + voiceParams.volHold;
    let gainAtNoteOff;
    if (noteOffTime <= volDelayTime) {
      gainAtNoteOff = 0;
    } else if (noteOffTime <= volAttackTime) {
      gainAtNoteOff = 1e-6 + (attackVolume - 1e-6) *
          (noteOffTime - volDelayTime) / voiceParams.volAttack;
    } else if (noteOffTime <= volHoldTime) {
      gainAtNoteOff = attackVolume;
    } else if (noteOffTime <= volHoldTime + voiceParams.volDecay) {
      const decayFraction = (noteOffTime - volHoldTime) / voiceParams.volDecay;
      gainAtNoteOff = attackVolume *
        Math.pow(sustainVolume / attackVolume, decayFraction);
    } else {
      gainAtNoteOff = sustainVolume;
    }
    volumeEnvelopeNode.gain
      .cancelScheduledValues(noteOffTime)
      .setValueAtTime(gainAtNoteOff, noteOffTime)
      .setTargetAtTime(0, noteOffTime, releaseDuration * envelopeCurve);
    if (filterEnvelopeNode) {
      const modEnvToFilterFc = voiceParams.modEnvToFilterFc;
      const peekFreq = this.clampCutoffFrequency(
        this.centToHz(voiceParams.initialFilterFc + modEnvToFilterFc),
      );
      const sustainFreq = this.clampCutoffFrequency(
        this.centToHz(
          voiceParams.initialFilterFc +
            modEnvToFilterFc * (1 - voiceParams.modSustain),
        ),
      );
      const modDelayTime = voiceParams.modDelay;
      const modAttackTime = modDelayTime + voiceParams.modAttack;
      const modHoldTime = modAttackTime + voiceParams.modHold;
      let freqAtNoteOff;
      if (noteOffTime <= modDelayTime) {
        freqAtNoteOff = initialFreq;
      } else if (noteOffTime <= modAttackTime) {
        freqAtNoteOff = initialFreq + (peekFreq - initialFreq) *
            (noteOffTime - modDelayTime) / voiceParams.modAttack;
      } else if (noteOffTime <= modHoldTime) {
        freqAtNoteOff = peekFreq;
      } else if (noteOffTime <= modHoldTime + voiceParams.modDecay) {
        const decayFraction = (noteOffTime - modHoldTime) /
          voiceParams.modDecay;
        freqAtNoteOff = peekFreq *
          Math.pow(sustainFreq / peekFreq, decayFraction);
      } else {
        freqAtNoteOff = sustainFreq;
      }
      filterEnvelopeNode.frequency
        .cancelScheduledValues(noteOffTime)
        .setValueAtTime(freqAtNoteOff, noteOffTime)
        .exponentialRampToValueAtTime(
          initialFreq,
          noteOffTime + voiceParams.modRelease,
        );
    }

    if (filterEnvelopeNode) {
      bufferSource.connect(filterEnvelopeNode);
      filterEnvelopeNode.connect(volumeEnvelopeNode);
    } else {
      bufferSource.connect(volumeEnvelopeNode);
    }
    volumeEnvelopeNode.connect(offlineContext.destination);
    // Match createAdsRenderedBuffer: compressed samples keep the full
    // decoded buffer, so the SF2 start offset must be applied here. PCM
    // samples are already sliced to [start, end) in createAudioBuffer.
    if (voiceParams.sample.type === "compressed") {
      bufferSource.start(0, voiceParams.start / audioBuffer.sampleRate);
    } else {
      bufferSource.start(0);
    }
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop: false,
      isFull: false,
      adsDuration,
      noteDuration: noteOffTime,
      releaseDuration,
    });
  }

  // "segment" / "chunk" mode: combine the voiceParams resolved during cacheVoiceIds()
  // (at the correct point in program-change order) with noteOnDurations
  // (which needs its own full-timeline pass and isn't ready until after
  // that loop) to decide which notes are safe to bake into a segment/chunk.
  // Notes that ring too long, or that participate in an exclusive class
  // (hi-hat choke groups etc.), are left out so they keep going through
  // normal per-note real-time ("ads"-style) scheduling instead — that
  // path is the only way to cut a note off early once it has started.
  // Cheap (no voice resolution), so tempoChange() can call this again
  // after buildNoteOnDurations() without redoing the full classification.

  finalizeSegmentClassification(): void {
    const { noteOnDurations, segmentVoiceParams } = this;
    const bakedSet = new Set<number>();
    for (let i = 0; i < segmentVoiceParams.length; i++) {
      const voiceParams = segmentVoiceParams[i];
      if (!voiceParams) continue;
      if ((voiceParams.exclusiveClass ?? 0) !== 0) continue;
      const duration = noteOnDurations[i] ?? 0;
      const releaseTail = voiceParams.volRelease * envelopeCurve * 5;
      if (this.maxSegmentNoteDuration < duration + releaseTail) continue;
      bakedSet.add(i);
    }
    this.segmentBakedSet = bakedSet;
  }

  // Bakes an entire segment (all notes queued for one channel within
  // segmentDuration seconds) into a single AudioBuffer using exactly one
  // OfflineAudioContext / startRendering() call, instead of one offline
  // context per note followed by a manual JS mixdown. Each note still gets
  // its own full envelope/pitch-bend/LFO/CC#1 bake (same fidelity as
  // "note" mode), but all notes share one offline render graph and are
  // simply scheduled at their respective offsets within it — the audio
  // graph itself does the mixing instead of a JS sample-accumulation loop.
  // TChannel volume/pan/expression are intentionally NOT baked in (same as
  // before): each note's volumeNode is rewired to bypass the channel bus
  // and connect straight to the offline destination, so the combined
  // segment buffer stays mixable through the real channel.gainL/gainR in
  // real time.
  async renderSegmentBuffer(
    channel: TChannel,
    segment: OpenSegment,
  ): Promise<AudioBuffer | null> {
    const notes = segment.notes;
    if (notes.length === 0) return null;
    let totalDuration = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const releaseEndDuration = n.voiceParams.volRelease * envelopeCurve * 5;
      const end = n.offset + n.noteDuration + releaseEndDuration;
      if (end > totalDuration) totalDuration = end;
    }
    if (totalDuration <= 0) return null;
    const ch = channel.channelNumber;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      1,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const offlinePlayer = new (this.constructor as new (
      audioContext: AudioContext | OfflineAudioContext,
      options?: { activeChannelNumbers?: Iterable<number> },
    ) => Player<TNote, TChannel>)(
      offlineContext as unknown as AudioContext,
      { activeChannelNumbers: [ch] },
    );
    offlinePlayer.cacheMode = "none";
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    offlinePlayer.rawAudioBufferCache = this.rawAudioBufferCache;
    const dstChannel = offlinePlayer.channels[ch];
    // Seed from the snapshot taken when this segment opened, not from the
    // channel's current state — by the time closeSegment()/renderSegmentBuffer()
    // run, the realtime channel has already had every event in this segment
    // applied to it by scheduleTimelineEvents. Replaying those same events
    // (via noteEvents below) on top of the post-segment value would double-
    // apply them. See OpenSegment.channelDetune/channelStateArray doc comment.
    dstChannel.state.array.set(segment.channelStateArray);
    dstChannel.isDrum = channel.isDrum;
    dstChannel.programNumber = segment.programNumber;
    dstChannel.modulationDepthRange = channel.modulationDepthRange;
    dstChannel.detune = segment.channelDetune;

    // Pre-fetch every note's raw sample buffer in parallel first. Without
    // this, the scheduling loop below awaits noteOnChannel -> ... ->
    // getRawAudioBuffer one note at a time, and any not-yet-decoded
    // compressed sample (decodeAudioData / wasm OGG decode) serializes its
    // real decode latency into the loop. That delay pushes back when
    // startRendering() finally runs, which can push the segment's
    // bufferReady time past its scheduled absoluteStart and make it play
    // late/at the wrong time instead of on the beat. Pre-warming
    // rawAudioBufferCache (shared with the realtime player) means every
    // getRawAudioBuffer() call inside the loop below resolves from cache
    // synchronously-ish (already-resolved promise), so the loop's awaits
    // no longer wait on real decode work.
    const prefetchTasks: Promise<unknown>[] = [];
    const seenAudioBufferIds = new Set<number>();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const audioBufferId = n.audioBufferId !== undefined
        ? n.audioBufferId
        : offlinePlayer.getVoiceId(dstChannel, n.noteNumber, n.velocity);
      if (
        audioBufferId === undefined || seenAudioBufferIds.has(audioBufferId)
      ) {
        continue;
      }
      seenAudioBufferIds.add(audioBufferId);
      prefetchTasks.push(
        offlinePlayer.getRawAudioBuffer(audioBufferId, n.voiceParams),
      );
    }
    if (prefetchTasks.length > 0) await Promise.all(prefetchTasks);

    // buildNoteOnDurations() assigns each note's noteEvents by registering
    // every CC/pitchBend/etc TimelineEvent that occurs while that note is
    // active. When notes overlap in time (chords, legato, or one note's
    // release tail still ringing as the next note starts), the SAME event
    // object gets registered into multiple notes' noteEvents arrays — by
    // design, since each note independently needs to know about it. That's
    // harmless when every note renders in its own isolated offline context
    // (as "note" mode does), but here every note in the segment shares one
    // dstChannel, so applying the same pitchBend event twice (once per
    // note that references it) double-applies channel.setPitchBend's `+=`
    // accumulation onto the shared channel.detune, corrupting pitch for
    // every later note in the segment. Track already-applied event objects
    // by identity and skip them on subsequent notes.
    const appliedEvents = new Set<TimelineEvent>();

    const promises = new Array(notes.length);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const preNote = offlinePlayer.createNoteInstance(
        n.noteNumber,
        n.velocity,
        n.offset,
      );
      preNote.voiceParams = n.voiceParams;
      preNote.voice = n.voice ?? null;
      preNote.audioBufferId = n.audioBufferId;
      promises[i] = offlinePlayer.noteOnChannel(
        dstChannel,
        n.noteNumber,
        n.velocity,
        n.offset,
        preNote,
      );
    }
    const offlineNotes = await Promise.all(promises);

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const offlineNote = offlineNotes[i] as TNote | undefined;
      if (offlineNote?.volumeNode) {
        offlineNote.volumeNode.disconnect();
        offlineNote.volumeNode.connect(offlineContext.destination);
      }
      const { startTime: noteStartTime = 0, events: noteEvents = [] } =
        n.noteEvent ?? {};
      for (let j = 0; j < noteEvents.length; j++) {
        const event = noteEvents[j];
        if (appliedEvents.has(event)) continue;
        if (event.type === "programChange") continue;
        const t = (event.startTime as number) / this.tempo - noteStartTime;
        if (t < 0 || t > n.noteDuration) continue;
        appliedEvents.add(event);
        offlinePlayer.processTimelineEvent(event, n.offset + t, {
          channels: offlinePlayer.channels,
        });
      }
      // Don't await this: noteOffChannel()'s returned promise resolves
      // inside releaseNote() via bufferSource.onended, but onended can
      // only fire once the OfflineAudioContext actually renders audio —
      // i.e. after startRendering() runs, below. Awaiting it here would
      // deadlock forever (nothing ever calls startRendering() to make it
      // resolve), silently killing the whole segment. The stop()/gain
      // automation that releaseNote() schedules happens synchronously
      // (off note.ready, which is already resolved since noteOnChannel
      // above was awaited), so the scheduling itself is correct without
      // waiting for onended; we just need it to have run by the time
      // startRendering() is called, which the microtask flush below
      // guarantees.
      offlinePlayer.noteOffChannel(
        dstChannel,
        n.noteNumber,
        0,
        n.offset + n.noteDuration,
        true,
      );
    }
    // Let the note.ready.then(...) microtasks queued by noteOffChannel
    // above actually run (and call releaseNote synchronously) before
    // rendering starts.
    await Promise.resolve();
    return await offlineContext.startRendering();
  }

  async createFullRenderedBuffer(
    channel: TChannel,
    note: { noteNumber: number; velocity: number },
    voiceParams: VoiceParams,
    noteDuration: number,
    noteEvent: NoteOnEventEntry | undefined = undefined,
  ): Promise<RenderedBuffer> {
    const { startTime: noteStartTime = 0, events: noteEvents = [] } =
      noteEvent ?? {};
    const ch = channel.channelNumber;
    const releaseEndDuration = voiceParams.volRelease * envelopeCurve * 5;
    const totalDuration = noteDuration + releaseEndDuration;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const offlinePlayer = new (this.constructor as new (
      audioContext: AudioContext | OfflineAudioContext,
      options?: { activeChannelNumbers?: Iterable<number> },
    ) => Player<TNote, TChannel>)(
      offlineContext as unknown as AudioContext,
      { activeChannelNumbers: [ch] },
    );
    offlinePlayer.cacheMode = "none";
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    offlinePlayer.rawAudioBufferCache = this.rawAudioBufferCache;
    const dstChannel = offlinePlayer.channels[ch];
    dstChannel.state.array.set(channel.state.array);
    dstChannel.isDrum = channel.isDrum;
    dstChannel.programNumber = channel.programNumber;
    dstChannel.modulationDepthRange = channel.modulationDepthRange;
    dstChannel.detune = channel.detune;
    offlinePlayer.updateChannelVolume(dstChannel, 0);
    await offlinePlayer.noteOnChannel(
      dstChannel,
      note.noteNumber,
      note.velocity,
      0,
    );
    for (let i = 0; i < noteEvents.length; i++) {
      const event = noteEvents[i];
      const t = (event.startTime as number) / this.tempo - noteStartTime;
      if (t < 0 || t > noteDuration) continue;
      offlinePlayer.processTimelineEvent(event, t, {
        channels: offlinePlayer.channels,
      });
    }
    offlinePlayer.noteOffChannel(
      dstChannel,
      note.noteNumber,
      0,
      noteDuration,
      true,
    );
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop: false,
      isFull: true,
      noteDuration,
      releaseDuration: releaseEndDuration,
    });
  }

  async getAudioBuffer(
    channel: TChannel,
    note: TNote,
    realtime: boolean,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    const cacheMode = this.cacheMode;
    const { noteNumber, velocity } = note;
    const audioBufferId = note.audioBufferId !== undefined
      ? note.audioBufferId
      : this.getVoiceId(channel, noteNumber, velocity);
    if (!realtime) {
      if (cacheMode === "note") {
        return await this.getFullCachedBuffer(channel, note, audioBufferId);
      } else if (cacheMode === "adsr") {
        return await this.getAdsrCachedBuffer(channel, note, audioBufferId);
      }
    }
    if (cacheMode === "none") {
      if (!audioBufferId) {
        return await this.createAudioBuffer(note.voiceParams as VoiceParams);
      }
      return await this.getRawAudioBuffer(
        audioBufferId,
        note.voiceParams as VoiceParams,
      );
    }
    // fallback to ADS cache:
    // - "ads" (realtime or not)
    // - "adsr" + realtime
    // - "note" + realtime
    return await this.getAdsCachedBuffer(
      channel,
      note,
      audioBufferId,
      realtime,
    );
  }

  async getAdsCachedBuffer(
    channel: TChannel,
    note: TNote,
    audioBufferId: number | undefined,
    realtime: boolean,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    if (!audioBufferId) return undefined;
    const cacheKey = audioBufferId + (note.noteNumber << 1) + 1;
    const voiceParams = note.voiceParams;
    if (!voiceParams) return undefined;
    if (realtime) {
      const cached = this.realtimeVoiceCache.get(cacheKey);
      if (cached) return cached;
      const rawBuffer = await this.getRawAudioBuffer(
        audioBufferId,
        voiceParams,
      );
      const rendered = await this.createAdsRenderedBuffer(
        channel,
        note,
        voiceParams,
        rawBuffer,
        channel.isDrum,
      );
      this.realtimeVoiceCache.set(cacheKey, rendered);
      return rendered;
    } else {
      const cache = this.voiceCache.get(cacheKey);
      if (cache) {
        cache.counter += 1;
        if (cache.maxCount <= cache.counter) {
          this.voiceCache.delete(cacheKey);
        }
        return cache.audioBuffer;
      } else {
        const maxCount = this.voiceCounter.get(cacheKey) ?? 0;
        const rawBuffer = await this.getRawAudioBuffer(
          audioBufferId,
          voiceParams,
        );
        const rendered = await this.createAdsRenderedBuffer(
          channel,
          note,
          voiceParams,
          rawBuffer,
          channel.isDrum,
        );
        const cache = { audioBuffer: rendered, maxCount, counter: 1 };
        this.voiceCache.set(cacheKey, cache);
        return rendered;
      }
    }
  }

  async getAdsrCachedBuffer(
    channel: TChannel,
    note: TNote,
    audioBufferId: number | undefined,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    if (!audioBufferId) return undefined;
    const voiceParams = note.voiceParams;
    if (!voiceParams) return undefined;
    const timelineIndex = note.timelineIndex;
    if (timelineIndex === null) return undefined;
    const noteEvent = this.noteOnEvents[timelineIndex];
    const noteDurationTicks = noteEvent?.durationTicks ?? 0;
    const safeTicks = noteDurationTicks === Infinity
      ? 0xFFFFFFFFn
      : BigInt(noteDurationTicks);
    const volReleaseBits = f64ToBigInt(voiceParams.volRelease);
    const playbackRateBits = f64ToBigInt(voiceParams.playbackRate);
    const cacheKey = (BigInt(audioBufferId) << 160n) |
      (playbackRateBits << 96n) |
      (safeTicks << 64n) |
      volReleaseBits;
    let durationMap = this.adsrVoiceCache.get(audioBufferId);
    if (!durationMap) {
      durationMap = new Map();
      this.adsrVoiceCache.set(audioBufferId, durationMap);
    }
    const cached = durationMap.get(cacheKey);
    if (cached instanceof RenderedBuffer) {
      return cached;
    }
    if (cached instanceof Promise) {
      return await cached;
    }
    const noteDuration = noteEvent?.duration ?? 0;
    const renderPromise = (async () => {
      try {
        const rawBuffer = await this.getRawAudioBuffer(
          audioBufferId!,
          voiceParams,
        );
        const rendered = await this.createAdsrRenderedBuffer(
          channel,
          note,
          voiceParams,
          rawBuffer,
          noteDuration,
          channel.isDrum,
        );
        durationMap!.set(cacheKey, rendered);
        return rendered;
      } catch (err) {
        durationMap!.delete(cacheKey);
        throw err;
      }
    })();
    durationMap.set(cacheKey, renderPromise);
    return await renderPromise;
  }

  async getFullCachedBuffer(
    channel: TChannel,
    note: TNote,
    audioBufferId: number | undefined,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    if (!audioBufferId) return undefined;
    const voiceParams = note.voiceParams;
    if (!voiceParams) return undefined;
    const timelineIndex = note.timelineIndex;
    if (!timelineIndex) return undefined;
    const noteEvent = this.noteOnEvents[timelineIndex];
    const noteDuration = noteEvent?.duration ?? 0;
    const cacheKey = timelineIndex;
    let durationMap = this.fullVoiceCache.get(audioBufferId);
    if (!durationMap) {
      durationMap = new Map();
      this.fullVoiceCache.set(audioBufferId, durationMap);
    }
    const cached = durationMap.get(cacheKey);
    if (cached instanceof RenderedBuffer) {
      note.fullCacheVoiceId = audioBufferId;
      return cached;
    }
    if (cached instanceof Promise) {
      const buf = await cached;
      if (buf == null) return await this.createAudioBuffer(voiceParams);
      note.fullCacheVoiceId = audioBufferId;
      return buf;
    }
    const renderPromise = (async () => {
      try {
        const rendered = await this.createFullRenderedBuffer(
          channel,
          { noteNumber: note.noteNumber, velocity: note.velocity },
          voiceParams,
          noteDuration,
          noteEvent,
        );
        durationMap!.set(cacheKey, rendered);
        return rendered;
      } catch (err) {
        durationMap!.delete(cacheKey);
        throw err;
      }
    })();
    durationMap.set(cacheKey, renderPromise);
    const rendered = await renderPromise;
    note.fullCacheVoiceId = audioBufferId;
    return rendered;
  }

  async setNoteAudioNode(
    channel: TChannel,
    note: TNote,
    realtime: boolean,
  ): Promise<void> {
    const audioContext = this.audioContext;
    const now = audioContext.currentTime;
    const { noteNumber, velocity, startTime } = note;
    const state = channel.state;
    const controllerState = this.getControllerState(
      channel,
      noteNumber,
      velocity,
      note.pressure,
    );
    const voiceParams = note.voiceParams ??
      note.voice?.getAllParams(controllerState) ?? null;
    note.voiceParams = voiceParams;
    if (!voiceParams) return;
    if (note.isSegmentGhost) {
      // No real bufferSource/volumeNode is created: this note's sound
      // comes from the combined segment buffer, baked and scheduled
      // separately by the segment pipeline (appendToSegmentQueue /
      // closeSegment / renderSegmentBuffer). This note object only exists
      // so activeNotes/FIFO noteOff matching stays correct relative to
      // any fallback (non-segment) notes on the same channel.
      return;
    }

    const audioBuffer = await this.getAudioBuffer(channel, note, realtime);
    // If pause()/stop() interrupts during preparation, abort without creating a node.
    if (note.ending || !audioBuffer) return;
    const isRendered = audioBuffer instanceof RenderedBuffer;
    note.renderedBuffer = isRendered ? audioBuffer : null;
    note.bufferSource = this.createBufferSource(
      channel,
      note.noteNumber,
      voiceParams,
      audioBuffer as RenderedBuffer | AudioBuffer,
    );
    note.volumeNode = new GainNode(audioContext);

    const cacheMode = this.cacheMode;
    const isFullCached = isRendered &&
      (audioBuffer as RenderedBuffer).isFull === true;
    if (cacheMode === "none") {
      note.volumeEnvelopeNode = new GainNode(audioContext);
      const filterIsAudible = voiceParams.modEnvToFilterFc !== 0 ||
        voiceParams.initialFilterFc < FULLY_OPEN_FILTER_CENTS;
      note.filterEnvelopeNode = filterIsAudible
        ? new BiquadFilterNode(audioContext, {
          type: "lowpass",
          Q: voiceParams.initialFilterQ / 10,
        })
        : null;
      this.setVolumeEnvelope(channel, note, now);
      if (note.filterEnvelopeNode) this.setFilterEnvelope(channel, note, now);
      this.setPitchEnvelope(note, now);
      this.setDetune(channel, note, now);
      const modLfoIsAudible = voiceParams.modLfoToPitch !== 0 ||
        voiceParams.modLfoToFilterFc !== 0 ||
        voiceParams.modLfoToVolume !== 0;
      if (modLfoIsAudible && 0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      if (note.filterEnvelopeNode) {
        note.bufferSource.connect(note.filterEnvelopeNode);
        note.filterEnvelopeNode.connect(note.volumeEnvelopeNode);
      } else {
        note.bufferSource.connect(note.volumeEnvelopeNode);
      }
      note.volumeEnvelopeNode.connect(note.volumeNode);
    } else if (isFullCached) { // "note" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      note.bufferSource.connect(note.volumeNode);
    } else { // "ads" / "adsr" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      this.setDetune(channel, note, now);
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      note.bufferSource.connect(note.volumeNode);
    }
    if (!realtime) {
      this.warnIfStartTimeMissed(
        `note (channel ${channel.channelNumber}, note ${note.noteNumber})`,
        startTime,
      );
    }
    if (!isRendered && voiceParams.sample.type === "compressed") {
      note.bufferSource.start(
        startTime,
        voiceParams.start / (audioBuffer as AudioBuffer).sampleRate,
      );
    } else {
      note.bufferSource.start(startTime);
    }
  }

  handleExclusiveClass(
    note: TNote,
    channel: TChannel,
    startTime: number,
  ): void {
    const exclusiveClass = note.voiceParams?.exclusiveClass ?? 0;
    if (exclusiveClass === 0) return;
    const prev = this.exclusiveClassNotes[exclusiveClass];
    if (prev) {
      const [prevNote, prevChannel] = prev;
      if (prevNote && !prevNote.ending) {
        prevChannel.noteOff(prevNote.noteNumber, 0, startTime, true);
      }
    }
    this.exclusiveClassNotes[exclusiveClass] = [note, channel];
  }

  handleDrumExclusiveClass(
    note: TNote,
    channel: TChannel,
    startTime: number,
  ): void {
    if (!channel.isDrum) return;
    const drumExclusiveClass = this.drumExclusiveClasses[note.noteNumber];
    if (drumExclusiveClass === 0) return;
    const index = drumExclusiveClass * this.channels.length +
      channel.channelNumber;
    const prevNote = this.drumExclusiveClassNotes[index];
    if (prevNote && !prevNote.ending) {
      channel.noteOff(prevNote.noteNumber, 0, startTime, true);
    }
    this.drumExclusiveClassNotes[index] = note;
  }

  // Shared across every cache mode: AudioBufferSourceNode.start(t) with a
  // t that has already passed doesn't throw or wait for the next bar — it
  // just starts immediately, on the next render quantum. If preparing a
  // note/segment (decoding, envelope baking, or — for "segment" mode —
  // the whole renderSegmentBuffer offline render) takes longer than
  // lookAhead, the note/segment's intended start time silently passes
  // while still being prepared, so it ends up playing late and "snapped"
  // to whatever moment preparation finished, instead of on the beat. This
  // logs that so it's visible instead of just sounding subtly wrong.
  warnIfStartTimeMissed(label: string, scheduledStart: number): void {
    const now = this.audioContext.currentTime;
    if (scheduledStart < now) {
      console.warn(
        `${label} missed its scheduled start by ${
          (now - scheduledStart).toFixed(3)
        }s (preparation took too long relative to lookAhead=${this.lookAhead}s)`,
      );
    }
  }

  setNoteRouting(channel: TChannel, note: TNote, startTime: number): void {
    if (note.isSegmentGhost) return;
    const { volumeNode } = note;
    if (!volumeNode) return;
    if (note.renderedBuffer?.isFull) {
      volumeNode.connect((this.masterVolume as unknown) as AudioNode);
    } else {
      volumeNode.connect(channel.gainL);
      volumeNode.connect(channel.gainR);
    }
    this.handleExclusiveClass(note, channel, startTime);
    this.handleDrumExclusiveClass(note, channel, startTime);
    this.soundingNotes.add(note);
  }

  async noteOnChannel(
    channel: TChannel,
    noteNumber: number,
    velocity: number,
    startTime: number | undefined,
    note?: TNote,
  ): Promise<TNote | void> {
    const t: number = startTime ?? this.audioContext.currentTime;
    const realtime = startTime === undefined;
    if (!note) note = this.createNoteInstance(noteNumber, velocity, t);
    if (!note.voice) {
      note.voice = this.resolveVoice(channel, noteNumber, velocity);
    }
    if (!note.voice) return;
    if (!channel.activeNotes[noteNumber]) {
      channel.activeNotes[noteNumber] = [];
    }
    channel.activeNotes[noteNumber].push(note);
    try {
      await this.setNoteAudioNode(channel, note, realtime);
      if (note.ending) {
        // When pause/stop is interrupted in the middle of setNoteAudioNode
        if (note.bufferSource || note.volumeNode) {
          await this.soundOffNote(note, this.audioContext.currentTime);
        }
        return note;
      }
      this.setNoteRouting(channel, note, t);
    } finally {
      note.resolveReady();
    }
    if (0.5 <= channel.state.sustainPedal) channel.sustainNotes.push(note);
    return note;
  }

  disconnectNote(note: TNote): void {
    this.soundingNotes.delete(note);
    note.bufferSource?.disconnect();
    note.filterEnvelopeNode?.disconnect();
    note.volumeEnvelopeNode?.disconnect();
    note.volumeNode?.disconnect();
    if (note.modLfoToPitch) {
      note.modLfoToFilterFc?.disconnect();
      note.modLfoToVolume?.disconnect?.();
      note.modLfoToPitch?.disconnect?.();
      try {
        note.modLfo?.stop();
      } catch {
        // not started / already stopped
      }
    }
  }

  releaseFullCache(note: TNote): void {
    if (note.timelineIndex == null || note.fullCacheVoiceId == null) return;
    const durationMap = this.fullVoiceCache.get(note.fullCacheVoiceId);
    if (!durationMap) return;
    const entry = durationMap.get(note.timelineIndex);
    if (entry instanceof RenderedBuffer) {
      durationMap.delete(note.timelineIndex);
      if (durationMap.size === 0) {
        this.fullVoiceCache.delete(note.fullCacheVoiceId);
      }
    }
  }

  releaseNote(
    _channel: TChannel,
    note: TNote,
    endTime: number,
  ): Promise<void> | void {
    if (note.isSegmentGhost) return;
    const now = this.audioContext.currentTime;
    if (note.renderedBuffer?.isFull) {
      const rb = note.renderedBuffer;
      const naturalEndTime = note.startTime + rb.buffer.duration;
      const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
      const isEarlyCut = endTime < noteOffTime;
      if (isEarlyCut) {
        const volDuration = note.voiceParams?.volRelease ?? 0;
        const volRelease = endTime + volDuration;
        try {
          note.volumeNode?.gain
            .cancelScheduledValues(endTime)
            .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
        } catch { /* already closed */ }
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            this.disconnectNote(note);
            this.releaseFullCache(note);
            resolve();
          };
          const src = note.bufferSource;
          if (!src) {
            finish();
            return;
          }
          src.onended = finish;
          try {
            src.stop(volRelease);
          } catch {
            finish();
          }
        });
      }
      if (naturalEndTime <= now) {
        this.disconnectNote(note);
        this.releaseFullCache(note);
        return;
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.disconnectNote(note);
          this.releaseFullCache(note);
          resolve();
        };
        const src = note.bufferSource;
        if (!src) {
          finish();
          return;
        }
        src.onended = finish;
        try {
          src.stop(naturalEndTime);
        } catch {
          finish();
        }
      });
    }

    const volDuration = note.voiceParams?.volRelease ?? 0;
    const volRelease = endTime + volDuration;

    if (note.volumeEnvelopeNode) {
      // "none" mode
      try {
        note.filterEnvelopeNode?.frequency
          .cancelScheduledValues(endTime)
          .exponentialRampToValueAtTime(
            note.adjustedBaseFreq,
            endTime + (note.voiceParams?.modRelease ?? 0),
          );
        note.volumeEnvelopeNode.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    } else {
      // "ads" / "adsr" mode
      const isAdsr = note.renderedBuffer?.releaseDuration != null &&
        !note.renderedBuffer.isFull;
      if (isAdsr) {
        const rb = note.renderedBuffer!;
        const naturalEndTime = note.startTime + rb.buffer.duration;
        const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
        const isEarlyCut = endTime < noteOffTime;
        if (isEarlyCut) {
          try {
            note.volumeNode?.gain
              .cancelScheduledValues(endTime)
              .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
          } catch { /* already closed */ }
          return new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              this.disconnectNote(note);
              resolve();
            };
            const src = note.bufferSource;
            if (!src) {
              finish();
              return;
            }
            src.onended = finish;
            try {
              src.stop(volRelease);
            } catch {
              finish();
            }
          });
        }
        if (naturalEndTime <= now) {
          this.disconnectNote(note);
          return;
        }
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            this.disconnectNote(note);
            resolve();
          };
          const src = note.bufferSource;
          if (!src) {
            finish();
            return;
          }
          src.onended = finish;
          try {
            src.stop(naturalEndTime);
          } catch {
            finish();
          }
        });
      }
      try {
        note.volumeNode?.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.disconnectNote(note);
        resolve();
      };
      const src = note.bufferSource;
      if (!src) {
        finish();
        return;
      }
      src.onended = finish;
      try {
        src.stop(volRelease);
      } catch {
        finish();
      }
    });
  }

  noteOffChannel(
    channel: TChannel,
    noteNumber: number,
    _velocity: number,
    endTime: number,
    force: boolean,
  ): Promise<void> | void {
    if (!force) {
      if (this.ignoreDrumNoteOff && channel.isDrum) {
        // One-shot behaviour applies to live MIDI input only. MIDI-file notes
        // carry a timelineIndex and must release at note-off so their decay
        // matches segment/chunk offline bakes (which force-release drums).
        const liveNote = this.findNoteForOff(channel, noteNumber);
        if (!liveNote || liveNote.timelineIndex === null) {
          this.removeFromActiveNotes(channel, noteNumber);
          return;
        }
      }
      if (0.5 <= channel.state.sustainPedal) return;
    }
    const note = this.findNoteForOff(channel, noteNumber);
    if (!note) return;
    note.ending = true;
    this.removeFromActiveNotes(channel, noteNumber);
    const promise = note.ready.then(() => {
      if (!note.voice) return;
      return this.releaseNote(channel, note, endTime);
    });
    this.notePromises.push(promise);
    return promise;
  }

  findNoteForOff(channel: TChannel, noteNumber: number): TNote | undefined {
    const stack = channel.activeNotes[noteNumber];
    if (!stack) return;
    for (let i = 0; i < stack.length; i++) {
      if (!stack[i]?.ending) return stack[i];
    }
  }

  removeFromActiveNotes(channel: TChannel, noteNumber: number): void {
    const stack = channel.activeNotes[noteNumber];
    if (!stack || stack.length === 0) return;
    stack.shift();
  }

  releaseSustainPedal(
    channel: TChannel,
    halfVelocity: number,
    scheduleTime: number,
  ): (Promise<void> | void)[] {
    const velocity = halfVelocity * 2;
    const promises: (Promise<void> | void)[] = [];
    for (let i = 0; i < channel.sustainNotes.length; i++) {
      const promise = channel.noteOff(
        channel.sustainNotes[i].noteNumber,
        velocity,
        scheduleTime,
        true,
      );
      promises.push(promise);
    }
    channel.sustainNotes = [];
    return promises;
  }

  soundOffNote(note: TNote, scheduleTime: number): Promise<void> {
    note.ending = true;
    if (!note.voice || note.isSegmentGhost) {
      this.soundingNotes.delete(note);
      return Promise.resolve();
    }
    if (!note.bufferSource && !note.volumeNode) {
      this.soundingNotes.delete(note);
      return Promise.resolve();
    }

    const now = this.audioContext.currentTime;
    const t = Math.max(scheduleTime, now);
    const timeConstant = this.perceptualSmoothingTime / 5;

    try {
      note.volumeNode?.gain
        .cancelScheduledValues(t)
        .setTargetAtTime(0, t, timeConstant);
    } catch { /* already closed */ }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          this.disconnectNote(note);
        } catch {
          // Ensure resolve is called even if an exception occurs during disconnect / modLfo.stop
        }
        resolve();
      };

      const src = note.bufferSource;
      if (!src) {
        finish();
        return;
      }

      src.onended = finish;
      try {
        src.stop(t + this.perceptualSmoothingTime);
      } catch {
        // Already stopped/ended → onended will never fire again.
        finish();
        return;
      }
      // To prevent indefinite waiting for pause()/stop() in cases where 'onended' does not fire,
      // force resolution after the fade completes.
      const waitMs = Math.max(
        50,
        (t + this.perceptualSmoothingTime - now) * 1000 + 50,
      );
      setTimeout(finish, waitMs);
    });
  }

  soundOff(
    channelNumber: number,
    noteNumber: number,
    scheduleTime: number,
  ): Promise<void> {
    const channel = this.channels[channelNumber];
    if (!channel) return Promise.resolve();
    const note = this.findNoteForOff(channel, noteNumber);
    if (!note) return Promise.resolve();
    this.removeFromActiveNotes(channel, note.noteNumber);
    return this.soundOffNote(note, scheduleTime);
  }

  createMessageHandlers(): MessageHandler[] {
    const handlers: MessageHandler[] = new Array(256);
    handlers[0x80] = (data, t) =>
      this.channels[data[0] & 0x0F].noteOff(data[1], data[2], t);
    handlers[0x90] = (data, t) =>
      this.channels[data[0] & 0x0F].noteOn(data[1], data[2], t);
    handlers[0xB0] = (data, t) =>
      this.channels[data[0] & 0x0F].setControlChange(data[1], data[2], t);
    handlers[0xC0] = (data, _t) =>
      this.channels[data[0] & 0x0F].setProgramChange(data[1]);
    handlers[0xE0] = (data, t) =>
      this.channels[data[0] & 0x0F].setPitchBend(data[2] * 128 + data[1], t);
    return handlers;
  }

  handleMessage(data: Uint8Array, scheduleTime: number): void {
    const status = data[0];
    if (status === 0xF0) {
      return this.handleSysEx(data.subarray(1), scheduleTime);
    }
    const handler = this.messageHandlers[status];
    if (handler) handler(data, scheduleTime);
  }

  setModLfoToPitch(channel: TChannel, note: TNote, scheduleTime: number): void {
    if (note.modLfoToPitch) {
      const modLfoToPitch = note.voiceParams?.modLfoToPitch ?? 0;
      const baseDepth = Math.abs(modLfoToPitch) +
        channel.state.modulationDepthMSB;
      const depth = baseDepth * Math.sign(modLfoToPitch);
      const timeConstant = this.perceptualSmoothingTime / 5;
      note.modLfoToPitch?.gain
        .cancelAndHoldAtTime(scheduleTime)
        .setTargetAtTime(depth, scheduleTime, timeConstant);
    } else {
      this.startModulation(channel, note, scheduleTime);
    }
  }

  setModLfoToFilterFc(
    _channel: TChannel,
    note: TNote,
    scheduleTime: number,
  ): void {
    const modLfoToFilterFc = note.voiceParams?.modLfoToFilterFc ?? 0;
    const timeConstant = this.perceptualSmoothingTime / 5;
    note.modLfoToFilterFc?.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(modLfoToFilterFc, scheduleTime, timeConstant);
  }

  setModLfoToVolume(
    _channel: TChannel,
    note: TNote,
    scheduleTime: number,
  ): void {
    const modLfoToVolume = note.voiceParams?.modLfoToVolume ?? 0;
    const baseDepth = cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const depth = baseDepth * Math.sign(modLfoToVolume);
    const timeConstant = this.perceptualSmoothingTime / 5;
    note.modLfoToVolume?.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(depth, scheduleTime, timeConstant);
  }

  setDelayModLFO(note: TNote): void {
    const startTime = note.startTime + (note.voiceParams?.delayModLFO ?? 0);
    try {
      note.modLfo?.start(startTime);
    } catch { /* empty */ }
  }

  setFreqModLFO(note: TNote, scheduleTime: number): void {
    const freqModLFO = note.voiceParams?.freqModLFO ?? 0;
    note.modLfo?.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(freqModLFO, scheduleTime);
  }

  getControllerState(
    channel: TChannel,
    noteNumber: number,
    velocity: number,
    polyphonicKeyPressure: number,
  ): Float32Array {
    const state = new Float32Array(channel.state.array.length);
    state.set(channel.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    state[10] = polyphonicKeyPressure / 127;
    return state;
  }

  applyVoiceParams(
    channel: TChannel,
    controllerType: number,
    scheduleTime: number,
  ): void {
    channel.processScheduledNotes((note: TNote) => {
      if (note.renderedBuffer?.isFull || note.isSegmentGhost) return;
      const controllerState = this.getControllerState(
        channel,
        note.noteNumber,
        note.velocity,
        note.pressure,
      );
      const voiceParams = note.voice?.getParams(
        controllerType,
        controllerState,
      );
      if (!voiceParams) return;
      let applyVolumeEnvelope = false;
      let applyFilterEnvelope = false;
      let applyPitchEnvelope = false;
      for (const [key, value] of Object.entries(voiceParams)) {
        const prevValue = note.voiceParams?.[key as keyof VoiceParams];
        if (value === prevValue) continue;
        (note.voiceParams as Record<keyof VoiceParams, unknown>)[
          key as keyof VoiceParams
        ] = value;
        if (key in this.voiceParamsHandlers) {
          this.voiceParamsHandlers[key](channel, note, scheduleTime);
        } else {
          if (volumeEnvelopeKeySet.has(key)) applyVolumeEnvelope = true;
          if (filterEnvelopeKeySet.has(key)) applyFilterEnvelope = true;
          if (pitchEnvelopeKeySet.has(key)) applyPitchEnvelope = true;
        }
      }
      if (applyVolumeEnvelope) {
        this.setVolumeEnvelope(channel, note, scheduleTime);
      }
      if (applyFilterEnvelope) {
        this.setFilterEnvelope(channel, note, scheduleTime);
      }
      if (applyPitchEnvelope) this.setPitchEnvelope(note, scheduleTime);
    });
  }

  updateModulation(channel: TChannel, scheduleTime: number): void {
    const depth = channel.state.modulationDepthMSB *
      channel.modulationDepthRange;
    const timeConstant = this.perceptualSmoothingTime / 5;
    channel.processScheduledNotes((note: TNote) => {
      if (note.renderedBuffer?.isFull || note.isSegmentGhost) return;
      if (note.modLfoToPitch) {
        note.modLfoToPitch?.gain
          .cancelAndHoldAtTime(scheduleTime)
          .setTargetAtTime(depth, scheduleTime, timeConstant);
      } else {
        this.startModulation(channel, note, scheduleTime);
      }
    });
  }

  panToGain(pan: number): { gainLeft: number; gainRight: number } {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  updateChannelVolume(channel: TChannel, scheduleTime: number): void {
    if (!channel.gainL) return;
    const state = channel.state;
    const gain = state.volumeMSB * state.expressionMSB;
    const { gainLeft, gainRight } = this.panToGain(state.panMSB);
    const timeConstant = this.perceptualSmoothingTime / 5;
    channel.gainL.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(gain * gainLeft, scheduleTime, timeConstant);
    channel.gainR.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(gain * gainRight, scheduleTime, timeConstant);
  }

  handleUniversalNonRealTimeExclusiveMessage(
    data: Uint8Array,
    scheduleTime: number,
    channels: TChannel[] = this.channels,
  ): void {
    switch (data[2]) {
      case 9:
        switch (data[3]) {
          case 1:
            this.GM1SystemOn(scheduleTime, channels);
            break;
          case 2: // GM System Off
            break;
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  GM1SystemOn(
    scheduleTime: number,
    channels: TChannel[] = this.channels,
  ): void {
    if (channels === this.channels) {
      this.mode = "GM1";
      this.exclusiveClassNotes.fill(null);
      this.drumExclusiveClassNotes.fill(null);
    }
    for (let ch = 0; ch < channels.length; ch++) {
      channels[ch].allSoundOff(scheduleTime);
    }
    this.resetChannels(channels, scheduleTime);
    this.setMasterVolume(1, scheduleTime);
  }

  handleUniversalRealTimeExclusiveMessage(
    data: Uint8Array,
    scheduleTime: number,
  ): void {
    switch (data[2]) {
      case 4:
        switch (data[3]) {
          case 1:
            return this.handleMasterVolumeSysEx(data, scheduleTime);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  fadeMasterVolumeTo(
    value: number,
    duration: number,
    scheduleTime?: number,
  ): void {
    const t = scheduleTime ?? this.audioContext.currentTime;
    const timeConstant = duration / 5;
    this.masterVolumeLocked = true;
    this.masterVolume.gain.cancelAndHoldAtTime(t).setTargetAtTime(
      value * value,
      t,
      timeConstant,
    );
    // Unlock after the fade. Prefer the audio clock so background-tab
    // setTimeout throttling does not leave masterVolumeLocked stuck true
    // longer than intended. Fall back to setTimeout when the context is
    // not running (suspended / offline), where the audio clock does not
    // advance. If pause/stop/seek aborts the scheduleTask via
    // cancelScheduledTasks(), that path clears masterVolumeLocked.
    const unlockAt = t + duration;
    const unlock = () => {
      this.masterVolumeLocked = false;
    };
    const ac = this.audioContext;
    if (
      ac instanceof AudioContext && ac.state === "running" && this.scheduler
    ) {
      this.scheduleTask(unlock, unlockAt);
    } else {
      setTimeout(
        unlock,
        Math.max(0, (unlockAt - ac.currentTime) * 1000),
      );
    }
  }

  fadeOutMasterVolume(duration: number, scheduleTime?: number): void {
    this.fadeMasterVolumeTo(0, duration, scheduleTime);
  }

  handleMasterVolumeSysEx(data: Uint8Array, scheduleTime: number): void {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.setMasterVolume(volume, scheduleTime);
  }

  setMasterVolume(value: number, scheduleTime?: number): void {
    const t: number = scheduleTime ?? this.audioContext.currentTime;
    const timeConstant = this.perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    this.masterVolume.gain
      .cancelAndHoldAtTime(t)
      .setTargetAtTime(value * value, t, timeConstant);
  }

  handleSysEx(
    data: Uint8Array,
    scheduleTime: number,
    channels: TChannel[] = this.channels,
  ): void {
    switch (data[0]) {
      case 126:
        return this.handleUniversalNonRealTimeExclusiveMessage(
          data,
          scheduleTime,
          channels,
        );
      case 127:
        return this.handleUniversalRealTimeExclusiveMessage(data, scheduleTime);
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  cancelScheduledTasks(): void {
    // Any in-flight fadeMasterVolumeTo unlock was scheduled via
    // scheduleTask; stopping those sources means the fade was aborted, so
    // the lock is no longer meaningful.
    this.masterVolumeLocked = false;
    for (const bufferSource of this.pendingSchedulerSources) {
      try {
        bufferSource.stop();
      } catch {
        // already stopped/ended
      }
    }
  }

  async waitForPendingSources(
    label: string,
    getPending: () => { source: AudioBufferSourceNode | null; done: boolean }[],
  ): Promise<void> {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (true) {
      const pending = getPending();
      let allDone = true;
      for (let i = 0; i < pending.length; i++) {
        if (!pending[i].done) {
          allDone = false;
          break;
        }
      }
      if (allDone) break;
      if (Date.now() > deadline) {
        console.warn(
          `${label}: timed out waiting for sources to end; forcing stop`,
        );
        for (const p of pending) {
          if (p.source) {
            try {
              p.source.stop();
            } catch {
              // already stopped/ended
            }
            p.source.disconnect();
          }
          p.done = true;
        }
        break;
      }
      await this.waitTick();
    }
  }

  async waitUntil(
    predicate: () => boolean,
    maxSeconds: number,
  ): Promise<void> {
    if (predicate()) return;
    const ac = this.audioContext;
    const useAudioClock = ac instanceof AudioContext &&
      ac.state === "running" &&
      !!this.scheduler;
    const deadline = useAudioClock
      ? ac.currentTime + maxSeconds
      : Date.now() + maxSeconds * 1000;
    while (!predicate()) {
      if (useAudioClock) {
        if (ac.currentTime >= deadline) return;
      } else {
        if (Date.now() >= deadline) return;
      }
      await this.waitTick();
    }
  }

  waitTick(): Promise<void> {
    // Prefer the audio clock while the context is running — accurate even
    // when the tab is backgrounded and setTimeout is heavily throttled.
    // When suspended/offline the audio clock does not advance, so fall
    // back to setTimeout to avoid hanging the drain loop forever.
    const ac = this.audioContext;
    if (
      ac instanceof AudioContext && ac.state === "running" && this.scheduler
    ) {
      return this.scheduleTask(
        () => {},
        ac.currentTime + this.noteCheckInterval,
      );
    }
    return new Promise((resolve) => {
      setTimeout(resolve, this.noteCheckInterval * 1000);
    });
  }

  scheduleTask(callback: () => void, scheduleTime: number): Promise<void> {
    return new Promise((resolve) => {
      const bufferSource = new AudioBufferSourceNode(this.audioContext, {
        buffer: this.schedulerBuffer!,
      });
      bufferSource.connect(this.scheduler!);
      this.pendingSchedulerSources.add(bufferSource);
      bufferSource.onended = () => {
        this.pendingSchedulerSources.delete(bufferSource);
        try {
          callback();
        } finally {
          bufferSource.disconnect();
          resolve();
        }
      };
      bufferSource.start(scheduleTime);
    });
  }
}
