import { type MidiData, type MidiSetTempoEvent, parseMidi } from "midi-file";
import {
  AudioData,
  parse,
  SoundFont,
  Voice,
  type VoiceParams,
} from "@marmooo/soundfont-parser";
import { OggVorbisDecoderWebWorker } from "@wasm-audio-decoders/ogg-vorbis";
import {
  createConvolutionReverb,
  createConvolutionReverbImpulse,
  createDattorroReverb,
  createFDNDefault,
  createFreeverb,
  createMoorerReverbDefault,
  createSchroederReverb,
  createVelvetNoiseReverb,
} from "./reverb.ts";

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
const DEFAULT_CACHE_MODE = "segment";
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
function f64ToBigInt(value: number): bigint {
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
  player?: MidyGM2;
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
  vibLfo: OscillatorNode | null = null; // vibrato LFO
  vibLfoToPitch: GainNode | null = null;
  reverbSend: GainNode | null = null;
  chorusSend: GainNode | null = null;
  portamentoNoteNumber: number = -1;
  // "segment" mode
  isSegmentGhost: boolean = false;
  segmentNoteDuration: number = 0;
  audioBufferId?: number;

  constructor(noteNumber: number, velocity: number, startTime: number) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
}

type ChannelSettings = typeof MidyGM2.channelSettings;
type ChannelAudioNodes = ReturnType<MidyGM2["createChannelAudioNodes"]>;

export class Channel {
  player!: MidyGM2;
  gainL!: GainNode;
  gainR!: GainNode;
  merger!: ChannelMergerNode;
  isDrum: boolean = false;
  channelNumber: number = 0;
  programNumber: number = 0;
  detune: number = 0;
  bankMSB: number = 121;
  bankLSB: number = 0;
  dataMSB: number = 0;
  dataLSB: number = 0;
  rpnMSB: number = 127;
  rpnLSB: number = 127;
  mono: boolean = false; // CC#124, CC#125
  modulationDepthRange: number = 50;
  fineTuning: number = 0; // cent
  coarseTuning: number = 0; // cent
  activeNotes: (Note[] | undefined)[] = new Array(128);
  sustainNotes: Note[] = [];
  sostenutoNotes: Note[] = [];
  controlTable = new Int8Array(defaultControlValues);
  scaleOctaveTuningTable = new Int8Array(12); // [-64, 63] cent
  channelPressureTable = new Int8Array(defaultPressureValues);
  keyBasedTable = new Int8Array(128 * 128).fill(-1);
  keyBasedGainLs = new Array(128);
  keyBasedGainRs = new Array(128);
  lastNote: Note | null = null;
  currentBufferSource: AudioBufferSourceNode | null = null;
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

  resetTable(): void {
    this.controlTable.set(defaultControlValues);
    this.scaleOctaveTuningTable.fill(0);
    this.channelPressureTable.set(defaultPressureValues);
    this.keyBasedTable.fill(-1);
  }

  processScheduledNotes(
    callback: (note: Note) => void | Promise<void>,
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
    callback: (note: Note) => void | Promise<void>,
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
    note?: Note,
  ): Promise<Note | void> {
    return await this.player.noteOnChannel(
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
    const player = this.player;
    const t: number = endTime ?? player.audioContext.currentTime;
    return await player.noteOffChannel(this, noteNumber, velocity, t, force);
  }

  setProgramChange(programNumber: number): void {
    this.programNumber = programNumber;
    if (this.player.mode === "GM2") {
      switch (this.bankMSB) {
        case 120:
          this.isDrum = true;
          this.keyBasedTable.fill(-1);
          break;
        case 121:
          this.isDrum = false;
          break;
      }
    }
  }

  setChannelPressure(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    if (this.isDrum) return;
    const prev = player.calcChannelPressureEffectValue(this, 0);
    this.state.channelPressure = value / 127;
    const next = player.calcChannelPressureEffectValue(this, 0);
    this.detune += next - prev;
    this.processActiveNotes(t, (note) => {
      player.setChannelPressureEffects(this, note, t);
    });
    player.applyVoiceParams(this, 13, t);
  }

  setPitchBend(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
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
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const handler = player.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(player, this, value, t);
      player.applyVoiceParams(this, controllerType + 128, t);
      this.processActiveNotes(t, (note) => {
        player.setControlChangeEffects(this, note, t);
      });
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`,
      );
    }
  }

  setBankMSB(msb: number): void {
    this.bankMSB = msb;
  }

  setModulationDepth(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.modulationDepthMSB = value / 127;
    player.updateModulation(this, t);
  }

  setPortamentoTime(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.portamentoTimeMSB = value / 127;
    if (this.isDrum) return;
    player.updatePortamento(this, t);
  }

  setVolume(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.volumeMSB = value / 127;
    player.applyVolume(this, t);
  }

  setPan(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.panMSB = value / 127;
    if (this.isDrum) {
      for (let i = 0; i < 128; i++) {
        player.updateKeyBasedVolume(this, i, t);
      }
    } else {
      player.updateChannelVolume(this, t);
    }
  }

  setExpression(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.expressionMSB = value / 127;
    player.updateChannelVolume(this, t);
  }

  setBankLSB(lsb: number): void {
    this.bankLSB = lsb;
  }

  dataEntryLSB(value: number, scheduleTime?: number): void {
    this.dataLSB = value;
    this.handleRPN(scheduleTime);
  }

  async setSustainPedal(value: number, scheduleTime?: number): Promise<void> {
    const player = this.player;
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

  setPortamento(value: number, scheduleTime?: number): void {
    const player = this.player;
    if (this.isDrum) return;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.portamento = value / 127;
    player.updatePortamento(this, t);
  }

  async setSostenutoPedal(value: number, scheduleTime?: number): Promise<void> {
    const player = this.player;
    if (this.isDrum) return;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const state = this.state;
    const prevValue = state.sostenutoPedal;
    state.sostenutoPedal = value / 127;
    if (64 <= value) {
      if (prevValue < 0.5) {
        const sostenutoNotes: Note[] = [];
        await this.processActiveNotes(t, (note) => {
          sostenutoNotes.push(note);
        });
        this.sostenutoNotes = sostenutoNotes;
      }
    } else {
      player.releaseSostenutoPedal(this, value, t);
    }
  }

  setSoftPedal(value: number, scheduleTime?: number): void {
    const player = this.player;
    if (this.isDrum) return;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.softPedal = value / 127;
    this.processScheduledNotes((note) => {
      if (player.isPortamento(this, note)) {
        player.ensureFilterEnvelopeNode(note);
        player.setPortamentoVolumeEnvelope(this, note, t);
        player.setPortamentoFilterEnvelope(this, note, t);
      } else {
        player.setVolumeEnvelope(this, note, t);
        player.setFilterEnvelope(this, note, t);
      }
    });
  }

  setReverbSendLevel(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.reverbSendLevel = value / 127;
    this.processScheduledNotes((note) => {
      player.setReverbSend(this, note, t);
    });
  }

  setChorusSendLevel(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.chorusSendLevel = value / 127;
    this.processScheduledNotes((note) => {
      player.setChorusSend(this, note, t);
    });
  }

  setRPNMSB(value: number): void {
    this.rpnMSB = value;
  }

  setRPNLSB(value: number): void {
    this.rpnLSB = value;
  }

  dataEntryMSB(value: number, scheduleTime?: number): void {
    this.dataMSB = value;
    this.handleRPN(scheduleTime);
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

  limitDataMSB(minMSB: number, maxMSB: number): void {
    if (maxMSB < this.dataMSB) {
      this.dataMSB = maxMSB;
    } else if (this.dataMSB < 0) {
      this.dataMSB = minMSB;
    }
  }

  handleRPN(scheduleTime?: number): void {
    const rpn = this.rpnMSB * 128 + this.rpnLSB;
    switch (rpn) {
      case 0:
        this.handlePitchBendRangeRPN(scheduleTime);
        break;
      case 1:
        this.handleFineTuningRPN(scheduleTime);
        break;
      case 2:
        this.handleCoarseTuningRPN(scheduleTime);
        break;
      case 5:
        this.handleModulationDepthRangeRPN(scheduleTime);
        break;
      case 16383: // NULL
        break;
      default:
        console.warn(
          `Channel ${this.channelNumber}: Unsupported RPN MSB=${this.rpnMSB} LSB=${this.rpnLSB}`,
        );
    }
  }

  handlePitchBendRangeRPN(scheduleTime?: number): void {
    this.limitData(0, 127, 0, 127);
    const pitchBendRange = (this.dataMSB + this.dataLSB / 128) * 100;
    this.setPitchBendRange(pitchBendRange, scheduleTime);
  }

  setPitchBendRange(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const state = this.state;
    const prev = state.pitchWheelSensitivity;
    const next = value / 12800;
    state.pitchWheelSensitivity = next;
    this.detune += (state.pitchWheel * 2 - 1) * (next - prev) * 12800;
    player.updateChannelDetune(this, t);
    player.applyVoiceParams(this, 16, t);
  }

  handleFineTuningRPN(scheduleTime?: number): void {
    this.limitData(0, 127, 0, 127);
    const value = this.dataMSB * 128 + this.dataLSB;
    const fineTuning = (value - 8192) / 8192 * 100;
    this.setFineTuning(fineTuning, scheduleTime);
  }

  setFineTuning(value: number, scheduleTime?: number): void { // [-100, 100] cent
    const player = this.player;
    if (this.isDrum) return;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const prev = this.fineTuning;
    this.fineTuning = value;
    this.detune += value - prev;
    player.updateChannelDetune(this, t);
  }

  handleCoarseTuningRPN(scheduleTime?: number): void {
    this.limitDataMSB(0, 127);
    const coarseTuning = (this.dataMSB - 64) * 100;
    this.setCoarseTuning(coarseTuning, scheduleTime);
  }

  setCoarseTuning(value: number, scheduleTime?: number): void { // [-6400, 6300] cent
    const player = this.player;
    if (this.isDrum) return;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const prev = this.coarseTuning;
    this.coarseTuning = value;
    this.detune += value - prev;
    player.updateChannelDetune(this, t);
  }

  handleModulationDepthRangeRPN(scheduleTime?: number): void {
    this.limitData(0, 127, 0, 127);
    const value = (this.dataMSB + this.dataLSB / 128) * 100;
    this.setModulationDepthRange(value, scheduleTime);
  }

  setModulationDepthRange(value: number, scheduleTime?: number): void { // [0, 12800] cent
    const player = this.player;
    if (this.isDrum) return;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.modulationDepthRange = value;
    player.updateModulation(this, t);
  }

  allSoundOff(scheduleTime?: number): Promise<void[]> {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const promises: Promise<void>[] = [];
    this.processActiveNotes(t, (note) => {
      promises.push(player.soundOffNote(note, t));
    });
    return Promise.all(promises);
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
  resetAllControllers(scheduleTime?: number): void {
    const player = this.player;
    const keys = [
      "channelPressure",
      "pitchWheel",
      "expressionMSB",
      "modulationDepthMSB",
      "sustainPedal",
      "portamento",
      "sostenutoPedal",
      "softPedal",
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
      (player.constructor as typeof MidyGM2).channelSettings;
    for (let i = 0; i < settingTypes.length; i++) {
      const key = settingTypes[i];
      this[key] = channelSettings[key];
    }
  }

  resetChannelStates(): void {
    const player = this.player;
    const scheduleTime = player.audioContext.currentTime;
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
          scheduleTime,
        );
      } else {
        state[key] = defaultValue;
      }
    }
    this.resetSettings(
      (player.constructor as typeof MidyGM2).channelSettings,
    );
  }

  allNotesOff(scheduleTime?: number): Promise<void[]> {
    const player = this.player;
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

  omniOff(scheduleTime?: number): void {
    this.allNotesOff(scheduleTime);
  }

  omniOn(scheduleTime?: number): void {
    this.allNotesOff(scheduleTime);
  }

  monoOn(scheduleTime?: number): void {
    this.allNotesOff(scheduleTime);
    this.mono = true;
  }

  polyOn(scheduleTime?: number): void {
    this.allNotesOff(scheduleTime);
    this.mono = false;
  }
}

const drumExclusiveClassesByKit = new Array(57);
const drumExclusiveClassCount = 10;
const standardSet = new Uint8Array(128);
standardSet[42] = 1;
standardSet[44] = 1;
standardSet[46] = 1; // HH
standardSet[71] = 2;
standardSet[72] = 2; // Whistle
standardSet[73] = 3;
standardSet[74] = 3; // Guiro
standardSet[78] = 4;
standardSet[79] = 4; // Cuica
standardSet[80] = 5;
standardSet[81] = 5; // Triangle
standardSet[29] = 6;
standardSet[30] = 6; // Scratch
standardSet[86] = 7;
standardSet[87] = 7; // Surdo
drumExclusiveClassesByKit[0] = standardSet;
const analogSet = new Uint8Array(128);
analogSet[42] = 8;
analogSet[44] = 8;
analogSet[46] = 8; // CHH
drumExclusiveClassesByKit[25] = analogSet;
const orchestraSet = new Uint8Array(128);
orchestraSet[27] = 9;
orchestraSet[28] = 9;
orchestraSet[29] = 9; // HH
drumExclusiveClassesByKit[48] = orchestraSet;
const sfxSet = new Uint8Array(128);
sfxSet[41] = 10;
sfxSet[42] = 10; // Scratch
drumExclusiveClassesByKit[56] = sfxSet;

// normalized to 0-1 for use with the SF2 modulator model
const defaultControllerState = {
  noteOnVelocity: { type: 2, defaultValue: 0 },
  noteOnKeyNumber: { type: 3, defaultValue: 0 },
  channelPressure: { type: 13, defaultValue: 0 },
  pitchWheel: { type: 14, defaultValue: 8192 / 16383 },
  pitchWheelSensitivity: { type: 16, defaultValue: 2 / 128 },
  link: { type: 127, defaultValue: 0 },
  // bankMSB: { type: 128 + 0, defaultValue: 121, },
  modulationDepthMSB: { type: 128 + 1, defaultValue: 0 },
  portamentoTimeMSB: { type: 128 + 5, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volumeMSB: { type: 128 + 7, defaultValue: 100 / 127 },
  panMSB: { type: 128 + 10, defaultValue: 64 / 127 },
  expressionMSB: { type: 128 + 11, defaultValue: 1 },
  // bankLSB: { type: 128 + 32, defaultValue: 0, },
  // dataLSB: { type: 128 + 38, defaultValue: 0, },
  sustainPedal: { type: 128 + 64, defaultValue: 0 },
  portamento: { type: 128 + 65, defaultValue: 0 },
  sostenutoPedal: { type: 128 + 66, defaultValue: 0 },
  softPedal: { type: 128 + 67, defaultValue: 0 },
  reverbSendLevel: { type: 128 + 91, defaultValue: 0 },
  chorusSendLevel: { type: 128 + 93, defaultValue: 0 },
  // dataIncrement: { type: 128 + 96, defaultValue: 0 },
  // dataDecrement: { type: 128 + 97, defaultValue: 0 },
  // rpnLSB: { type: 128 + 100, defaultValue: 127 },
  // rpnMSB: { type: 128 + 101, defaultValue: 127 },
  // allSoundOff: { type: 128 + 120, defaultValue: 0 },
  // resetAllControllers: { type: 128 + 121, defaultValue: 0 },
  // allNotesOff: { type: 128 + 123, defaultValue: 0 },
  // omniOff: { type: 128 + 124, defaultValue: 0 },
  // omniOn: { type: 128 + 125, defaultValue: 0 },
  // monoOn: { type: 128 + 126, defaultValue: 0 },
  // polyOn: { type: 128 + 127, defaultValue: 0 },
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

  get channelPressure(): number {
    return this.array[13];
  }
  set channelPressure(value: number) {
    this.array[13] = value;
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

  get portamentoTimeMSB(): number {
    return this.array[128 + 5];
  }
  set portamentoTimeMSB(value: number) {
    this.array[128 + 5] = value;
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

  get portamento(): number {
    return this.array[128 + 65];
  }
  set portamento(value: number) {
    this.array[128 + 65] = value;
  }

  get sostenutoPedal(): number {
    return this.array[128 + 66];
  }
  set sostenutoPedal(value: number) {
    this.array[128 + 66] = value;
  }

  get softPedal(): number {
    return this.array[128 + 67];
  }
  set softPedal(value: number) {
    this.array[128 + 67] = value;
  }

  get reverbSendLevel(): number {
    return this.array[128 + 91];
  }
  set reverbSendLevel(value: number) {
    this.array[128 + 91] = value;
  }

  get chorusSendLevel(): number {
    return this.array[128 + 93];
  }
  set chorusSendLevel(value: number) {
    this.array[128 + 93] = value;
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
const volumeEnvelopeKeySet = new Set(volumeEnvelopeKeys);
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
const filterEnvelopeKeySet = new Set(filterEnvelopeKeys);
const pitchEnvelopeKeys = [
  "modEnvToPitch",
  "modDelay",
  "modAttack",
  "modHold",
  "modDecay",
  "modSustain",
  "playbackRate",
];
const pitchEnvelopeKeySet = new Set(pitchEnvelopeKeys);

const effectParameters = [
  2400 / 64, // cent
  9600 / 64, // cent
  1 / 64,
  600 / 127, // cent
  2400 / 127, // cent
  1 / 127,
];
const pressureBaselines = new Int8Array([64, 64, 0, 0, 0, 0]);
const defaultPressureValues = new Int8Array([64, 64, 64, 0, 0, 0]);
const defaultControlValues = new Int8Array([
  ...[-1, -1, -1, -1, -1, -1],
  ...defaultPressureValues,
]);

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

function cbToRatio(cb: number): number {
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
const envelopeCurve = 1 / (-Math.log(cbToRatio(-1000)));

// https://www.synthfont.com/sfspec24.pdf
// SF2 spec's defined maximum (and default) value for the initialFilterFc
// generator: 13500 cents (≈19913Hz via centToHz, see clampCutoffFrequency).
// The spec treats this as "no filtering" / fully open by convention
const FULLY_OPEN_FILTER_CENTS = 13500;

interface TimelineEvent {
  type: string;
  ticks: number;
  startTime: number;
  channel?: number;
  noteNumber?: number;
  velocity?: number;
  controllerType?: number;
  programNumber?: number;
  value?: number;
  amount?: number;
  data?: ArrayLike<number>;
  microsecondsPerBeat?: number;
}

interface CacheEntry {
  audioBuffer: RenderedBuffer;
  maxCount: number;
  counter: number;
}
interface NoteOnEventEntry {
  duration: number;
  durationTicks: number;
  startTime: number;
  events: TimelineEvent[];
}
interface NoteOnEntry {
  idx: number;
  startTime: number;
  startTicks: number;
  events: TimelineEvent[];
}
interface PendingOffItem {
  t: number;
  ticks: number;
}

// "segment" mode
interface SegmentNoteEntry {
  offset: number;
  noteNumber: number;
  velocity: number;
  voiceParams: VoiceParams;
  noteDuration: number;
  noteEvent: NoteOnEventEntry | undefined;
  audioBufferId?: number;
  voice?: Voice;
}
interface OpenSegment {
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
interface PendingSegment {
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
interface SegmentChannelState {
  openSegment: OpenSegment | null;
  pending: PendingSegment[];
}

// "chunk" mode
// ChunkNoteEntry mirrors SegmentNoteEntry, with a channelNumber added so
// the renderer knows which channel each note belongs to.
interface ChunkNoteEntry {
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
interface OpenChunk {
  chunkStart: number;
  notes: ChunkNoteEntry[];
}
interface PendingChunk {
  chunkStart: number;
  buffer: AudioBuffer | null;
  bufferReady: boolean;
  bufferPromise: Promise<AudioBuffer | null>;
  source: AudioBufferSourceNode | null;
  done: boolean;
  generation: number;
}
interface ChunkState {
  openChunk: OpenChunk | null;
  pending: PendingChunk[];
}

type MessageHandler = (bytes: Uint8Array, time: number) => void;
type ControlChangeHandler = (ch: Channel, v: number, t: number) => void;
type VoiceParamsHandler = (
  channel: Channel,
  note: Note,
  scheduleTime: number,
) => void;
type EffectHandler = (
  channel: Channel,
  note: Note,
  scheduleTime: number,
) => void;
type KeyBasedHandler = (
  channel: Channel,
  keyNumber: number,
  scheduleTime: number,
) => void;

const voiceParamsHandlers: Record<string, VoiceParamsHandler> = {
  modLfoToPitch: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.player.setModLfoToPitch(channel, note, t);
    }
  },
  vibLfoToPitch: (channel, note, t) =>
    channel.player.setVibLfoToPitch(channel, note, t),
  modLfoToFilterFc: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.player.setModLfoToFilterFc(channel, note, t);
    }
  },
  modLfoToVolume: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.player.setModLfoToVolume(channel, note, t);
    }
  },
  chorusEffectsSend: (channel, note, t) =>
    channel.player.setChorusSend(channel, note, t),
  reverbEffectsSend: (channel, note, t) =>
    channel.player.setReverbSend(channel, note, t),
  delayModLFO: (channel, note, _t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.player.setDelayModLFO(note);
    }
  },
  freqModLFO: (channel, note, t) => {
    if (0 < channel.state.modulationDepthMSB) {
      channel.player.setFreqModLFO(note, t);
    }
  },
  delayVibLFO: (channel, note, _t) => channel.player.setDelayVibLFO(note),
  freqVibLFO: (channel, note, t) => channel.player.setFreqVibLFO(note, t),
  detune: (channel, note, t) => {
    if (channel.player.isPortamento(channel, note)) {
      channel.player.setPortamentoDetune(channel, note, t);
    } else {
      channel.player.setDetune(channel, note, t);
    }
  },
};

const controlChangeHandlers: ControlChangeHandler[] = new Array(128);
controlChangeHandlers[0] = (ch, v, _t) => ch.setBankMSB(v);
controlChangeHandlers[1] = (ch, v, t) => ch.setModulationDepth(v, t);
controlChangeHandlers[5] = (ch, v, t) => ch.setPortamentoTime(v, t);
controlChangeHandlers[6] = (ch, v, t) => ch.dataEntryMSB(v, t);
controlChangeHandlers[7] = (ch, v, t) => ch.setVolume(v, t);
controlChangeHandlers[10] = (ch, v, t) => ch.setPan(v, t);
controlChangeHandlers[11] = (ch, v, t) => ch.setExpression(v, t);
controlChangeHandlers[32] = (ch, v, _t) => ch.setBankLSB(v);
controlChangeHandlers[38] = (ch, v, t) => ch.dataEntryLSB(v, t);
controlChangeHandlers[64] = (ch, v, t) => ch.setSustainPedal(v, t);
controlChangeHandlers[65] = (ch, v, t) => ch.setPortamento(v, t);
controlChangeHandlers[66] = (ch, v, t) => ch.setSostenutoPedal(v, t);
controlChangeHandlers[67] = (ch, v, t) => ch.setSoftPedal(v, t);
controlChangeHandlers[91] = (ch, v, t) => ch.setReverbSendLevel(v, t);
controlChangeHandlers[93] = (ch, v, t) => ch.setChorusSendLevel(v, t);
controlChangeHandlers[100] = (ch, v, _t) => ch.setRPNLSB(v);
controlChangeHandlers[101] = (ch, v, _t) => ch.setRPNMSB(v);
controlChangeHandlers[120] = (ch, _v, t) => ch.allSoundOff(t);
controlChangeHandlers[121] = (ch, _v, t) => ch.resetAllControllers(t);
controlChangeHandlers[123] = (ch, _v, t) => ch.allNotesOff(t);
controlChangeHandlers[124] = (ch, _v, t) => ch.omniOff(t);
controlChangeHandlers[125] = (ch, _v, t) => ch.omniOn(t);
controlChangeHandlers[126] = (ch, _v, t) => ch.monoOn(t);
controlChangeHandlers[127] = (ch, _v, t) => ch.polyOn(t);

const keyBasedControllerHandlers: KeyBasedHandler[] = new Array(128);
keyBasedControllerHandlers[7] = (channel, keyNumber, t) =>
  channel.player.updateKeyBasedVolume(channel, keyNumber, t);
keyBasedControllerHandlers[10] = (channel, keyNumber, t) =>
  channel.player.updateKeyBasedVolume(channel, keyNumber, t);
keyBasedControllerHandlers[91] = (channel, keyNumber, t) =>
  channel.processScheduledNotes((note) => {
    if (note.noteNumber === keyNumber) {
      channel.player.setReverbSend(channel, note, t);
    }
  });
keyBasedControllerHandlers[93] = (channel, keyNumber, t) =>
  channel.processScheduledNotes((note) => {
    if (note.noteNumber === keyNumber) {
      channel.player.setChorusSend(channel, note, t);
    }
  });

const effectHandlers: EffectHandler[] = new Array(6);
effectHandlers[0] = (channel, note, scheduleTime) => {
  if (channel.player.isPortamento(channel, note)) {
    channel.player.setPortamentoDetune(channel, note, scheduleTime);
  } else {
    channel.player.setDetune(channel, note, scheduleTime);
  }
};
effectHandlers[1] = (channel, note, scheduleTime) => {
  if (channel.player.isPortamento(channel, note)) {
    channel.player.ensureFilterEnvelopeNode(note);
    channel.player.setPortamentoFilterEnvelope(channel, note, scheduleTime);
  } else {
    channel.player.setFilterEnvelope(channel, note, scheduleTime);
  }
};
effectHandlers[2] = (channel, _note, scheduleTime) =>
  channel.player.applyVolume(channel, scheduleTime);
effectHandlers[3] = (channel, note, scheduleTime) =>
  channel.player.setModLfoToPitch(channel, note, scheduleTime);
effectHandlers[4] = (channel, note, scheduleTime) =>
  channel.player.setModLfoToFilterFc(channel, note, scheduleTime);
effectHandlers[5] = (channel, note, scheduleTime) =>
  channel.player.setModLfoToVolume(channel, note, scheduleTime);

type PressureTableName = "channelPressureTable";

type ReverbAlgorithm =
  | "Convolution"
  | "Schroeder"
  | "Moorer"
  | "FDN"
  | "Dattorro"
  | "Freeverb"
  | "VelvetNoise";
type ReverbEffect = { input: AudioNode; output: AudioNode };
type ChorusEffect = {
  input: GainNode;
  output: GainNode;
  sendGain: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  delayNodes: DelayNode[];
  feedbackGains: GainNode[];
};

export class MidyGM2 extends EventTarget {
  // https://pmc.ncbi.nlm.nih.gov/articles/PMC4191557/
  // https://pubmed.ncbi.nlm.nih.gov/12488797/
  // Gap detection studies indicate humans detect temporal discontinuities
  // around 2–3 ms. Smoothing over ~4 ms is perceived as continuous.
  perceptualSmoothingTime: number = 0.004;
  mode: string = "GM2";
  masterFineTuning: number = 0; // cent
  masterCoarseTuning: number = 0; // cent
  reverb = {
    algorithm: "Schroeder" as ReverbAlgorithm,
    time: this.getReverbTime(64),
    feedback: 0.8,
  };
  chorus = {
    modRate: this.getChorusModRate(3),
    modDepth: this.getChorusModDepth(19),
    feedback: this.getChorusFeedback(8),
    sendToReverb: this.getChorusSendToReverb(0),
    delayTimes: this.generateDistributedArray(0.02, 2, 0.5),
  };
  numChannels: number = 16;
  ticksPerBeat: number = 120;
  totalTime: number = 0;
  lastActiveSensing: number = 0;
  activeSensingThreshold: number = 0.3;
  noteCheckInterval: number = 0.1;
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
  startDelay: number = 0.1;
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
  instruments: Set<string> = new Set();
  exclusiveClassNotes: ([Note, Channel] | null)[] = new Array(128);
  drumExclusiveClassNotes: (Note | null)[] = new Array(
    16 * drumExclusiveClassCount,
  );
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

  // Required properties
  audioContext!: AudioContext | OfflineAudioContext;
  cacheMode!: CacheMode;
  masterVolume!: GainNode;
  scheduler!: GainNode;
  schedulerBuffer!: AudioBuffer;
  pendingSchedulerSources: Set<AudioBufferSourceNode> = new Set();
  channels!: Channel[];
  reverbEffect!: ReverbEffect;
  chorusEffect!: ChorusEffect;
  messageHandlers!: MessageHandler[];
  voiceParamsHandlers!: Record<string, VoiceParamsHandler>;
  controlChangeHandlers!: ControlChangeHandler[];
  effectHandlers!: EffectHandler[];
  keyBasedControllerHandlers!: KeyBasedHandler[];

  static channelSettings = {
    detune: 0,
    programNumber: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    modulationDepthRange: 50, // cent
    fineTuning: 0, // cent
    coarseTuning: 0, // cent
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
      this.scheduler = null as unknown as GainNode;
      this.schedulerBuffer = null as unknown as AudioBuffer;
      this.messageHandlers = [];
    } else {
      this.scheduler = new GainNode(audioContext, { gain: 0 });
      this.schedulerBuffer = new AudioBuffer({
        length: 1,
        sampleRate: audioContext.sampleRate,
      });
      this.messageHandlers = this.createMessageHandlers();
    }
    this.voiceParamsHandlers = voiceParamsHandlers;
    this.controlChangeHandlers = controlChangeHandlers;
    this.keyBasedControllerHandlers = keyBasedControllerHandlers;
    this.effectHandlers = effectHandlers;
    const activeChannelNumbers = options?.activeChannelNumbers
      ? new Set(options.activeChannelNumbers)
      : undefined;
    this.channels = this.createChannels(activeChannelNumbers);
    this.reverbEffect = this.createReverbEffect(this.reverb.algorithm);
    this.chorusEffect = this.createChorusEffect();
    this.chorusEffect.output.connect(this.masterVolume);
    this.reverbEffect.output.connect(this.masterVolume);
    this.masterVolume.connect(audioContext.destination);
    if (!isOffline) {
      this.scheduler.connect(audioContext.destination);
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
    this.voiceCounter.clear();
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
    const sostenutoPedal = new Uint8Array(numChannels);
    const sostenutoKeys = new Array(numChannels).fill(null).map(() =>
      new Set()
    );
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
          const isSostenuto = sostenutoKeys[ch].has(key);
          if (sustainPedal[ch] || isSostenuto) {
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
            case 66: { // Sostenuto Pedal
              const on = event.value! >= 64;
              if (on && !sostenutoPedal[ch]) {
                for (const [key] of activeNotes) {
                  if (key % numChannels === ch) sostenutoKeys[ch].add(key);
                }
              } else if (!on) {
                sostenutoKeys[ch].clear();
              }
              sostenutoPedal[ch] = on ? 1 : 0;
              break;
            }
            case 121: // Reset All Controllers
              sustainPedal[ch] = 0;
              sostenutoPedal[ch] = 0;
              sostenutoKeys[ch].clear();
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
            // GM1 System On / GM2 System On
            if (data[3] === 1 || data[3] === 3) {
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
        case "programChange":
        case "channelAftertouch": {
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
          const kitTable = drumExclusiveClassesByKit[channel.programNumber];
          const isExcludedDrum = channel.isDrum &&
            kitTable !== undefined &&
            kitTable[event.noteNumber!] !== 0;
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
        case "controller":
          if (event.controllerType === 0) {
            channels[event.channel!].setBankMSB(event.value!);
          } else if (event.controllerType === 32) {
            channels[event.channel!].setBankLSB(event.value!);
          }
          break;
        case "programChange":
          channels[event.channel!].setProgramChange(event.programNumber!);
      }
    }
    this.noteAudioBufferIds = noteAudioBufferIds;
    this.preloadEntries = preloadEntries;
    for (const [audioBufferId, count] of voiceCounter) {
      if (count === 1) voiceCounter.delete(audioBufferId);
    }
    this.GM2SystemOn(this.audioContext.currentTime);
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
    channel: Channel,
    noteNumber: number,
    velocity: number,
  ): number | undefined {
    const programNumber = channel.programNumber;
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return;
    let bank = channel.isDrum ? 128 : channel.bankLSB;
    if (bankTable[bank] === undefined) {
      if (channel.isDrum) return;
      bank = 0;
    }
    const soundFontIndex = bankTable[bank];
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(bank, programNumber, noteNumber, velocity);
    if (!voice) return;
    const { instrument, sampleID } = voice.generators;
    return soundFontIndex * (2 ** 31) + instrument * (2 ** 24) +
      (sampleID << 8);
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

  createChannels(activeChannelNumbers?: Set<number>): Channel[] {
    const settings = (this.constructor as typeof MidyGM2).channelSettings;
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
          const channel = new Channel(ch, settings, audioNodes);
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
          const channel = new Channel(ch, settings, audioNodes);
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

  isLoopDrum(channel: Channel, noteNumber: number): boolean {
    const programNumber = channel.programNumber;
    return ((programNumber === 48 && noteNumber === 88) ||
      (programNumber === 56 && 47 <= noteNumber && noteNumber <= 84));
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
    channel: Channel,
    noteNumber: number,
    voiceParams: VoiceParams,
    renderedOrRaw: RenderedBuffer | AudioBuffer,
  ): AudioBufferSourceNode {
    const isRendered = renderedOrRaw instanceof RenderedBuffer;
    const audioBuffer = isRendered ? renderedOrRaw.buffer : renderedOrRaw;
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    const isDrumLoop = channel.isDrum
      ? this.isLoopDrum(channel, noteNumber)
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
    channels?: Channel[];
    onNoteOn?:
      | ((channel: Channel, event: TimelineEvent, scheduleTime: number) => void)
      | null;
    onNoteOff?:
      | ((channel: Channel, event: TimelineEvent, scheduleTime: number) => void)
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
        break;
      case "channelAftertouch":
        channel.setChannelPressure(event.amount!, scheduleTime);
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
          const note = new Note(
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

  resetAllStates(): void {
    this.mode = "GM2";
    this.masterFineTuning = 0;
    this.masterCoarseTuning = 0;
    this.exclusiveClassNotes.fill(null);
    this.drumExclusiveClassNotes.fill(null);
    this.voiceCache.clear();
    this.realtimeVoiceCache.clear();
    this.adsrVoiceCache.clear();
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.lastNote = null;
      channel.activeNotes = new Array(128);
      channel.sustainNotes = [];
      channel.sostenutoNotes = [];
      channel.resetChannelStates();
    }
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
          await this.suspendAudioContext();
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

  private suspendAudioContext(): Promise<void> {
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
        0 < this.lastActiveSensing &&
        this.activeSensingThreshold < performance.now() - this.lastActiveSensing
      ) {
        await this.stopNotes(now);
        await this.suspendAudioContext();
        exitReason = "aborted";
        break;
      }
      if (
        this.totalTime < this.currentTime() ||
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
          await this.suspendAudioContext();
          exitReason = "ended";
          break;
        }
      }
      if (this.isPausing) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
        await this.suspendAudioContext();
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
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
      this.lastActiveSensing = 0;
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

  getSoundFontId(channel: Channel): string {
    const programNumber = channel.programNumber;
    const bankNumber = channel.isDrum ? 128 : channel.bankLSB;
    const bank = bankNumber.toString().padStart(3, "0");
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
          case "controller":
            switch (event.controllerType) {
              case 0:
                channels[event.channel!].setBankMSB(event.value!);
                break;
              case 32:
                channels[event.channel!].setBankLSB(event.value!);
                break;
            }
            break;
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
      sysEx: 1,
      noteOff: 2, // for portamento
      noteOn: 3,
    };
    timeline.sort((a, b) => {
      if (a.ticks !== b.ticks) return a.ticks - b.ticks;
      return (priority[a.type] ?? 4) - (priority[b.type] ?? 4);
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
    channel: Channel,
    scheduleTime: number,
  ): Promise<void> {
    const promises: Promise<void>[] = [];
    const timeConstant = this.perceptualSmoothingTime / 5;
    for (let i = 0; i < 128; i++) {
      const stack = channel.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        const promise = note.ready.then(() => {
          if (!note.voice || note.isSegmentGhost) return;
          const now = this.audioContext.currentTime;
          const startTime = Math.max(scheduleTime, now);
          (note.volumeNode as GainNode).gain
            .cancelScheduledValues(startTime)
            .setTargetAtTime(0, startTime, timeConstant);
          (note.bufferSource as AudioBufferSourceNode).stop(
            startTime + this.perceptualSmoothingTime,
          );
        });
        promises.push(promise);
      }
    }
    await Promise.all(promises);
    channel.lastNote = null;
    channel.activeNotes = new Array(128);
    channel.sustainNotes = [];
    this.notePromises = [];
  }

  async stopNotes(scheduleTime: number): Promise<void[]> {
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      await this.stopChannelNotes(channels[ch], scheduleTime);
    }
    const stopPromise = Promise.all(this.notePromises);
    this.notePromises = [];
    return stopPromise;
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
    while (true) {
      let allDone = true;
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (!state) continue;
        const pending = state.pending;
        for (let i = 0; i < pending.length; i++) {
          if (!pending[i].done) {
            allDone = false;
            break;
          }
        }
        if (!allDone) break;
      }
      if (allDone) break;
      const now = this.audioContext.currentTime;
      await this.scheduleTask(() => {}, now + this.noteCheckInterval);
    }
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

  closeSegment(state: SegmentChannelState, channel: Channel): void {
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

  startPendingSegment(channel: Channel, pending: PendingSegment): void {
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
  // instead of one context per channel. Channel volume/pan/expression are
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
    while (true) {
      if (state.pending.every((p) => p.done)) break;
      const now = this.audioContext.currentTime;
      await this.scheduleTask(() => {}, now + this.noteCheckInterval);
    }
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
    channel: Channel,
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
    // create a full MidyGMLite instance against the offline context but
    // immediately override suspend/resume so they don't throw.
    const allChannelNumbers = [...new Set(notes.map((n) => n.channelNumber))];
    const offlinePlayer = new (this.constructor as typeof MidyGM2)(
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
      const preNote = new Note(n.noteNumber, n.velocity, n.offset);
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
      const offlineNote = offlineNotes[i];
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

  generateDistributedArray(
    center: number,
    count: number,
    varianceRatio: number = 0.1,
    randomness: number = 0.05,
  ): number[] {
    const variance = center * varianceRatio;
    const array = new Array(count);
    for (let i = 0; i < count; i++) {
      const fraction = i / (count - 1 || 1);
      const value = center - variance + fraction * 2 * variance;
      array[i] = value * (1 - (Math.random() * 2 - 1) * randomness);
    }
    return array;
  }

  setReverbEffect(algorithm: ReverbAlgorithm): void {
    if (this.reverbEffect) this.reverbEffect.output.disconnect();
    this.reverbEffect = this.createReverbEffect(algorithm);
    this.reverb.algorithm = algorithm;
  }

  createReverbEffect(algorithm: ReverbAlgorithm): ReverbEffect {
    const { audioContext, reverb } = this;
    const { time: rt60, feedback } = reverb;
    switch (algorithm) {
      case "Convolution": {
        const impulse = createConvolutionReverbImpulse(
          audioContext,
          rt60,
          this.calcDelay(rt60, feedback),
        );
        return createConvolutionReverb(audioContext, impulse);
      }
      case "Schroeder": {
        const combFeedbacks = this.generateDistributedArray(feedback, 4);
        const combDelays = combFeedbacks.map((fb) => this.calcDelay(rt60, fb));
        const allpassFeedbacks = this.generateDistributedArray(feedback, 4);
        const allpassDelays = allpassFeedbacks.map((fb) =>
          this.calcDelay(rt60, fb)
        );
        return createSchroederReverb(
          audioContext,
          combFeedbacks,
          combDelays,
          allpassFeedbacks,
          allpassDelays,
        );
      }
      case "Moorer":
        return createMoorerReverbDefault(audioContext, {
          rt60,
          damping: 1 - feedback,
        });
      case "FDN":
        return createFDNDefault(audioContext, { rt60, damping: 1 - feedback });
      case "Dattorro": {
        const decay = feedback * 0.28 + 0.7;
        return createDattorroReverb(audioContext, {
          decay,
          damping: 1 - feedback,
        });
      }
      case "Freeverb": {
        const damping = 1 - feedback;
        const { inputL, inputR, outputL, outputR } = createFreeverb(
          audioContext,
          { roomSize: feedback, damping },
        );
        const inputMerger = new GainNode(audioContext);
        const outputMerger = new GainNode(audioContext, { gain: 0.5 });
        inputMerger.connect(inputL);
        inputMerger.connect(inputR);
        outputL.connect(outputMerger);
        outputR.connect(outputMerger);
        return { input: inputMerger, output: outputMerger };
      }
      case "VelvetNoise":
        return createVelvetNoiseReverb(audioContext, rt60);
      default:
        throw new Error(`Unknown reverb algorithm: ${algorithm}`);
    }
  }

  createChorusEffect(): ChorusEffect {
    const audioContext = this.audioContext;
    const input = new GainNode(audioContext);
    const output = new GainNode(audioContext);
    const sendGain = new GainNode(audioContext);
    const lfo = new OscillatorNode(audioContext, {
      frequency: this.chorus.modRate,
    });
    const lfoGain = new GainNode(audioContext, {
      gain: this.chorus.modDepth / 2,
    });
    const delayTimes = this.chorus.delayTimes;
    const delayNodes: DelayNode[] = [];
    const feedbackGains: GainNode[] = [];
    for (let i = 0; i < delayTimes.length; i++) {
      const delayTime = delayTimes[i];
      const delayNode = new DelayNode(audioContext, {
        maxDelayTime: 0.1, // generally, 5ms < delayTime < 50ms
        delayTime,
      });
      const feedbackGain = new GainNode(audioContext, {
        gain: this.chorus.feedback,
      });
      delayNodes.push(delayNode);
      feedbackGains.push(feedbackGain);
      input.connect(delayNode);
      lfoGain.connect(delayNode.delayTime);
      delayNode.connect(feedbackGain);
      feedbackGain.connect(delayNode);
      delayNode.connect(output);
    }
    output.connect(sendGain);
    lfo.connect(lfoGain);
    lfo.start();
    return {
      input,
      output,
      sendGain,
      lfo,
      lfoGain,
      delayNodes,
      feedbackGains,
    };
  }

  resolveVoice(
    channel: Channel,
    noteNumber: number,
    velocity: number,
  ): Voice | null {
    const programNumber = channel.programNumber;
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return null;
    let bank = channel.isDrum ? 128 : channel.bankLSB;
    if (bankTable[bank] === undefined) {
      if (channel.isDrum) return null;
      bank = 0;
    }
    const soundFontIndex = bankTable[bank];
    if (soundFontIndex === undefined) return null;
    return this.soundFonts[soundFontIndex].getVoice(
      bank,
      programNumber,
      noteNumber,
      velocity,
    );
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
    const settings = (this.constructor as typeof MidyGM2).channelSettings;
    const renderChannels = Array.from({ length: this.numChannels }, (_, ch) => {
      const channel = new Channel(ch, settings);
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
        onNoteOn: (renderChannel: Channel, event: TimelineEvent) => {
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
            this.getControllerState(renderChannel, noteNumber!, velocity!),
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
    if (this.isPlaying || this.isPaused) return;
    this.resumeTime = 0;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    if (preload) await this.preloadSamples();
    this.playPromise = this.playNotes();
    await this.playPromise;
  }

  async stop(): Promise<void> {
    if (!this.isPlaying) return;
    this.isStopping = true;
    await this.playPromise;
  }

  async pause(): Promise<void> {
    if (!this.isPlaying || this.isPaused) return;
    const now = this.audioContext.currentTime;
    this.resumeTime = now + this.resumeTime - this.startTime;
    this.isPausing = true;
    await this.playPromise;
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    this.playPromise = this.playNotes();
    await this.playPromise;
  }

  seekTo(second: number): void {
    this.resumeTime = second;
    if (this.isPlaying) {
      this.isSeeking = true;
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

  calcChannelDetune(channel: Channel): number {
    const masterTuning = channel.isDrum
      ? 0
      : this.masterCoarseTuning + this.masterFineTuning;
    const channelTuning = channel.coarseTuning + channel.fineTuning;
    const tuning = masterTuning + channelTuning;
    const pitchWheel = channel.state.pitchWheel * 2 - 1;
    const pitchWheelSensitivity = channel.state.pitchWheelSensitivity * 12800;
    const pitch = pitchWheel * pitchWheelSensitivity;
    const effect = this.getChannelPitchControl(channel);
    return tuning + pitch + effect;
  }

  updateChannelDetune(channel: Channel, scheduleTime: number): void {
    channel.processScheduledNotes((note) => {
      if (note.renderedBuffer?.isFull || note.isSegmentGhost) return;
      if (this.isPortamento(channel, note)) {
        this.setPortamentoDetune(channel, note, scheduleTime);
      } else {
        this.setDetune(channel, note, scheduleTime);
      }
    });
  }

  calcScaleOctaveTuning(channel: Channel, note: Note): number {
    return channel.scaleOctaveTuningTable[note.noteNumber % 12];
  }

  calcNoteDetune(channel: Channel, note: Note): number {
    const noteDetune = (note.voiceParams?.detune || 0) +
      this.calcScaleOctaveTuning(channel, note);
    return channel.detune + noteDetune;
  }

  getPortamentoTime(channel: Channel, note: Note): number {
    const deltaSemitone = Math.abs(note.noteNumber - note.portamentoNoteNumber);
    const value = Math.ceil(channel.state.portamentoTimeMSB * 127);
    return deltaSemitone / this.getPitchIncrementSpeed(value) / 10;
  }

  getPitchIncrementSpeed(value: number): number {
    const points = [
      [0, 1000],
      [6, 100],
      [16, 20],
      [32, 10],
      [48, 5],
      [64, 2.5],
      [80, 1],
      [96, 0.4],
      [112, 0.15],
      [127, 0.01],
    ];
    const logPoints = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      if (value === x) return y;
      logPoints[i] = [x, Math.log(y)];
    }
    let startIndex = 0;
    for (let i = 1; i < logPoints.length; i++) {
      if (value <= logPoints[i][0]) {
        startIndex = i - 1;
        break;
      }
    }
    const [x0, y0] = logPoints[startIndex];
    const [x1, y1] = logPoints[startIndex + 1];
    const h = x1 - x0;
    const t = (value - x0) / h;
    let m0, m1;
    if (startIndex === 0) {
      m0 = (y1 - y0) / h;
    } else {
      const [xPrev, yPrev] = logPoints[startIndex - 1];
      m0 = (y1 - yPrev) / (x1 - xPrev);
    }
    if (startIndex === logPoints.length - 2) {
      m1 = (y1 - y0) / h;
    } else {
      const [xNext, yNext] = logPoints[startIndex + 2];
      m1 = (yNext - y0) / (xNext - x0);
    }
    // Cubic Hermite Spline
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y = h00 * y0 + h01 * y1 + h * (h10 * m0 + h11 * m1);
    return Math.exp(y);
  }

  setPortamentoVolumeEnvelope(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    const { voiceParams, startTime } = note;
    if (!voiceParams) return;
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getAmplitudeControl(channel));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const portamentoTime = startTime + this.getPortamentoTime(channel, note);
    note.volumeEnvelopeNode?.gain
      .cancelScheduledValues(scheduleTime)
      .exponentialRampToValueAtTime(sustainVolume, portamentoTime);
  }

  setVolumeEnvelope(channel: Channel, note: Note, scheduleTime: number): void {
    if (!note.volumeEnvelopeNode) return;
    const { voiceParams, startTime } = note;
    if (!voiceParams) return;
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getAmplitudeControl(channel));
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

  setPortamentoDetune(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    const detune = this.calcNoteDetune(channel, note);
    const startTime = note.startTime;
    const deltaCent = (note.noteNumber - note.portamentoNoteNumber) * 100;
    const portamentoTime = startTime + this.getPortamentoTime(channel, note);
    note.bufferSource?.detune
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(detune - deltaCent, scheduleTime)
      .linearRampToValueAtTime(detune, portamentoTime);
  }

  setDetune(channel: Channel, note: Note, scheduleTime: number): void {
    const detune = this.calcNoteDetune(channel, note);
    const timeConstant = this.perceptualSmoothingTime / 5;
    (note.bufferSource as AudioBufferSourceNode).detune
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(detune, scheduleTime, timeConstant);
  }

  setPortamentoPitchEnvelope(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    const baseRate = note.voiceParams?.playbackRate;
    if (baseRate == null) return;
    const portamentoTime = note.startTime +
      this.getPortamentoTime(channel, note);
    note.bufferSource?.playbackRate
      .cancelScheduledValues(scheduleTime)
      .exponentialRampToValueAtTime(baseRate, portamentoTime);
  }

  setPitchEnvelope(note: Note, scheduleTime: number): void {
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

  ensureFilterEnvelopeNode(note: Note): void {
    if (note.filterEnvelopeNode) return;
    const { voiceParams, bufferSource, volumeEnvelopeNode } = note;
    if (!voiceParams || !bufferSource || !volumeEnvelopeNode) return;

    const filter = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10,
    });
    note.filterEnvelopeNode = filter;

    bufferSource.disconnect(volumeEnvelopeNode);
    bufferSource.connect(filter);
    filter.connect(volumeEnvelopeNode);

    if (note.modLfoToFilterFc) {
      note.modLfoToFilterFc.connect(filter.frequency);
    }
  }

  setPortamentoFilterEnvelope(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    if (!note.filterEnvelopeNode) return;
    const { voiceParams, startTime } = note;
    if (!voiceParams) return;
    const scale = this.getSoftPedalFactor(channel, note);
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel);
    const sustainCent = baseCent +
      voiceParams.modEnvToFilterFc * (1 - voiceParams.modSustain);
    const baseFreq = this.centToHz(baseCent) * scale;
    const sustainFreq = this.centToHz(sustainCent) * scale;
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const portamentoTime = startTime + this.getPortamentoTime(channel, note);
    const modDelay = startTime + voiceParams.modDelay;
    note.adjustedBaseFreq = adjustedSustainFreq;
    note.filterEnvelopeNode.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .exponentialRampToValueAtTime(adjustedSustainFreq, portamentoTime);
  }

  setFilterEnvelope(channel: Channel, note: Note, scheduleTime: number): void {
    if (!note.filterEnvelopeNode) return;
    const { voiceParams, startTime } = note;
    if (!voiceParams) return;
    const modEnvToFilterFc = voiceParams.modEnvToFilterFc;
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel);
    const peekCent = baseCent + modEnvToFilterFc;
    const sustainCent = baseCent +
      modEnvToFilterFc * (1 - voiceParams.modSustain);
    const softPedalFactor = this.getSoftPedalFactor(channel, note);
    const baseFreq = this.centToHz(baseCent) * softPedalFactor;
    const peekFreq = this.centToHz(peekCent) * softPedalFactor;
    const sustainFreq = this.centToHz(sustainCent) * softPedalFactor;
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

  startModulation(channel: Channel, note: Note, scheduleTime: number): void {
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

  startVibrato(channel: Channel, note: Note, scheduleTime: number): void {
    const audioContext = this.audioContext;
    const { voiceParams } = note;
    if (!voiceParams) return;
    note.vibLfo = new OscillatorNode(audioContext, {
      frequency: this.centToHz(voiceParams.freqVibLFO),
    });
    note.vibLfo.start(note.startTime + voiceParams.delayVibLFO);
    note.vibLfoToPitch = new GainNode(audioContext);
    this.setVibLfoToPitch(channel, note, scheduleTime);
    note.vibLfo.connect(note.vibLfoToPitch);
    note.vibLfoToPitch.connect(note.bufferSource!.detune);
  }

  async createAdsRenderedBuffer(
    channel: Channel,
    note: Note,
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
    );
    this.setVolumeEnvelope(channel, offlineNote, 0);
    if (filterEnvelopeNode) {
      this.setFilterEnvelope(channel, offlineNote, 0);
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
    channel: Channel,
    note: Note,
    voiceParams: VoiceParams,
    audioBuffer: AudioBuffer,
    noteDuration: number,
  ): Promise<RenderedBuffer> {
    const isLoop = voiceParams.sampleModes % 2 !== 0;
    const volAttack = voiceParams.volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    const adsDuration = volHold + decayDuration * envelopeCurve * 5;
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
    );
    this.setVolumeEnvelope(channel, offlineNote, 0);
    this.setFilterEnvelope(channel, offlineNote, 0);

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
    if (isLoop) {
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
  // Channel volume/pan/expression are intentionally NOT baked in (same as
  // before): each note's volumeNode is rewired to bypass the channel bus
  // and connect straight to the offline destination, so the combined
  // segment buffer stays mixable through the real channel.gainL/gainR in
  // real time.
  async renderSegmentBuffer(
    channel: Channel,
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
    const offlinePlayer = new (this.constructor as typeof MidyGM2)(
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
      const preNote = new Note(n.noteNumber, n.velocity, n.offset);
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
      const offlineNote = offlineNotes[i];
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
    channel: Channel,
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
    const offlinePlayer = new (this.constructor as typeof MidyGM2)(
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
    channel: Channel,
    note: Note,
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
    channel: Channel,
    note: Note,
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
    channel: Channel,
    note: Note,
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
    channel: Channel,
    note: Note,
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
    channel: Channel,
    note: Note,
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
    const isRendered = audioBuffer instanceof RenderedBuffer;
    note.renderedBuffer = isRendered ? audioBuffer : null;
    note.bufferSource = this.createBufferSource(
      channel,
      noteNumber,
      voiceParams,
      audioBuffer as RenderedBuffer | AudioBuffer,
    );
    note.volumeNode = new GainNode(audioContext);

    const cacheMode = this.cacheMode;
    const isFullCached = isRendered &&
      (audioBuffer as RenderedBuffer).isFull === true;
    if (cacheMode === "none") {
      note.volumeEnvelopeNode = new GainNode(audioContext);
      const prevNote = channel.lastNote;
      if (prevNote && prevNote.noteNumber !== noteNumber) {
        note.portamentoNoteNumber = prevNote.noteNumber;
      }
      const isPortamento = !channel.isDrum && this.isPortamento(channel, note);
      const filterIsAudible = voiceParams.modEnvToFilterFc !== 0 ||
        voiceParams.initialFilterFc < FULLY_OPEN_FILTER_CENTS ||
        isPortamento;
      note.filterEnvelopeNode = filterIsAudible
        ? new BiquadFilterNode(audioContext, {
          type: "lowpass",
          Q: voiceParams.initialFilterQ / 10,
        })
        : null;
      if (isPortamento) {
        this.setPortamentoVolumeEnvelope(channel, note, now);
        this.setPortamentoFilterEnvelope(channel, note, now);
        this.setPortamentoPitchEnvelope(channel, note, now);
        this.setPortamentoDetune(channel, note, now);
      } else {
        this.setVolumeEnvelope(channel, note, now);
        if (note.filterEnvelopeNode) this.setFilterEnvelope(channel, note, now);
        this.setPitchEnvelope(note, now);
        this.setDetune(channel, note, now);
      }
      this.startVibrato(channel, note, now);
      const modLfoIsAudible = voiceParams.modLfoToPitch !== 0 ||
        voiceParams.modLfoToFilterFc !== 0 ||
        voiceParams.modLfoToVolume !== 0;
      if (modLfoIsAudible && 0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      if (channel.mono && channel.currentBufferSource) {
        channel.currentBufferSource.stop(startTime);
        channel.currentBufferSource = note.bufferSource;
      }
      if (note.filterEnvelopeNode) {
        note.bufferSource.connect(note.filterEnvelopeNode);
        note.filterEnvelopeNode.connect(note.volumeEnvelopeNode);
      } else {
        note.bufferSource.connect(note.volumeEnvelopeNode);
      }
      note.volumeEnvelopeNode.connect(note.volumeNode);
      this.setChorusSend(channel, note, now);
      this.setReverbSend(channel, note, now);
    } else if (isFullCached) { // "note" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      note.bufferSource.connect(note.volumeNode);
      this.setChorusSend(channel, note, now);
      this.setReverbSend(channel, note, now);
    } else { // "ads" / "asdr" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      this.setDetune(channel, note, now);
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      note.bufferSource.connect(note.volumeNode);
      this.setChorusSend(channel, note, now);
      this.setReverbSend(channel, note, now);
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

  handleExclusiveClass(note: Note, channel: Channel, startTime: number): void {
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
    note: Note,
    channel: Channel,
    startTime: number,
  ): void {
    if (!channel.isDrum) return;
    const kitTable = drumExclusiveClassesByKit[channel.programNumber];
    if (!kitTable) return;
    const drumExclusiveClass = kitTable[note.noteNumber];
    if (drumExclusiveClass === 0) return;
    const index = (drumExclusiveClass - 1) * this.channels.length +
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

  setNoteRouting(channel: Channel, note: Note, startTime: number): void {
    const { volumeNode } = note;
    if (!volumeNode) return;
    if (note.renderedBuffer?.isFull) {
      volumeNode.connect((this.masterVolume as unknown) as AudioNode);
    } else {
      if (channel.isDrum) {
        const noteNumber = note.noteNumber;
        const { keyBasedGainLs, keyBasedGainRs } = channel;
        let gainL = keyBasedGainLs[noteNumber];
        let gainR = keyBasedGainRs[noteNumber];
        if (!gainL) {
          const audioNodes = this.createChannelAudioNodes(this.audioContext);
          gainL = keyBasedGainLs[noteNumber] = audioNodes.gainL;
          gainR = keyBasedGainRs[noteNumber] = audioNodes.gainR;
        }
        volumeNode.connect(gainL);
        volumeNode.connect(gainR);
      } else {
        volumeNode.connect(channel.gainL);
        volumeNode.connect(channel.gainR);
      }
    }
    this.handleExclusiveClass(note, channel, startTime);
    this.handleDrumExclusiveClass(note, channel, startTime);
  }

  async noteOnChannel(
    channel: Channel,
    noteNumber: number,
    velocity: number,
    startTime: number | undefined,
    note?: Note,
  ): Promise<Note | void> {
    const t: number = startTime ?? this.audioContext.currentTime;
    const realtime = startTime === undefined;
    if (!note) note = new Note(noteNumber, velocity, t);
    if (!note.voice) {
      const programNumber = channel.programNumber;
      const bankTable = this.soundFontTable[programNumber];
      if (!bankTable) return;
      let bank = channel.isDrum ? 128 : channel.bankLSB;
      if (bankTable[bank] === undefined) {
        if (channel.isDrum) return;
        bank = 0;
      }
      const soundFontIndex = bankTable[bank];
      if (soundFontIndex === undefined) return;
      const soundFont = this.soundFonts[soundFontIndex];
      note.voice = soundFont.getVoice(
        bank,
        programNumber,
        noteNumber,
        velocity,
      );
    }
    if (!note.voice) return;
    if (!channel.activeNotes[noteNumber]) {
      channel.activeNotes[noteNumber] = [];
    }
    channel.activeNotes[noteNumber].push(note);
    await this.setNoteAudioNode(channel, note, realtime);
    channel.lastNote = note;
    this.setNoteRouting(channel, note, t);
    note.resolveReady();
    if (0.5 <= channel.state.sustainPedal) channel.sustainNotes.push(note);
    return note;
  }

  disconnectNote(note: Note): void {
    note.bufferSource?.disconnect();
    note.filterEnvelopeNode?.disconnect();
    note.volumeEnvelopeNode?.disconnect();
    note.volumeNode?.disconnect();
    if (note.modLfoToPitch) {
      note.modLfoToFilterFc?.disconnect();
      note.modLfoToVolume?.disconnect?.();
      note.modLfoToPitch?.disconnect?.();
      note.modLfo?.stop();
    }
    if (note.vibLfoToPitch) {
      note.vibLfoToPitch.disconnect();
      note.vibLfo?.stop();
    }
    if (note.reverbSend) {
      note.reverbSend.disconnect();
    }
    if (note.chorusSend) {
      note.chorusSend.disconnect();
    }
  }

  releaseFullCache(note: Note): void {
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

  releaseNote(note: Note, endTime: number): Promise<void> | void {
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
        note.volumeNode?.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
        note.bufferSource?.stop(volRelease);
      } else {
        if (naturalEndTime <= now) {
          this.disconnectNote(note);
          this.releaseFullCache(note);
          return;
        }
        note.bufferSource?.stop(naturalEndTime);
      }
      return new Promise<void>((resolve) => {
        note.bufferSource!.onended = () => {
          this.disconnectNote(note);
          this.releaseFullCache(note);
          resolve();
        };
      });
    }
    const volDuration = note.voiceParams?.volRelease ?? 0;
    const volRelease = endTime + volDuration;
    if (note.volumeEnvelopeNode) { // "none" mode
      note.filterEnvelopeNode?.frequency
        .cancelScheduledValues(endTime)
        .exponentialRampToValueAtTime(
          note.adjustedBaseFreq,
          endTime + (note.voiceParams?.modRelease ?? 0),
        );
      note.volumeEnvelopeNode.gain
        .cancelScheduledValues(endTime)
        .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
    } else { // "ads" / "adsr" mode
      const isAdsr = note.renderedBuffer?.releaseDuration != null &&
        !note.renderedBuffer.isFull;
      if (isAdsr) {
        const rb = note.renderedBuffer!;
        const naturalEndTime = note.startTime + rb.buffer.duration;
        const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
        const isEarlyCut = endTime < noteOffTime;
        if (isEarlyCut) {
          note.volumeNode?.gain
            .cancelScheduledValues(endTime)
            .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
          note.bufferSource?.stop(volRelease);
        } else {
          if (naturalEndTime <= now) {
            this.disconnectNote(note);
            return;
          }
          note.bufferSource?.stop(naturalEndTime);
        }
        return new Promise<void>((resolve) => {
          note.bufferSource!.onended = () => {
            this.disconnectNote(note);
            resolve();
          };
        });
      }
      note.volumeNode?.gain
        .cancelScheduledValues(endTime)
        .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
    }
    note.bufferSource?.stop(volRelease);
    return new Promise<void>((resolve) => {
      note.bufferSource!.onended = () => {
        this.disconnectNote(note);
        resolve();
      };
    });
  }

  noteOffChannel(
    channel: Channel,
    noteNumber: number,
    _velocity: number,
    endTime: number,
    force: boolean,
  ): Promise<void> | void {
    if (!force) {
      if (channel.isDrum && !this.isLoopDrum(channel, noteNumber)) {
        this.removeFromActiveNotes(channel, noteNumber);
        return;
      }
      const state = channel.state;
      if (0.5 <= state.sustainPedal) return;
      const heldBySostenuto = channel.sostenutoNotes.some(
        (n) => n.noteNumber === noteNumber && !n.ending,
      );
      if (0.5 <= state.sostenutoPedal && heldBySostenuto) return;
    }
    const note = this.findNoteForOff(channel, noteNumber);
    if (!note) return;
    note.ending = true;
    this.removeFromActiveNotes(channel, noteNumber);
    const promise = note.ready.then(() => {
      if (!note.voice) return;
      return this.releaseNote(note, endTime);
    });
    this.notePromises.push(promise);
    return promise;
  }

  findNoteForOff(channel: Channel, noteNumber: number): Note | undefined {
    const stack = channel.activeNotes[noteNumber];
    if (!stack) return;
    for (let i = 0; i < stack.length; i++) {
      if (!stack[i]?.ending) return stack[i];
    }
  }

  removeFromActiveNotes(channel: Channel, noteNumber: number): void {
    const stack = channel.activeNotes[noteNumber];
    if (!stack || stack.length === 0) return;
    stack.shift();
  }

  releaseSustainPedal(
    channel: Channel,
    halfVelocity: number,
    scheduleTime: number,
  ): (Promise<void> | void)[] {
    const velocity = halfVelocity * 2;
    const promises: (Promise<void> | void)[] = [];
    for (let i = 0; i < channel.sustainNotes.length; i++) {
      const note = channel.sustainNotes[i];
      const heldBySostenuto = channel.sostenutoNotes.some(
        (n) => n === note && !n.ending,
      );
      if (heldBySostenuto) continue;
      const promise = channel.noteOff(
        note.noteNumber,
        velocity,
        scheduleTime,
        true,
      );
      promises.push(promise);
    }
    channel.sustainNotes = [];
    return promises;
  }

  releaseSostenutoPedal(
    channel: Channel,
    halfVelocity: number,
    scheduleTime: number,
  ): (Promise<void> | void)[] {
    const velocity = halfVelocity * 2;
    const sostenutoNotes = channel.sostenutoNotes;
    const promises: (Promise<void> | void)[] = [];
    for (let i = 0; i < sostenutoNotes.length; i++) {
      const note = sostenutoNotes[i];
      const promise = channel.noteOff(
        note.noteNumber,
        velocity,
        scheduleTime,
        true,
      );
      promises.push(promise);
    }
    channel.sostenutoNotes = [];
    return promises;
  }

  soundOffNote(note: Note, scheduleTime: number): Promise<void> {
    note.ending = true;
    if (!note.voice || note.isSegmentGhost) return Promise.resolve();
    const now = this.audioContext.currentTime;
    const startTime = Math.max(scheduleTime, now);
    const perceptualSmoothingTime = this.perceptualSmoothingTime;
    const timeConstant = perceptualSmoothingTime / 5;
    note.volumeNode?.gain
      .cancelScheduledValues(startTime)
      .setTargetAtTime(0, startTime, timeConstant);
    note.bufferSource?.stop(startTime + perceptualSmoothingTime);
    return new Promise((resolve) => {
      note.bufferSource!.onended = () => {
        this.disconnectNote(note);
        resolve();
      };
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
    // Channel Message
    handlers[0x80] = (data, t) =>
      this.channels[data[0] & 0x0F].noteOff(data[1], data[2], t);
    handlers[0x90] = (data, t) =>
      this.channels[data[0] & 0x0F].noteOn(data[1], data[2], t);
    handlers[0xB0] = (data, t) =>
      this.channels[data[0] & 0x0F].setControlChange(data[1], data[2], t);
    handlers[0xC0] = (data, _t) =>
      this.channels[data[0] & 0x0F].setProgramChange(data[1]);
    handlers[0xD0] = (data, t) =>
      this.channels[data[0] & 0x0F].setChannelPressure(data[1], t);
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

  activeSensing(): void {
    this.lastActiveSensing = performance.now();
  }

  setModLfoToPitch(channel: Channel, note: Note, scheduleTime: number): void {
    if (note.modLfoToPitch) {
      const modLfoToPitch = (note.voiceParams?.modLfoToPitch ?? 0) +
        this.getLFOPitchDepth(channel);
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

  setVibLfoToPitch(channel: Channel, note: Note, scheduleTime: number): void {
    if (note.vibLfoToPitch) {
      const vibLfoToPitch = note.voiceParams?.vibLfoToPitch ?? 0;
      const baseDepth = Math.abs(vibLfoToPitch);
      const depth = baseDepth * Math.sign(vibLfoToPitch);
      note.vibLfoToPitch.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(depth, scheduleTime);
    } else {
      this.startVibrato(channel, note, scheduleTime);
    }
  }

  setModLfoToFilterFc(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    const modLfoToFilterFc = (note.voiceParams?.modLfoToFilterFc ?? 0) +
      this.getLFOFilterDepth(channel);
    const timeConstant = this.perceptualSmoothingTime / 5;
    note.modLfoToFilterFc?.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(modLfoToFilterFc, scheduleTime, timeConstant);
  }

  setModLfoToVolume(channel: Channel, note: Note, scheduleTime: number): void {
    const modLfoToVolume = note.voiceParams?.modLfoToVolume ?? 0;
    const baseDepth = cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const depth = baseDepth * Math.sign(modLfoToVolume) *
      (1 + this.getLFOAmplitudeDepth(channel));
    const timeConstant = this.perceptualSmoothingTime / 5;
    note.modLfoToVolume?.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(depth, scheduleTime, timeConstant);
  }

  setReverbSend(channel: Channel, note: Note, scheduleTime: number): void {
    let value = (note.voiceParams?.reverbEffectsSend ?? 0) *
      channel.state.reverbSendLevel;
    if (channel.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel, note.noteNumber, 91);
      if (0 <= keyBasedValue) value = keyBasedValue / 127;
    }
    if (!note.reverbSend) {
      if (0 < value) {
        note.reverbSend = new GainNode(this.audioContext, { gain: value });
        note.volumeNode?.connect(note.reverbSend);
        note.reverbSend.connect(this.reverbEffect.input);
      }
    } else {
      note.reverbSend.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(value, scheduleTime);
      if (0 < value) {
        note.volumeNode?.connect(note.reverbSend);
      } else {
        try {
          note.volumeNode?.disconnect(note.reverbSend);
        } catch { /* empty */ }
      }
    }
  }

  setChorusSend(channel: Channel, note: Note, scheduleTime: number): void {
    let value = (note.voiceParams?.chorusEffectsSend ?? 0) *
      channel.state.chorusSendLevel;
    if (channel.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel, note.noteNumber, 93);
      if (0 <= keyBasedValue) value = keyBasedValue / 127;
    }
    if (!note.chorusSend) {
      if (0 < value) {
        note.chorusSend = new GainNode(this.audioContext, { gain: value });
        note.volumeNode?.connect(note.chorusSend);
        note.chorusSend.connect(this.chorusEffect.input);
      }
    } else {
      note.chorusSend.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(value, scheduleTime);
      if (0 < value) {
        note.volumeNode?.connect(note.chorusSend);
      } else {
        try {
          note.volumeNode?.disconnect(note.chorusSend);
        } catch { /* empty */ }
      }
    }
  }

  setDelayModLFO(note: Note): void {
    const startTime = note.startTime + (note.voiceParams?.delayModLFO ?? 0);
    try {
      note.modLfo?.start(startTime);
    } catch { /* empty */ }
  }

  setFreqModLFO(note: Note, scheduleTime: number): void {
    const freqModLFO = note.voiceParams?.freqModLFO ?? 0;
    note.modLfo?.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(freqModLFO, scheduleTime);
  }

  setDelayVibLFO(note: Note): void {
    const value = note.voiceParams?.delayVibLFO ?? 0;
    const startTime = note.startTime + value;
    try {
      note.vibLfo?.start(startTime);
    } catch { /* empty */ }
  }

  setFreqVibLFO(note: Note, scheduleTime: number): void {
    const freqVibLFO = note.voiceParams?.freqVibLFO ?? 0;
    note.vibLfo?.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(freqVibLFO, scheduleTime);
  }

  getControllerState(
    channel: Channel,
    noteNumber: number,
    velocity: number,
  ): Float32Array {
    const state = new Float32Array(channel.state.array.length);
    state.set(channel.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    return state;
  }

  applyVoiceParams(
    channel: Channel,
    controllerType: number,
    scheduleTime: number,
  ): void {
    channel.processScheduledNotes((note: Note) => {
      if (note.renderedBuffer?.isFull || note.isSegmentGhost) return;
      const controllerState = this.getControllerState(
        channel,
        note.noteNumber,
        note.velocity,
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

  updateModulation(channel: Channel, scheduleTime: number): void {
    const depth = channel.state.modulationDepthMSB *
      channel.modulationDepthRange;
    const timeConstant = this.perceptualSmoothingTime / 5;
    channel.processScheduledNotes((note: Note) => {
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

  updatePortamento(channel: Channel, scheduleTime: number): void {
    if (channel.isDrum) return;
    channel.processScheduledNotes((note) => {
      if (this.isPortamento(channel, note)) {
        this.ensureFilterEnvelopeNode(note);
        this.setPortamentoVolumeEnvelope(channel, note, scheduleTime);
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
        this.setPortamentoPitchEnvelope(channel, note, scheduleTime);
        this.setPortamentoDetune(channel, note, scheduleTime);
      } else {
        this.setVolumeEnvelope(channel, note, scheduleTime);
        this.setFilterEnvelope(channel, note, scheduleTime);
        this.setPitchEnvelope(note, scheduleTime);
        this.setDetune(channel, note, scheduleTime);
      }
    });
  }

  applyVolume(channel: Channel, scheduleTime: number): void {
    if (channel.isDrum) {
      for (let i = 0; i < 128; i++) {
        this.updateKeyBasedVolume(channel, i, scheduleTime);
      }
    } else {
      this.updateChannelVolume(channel, scheduleTime);
    }
  }

  panToGain(pan: number): { gainLeft: number; gainRight: number } {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  updateChannelVolume(channel: Channel, scheduleTime: number): void {
    if (!channel.gainL) return;
    const state = channel.state;
    const effect = this.getChannelAmplitudeControl(channel);
    const gain = state.volumeMSB * state.expressionMSB * (1 + effect);
    const { gainLeft, gainRight } = this.panToGain(state.panMSB);
    const timeConstant = this.perceptualSmoothingTime / 5;
    channel.gainL.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(gain * gainLeft, scheduleTime, timeConstant);
    channel.gainR.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(gain * gainRight, scheduleTime, timeConstant);
  }

  updateKeyBasedVolume(
    channel: Channel,
    keyNumber: number,
    scheduleTime: number,
  ): void {
    const gainL = channel.keyBasedGainLs[keyNumber];
    if (!gainL) return;
    const gainR = channel.keyBasedGainRs[keyNumber];
    const state = channel.state;
    const defaultGain = state.volumeMSB * state.expressionMSB;
    const defaultPan = state.panMSB;
    const keyBasedVolume = this.getKeyBasedValue(channel, keyNumber, 7);
    const gain = (0 <= keyBasedVolume)
      ? defaultGain * keyBasedVolume / 64
      : defaultGain;
    const keyBasedPan = this.getKeyBasedValue(channel, keyNumber, 10);
    const pan = (0 <= keyBasedPan) ? keyBasedPan / 127 : defaultPan;
    const { gainLeft, gainRight } = this.panToGain(pan);
    gainL.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainLeft, scheduleTime);
    gainR.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainRight, scheduleTime);
  }

  isPortamento(channel: Channel, note: Note): boolean {
    return 0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber;
  }

  getSoftPedalFactor(channel: Channel, note: Note): number {
    return 1 - (0.1 + (note.noteNumber / 127) * 0.2) * channel.state.softPedal;
  }

  handleUniversalNonRealTimeExclusiveMessage(
    data: Uint8Array,
    scheduleTime: number,
    channels: Channel[] = this.channels,
  ): void {
    switch (data[2]) {
      case 8:
        switch (data[3]) {
          case 8:
            // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca21.pdf
            return this.handleScaleOctaveTuning1ByteFormatSysEx(
              data,
              false,
              scheduleTime,
            );
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          case 1:
            this.GM1SystemOn(scheduleTime, channels);
            break;
          case 2: // GM System Off
            break;
          case 3:
            this.GM2SystemOn(scheduleTime, channels);
            break;
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  GM1SystemOn(scheduleTime: number, channels: Channel[] = this.channels): void {
    if (channels === this.channels) this.mode = "GM1";
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.allSoundOff(scheduleTime);
      channel.bankMSB = 0;
      channel.bankLSB = 0;
      channel.isDrum = false;
    }
    channels[9].bankMSB = 1;
    channels[9].isDrum = true;
  }

  GM2SystemOn(scheduleTime: number, channels: Channel[] = this.channels): void {
    if (channels === this.channels) this.mode = "GM2";
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.allSoundOff(scheduleTime);
      channel.bankMSB = 121;
      channel.bankLSB = 0;
      channel.isDrum = false;
    }
    channels[9].bankMSB = 120;
    channels[9].isDrum = true;
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
          case 3: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca25.pdf
            return this.handleMasterFineTuningSysEx(data, scheduleTime);
          case 4: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca25.pdf
            return this.handleMasterCoarseTuningSysEx(data, scheduleTime);
          case 5: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca24.pdf
            return this.handleGlobalParameterControlSysEx(data, scheduleTime);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          case 1: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca22.pdf
            return this.handleChannelPressureSysEx(data, scheduleTime);
          case 3: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca22.pdf
            return this.handleControlChangeSysEx(data, scheduleTime);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 10:
        switch (data[3]) {
          case 1: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca23.pdf
            return this.handleKeyBasedInstrumentControlSysEx(
              data,
              scheduleTime,
            );
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  handleMasterVolumeSysEx(data: Uint8Array, scheduleTime: number): void {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.setMasterVolume(volume, scheduleTime);
  }

  setMasterVolume(value: number, scheduleTime: number): void {
    const t: number = scheduleTime ?? this.audioContext.currentTime;
    const timeConstant = this.perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    this.masterVolume.gain
      .cancelAndHoldAtTime(t)
      .setTargetAtTime(value * value, t, timeConstant);
  }

  handleMasterFineTuningSysEx(data: Uint8Array, scheduleTime: number): void {
    const value = (data[5] * 128 + data[4]) / 16383;
    const fineTuning = (value - 8192) / 8192 * 100;
    this.setMasterFineTuning(fineTuning, scheduleTime);
  }

  setMasterFineTuning(value: number, scheduleTime: number): void { // [-100, 100] cent
    const prev = this.masterFineTuning;
    const next = value;
    this.masterFineTuning = next;
    const detuneChange = next - prev;
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      if (channel.isDrum) continue;
      channel.detune += detuneChange;
      this.updateChannelDetune(channel, scheduleTime);
    }
  }

  handleMasterCoarseTuningSysEx(data: Uint8Array, scheduleTime: number): void {
    const coarseTuning = (data[4] - 64) * 100;
    this.setMasterCoarseTuning(coarseTuning, scheduleTime);
  }

  setMasterCoarseTuning(value: number, scheduleTime: number): void { // [-6400, 6300] cent
    const prev = this.masterCoarseTuning;
    const next = value;
    this.masterCoarseTuning = next;
    const detuneChange = next - prev;
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      if (channel.isDrum) continue;
      channel.detune += detuneChange;
      this.updateChannelDetune(channel, scheduleTime);
    }
  }

  handleGlobalParameterControlSysEx(
    data: Uint8Array,
    scheduleTime: number,
  ): void {
    if (data[7] === 1) {
      switch (data[8]) {
        case 1:
          return this.handleReverbParameterSysEx(data);
        case 2:
          return this.handleChorusParameterSysEx(data, scheduleTime);
        default:
          console.warn(
            `Unsupported Global Parameter Control Message: ${data}`,
          );
      }
    } else {
      console.warn(`Unsupported Global Parameter Control Message: ${data}`);
    }
  }

  handleReverbParameterSysEx(data: Uint8Array): void {
    switch (data[9]) {
      case 0:
        return this.setReverbType(data[10]);
      case 1:
        return this.setReverbTime(data[10]);
    }
  }

  setReverbType(type: number): void {
    this.reverb.time = this.getReverbTimeFromType(type) ?? this.reverb.time;
    this.reverb.feedback = (type === 8) ? 0.9 : 0.8;
    this.setReverbEffect(this.reverb.algorithm);
  }

  getReverbTimeFromType(type: number): number | undefined {
    switch (type) {
      case 0:
        return this.getReverbTime(44);
      case 1:
        return this.getReverbTime(50);
      case 2:
        return this.getReverbTime(56);
      case 3:
        return this.getReverbTime(64);
      case 4:
        return this.getReverbTime(64);
      case 8:
        return this.getReverbTime(50);
      default:
        console.warn(`Unsupported Reverb Time: ${type}`);
    }
  }

  setReverbTime(value: number): void {
    this.reverb.time = this.getReverbTime(value);
    this.setReverbEffect(this.reverb.algorithm);
  }

  getReverbTime(value: number): number {
    return Math.exp((value - 40) * 0.025);
  }

  // mean free path equation
  //   https://repository.dl.itc.u-tokyo.ac.jp/record/8550/files/A31912.pdf
  //     江田和司, 拡散性制御に基づく室内音響設計に向けた音場解析に関する研究, 2015
  //   V: room size (m^3)
  //   S: room surface area (m^2)
  //   meanFreePath = 4V / S (m)
  // delay estimation using mean free path
  //   t: degree Celsius, generally used 20
  //   c: speed of sound = 331.5 + 0.61t = 331.5 * 0.61 * 20 = 343.7 (m/s)
  //   delay = meanFreePath / c (s)
  // feedback equation
  //   RT60 means that the energy is reduced to Math.pow(10, -6).
  //   Since energy is proportional to the square of the amplitude,
  //   the amplitude is reduced to Math.pow(10, -3).
  //   When this is done through n feedbacks,
  //   Math.pow(feedback, n) = Math.pow(10, -3)
  //   Math.pow(feedback, RT60 / delay) = Math.pow(10, -3)
  //   RT60 / delay * Math.log10(feedback) = -3
  //   RT60 = -3 * delay / Math.log10(feedback)
  //   feedback = Math.pow(10, -3 * delay / RT60)
  // delay estimation using ideal feedback
  //   The structure of a concert hall is complex,
  //   so estimates based on mean free path are unstable.
  //   It is easier to determine the delay based on ideal feedback.
  //   The average sound absorption coefficient
  //   suitable for playing musical instruments is 0.18 to 0.28.
  //   delay = -RT60 * Math.log10(feedback) / 3
  calcDelay(rt60: number, feedback: number): number {
    return -rt60 * Math.log10(feedback) / 3;
  }

  handleChorusParameterSysEx(data: Uint8Array, scheduleTime: number): void {
    switch (data[9]) {
      case 0:
        return this.setChorusType(data[10], scheduleTime);
      case 1:
        return this.setChorusModRate(data[10], scheduleTime);
      case 2:
        return this.setChorusModDepth(data[10], scheduleTime);
      case 3:
        return this.setChorusFeedback(data[10], scheduleTime);
      case 4:
        return this.setChorusSendToReverb(data[10], scheduleTime);
    }
  }

  setChorusType(type: number, scheduleTime: number): void {
    switch (type) {
      case 0:
        return this.setChorusParameter(3, 5, 0, 0, scheduleTime);
      case 1:
        return this.setChorusParameter(9, 19, 5, 0, scheduleTime);
      case 2:
        return this.setChorusParameter(3, 19, 8, 0, scheduleTime);
      case 3:
        return this.setChorusParameter(9, 16, 16, 0, scheduleTime);
      case 4:
        return this.setChorusParameter(2, 24, 64, 0, scheduleTime);
      case 5:
        return this.setChorusParameter(1, 5, 112, 0, scheduleTime);
      default:
        console.warn(`Unsupported Chorus Type: ${type}`);
    }
  }

  setChorusParameter(
    modRate: number,
    modDepth: number,
    feedback: number,
    sendToReverb: number,
    scheduleTime: number,
  ): void {
    this.setChorusModRate(modRate, scheduleTime);
    this.setChorusModDepth(modDepth, scheduleTime);
    this.setChorusFeedback(feedback, scheduleTime);
    this.setChorusSendToReverb(sendToReverb, scheduleTime);
  }

  setChorusModRate(value: number, scheduleTime: number): void {
    const modRate = this.getChorusModRate(value);
    this.chorus.modRate = modRate;
    this.chorusEffect.lfo.frequency.setValueAtTime(modRate, scheduleTime);
  }

  getChorusModRate(value: number): number {
    return value * 0.122; // Hz
  }

  setChorusModDepth(value: number, scheduleTime: number): void {
    const modDepth = this.getChorusModDepth(value);
    this.chorus.modDepth = modDepth;
    this.chorusEffect.lfoGain.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modDepth / 2, scheduleTime);
  }

  getChorusModDepth(value: number): number {
    return (value + 1) / 3200; // second
  }

  setChorusFeedback(value: number, scheduleTime: number): void {
    const feedback = this.getChorusFeedback(value);
    this.chorus.feedback = feedback;
    const chorusEffect = this.chorusEffect;
    for (let i = 0; i < chorusEffect.feedbackGains.length; i++) {
      chorusEffect.feedbackGains[i].gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(feedback, scheduleTime);
    }
  }

  getChorusFeedback(value: number): number {
    return value * 0.00763;
  }

  setChorusSendToReverb(value: number, scheduleTime: number): void {
    const sendToReverb = this.getChorusSendToReverb(value);
    const sendGain = this.chorusEffect.sendGain;
    if (0 < this.chorus.sendToReverb) {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        sendGain.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(sendToReverb, scheduleTime);
      } else {
        sendGain.disconnect();
      }
    } else {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        sendGain.connect(this.reverbEffect.input);
        sendGain.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(sendToReverb, scheduleTime);
      }
    }
  }

  getChorusSendToReverb(value: number): number {
    return value * 0.00787;
  }

  getChannelBitmap(data: Uint8Array): boolean[] {
    const bitmap = new Array(this.channels.length).fill(false);
    const ff = data[4] & 0b11;
    const gg = data[5] & 0x7F;
    const hh = data[6] & 0x7F;
    for (let bit = 0; bit < 7; bit++) {
      if (hh & (1 << bit)) bitmap[bit] = true;
    }
    for (let bit = 0; bit < 7; bit++) {
      if (gg & (1 << bit)) bitmap[bit + 7] = true;
    }
    for (let bit = 0; bit < 2; bit++) {
      if (ff & (1 << bit)) bitmap[bit + 14] = true;
    }
    return bitmap;
  }

  handleScaleOctaveTuning1ByteFormatSysEx(
    data: Uint8Array,
    realtime: boolean,
    scheduleTime: number,
  ): void {
    if (data.length < 19) {
      console.error("Data length is too short");
      return;
    }
    const channelBitmap = this.getChannelBitmap(data);
    for (let i = 0; i < channelBitmap.length; i++) {
      if (!channelBitmap[i]) continue;
      const channel = this.channels[i];
      if (channel.isDrum) continue;
      for (let j = 0; j < 12; j++) {
        const centValue = data[j + 7] - 64;
        channel.scaleOctaveTuningTable[j] = centValue;
      }
      if (realtime) this.updateChannelDetune(channel, scheduleTime);
    }
  }

  calcEffectValue(channel: Channel, destination: number): number {
    return this.calcChannelEffectValue(channel, destination);
  }

  calcChannelEffectValue(channel: Channel, destination: number): number {
    return this.calcControlChangeEffectValue(channel, destination) +
      this.calcChannelPressureEffectValue(channel, destination);
  }

  calcControlChangeEffectValue(channel: Channel, destination: number): number {
    const controlType = channel.controlTable[destination];
    if (controlType < 0) return 0;
    const pressure = channel.state.array[controlType];
    if (pressure <= 0) return 0;
    const baseline = pressureBaselines[destination];
    const tableValue = channel.controlTable[destination + 6];
    const value = (tableValue - baseline) * pressure;
    return value * effectParameters[destination];
  }

  calcChannelPressureEffectValue(
    channel: Channel,
    destination: number,
  ): number {
    const pressure = channel.state.channelPressure;
    if (pressure <= 0) return 0;
    const baseline = pressureBaselines[destination];
    const tableValue = channel.channelPressureTable[destination];
    const value = (tableValue - baseline) * pressure;
    return value * effectParameters[destination];
  }

  getChannelPitchControl(channel: Channel): number {
    return this.calcChannelEffectValue(channel, 0);
  }

  getPitchControl(channel: Channel): number {
    return this.calcEffectValue(channel, 0);
  }

  getFilterCutoffControl(channel: Channel): number {
    return this.calcEffectValue(channel, 1);
  }

  getChannelAmplitudeControl(channel: Channel): number {
    return this.calcChannelEffectValue(channel, 2);
  }

  getAmplitudeControl(channel: Channel): number {
    return this.calcEffectValue(channel, 2);
  }

  getLFOPitchDepth(channel: Channel): number {
    return this.calcEffectValue(channel, 3);
  }

  getLFOFilterDepth(channel: Channel): number {
    return this.calcEffectValue(channel, 4);
  }

  getLFOAmplitudeDepth(channel: Channel): number {
    return this.calcEffectValue(channel, 5);
  }

  setControlChangeEffects(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    const handlers = this.effectHandlers;
    for (let i = 0; i < handlers.length; i++) {
      const baseline = pressureBaselines[i];
      const tableValue = channel.controlTable[i + 6];
      if (baseline === tableValue) continue;
      handlers[i](channel, note, scheduleTime);
    }
  }

  setChannelPressureEffects(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    this.setPressureEffects(
      channel,
      note,
      "channelPressureTable",
      scheduleTime,
    );
  }

  setPressureEffects(
    channel: Channel,
    note: Note,
    tableName: PressureTableName,
    scheduleTime: number,
  ): void {
    const handlers = this.effectHandlers;
    const table = channel[tableName];
    for (let i = 0; i < handlers.length; i++) {
      const baseline = pressureBaselines[i];
      const tableValue = table[i];
      if (baseline === tableValue) continue;
      handlers[i](channel, note, scheduleTime);
    }
  }

  handleChannelPressureSysEx(data: Uint8Array, scheduleTime: number): void {
    this.handlePressureSysEx(data, "channelPressureTable", scheduleTime);
  }

  handlePressureSysEx(
    data: Uint8Array,
    tableName: PressureTableName,
    scheduleTime: number,
  ): void {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const table = channel[tableName];
    for (let i = 5; i < data.length - 1; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = rr;
      const handler = this.effectHandlers[pp];
      channel.processActiveNotes(scheduleTime, (note) => {
        if (handler) handler(channel, note, scheduleTime);
      });
    }
  }

  handleControlChangeSysEx(data: Uint8Array, scheduleTime: number): void {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const table = channel.controlTable;
    table.set(defaultControlValues);
    const controllerType = data[5];
    for (let i = 6; i < data.length; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = controllerType;
      table[pp + 6] = rr;
      const handler = this.effectHandlers[pp];
      channel.processActiveNotes(scheduleTime, (note) => {
        if (handler) handler(channel, note, scheduleTime);
      });
    }
  }

  getKeyBasedValue(
    channel: Channel,
    keyNumber: number,
    controllerType: number,
  ): number {
    const index = keyNumber * 128 + controllerType;
    const controlValue = channel.keyBasedTable[index];
    return controlValue;
  }

  handleKeyBasedInstrumentControlSysEx(
    data: Uint8Array,
    scheduleTime: number,
  ): void {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (!channel.isDrum) return;
    const keyNumber = data[5];
    const table = channel.keyBasedTable;
    for (let i = 6; i < data.length; i += 2) {
      const controllerType = data[i];
      const value = data[i + 1];
      const index = keyNumber * 128 + controllerType;
      table[index] = value;
      const handler = this.keyBasedControllerHandlers[controllerType];
      if (handler) handler(channel, keyNumber, scheduleTime);
    }
  }

  handleSysEx(
    data: Uint8Array,
    scheduleTime: number,
    channels: Channel[] = this.channels,
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
    for (const bufferSource of this.pendingSchedulerSources) {
      try {
        bufferSource.stop();
      } catch {
        // already stopped/ended
      }
    }
  }

  scheduleTask(callback: () => void, scheduleTime: number): Promise<void> {
    return new Promise((resolve) => {
      const bufferSource = new AudioBufferSourceNode(this.audioContext, {
        buffer: this.schedulerBuffer,
      });
      bufferSource.connect(this.scheduler);
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
