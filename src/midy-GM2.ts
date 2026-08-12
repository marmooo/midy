// GM2 implementation. Extends the shared Player engine (playback scheduling,
// caching, ADSR/segment/chunk rendering, etc.) with GM2-specific features:
// bank select, RPN fine/coarse tuning, modulation depth range, portamento,
// sostenuto/soft pedal, channel pressure, key-based instrument control,
// reverb/chorus sends & SysEx, scale/octave tuning, drum exclusive classes
// by kit, vibrato LFO, and GM2 system on/off.
import {
  cbToRatio,
  Channel as BaseChannel,
  envelopeCurve,
  filterEnvelopeKeySet,
  FULLY_OPEN_FILTER_CENTS,
  type MessageHandler,
  Note as BaseNote,
  type NoteOnEntry,
  type PendingOffItem,
  pitchEnvelopeKeySet,
  Player,
  RenderedBuffer,
  type TimelineEvent,
  volumeEnvelopeKeySet,
} from "./player.ts";
import { type MidiData, type MidiSetTempoEvent } from "midi-file";
import { Voice, type VoiceParams } from "@marmooo/soundfont-parser";
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

export { Player, RenderedBuffer } from "./player.ts";

const drumExclusiveClassesByKit = new Array(57);
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

// https://www.synthfont.com/sfspec24.pdf
// SF2 spec's defined maximum (and default) value for the initialFilterFc
// generator: 13500 cents (≈19913Hz via centToHz, see clampCutoffFrequency).
// The spec treats this as "no filtering" / fully open by convention

// "segment" mode

// "chunk" mode
// ChunkNoteEntry mirrors SegmentNoteEntry, with a channelNumber added so
// the renderer knows which channel each note belongs to.

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

type PressureTableName = "channelPressureTable" | "polyphonicKeyPressureTable";

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

export class Note extends BaseNote {
  declare player?: MidyGM2;
  vibLfo: OscillatorNode | null = null;
  vibLfoToPitch: GainNode | null = null;
  reverbSend: GainNode | null = null;
  chorusSend: GainNode | null = null;
  portamentoNoteNumber: number = -1;

  constructor(noteNumber: number, velocity: number, startTime: number) {
    super(noteNumber, velocity, startTime);
  }
}

type ChannelSettings = {
  detune: number;
  programNumber: number;
  dataMSB: number;
  dataLSB: number;
  rpnMSB: number;
  rpnLSB: number;
  modulationDepthRange: number;
  fineTuning: number;
  coarseTuning: number;
};
type ChannelAudioNodes = {
  gainL: GainNode;
  gainR: GainNode;
  merger: ChannelMergerNode;
};

export class Channel extends BaseChannel<Note> {
  declare player: MidyGM2;
  bankMSB: number = 121;
  bankLSB: number = 0;
  mono: boolean = false; // CC#124, CC#125
  fineTuning: number = 0; // cent
  coarseTuning: number = 0; // cent
  sostenutoNotes: Note[] = [];
  controlTable = new Int8Array(128); // filled in constructor from defaultControlValues
  scaleOctaveTuningTable = new Float32Array(12); // cent
  channelPressureTable = new Int8Array(6); // filled in constructor
  keyBasedTable = new Int8Array(128 * 128).fill(-1);
  keyBasedGainLs: (GainNode | undefined)[] = new Array(128);
  keyBasedGainRs: (GainNode | undefined)[] = new Array(128);
  lastNote: Note | null = null;
  currentBufferSource: AudioBufferSourceNode | null = null;
  declare state: ControllerState;

  constructor(
    channelNumber: number,
    settings: ChannelSettings,
    audioNodes?: ChannelAudioNodes,
  ) {
    super(channelNumber, settings, audioNodes);
    this.controlTable = new Int8Array(defaultControlValues);
    this.channelPressureTable = new Int8Array(defaultPressureValues);
    this.state = new ControllerState();
  }

  override resetSettings(settings: ChannelSettings): void {
    Object.assign(this, settings);
  }

  resetTable(): void {
    this.controlTable.set(defaultControlValues);
    this.scaleOctaveTuningTable.fill(0);
    this.channelPressureTable.set(defaultPressureValues);
    this.keyBasedTable.fill(-1);
  }

  override setProgramChange(programNumber: number): void {
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

  override setPitchBend(value: number, scheduleTime?: number): void {
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

  override setControlChange(
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

  override setModulationDepth(value: number, scheduleTime?: number): void {
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

  override setVolume(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.volumeMSB = value / 127;
    player.applyVolume(this, t);
  }

  override setPan(value: number, scheduleTime?: number): void {
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

  override setExpression(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.expressionMSB = value / 127;
    player.updateChannelVolume(this, t);
  }

  setBankLSB(lsb: number): void {
    this.bankLSB = lsb;
  }

  override dataEntryLSB(value: number, scheduleTime?: number): void {
    this.dataLSB = value;
    this.handleRPN(scheduleTime);
  }

  override async setSustainPedal(
    value: number,
    scheduleTime?: number,
  ): Promise<void> {
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

  override setRPNMSB(value: number): void {
    this.rpnMSB = value;
  }

  override setRPNLSB(value: number): void {
    this.rpnLSB = value;
  }

  override dataEntryMSB(value: number, scheduleTime?: number): void {
    this.dataMSB = value;
    this.handleRPN(scheduleTime);
  }

  override limitData(
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

  override handleRPN(scheduleTime?: number): void {
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

  override handlePitchBendRangeRPN(scheduleTime?: number): void {
    this.limitData(0, 127, 0, 127);
    const pitchBendRange = (this.dataMSB + this.dataLSB / 128) * 100;
    this.setPitchBendRange(pitchBendRange, scheduleTime);
  }

  override setPitchBendRange(value: number, scheduleTime?: number): void {
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

  override allSoundOff(scheduleTime?: number): Promise<void[]> {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const promises: Promise<void>[] = [];
    this.processActiveNotes(t, (note) => {
      promises.push(player.soundOffNote(note, t));
    });
    return Promise.all(promises);
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf

  override resetAllControllers(scheduleTime?: number): void {
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

  override resetChannelStates(scheduleTime?: number): void {
    const player = this.player;
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
      (player.constructor as typeof MidyGM2).channelSettings,
    );
    this.mono = false;
    this.resetTable();
  }

  override allNotesOff(scheduleTime?: number): Promise<void[]> {
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

export class MidyGM2 extends Player<Note, Channel> {
  override mode: string = "GM2";
  masterFineTuning: number = 0; // cent
  masterCoarseTuning: number = 0; // cent
  reverb = {
    algorithm: "Schroeder" as ReverbAlgorithm,
    time: 0, // set in constructor via getReverbTime
    feedback: 0.8,
  };
  chorus = {
    modRate: 0,
    modDepth: 0,
    feedback: 0,
    sendToReverb: 0,
    delayTimes: [] as number[],
  };
  lastActiveSensing: number = 0;
  activeSensingThreshold: number = 0.3;
  keyBasedControllerHandlers!: KeyBasedHandler[];
  effectHandlers!: EffectHandler[];
  reverbEffect!: ReverbEffect;
  chorusEffect!: ChorusEffect;
  // GM2 uses SF2 exclusiveClass + per-kit drum exclusive tables
  override ignoreDrumNoteOff: boolean = false;
  static override channelSettings = {
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
    super(audioContext, options);
    this.mode = "GM2";
    this.ignoreDrumNoteOff = false;
    this.reverb = {
      algorithm: "Schroeder" as ReverbAlgorithm,
      time: this.getReverbTime(64),
      feedback: 0.8,
    };
    this.chorus = {
      modRate: this.getChorusModRate(3),
      modDepth: this.getChorusModDepth(19),
      feedback: this.getChorusFeedback(8),
      sendToReverb: this.getChorusSendToReverb(0),
      delayTimes: this.generateDistributedArray(0.02, 2, 0.5),
    };
    this.voiceParamsHandlers = voiceParamsHandlers;
    this.controlChangeHandlers = controlChangeHandlers;
    this.keyBasedControllerHandlers = keyBasedControllerHandlers;
    this.effectHandlers = effectHandlers;
    this.reverbEffect = this.createReverbEffect(this.reverb.algorithm);
    this.chorusEffect = this.createChorusEffect();
    this.chorusEffect.output.connect(this.masterVolume);
    this.reverbEffect.output.connect(this.masterVolume);
    const isOffline = audioContext instanceof OfflineAudioContext;
    // Player does not call finishConstruction automatically; wire the graph
    // and system-on here so reverb/chorus exist first.
    this.masterVolume.connect(audioContext.destination);
    if (!isOffline) {
      this.scheduler!.connect(audioContext.destination);
      this.GM1SystemOn(audioContext.currentTime);
    } else {
      if (this.channels[9]) this.channels[9].isDrum = true;
    }
  }

  override createChannelInstance(
    channelNumber: number,
    settings: typeof MidyGM2.channelSettings,
    audioNodes?: ReturnType<MidyGM2["createChannelAudioNodes"]>,
  ): Channel {
    return new Channel(channelNumber, settings, audioNodes);
  }

  override createNoteInstance(
    noteNumber: number,
    velocity: number,
    startTime: number,
  ): Note {
    return new Note(noteNumber, velocity, startTime);
  }

  override buildNoteOnDurations(): void {
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

  override cacheVoiceIds(): void {
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

  override getVoiceId(
    channel: Channel,
    noteNumber: number,
    velocity: number,
  ): number | undefined {
    const resolved = this.resolveVoiceResult(channel, noteNumber, velocity);
    if (!resolved) return;
    const { instrument, sampleID } = resolved.voice.generators;
    return resolved.soundFontIndex * (2 ** 31) + instrument * (2 ** 24) +
      (sampleID << 8);
  }

  override createChannels(activeChannelNumbers?: Set<number>): Channel[] {
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

  override isLoopDrum(channel: Channel, noteNumber: number): boolean {
    const programNumber = channel.programNumber;
    return ((programNumber === 48 && noteNumber === 88) ||
      (programNumber === 56 && 47 <= noteNumber && noteNumber <= 84));
  }

  override processTimelineEvent(event: TimelineEvent, scheduleTime: number, {
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
        channel.setChannelPressure(
          (event as TimelineEvent & { amount?: number }).amount!,
          scheduleTime,
        );
    }
  }

  override scheduleTimelineEvents(
    scheduleTime: number,
    queueIndex: number,
  ): number {
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

  override resetChannels(
    channels: Channel[] = this.channels,
    scheduleTime?: number,
  ): void {
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.lastNote = null;
      channel.currentBufferSource = null;
      channel.activeNotes = new Array(128);
      channel.sustainNotes = [];
      channel.sostenutoNotes = [];
      channel.isDrum = false;
      channel.resetChannelStates(scheduleTime);
    }
    if (channels[9]) channels[9].isDrum = true;
  }

  override resetAllStates(): void {
    this.masterFineTuning = 0;
    this.masterCoarseTuning = 0;
    this.clearPlaybackCaches();
    this.GM2SystemOn(this.audioContext.currentTime, this.channels);
  }

  override async playNotes(): Promise<void> {
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
        this.totalTime < this.currentTime() &&
        this.timeline.length <= queueIndex
      ) {
        const pendingPromises = this.notePromises.slice();
        this.notePromises = [];
        // Interruptible + grace-bounded wait (see BasePlayer.waitNotePromisesInterruptible).
        // Dense songs can leave a large release backlog here; a blocking
        // allSettled would make seek/pause unresponsive until every tail ends.
        const result = await this.waitNotePromisesInterruptible(
          pendingPromises,
        );
        if (result === "completed") {
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
        // aborted → fall through to isPausing / isStopping / isSeeking
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
      this.dispatchEvent(new Event(exitReason!));
    }
  }

  override getSoundFontId(channel: Channel): string {
    const programNumber = channel.programNumber;
    const bankNumber = channel.isDrum ? 128 : channel.bankLSB;
    const bank = bankNumber.toString().padStart(3, "0");
    const program = programNumber.toString().padStart(3, "0");
    return `${bank}:${program}`;
  }

  override extractMidiData(
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

  override async stopChannelNotes(
    channel: Channel,
    scheduleTime: number,
  ): Promise<void> {
    // Match Player.stopChannelNotes: mark ending first so in-flight
    // noteOnChannel (awaiting setNoteAudioNode) will soundOff instead of
    // routing, then properly disconnect via soundOffNote.
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 128; i++) {
      const stack = channel.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        if (note.isSegmentGhost) continue;
        note.ending = true;
        if (note.bufferSource || note.volumeNode) {
          promises.push(this.soundOffNote(note, scheduleTime));
        } else {
          this.soundingNotes.delete(note);
        }
      }
    }
    await Promise.all(promises);
    channel.lastNote = null;
    channel.activeNotes = new Array(128);
    channel.sustainNotes = [];
    channel.sostenutoNotes = [];
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

  override findFirstPresetVoice(
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
  //   1. requested bankLSB + program
  //   2. bank 0 + same program (GM)
  //   3. bank 0 + closest program in the same GM family of 8
  //   4. bank 0, program 0 (Acoustic Grand Piano)
  //   5. first melodic preset found across loaded soundfonts
  //   6. null (silence)
  // Fallback order (drum):
  //   1. bank 128 + program
  //   2. bank 128, program 0 (Standard Kit)
  //   3. first drum preset (bank 128) found across loaded soundfonts
  //   4. null (silence)

  override resolveVoiceResult(
    channel: Channel,
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

    const requestedBank = channel.bankLSB;
    let result = this.tryGetVoice(
      requestedBank,
      programNumber,
      noteNumber,
      velocity,
    );
    if (result) return result;
    if (requestedBank !== 0) {
      result = this.tryGetVoice(0, programNumber, noteNumber, velocity);
      if (result) return result;
    }
    const family = MidyGM2.gmFamilyCandidates(programNumber);
    for (let i = 0; i < family.length; i++) {
      result = this.tryGetVoice(0, family[i], noteNumber, velocity);
      if (result) return result;
    }
    // Acoustic Grand Piano — skip if already attempted above (program 0).
    if (programNumber !== 0) {
      result = this.tryGetVoice(0, 0, noteNumber, velocity);
      if (result) return result;
    }
    return this.findFirstPresetVoice(noteNumber, velocity, false);
  }

  override calcChannelDetune(channel: Channel): number {
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

  override updateChannelDetune(channel: Channel, scheduleTime: number): void {
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

  override calcNoteDetune(channel: Channel, note: Note): number {
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

  override setVolumeEnvelope(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
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

  override setFilterEnvelope(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
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

  override async setNoteAudioNode(
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
        const prevNote = channel.lastNote;
        const staleSource = channel.currentBufferSource;
        staleSource.stop(startTime);
        if (prevNote && prevNote !== note) {
          prevNote.ending = true;
          try {
            prevNote.modLfo?.stop(startTime);
          } catch {
            // not started / already stopped
          }
          try {
            prevNote.vibLfo?.stop(startTime);
          } catch {
            // not started / already stopped
          }
          staleSource.onended = () => {
            try {
              this.disconnectNote(prevNote);
            } catch {
              // already torn down
            }
          };
        }
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

  override handleDrumExclusiveClass(
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

  override setNoteRouting(
    channel: Channel,
    note: Note,
    startTime: number,
  ): void {
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
        volumeNode.connect(gainL!);
        volumeNode.connect(gainR!);
      } else {
        volumeNode.connect(channel.gainL);
        volumeNode.connect(channel.gainR);
      }
    }
    this.handleExclusiveClass(note, channel, startTime);
    this.handleDrumExclusiveClass(note, channel, startTime);
    this.soundingNotes.add(note);
  }

  override async noteOnChannel(
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
      note.voice = this.resolveVoice(channel, noteNumber, velocity);
    }
    if (!note.voice) return;
    if (!channel.activeNotes[noteNumber]) {
      channel.activeNotes[noteNumber] = [];
    }
    channel.activeNotes[noteNumber].push(note);
    try {
      await this.setNoteAudioNode(channel, note, realtime);
      // pause/stop may have set ending while setNoteAudioNode was in flight
      if (note.ending) {
        if (note.bufferSource || note.volumeNode) {
          await this.soundOffNote(note, this.audioContext.currentTime);
        }
        return note;
      }
      channel.lastNote = note;
      this.setNoteRouting(channel, note, t);
    } finally {
      note.resolveReady();
    }
    if (0.5 <= channel.state.sustainPedal) channel.sustainNotes.push(note);
    return note;
  }

  override disconnectNote(note: Note): void {
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
    if (note.vibLfoToPitch) {
      note.vibLfoToPitch.disconnect();
      try {
        note.vibLfo?.stop();
      } catch {
        // not started / already stopped
      }
    }
    if (note.reverbSend) {
      note.reverbSend.disconnect();
    }
    if (note.chorusSend) {
      note.chorusSend.disconnect();
    }
  }

  override releaseNote(
    _channel: Channel,
    note: Note,
    endTime: number,
  ): Promise<void> | void {
    if (note.isSegmentGhost) return;
    const now = this.audioContext.currentTime;

    const makePromise = (
      stopTime: number,
      onFinish?: () => void,
    ): Promise<void> => {
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.disconnectNote(note);
          onFinish?.();
          resolve();
        };
        const src = note.bufferSource;
        if (!src) {
          finish();
          return;
        }
        src.onended = finish;
        try {
          src.stop(stopTime);
        } catch {
          finish();
          return;
        }
        const waitMs = Math.max(50, (stopTime - now) * 1000 + 100);
        setTimeout(finish, waitMs);
      });
    };

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
        return makePromise(volRelease, () => this.releaseFullCache(note));
      }
      if (naturalEndTime <= now) {
        this.disconnectNote(note);
        this.releaseFullCache(note);
        return;
      }
      return makePromise(naturalEndTime, () => this.releaseFullCache(note));
    }

    const volDuration = note.voiceParams?.volRelease ?? 0;
    const volRelease = endTime + volDuration;

    if (note.volumeEnvelopeNode) {
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
          return makePromise(volRelease);
        }
        if (naturalEndTime <= now) {
          this.disconnectNote(note);
          return;
        }
        return makePromise(naturalEndTime);
      }
      try {
        note.volumeNode?.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    }

    return makePromise(volRelease);
  }

  override noteOffChannel(
    channel: Channel,
    noteNumber: number,
    _velocity: number,
    endTime: number,
    force: boolean,
  ): Promise<void> | void {
    if (!force) {
      if (channel.isDrum && !this.isLoopDrum(channel, noteNumber)) {
        // One-shot behaviour applies to live MIDI input only. MIDI-file notes
        // carry a timelineIndex and must release at note-off so their decay
        // matches segment/chunk offline bakes (which force-release drums).
        // Loop drums (isLoopDrum) already fall through and release.
        const liveNote = this.findNoteForOff(channel, noteNumber);
        if (!liveNote || liveNote.timelineIndex === null) {
          this.removeFromActiveNotes(channel, noteNumber);
          return;
        }
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
      return this.releaseNote(channel, note, endTime);
    });
    this.notePromises.push(promise);
    return promise;
  }

  override releaseSustainPedal(
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

  override createMessageHandlers(): MessageHandler[] {
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

  activeSensing(): void {
    this.lastActiveSensing = performance.now();
  }

  override setModLfoToPitch(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
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

  override setModLfoToFilterFc(
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

  override setModLfoToVolume(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
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

  override getControllerState(
    channel: Channel,
    noteNumber: number,
    velocity: number,
    polyphonicKeyPressure: number = 0,
  ): Float32Array {
    const state = new Float32Array(channel.state.array.length);
    state.set(channel.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    state[10] = polyphonicKeyPressure / 127;
    return state;
  }

  override applyVoiceParams(
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

  override updateChannelVolume(channel: Channel, scheduleTime: number): void {
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
    const gainR = channel.keyBasedGainRs[keyNumber]!;
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

  override handleUniversalNonRealTimeExclusiveMessage(
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

  override GM1SystemOn(
    scheduleTime: number,
    channels: Channel[] = this.channels,
  ): void {
    const isPrimary = channels === this.channels;
    if (isPrimary) {
      this.mode = "GM1";
      this.exclusiveClassNotes.fill(null);
      this.drumExclusiveClassNotes.fill(null);
    }
    for (let ch = 0; ch < channels.length; ch++) {
      channels[ch].allSoundOff(scheduleTime);
    }
    this.resetChannels(channels, scheduleTime);
    if (isPrimary) {
      this.setMasterVolume(1, scheduleTime);
    }
    for (let ch = 0; ch < channels.length; ch++) {
      channels[ch].bankMSB = 0;
      channels[ch].bankLSB = 0;
    }
    if (channels[9]) {
      channels[9].bankMSB = 1;
      channels[9].isDrum = true;
    }
  }

  GM2SystemOn(scheduleTime: number, channels: Channel[] = this.channels): void {
    const isPrimary = channels === this.channels;
    if (isPrimary) {
      this.mode = "GM2";
      this.exclusiveClassNotes.fill(null);
      this.drumExclusiveClassNotes.fill(null);
    }
    for (let ch = 0; ch < channels.length; ch++) {
      channels[ch].allSoundOff(scheduleTime);
    }
    this.resetChannels(channels, scheduleTime);
    if (isPrimary) {
      this.setMasterVolume(1, scheduleTime);
    }
    for (let ch = 0; ch < channels.length; ch++) {
      channels[ch].bankMSB = 121;
      channels[ch].bankLSB = 0;
    }
    if (channels[9]) {
      channels[9].bankMSB = 120;
      channels[9].isDrum = true;
    }
  }

  override handleUniversalRealTimeExclusiveMessage(
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

  override setMasterVolume(value: number, scheduleTime: number): void {
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
    const table =
      (channel as Channel & Record<PressureTableName, Int8Array>)[tableName];
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
    const table =
      (channel as Channel & Record<PressureTableName, Int8Array>)[tableName];
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
}
