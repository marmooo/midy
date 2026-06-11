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
// - "none"  for full real-time control (dynamic CC, LFO, pitch)
// - "ads"   for real-time playback with higher cache hit rate
// - "adsr"  for real-time playback with accurate release envelope
// - "note"  for efficient playback when note behavior is fixed
// - "audio" for fully pre-rendered playback (lowest CPU)
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
// "audio"
//   Renders the entire MIDI file into a single AudioBuffer offline.
//   Call render() to complete rendering before calling start().
//   Playback simply streams an AudioBufferSourceNode, so CPU usage
//   is near zero. Seek and tempo changes are handled in real time.
//   A "rendering" event is dispatched when rendering starts, and a
//   "rendered" event is dispatched when rendering completes.
const DEFAULT_CACHE_MODE = "ads";
type CacheMode = "none" | "ads" | "adsr" | "note" | "audio";

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
    const player = this.player;
    const t: number = startTime ?? player.audioContext.currentTime;
    return await player.noteOnChannel(this, noteNumber, velocity, t, note);
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

export class ControllerState {
  array: Float32Array = new Float32Array(256);
  [key: string]: number | Float32Array;

  channelPressure: number = 0;
  pitchWheel: number = 0;
  pitchWheelSensitivity: number = 0;
  modulationDepthMSB: number = 0;
  portamentoTimeMSB: number = 0;
  volumeMSB: number = 0;
  panMSB: number = 0;
  expressionMSB: number = 0;
  sustainPedal: number = 0;
  portamento: number = 0;
  sostenutoPedal: number = 0;
  softPedal: number = 0;
  reverbSendLevel: number = 0;
  chorusSendLevel: number = 0;

  constructor() {
    const entries = Object.entries(defaultControllerState);
    for (const [name, { type, defaultValue }] of entries) {
      this.array[type] = defaultValue;
      Object.defineProperty(this, name, {
        get: () => this.array[type],
        set: (value: number) => this.array[type] = value,
        enumerable: true,
        configurable: true,
      });
    }
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

const decayCurve = 1 / (-Math.log(cbToRatio(-1000)));
const releaseCurve = 1 / (-Math.log(cbToRatio(-600)));

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
  lookAhead: number = 1;
  startDelay: number = 0.1;
  startTime: number = 0;
  resumeTime: number = 0;
  soundFonts: SoundFont[] = [];
  soundFontTable: number[][] = Array.from({ length: 128 }, () => []);
  voiceCounter: Map<number, number> = new Map();
  voiceCache: Map<number, CacheEntry> = new Map();
  realtimeVoiceCache: Map<number, RenderedBuffer> = new Map();
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
  // "adsr" mode
  adsrVoiceCache: Map<
    number,
    Map<bigint, RenderedBuffer | Promise<RenderedBuffer>>
  > = new Map();
  // "note" mode
  noteOnDurations: Map<number, number> = new Map();
  noteOnEvents: Map<number, NoteOnEventEntry> = new Map();
  fullVoiceCache: Map<
    number,
    Map<number, RenderedBuffer | Promise<RenderedBuffer>>
  > = new Map();
  // "audio" mode
  renderedAudioBuffer: AudioBuffer | null = null;
  isRendering: boolean = false;
  audioModeBufferSource: AudioBufferSourceNode | null = null;

  // Required properties
  audioContext!: AudioContext | OfflineAudioContext;
  cacheMode!: CacheMode;
  masterVolume!: GainNode;
  scheduler!: GainNode;
  schedulerBuffer!: AudioBuffer;
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

  constructor(audioContext: AudioContext | OfflineAudioContext) {
    super();
    this.audioContext = audioContext;
    this.cacheMode = DEFAULT_CACHE_MODE;
    this.masterVolume = new GainNode(audioContext);
    this.scheduler = new GainNode(audioContext, { gain: 0 });
    this.schedulerBuffer = new AudioBuffer({
      length: 1,
      sampleRate: audioContext.sampleRate,
    });
    this.messageHandlers = this.createMessageHandlers();
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.keyBasedControllerHandlers = this.createKeyBasedControllerHandlers();
    this.effectHandlers = this.createEffectHandlers();
    this.channels = this.createChannels();
    this.reverbEffect = this.createReverbEffect(this.reverb.algorithm);
    this.chorusEffect = this.createChorusEffect();
    this.chorusEffect.output.connect(this.masterVolume);
    this.reverbEffect.output.connect(this.masterVolume);
    this.masterVolume.connect(audioContext.destination);
    this.scheduler.connect(audioContext.destination);
    this.GM2SystemOn(audioContext.currentTime);
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
    noteOnDurations.clear();
    noteOnEvents.clear();
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
      noteOnDurations.set(entry.idx, duration);
      noteOnEvents.set(entry.idx, {
        duration,
        durationTicks,
        startTime: entry.startTime,
        events: entry.events,
      });
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
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "noteOn": {
          const audioBufferId = this.getVoiceId(
            channels[event.channel!],
            event.noteNumber!,
            event.velocity!,
          );
          voiceCounter.set(
            audioBufferId!,
            (voiceCounter.get(audioBufferId!) ?? 0) + 1,
          );
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
    for (const [audioBufferId, count] of voiceCounter) {
      if (count === 1) voiceCounter.delete(audioBufferId);
    }
    this.GM2SystemOn(this.audioContext.currentTime);
    if (cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio") {
      this.buildNoteOnDurations();
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

  createChannels(): Channel[] {
    const settings = (this.constructor as typeof MidyGM2).channelSettings;
    const audioContext = this.audioContext;
    return Array.from(
      { length: this.numChannels },
      (_, ch) => {
        const channel = new Channel(
          ch,
          settings,
          this.createChannelAudioNodes(audioContext),
        );
        channel.player = this;
        return channel;
      },
    );
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
    const lookAheadCheckTime = scheduleTime + timeOffset + this.lookAhead;
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
          channel.noteOn(
            event.noteNumber!,
            event.velocity!,
            startTime,
            note,
          );
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
      this.processTimelineEvent(event, t);
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
          this.resumeTime = this.currentTime();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          await this.suspendAudioContext();
          this.isPausing = false;
          exitReason = "paused";
          break outer;
        } else if (this.isStopping) {
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          await this.suspendAudioContext();
          this.isStopping = false;
          exitReason = "stopped";
          break outer;
        } else if (this.isSeeking) {
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
          this.dispatchEvent(new Event("looped"));
          continue;
        } else {
          await this.suspendAudioContext();
          exitReason = "ended";
          break;
        }
      }
      if (this.isPausing) {
        await this.stopNotes(now);
        await this.suspendAudioContext();
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        await this.stopNotes(now);
        await this.suspendAudioContext();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.stopNotes(now);
        this.startTime = audioContext.currentTime;
        const nextQueueIndex = this.getQueueIndex(this.resumeTime);
        this.updateStates(queueIndex, nextQueueIndex);
        queueIndex = nextQueueIndex;
        this.isSeeking = false;
        this.dispatchEvent(new Event("seeked"));
        continue;
      }
      queueIndex = this.scheduleTimelineEvents(now, queueIndex);
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
          if (!note.voice) return;
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
    let bank = channel.isDrum ? 128 : 0;
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

    const settings = (this.constructor as typeof MidyGM2).channelSettings;
    const renderChannels = Array.from({ length: this.numChannels }, (_, ch) => {
      const channel = new Channel(ch, settings);
      channel.player = this;
      return channel;
    });
    renderChannels[9].isDrum = true;

    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    this.isRendering = true;
    this.renderedAudioBuffer = null;
    this.dispatchEvent(new Event("rendering"));

    const sampleRate = this.audioContext.sampleRate;
    const totalSamples = Math.ceil(
      (this.totalTime + this.startDelay) * sampleRate,
    );
    const tasks: {
      t: number;
      promise: Promise<RenderedBuffer | AudioBuffer | null>;
    }[] = [];
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const t = event.startTime * inverseTempo + this.startDelay;
      this.processTimelineEvent(event, -1, {
        channels: renderChannels,
        onNoteOn: (renderChannel: Channel, event: TimelineEvent) => {
          const noteEvent = this.noteOnEvents.get(i);
          const noteDuration = noteEvent?.duration ??
            this.noteOnDurations.get(i) ?? 0;
          if (noteDuration <= 0) return;
          const { noteNumber, velocity } = event;
          const voice = this.resolveVoice(
            renderChannel,
            noteNumber!,
            velocity!,
          );
          if (!voice) return;
          const promise = (async () => {
            try {
              return await this.createFullRenderedBuffer(
                renderChannel,
                { noteNumber: noteNumber!, velocity: velocity! },
                voice.getAllParams(
                  this.getControllerState(
                    renderChannel,
                    noteNumber!,
                    velocity!,
                  ),
                ),
                noteDuration,
                noteEvent,
              );
            } catch (err) {
              console.warn("render: note render failed", err);
              return null;
            }
          })();
          tasks.push({ t, promise });
        },
      });
    }
    const offlineContext = new OfflineAudioContext(2, totalSamples, sampleRate);
    for (let i = 0; i < tasks.length; i++) {
      const { t, promise } = tasks[i];
      const noteBuffer = await promise;
      if (!noteBuffer) continue;
      const audioBuffer = noteBuffer instanceof RenderedBuffer
        ? noteBuffer.buffer
        : noteBuffer;
      const bufferSource = new AudioBufferSourceNode(offlineContext, {
        buffer: audioBuffer,
      });
      bufferSource.connect(offlineContext.destination);
      bufferSource.start(t);
    }
    this.renderedAudioBuffer = await offlineContext.startRendering();
    this.isRendering = false;
    this.dispatchEvent(new Event("rendered"));
    return this.renderedAudioBuffer;
  }

  async start(): Promise<void> {
    if (this.isPlaying || this.isPaused) return;
    this.resumeTime = 0;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
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
    if (cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio") {
      this.buildNoteOnDurations();
      this.fullVoiceCache.clear();
      this.adsrVoiceCache.clear();
    }
    if (cacheMode === "audio") {
      if (this.audioModeBufferSource) {
        this.audioModeBufferSource.playbackRate.setValueAtTime(
          this.tempo,
          this.audioContext.currentTime,
        );
      }
    }
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
      if (note.renderedBuffer?.isFull) return;
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
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
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
      .setTargetAtTime(sustainVolume, volHold, decayDuration * decayCurve);
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
    const modDelay = note.startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const decayDuration = voiceParams.modDecay;
    bufferSource.playbackRate
      .setValueAtTime(baseRate, modDelay)
      .exponentialRampToValueAtTime(peekRate, modAttack)
      .setValueAtTime(peekRate, modHold)
      .setTargetAtTime(baseRate, modHold, decayDuration * decayCurve);
  }

  clampCutoffFrequency(frequency: number): number {
    const minFrequency = 20;
    const maxFrequency = 20000;
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
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
      .setTargetAtTime(
        adjustedSustainFreq,
        modHold,
        decayDuration * decayCurve,
      );
  }

  startModulation(channel: Channel, note: Note, scheduleTime: number): void {
    const audioContext = this.audioContext;
    const { voiceParams } = note;
    if (!voiceParams) return;
    note.modLfo = new OscillatorNode(audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO),
    });
    note.modLfoToFilterFc = new GainNode(audioContext, {
      gain: voiceParams.modLfoToFilterFc,
    });
    note.modLfoToPitch = new GainNode(audioContext);
    note.modLfoToVolume = new GainNode(audioContext);
    this.setModLfoToPitch(channel, note, scheduleTime);
    this.setModLfoToVolume(channel, note, scheduleTime);

    note.modLfo!.start(note.startTime + voiceParams.delayModLFO);
    note.modLfo!.connect(note.modLfoToFilterFc);
    if (note.filterEnvelopeNode) {
      note.modLfoToFilterFc.connect(note.filterEnvelopeNode.frequency);
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
    const adsDuration = volHold + decayDuration * decayCurve * 5;
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
    const filterEnvelopeNode = new BiquadFilterNode(offlineContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10,
      frequency: initialFreq,
    });
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
    bufferSource.connect(filterEnvelopeNode);
    filterEnvelopeNode.connect(volumeEnvelopeNode);
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
    const adsDuration = volHold + decayDuration * decayCurve * 5;
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
    const filterEnvelopeNode = new BiquadFilterNode(offlineContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10,
      frequency: initialFreq,
    });
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
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
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
    } else {
      const decayElapsed = noteOffTime - volHoldTime;
      gainAtNoteOff = sustainVolume +
        (attackVolume - sustainVolume) *
          Math.exp(-decayElapsed / (decayCurve * voiceParams.volDecay));
    }
    volumeEnvelopeNode.gain
      .cancelScheduledValues(noteOffTime)
      .setValueAtTime(gainAtNoteOff, noteOffTime)
      .setTargetAtTime(0, noteOffTime, releaseDuration * releaseCurve);
    filterEnvelopeNode.frequency
      .cancelScheduledValues(noteOffTime)
      .setValueAtTime(initialFreq, noteOffTime)
      .setTargetAtTime(
        initialFreq,
        noteOffTime,
        voiceParams.modRelease * releaseCurve,
      );

    bufferSource.connect(filterEnvelopeNode);
    filterEnvelopeNode.connect(volumeEnvelopeNode);
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
    const releaseEndDuration = voiceParams.volRelease * releaseCurve * 5;
    const totalDuration = noteDuration + releaseEndDuration;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const offlinePlayer = new (this.constructor as typeof MidyGM2)(
      offlineContext as unknown as AudioContext,
    );
    offlinePlayer.cacheMode = "none";
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
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
    for (const event of noteEvents) {
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
    const audioBufferId = this.getVoiceId(channel, noteNumber, velocity);
    if (!realtime) {
      if (cacheMode === "note") {
        return await this.getFullCachedBuffer(channel, note, audioBufferId);
      } else if (cacheMode === "adsr") {
        return await this.getAdsrCachedBuffer(channel, note, audioBufferId);
      }
    }
    if (cacheMode === "none") {
      return await this.createAudioBuffer(note.voiceParams as VoiceParams);
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
      const rawBuffer = await this.createAudioBuffer(voiceParams);
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
        const rawBuffer = await this.createAudioBuffer(voiceParams);
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
    const noteEvent = this.noteOnEvents.get(timelineIndex);
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
        const rawBuffer = await this.createAudioBuffer(voiceParams);
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
    const noteEvent = this.noteOnEvents.get(timelineIndex);
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
    const voiceParams = note.voice?.getAllParams(controllerState) ?? null;
    note.voiceParams = voiceParams;
    if (!voiceParams) return;

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
      note.filterEnvelopeNode = new BiquadFilterNode(audioContext, {
        type: "lowpass",
        Q: voiceParams.initialFilterQ / 10,
      });
      const prevNote = channel.lastNote;
      if (prevNote && prevNote.noteNumber !== noteNumber) {
        note.portamentoNoteNumber = prevNote.noteNumber;
      }
      if (!channel.isDrum && this.isPortamento(channel, note)) {
        this.setPortamentoVolumeEnvelope(channel, note, now);
        this.setPortamentoFilterEnvelope(channel, note, now);
        this.setPortamentoPitchEnvelope(channel, note, now);
        this.setPortamentoDetune(channel, note, now);
      } else {
        this.setVolumeEnvelope(channel, note, now);
        this.setFilterEnvelope(channel, note, now);
        this.setPitchEnvelope(note, now);
        this.setDetune(channel, note, now);
      }
      this.startVibrato(channel, note, now);
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      if (channel.mono && channel.currentBufferSource) {
        channel.currentBufferSource.stop(startTime);
        channel.currentBufferSource = note.bufferSource;
      }
      note.bufferSource.connect(note.filterEnvelopeNode);
      note.filterEnvelopeNode.connect(note.volumeEnvelopeNode);
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
    if (voiceParams.sample.type === "compressed") {
      note.bufferSource.start(startTime);
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
    startTime: number,
    note?: Note,
  ): Promise<Note | void> {
    const realtime = startTime === undefined;
    if (!note) note = new Note(noteNumber, velocity, startTime);
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
    note.voice = soundFont.getVoice(bank, programNumber, noteNumber, velocity);
    if (!note.voice) return;
    if (!channel.activeNotes[noteNumber]) {
      channel.activeNotes[noteNumber] = [];
    }
    channel.activeNotes[noteNumber].push(note);
    await this.setNoteAudioNode(channel, note, realtime);
    channel.lastNote = note;
    this.setNoteRouting(channel, note, startTime);
    note.resolveReady();
    const state = channel.state;
    if (0.5 <= state.sustainPedal) channel.sustainNotes.push(note);
    return note;
  }

  disconnectNote(note: Note): void {
    note.bufferSource?.disconnect();
    note.filterEnvelopeNode?.disconnect();
    note.volumeEnvelopeNode?.disconnect();
    note.volumeNode?.disconnect();
    if (note.modLfoToPitch) {
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
          .setTargetAtTime(0, endTime, volDuration * releaseCurve);
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
        .setTargetAtTime(
          note.adjustedBaseFreq,
          endTime,
          (note.voiceParams?.modRelease ?? 0) * releaseCurve,
        );
      note.volumeEnvelopeNode.gain
        .cancelScheduledValues(endTime)
        .setTargetAtTime(0, endTime, volDuration * releaseCurve);
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
            .setTargetAtTime(0, endTime, volDuration * releaseCurve);
          note.bufferSource?.stop(volRelease);
        } else {
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
        .setTargetAtTime(0, endTime, volDuration * releaseCurve);
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
    if (!note.voice) return Promise.resolve();
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
      note.modLfoToPitch?.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(depth, scheduleTime);
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
    note.modLfoToFilterFc?.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modLfoToFilterFc, scheduleTime);
  }

  setModLfoToVolume(channel: Channel, note: Note, scheduleTime: number): void {
    const modLfoToVolume = note.voiceParams?.modLfoToVolume ?? 0;
    const baseDepth = cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const depth = baseDepth * Math.sign(modLfoToVolume) *
      (1 + this.getLFOAmplitudeDepth(channel));
    note.modLfoToVolume?.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(depth, scheduleTime);
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

  createVoiceParamsHandlers(): Record<string, VoiceParamsHandler> {
    return {
      modLfoToPitch: (channel, note, t) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setModLfoToPitch(channel, note, t);
        }
      },
      vibLfoToPitch: (channel, note, t) =>
        this.setVibLfoToPitch(channel, note, t),
      modLfoToFilterFc: (channel, note, t) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setModLfoToFilterFc(channel, note, t);
        }
      },
      modLfoToVolume: (channel, note, t) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setModLfoToVolume(channel, note, t);
        }
      },
      chorusEffectsSend: (channel, note, t) =>
        this.setChorusSend(channel, note, t),
      reverbEffectsSend: (channel, note, t) =>
        this.setReverbSend(channel, note, t),
      delayModLFO: (channel, note, _t) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setDelayModLFO(note);
        }
      },
      freqModLFO: (channel, note, t) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setFreqModLFO(note, t);
        }
      },
      delayVibLFO: (_channel, note, _t) => this.setDelayVibLFO(note),
      freqVibLFO: (_channel, note, t) => this.setFreqVibLFO(note, t),
      detune: (channel, note, t) => {
        if (this.isPortamento(channel, note)) {
          this.setPortamentoDetune(channel, note, t);
        } else {
          this.setDetune(channel, note, t);
        }
      },
    };
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
      if (note.renderedBuffer?.isFull) return;
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

  createControlChangeHandlers(): ControlChangeHandler[] {
    const handlers: ControlChangeHandler[] = new Array(128);
    handlers[0] = (ch, v, _t) => ch.setBankMSB(v);
    handlers[1] = (ch, v, t) => ch.setModulationDepth(v, t);
    handlers[5] = (ch, v, t) => ch.setPortamentoTime(v, t);
    handlers[6] = (ch, v, t) => ch.dataEntryMSB(v, t);
    handlers[7] = (ch, v, t) => ch.setVolume(v, t);
    handlers[10] = (ch, v, t) => ch.setPan(v, t);
    handlers[11] = (ch, v, t) => ch.setExpression(v, t);
    handlers[32] = (ch, v, _t) => ch.setBankLSB(v);
    handlers[38] = (ch, v, t) => ch.dataEntryLSB(v, t);
    handlers[64] = (ch, v, t) => ch.setSustainPedal(v, t);
    handlers[65] = (ch, v, t) => ch.setPortamento(v, t);
    handlers[66] = (ch, v, t) => ch.setSostenutoPedal(v, t);
    handlers[67] = (ch, v, t) => ch.setSoftPedal(v, t);
    handlers[91] = (ch, v, t) => ch.setReverbSendLevel(v, t);
    handlers[93] = (ch, v, t) => ch.setChorusSendLevel(v, t);
    handlers[100] = (ch, v, _t) => ch.setRPNLSB(v);
    handlers[101] = (ch, v, _t) => ch.setRPNMSB(v);
    handlers[120] = (ch, _v, t) => ch.allSoundOff(t);
    handlers[121] = (ch, _v, t) => ch.resetAllControllers(t);
    handlers[123] = (ch, _v, t) => ch.allNotesOff(t);
    handlers[124] = (ch, _v, t) => ch.omniOff(t);
    handlers[125] = (ch, _v, t) => ch.omniOn(t);
    handlers[126] = (ch, _v, t) => ch.monoOn(t);
    handlers[127] = (ch, _v, t) => ch.polyOn(t);
    return handlers;
  }

  updateModulation(channel: Channel, scheduleTime: number): void {
    const depth = channel.state.modulationDepthMSB *
      channel.modulationDepthRange;
    channel.processScheduledNotes((note: Note) => {
      if (note.renderedBuffer?.isFull) return;
      if (note.modLfoToPitch) {
        note.modLfoToPitch?.gain.setValueAtTime(depth, scheduleTime);
      } else {
        this.startModulation(channel, note, scheduleTime);
      }
    });
  }

  updatePortamento(channel: Channel, scheduleTime: number): void {
    if (channel.isDrum) return;
    channel.processScheduledNotes((note) => {
      if (this.isPortamento(channel, note)) {
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
    channel.gainL.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainLeft, scheduleTime);
    channel.gainR.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainRight, scheduleTime);
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

  createEffectHandlers(): EffectHandler[] {
    const handlers: EffectHandler[] = new Array(6);
    handlers[0] = (channel, note, scheduleTime) => {
      if (this.isPortamento(channel, note)) {
        this.setPortamentoDetune(channel, note, scheduleTime);
      } else {
        this.setDetune(channel, note, scheduleTime);
      }
    };
    handlers[1] = (channel, note, scheduleTime) => {
      if (0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber) {
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
      } else {
        this.setFilterEnvelope(channel, note, scheduleTime);
      }
    };
    handlers[2] = (channel, _note, scheduleTime) =>
      this.applyVolume(channel, scheduleTime);
    handlers[3] = (channel, note, scheduleTime) =>
      this.setModLfoToPitch(channel, note, scheduleTime);
    handlers[4] = (channel, note, scheduleTime) =>
      this.setModLfoToFilterFc(channel, note, scheduleTime);
    handlers[5] = (channel, note, scheduleTime) =>
      this.setModLfoToVolume(channel, note, scheduleTime);
    return handlers;
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

  createKeyBasedControllerHandlers(): KeyBasedHandler[] {
    const handlers: KeyBasedHandler[] = new Array(128);
    handlers[7] = (channel, keyNumber, t) =>
      this.updateKeyBasedVolume(channel, keyNumber, t);
    handlers[10] = (channel, keyNumber, t) =>
      this.updateKeyBasedVolume(channel, keyNumber, t);
    handlers[91] = (channel, keyNumber, t) =>
      channel.processScheduledNotes((note) => {
        if (note.noteNumber === keyNumber) this.setReverbSend(channel, note, t);
      });
    handlers[93] = (channel, keyNumber, t) =>
      channel.processScheduledNotes((note) => {
        if (note.noteNumber === keyNumber) this.setChorusSend(channel, note, t);
      });
    return handlers;
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

  scheduleTask(callback: () => void, scheduleTime: number): Promise<void> {
    return new Promise((resolve) => {
      const bufferSource = new AudioBufferSourceNode(this.audioContext, {
        buffer: this.schedulerBuffer,
      });
      bufferSource.connect(this.scheduler);
      bufferSource.onended = () => {
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
