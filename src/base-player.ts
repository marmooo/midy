import { type MidiData, type MidiSetTempoEvent, parseMidi } from "midi-file";
import {
  type AudioData,
  type GeneratorStore,
  parse,
  SoundFont,
  type ValueGeneratorKey,
  ValueGeneratorKeys,
  Voice,
} from "@marmooo/soundfont";
import { OggVorbisDecoderWebWorker } from "@wasm-audio-decoders/ogg-vorbis";

// @marmooo/soundfont exposes only raw, spec-unit generator values
// (Voice.transformAllParams()/transformParams(), read via
// GeneratorStore.get()). This section interprets those raw values into the
// playback parameters the rest of this file needs: timecents -> seconds
// (SF2 spec §8.1.2), centibel/permille scalings, keynum-scaled envelope
// timings (§8.1.3), and the derived playbackRate/detune (§7.9, §8.1.2).
// Field names match the SF2 generator names exactly (e.g. attackVolEnv,
// not an invented alias like "volAttack") except playbackRate/detune,
// which are genuine composites with no single spec-generator equivalent.

export interface VoiceParams {
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  instrument: number;
  sampleID: number;
  sample: AudioData;
  sampleRate: number;
  sampleName: string;
  sampleModes: number;
  exclusiveClass: number;
  modLfoToPitch: number;
  vibLfoToPitch: number;
  modEnvToPitch: number;
  initialFilterFc: number;
  initialFilterQ: number;
  modLfoToFilterFc: number;
  modEnvToFilterFc: number;
  modLfoToVolume: number;
  chorusEffectsSend: number;
  reverbEffectsSend: number;
  pan: number;
  delayModLFO: number;
  freqModLFO: number;
  delayVibLFO: number;
  freqVibLFO: number;
  delayModEnv: number;
  attackModEnv: number;
  holdModEnv: number;
  decayModEnv: number;
  sustainModEnv: number;
  releaseModEnv: number;
  initialAttenuation: number;
  detune: number;
  playbackRate: number;
  delayVolEnv: number;
  attackVolEnv: number;
  holdVolEnv: number;
  decayVolEnv: number;
  sustainVolEnv: number;
  releaseVolEnv: number;
}

function timecentToSecond(value: number): number {
  return Math.pow(2, value / 1200);
}

// holdVolEnv/holdModEnv (and their decay counterparts) are scaled by how
// far the note key is from C4 (SF2 spec §8.1.3).
function keynumScaledSecond(
  key: number,
  timecents: number,
  keynumScale: number,
): number {
  return timecentToSecond(timecents + (key - 60) * keynumScale);
}

function getPlaybackRate(
  key: number,
  originalPitch: number,
  generators: GeneratorStore,
): number {
  const overridingRootKey = generators.get("overridingRootKey");
  const scaleTuning = generators.get("scaleTuning");
  const rootKey = overridingRootKey === -1 ? originalPitch : overridingRootKey;
  return Math.pow(2, (key - rootKey) * scaleTuning / 1200);
}

function getDetune(
  pitchCorrection: number,
  generators: GeneratorStore,
): number {
  const coarseTune = generators.get("coarseTune") * 100;
  const fineTune = generators.get("fineTune");
  return coarseTune + fineTune + pitchCorrection;
}

type VoiceParamsHandlerFn = (
  params: Partial<VoiceParams>,
  generators: GeneratorStore,
  key: number,
  originalPitch: number,
  pitchCorrection: number,
) => void;

// One entry per SF2 value generator (Generator.ts's ValueGeneratorKeys),
// converting its raw value into the interpreted VoiceParams field(s) it
// feeds.
const voiceParamsHandlerFns: Record<ValueGeneratorKey, VoiceParamsHandlerFn> = {
  modLfoToPitch: (p, g) => {
    p.modLfoToPitch = g.get("modLfoToPitch");
  },
  vibLfoToPitch: (p, g) => {
    p.vibLfoToPitch = g.get("vibLfoToPitch");
  },
  modEnvToPitch: (p, g) => {
    p.modEnvToPitch = g.get("modEnvToPitch");
  },
  initialFilterFc: (p, g) => {
    p.initialFilterFc = g.get("initialFilterFc");
  },
  initialFilterQ: (p, g) => {
    p.initialFilterQ = g.get("initialFilterQ");
  },
  modLfoToFilterFc: (p, g) => {
    p.modLfoToFilterFc = g.get("modLfoToFilterFc");
  },
  modEnvToFilterFc: (p, g) => {
    p.modEnvToFilterFc = g.get("modEnvToFilterFc");
  },
  modLfoToVolume: (p, g) => {
    p.modLfoToVolume = g.get("modLfoToVolume");
  },
  chorusEffectsSend: (p, g) => {
    p.chorusEffectsSend = g.get("chorusEffectsSend") / 1000;
  },
  reverbEffectsSend: (p, g) => {
    p.reverbEffectsSend = g.get("reverbEffectsSend") / 1000;
  },
  pan: (p, g) => {
    p.pan = g.get("pan") / 1000;
  },
  delayModLFO: (p, g) => {
    p.delayModLFO = timecentToSecond(g.get("delayModLFO"));
  },
  freqModLFO: (p, g) => {
    p.freqModLFO = g.get("freqModLFO");
  },
  delayVibLFO: (p, g) => {
    p.delayVibLFO = timecentToSecond(g.get("delayVibLFO"));
  },
  freqVibLFO: (p, g) => {
    p.freqVibLFO = g.get("freqVibLFO");
  },
  delayModEnv: (p, g) => {
    p.delayModEnv = timecentToSecond(g.get("delayModEnv"));
  },
  attackModEnv: (p, g) => {
    p.attackModEnv = timecentToSecond(g.get("attackModEnv"));
  },
  holdModEnv: (p, g, key) => {
    p.holdModEnv = keynumScaledSecond(
      key,
      g.get("holdModEnv"),
      g.get("keynumToModEnvHold"),
    );
  },
  decayModEnv: (p, g, key) => {
    p.decayModEnv = keynumScaledSecond(
      key,
      g.get("decayModEnv"),
      g.get("keynumToModEnvDecay"),
    );
  },
  sustainModEnv: (p, g) => {
    p.sustainModEnv = g.get("sustainModEnv") / 1000;
  },
  releaseModEnv: (p, g) => {
    p.releaseModEnv = timecentToSecond(g.get("releaseModEnv"));
  },
  keynumToModEnvHold: (p, g, key) => {
    p.holdModEnv = keynumScaledSecond(
      key,
      g.get("holdModEnv"),
      g.get("keynumToModEnvHold"),
    );
  },
  keynumToModEnvDecay: (p, g, key) => {
    p.decayModEnv = keynumScaledSecond(
      key,
      g.get("decayModEnv"),
      g.get("keynumToModEnvDecay"),
    );
  },
  delayVolEnv: (p, g) => {
    p.delayVolEnv = timecentToSecond(g.get("delayVolEnv"));
  },
  attackVolEnv: (p, g) => {
    p.attackVolEnv = timecentToSecond(g.get("attackVolEnv"));
  },
  holdVolEnv: (p, g, key) => {
    p.holdVolEnv = keynumScaledSecond(
      key,
      g.get("holdVolEnv"),
      g.get("keynumToVolEnvHold"),
    );
  },
  decayVolEnv: (p, g, key) => {
    p.decayVolEnv = keynumScaledSecond(
      key,
      g.get("decayVolEnv"),
      g.get("keynumToVolEnvDecay"),
    );
  },
  sustainVolEnv: (p, g) => {
    p.sustainVolEnv = g.get("sustainVolEnv") / 1000;
  },
  releaseVolEnv: (p, g) => {
    p.releaseVolEnv = timecentToSecond(g.get("releaseVolEnv"));
  },
  keynumToVolEnvHold: (p, g, key) => {
    p.holdVolEnv = keynumScaledSecond(
      key,
      g.get("holdVolEnv"),
      g.get("keynumToVolEnvHold"),
    );
  },
  keynumToVolEnvDecay: (p, g, key) => {
    p.decayVolEnv = keynumScaledSecond(
      key,
      g.get("decayVolEnv"),
      g.get("keynumToVolEnvDecay"),
    );
  },
  initialAttenuation: (p, g) => {
    p.initialAttenuation = g.get("initialAttenuation");
  },
  coarseTune: (p, g, _key, _originalPitch, pitchCorrection) => {
    p.detune = getDetune(pitchCorrection, g);
  },
  fineTune: (p, g, _key, _originalPitch, pitchCorrection) => {
    p.detune = getDetune(pitchCorrection, g);
  },
  scaleTuning: (p, g, key, originalPitch) => {
    p.playbackRate = getPlaybackRate(key, originalPitch, g);
  },
} as Record<ValueGeneratorKey, VoiceParamsHandlerFn>;

// Full interpreted VoiceParams for a voice at its current controller state
// (modulator application + SF2 §9.5 clamping is done by Voice itself;
// this only converts the resulting raw values into playback units).
export function getVoiceParams(
  voice: Voice,
  controllerState: Float32Array,
): VoiceParams {
  const key = voice.key;
  const sampleHeader = voice.sampleHeader;
  const staticGenerators = voice.generators;
  const params: Partial<VoiceParams> = {
    start: staticGenerators.get("startAddrsCoarseOffset") * 32768 +
      staticGenerators.get("startAddrsOffset"),
    end: staticGenerators.get("endAddrsCoarseOffset") * 32768 +
      staticGenerators.get("endAddrsOffset"),
    loopStart: sampleHeader.loopStart +
      staticGenerators.get("startloopAddrsCoarseOffset") * 32768 +
      staticGenerators.get("startloopAddrsOffset"),
    loopEnd: sampleHeader.loopEnd +
      staticGenerators.get("endloopAddrsCoarseOffset") * 32768 +
      staticGenerators.get("endloopAddrsOffset"),
    instrument: staticGenerators.get("instrument"),
    sampleID: staticGenerators.get("sampleID"),
    sample: voice.sample,
    sampleRate: sampleHeader.sampleRate,
    sampleName: sampleHeader.sampleName,
    sampleModes: staticGenerators.get("sampleModes"),
    exclusiveClass: staticGenerators.get("exclusiveClass"),
  };
  const generators = voice.transformAllParams(controllerState);
  for (let i = 0; i < ValueGeneratorKeys.length; i++) {
    const generatorKey = ValueGeneratorKeys[i];
    voiceParamsHandlerFns[generatorKey](
      params,
      generators,
      key,
      sampleHeader.originalPitch,
      sampleHeader.pitchCorrection,
    );
  }
  return params as VoiceParams;
}

// Interpreted VoiceParams fields affected by a single controller change
// (e.g. one MIDI CC), for incremental updates instead of recomputing every
// field on every controller message.
export function getVoiceParamsForController(
  voice: Voice,
  controllerType: number,
  controllerState: Float32Array,
): Partial<VoiceParams> {
  const params: Partial<VoiceParams> = {};
  const updatedParams = voice.transformParams(controllerType, controllerState);
  const updatedKeys = Object.keys(updatedParams) as ValueGeneratorKey[];
  if (updatedKeys.length === 0) return params;
  const generators = voice.generators.clone();
  for (let i = 0; i < updatedKeys.length; i++) {
    const generatorKey = updatedKeys[i];
    generators.set(generatorKey, updatedParams[generatorKey]!);
  }
  const key = voice.key;
  const sampleHeader = voice.sampleHeader;
  for (let i = 0; i < updatedKeys.length; i++) {
    voiceParamsHandlerFns[updatedKeys[i]](
      params,
      generators,
      key,
      sampleHeader.originalPitch,
      sampleHeader.pitchCorrection,
    );
  }
  return params;
}

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
  // a fixed BasePlayer<Note,Channel<Note>> here because subclass methods take
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
  // Set by Player when a note is absorbed into an offline segment/chunk tile
  // buffer (no per-note AudioBufferSourceNode). BasePlayer treats these as no-ops.
  isTiledGhost: boolean = false;
  tiledNoteDuration: number = 0;
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

type ChannelSettings = typeof BasePlayer.channelSettings;
type ChannelAudioNodes = ReturnType<BasePlayer["createChannelAudioNodes"]>;

export class Channel<TNote extends Note = Note> {
  // See Note.player above for why this is unknown rather than
  // BasePlayer<TNote, Channel<TNote>>.
  player!: unknown;
  // Every Channel<TNote> is always constructed by, and only by, a matching
  // BasePlayer<TNote, ...> (see Player.createChannels / createChannelInstance),
  // so this cast is safe by construction even though TypeScript can't prove
  // it generically. This is the single place that assertion is made; every
  // other place that needs the owning player (in this class, its
  // subclasses, or the default handlers below) should read
  // `channel.typedPlayer` instead of casting `channel.player` itself.
  get typedPlayer(): BasePlayer<TNote, Channel<TNote>> {
    return this.player as BasePlayer<TNote, Channel<TNote>>;
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
      (player.constructor as typeof BasePlayer).channelSettings;
    for (let i = 0; i < settingTypes.length; i++) {
      const key = settingTypes[i];
      this[key] = channelSettings[key];
    }
  }

  resetChannelStates(scheduleTime?: number): void {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const state = this.state;
    const keys = Object.keys(
      defaultControllerState,
    ) as (keyof typeof defaultControllerState)[];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const { type, defaultValue } = defaultControllerState[key];
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
      (player.constructor as typeof BasePlayer).channelSettings,
    );
  }

  allNotesOff(scheduleTime?: number): Promise<void[]> {
    const player = this.typedPlayer;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const promises: Promise<void>[] = [];
    this.processActiveNotes(t, (note) => {
      // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
      const promise = this.noteOff(note.noteNumber, 0, t, true);
      if (promise !== undefined) promises.push(promise);
    });
    this.sustainNotes = [];
    return Promise.all(promises);
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
{
  const defs = Object.values(defaultControllerState);
  for (let i = 0; i < defs.length; i++) {
    const { type, defaultValue } = defs[i];
    defaultControllerStateArray[type] = defaultValue;
  }
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
  "delayVolEnv",
  "attackVolEnv",
  "holdVolEnv",
  "decayVolEnv",
  "sustainVolEnv",
  "releaseVolEnv",
  "initialAttenuation",
];
export const volumeEnvelopeKeySet = new Set(volumeEnvelopeKeys);
const filterEnvelopeKeys = [
  "modEnvToPitch",
  "initialFilterFc",
  "modEnvToFilterFc",
  "delayModEnv",
  "attackModEnv",
  "holdModEnv",
  "decayModEnv",
  "sustainModEnv",
];
export const filterEnvelopeKeySet = new Set(filterEnvelopeKeys);
const pitchEnvelopeKeys = [
  "modEnvToPitch",
  "delayModEnv",
  "attackModEnv",
  "holdModEnv",
  "decayModEnv",
  "sustainModEnv",
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
// — used for both the Volume and Modulation envelopes.
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

export class BasePlayer<
  TNote extends Note = Note,
  TChannel extends Channel<TNote> = Channel<TNote>,
> extends EventTarget {
  // https://pmc.ncbi.nlm.nih.gov/articles/PMC4191557/
  // Gap detection studies indicate humans detect temporal discontinuities
  // around 2–3 ms. Smoothing over ~4 ms is perceived as continuous.
  perceptualSmoothingTime: number = 0.004;
  mode: string = "GM1";
  numChannels: number = 16;
  ticksPerBeat: number = 120;
  totalTime: number = 0;
  noteCheckInterval: number = 0.1;
  drainTimeoutMs: number = 5000;
  lookAhead: number = 1;
  startDelay: number = 0.5;
  startTime: number = 0;
  resumeTime: number = 0;
  soundFonts: SoundFont[] = [];
  soundFontTable: number[][] = (() => {
    const t = new Array<number[]>(128);
    for (let i = 0; i < 128; i++) t[i] = [];
    return t;
  })();
  voiceCounter: Map<number, number> = new Map();
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
  drumExclusiveClasses: Uint8Array = createDefaultDrumExclusiveClasses();
  drumExclusiveClassNotes: (TNote | null)[] = new Array(
    16 * DEFAULT_DRUM_EXCLUSIVE_CLASS_COUNT,
  );
  ignoreDrumNoteOff: boolean = true;
  noteAudioBufferIds: (number | undefined)[] = [];
  preloadEntries: { audioBufferId: number; voiceParams: VoiceParams }[] = [];
  // Max time to wait for natural note-release tails at song end before
  // force-stopping remaining notes. Also bounds
  // waitNotePromisesInterruptible so seek/pause/stop can break out of a
  // large pending-release backlog near the end of dense MIDI files.
  releaseGraceSec: number = 2;

  audioContext: AudioContext | OfflineAudioContext;
  masterVolume: GainNode;
  masterVolumeLocked: boolean = false;
  scheduler: GainNode | null;
  schedulerBuffer: AudioBuffer | null;
  pendingSchedulerSources: Set<AudioBufferSourceNode> = new Set();
  channels: TChannel[];
  messageHandlers: MessageHandler[];
  voiceParamsHandlers: Record<string, VoiceParamsHandler<TNote, TChannel>>;
  controlChangeHandlers: ControlChangeHandler<TNote, TChannel>[];
  // 1-sample buffer used only to detach large AudioBuffers from
  // AudioBufferSourceNode.buffer on stop/disconnect. On iOS Safari, clearing
  // the JS reference alone often does not release the underlying PCM until
  // the source node itself is torn down with buffer reassigned.
  private scratchBufferForNeuter: AudioBuffer | null = null;

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
    options?: {
      activeChannelNumbers?: Iterable<number>;
      offlineRenderOnly?: boolean;
    },
  ) {
    super();
    this.audioContext = audioContext;
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
    this.channels = this.createChannels(
      activeChannelNumbers,
      options?.offlineRenderOnly === true,
    );
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
    const presetHeaders = soundFont.presetHeaders;
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
        const soundFont = parse(uint8Arrays[i]);
        this.addSoundFont(soundFont);
      }
    } else {
      const uint8Array = await this.toUint8Array(input);
      const soundFont = parse(uint8Array);
      this.addSoundFont(soundFont);
    }
  }

  async loadMIDI(input: string | Uint8Array): Promise<void> {
    if (this.isPlaying || this.isPaused) {
      await this.stop();
    }
    this.voiceCounter.clear();
    this.clearPlaybackCaches();
    this.noteAudioBufferIds = [];
    this.preloadEntries = [];
    this.resumeTime = 0;
    this.isPaused = false;

    const uint8Array = await this.toUint8Array(input);
    const midi = parseMidi(uint8Array);
    this.ticksPerBeat = midi.header.ticksPerBeat ?? 480;
    const midiData = this.extractMidiData(midi);
    this.instruments = midiData.instruments;
    this.timeline = midiData.timeline;
    this.totalTime = this.calcTotalTime();
  }

  getVoiceId(
    channel: TChannel,
    noteNumber: number,
    velocity: number,
  ): number | undefined {
    const resolved = this.resolveVoiceResult(channel, noteNumber, velocity);
    if (!resolved) return;
    const instrument = resolved.voice.generators.get("instrument");
    const sampleID = resolved.voice.generators.get("sampleID");
    // Include a coarse start-offset tag so two presets that share sampleID
    // but slice different regions don't collide in rawAudioBufferCache
    // (createAudioBuffer applies voiceParams.start/end for PCM).
    const controllerState = this.getControllerState(
      channel,
      noteNumber,
      velocity,
      0,
    );
    const params = getVoiceParams(resolved.voice, controllerState);
    const startTag = (params.start | 0) & 0xffff;
    return resolved.soundFontIndex * (2 ** 31) + instrument * (2 ** 24) +
      ((sampleID & 0xffff) << 8) + startTag;
  }

  // Overridden by subclasses (e.g. Midy) that instantiate Player<TChannel,
  // TNote> with a richer TChannel/TNote subclass, so that base methods
  // shared via inheritance (createChannels, scheduleTimelineEvents, ...)
  // still construct the right runtime type instead of the base one.
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

  createChannels(
    activeChannelNumbers?: Set<number>,
    offlineRenderOnly = false,
  ): TChannel[] {
    const settings = (this.constructor as typeof BasePlayer).channelSettings;
    const audioContext = this.audioContext;
    const numChannels = this.numChannels;
    const channels = new Array<TChannel>(numChannels);
    if (audioContext instanceof OfflineAudioContext) {
      for (let ch = 0; ch < numChannels; ch++) {
        const isActive = !activeChannelNumbers ||
          activeChannelNumbers.has(ch);
        if (offlineRenderOnly && !isActive) {
          channels[ch] = undefined as unknown as TChannel;
          continue;
        }
        const audioNodes = isActive
          ? this.createChannelAudioNodes(audioContext)
          : undefined;
        const channel = this.createChannelInstance(ch, settings, audioNodes);
        channel.player = this;
        channels[ch] = channel;
      }
    } else {
      let unusedAudioNodes: ChannelAudioNodes | null = null;
      for (let ch = 0; ch < numChannels; ch++) {
        const audioNodes = !activeChannelNumbers || activeChannelNumbers.has(ch)
          ? this.createChannelAudioNodes(audioContext)
          : (unusedAudioNodes ??= this.createUnusedChannelAudioNodes(
            audioContext,
          ));
        const channel = this.createChannelInstance(ch, settings, audioNodes);
        channel.player = this;
        channels[ch] = channel;
      }
    }
    return channels;
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

  isLoopDrum(_channel: TChannel, _noteNumber: number): boolean {
    return false;
  }

  createBufferSource(
    channel: TChannel,
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
          const note = this.createNoteInstance(
            event.noteNumber!,
            event.velocity!,
            startTime,
          );
          note.timelineIndex = queueIndex;
          note.audioBufferId = this.noteAudioBufferIds[queueIndex];
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

  clearPlaybackCaches(): void {
    // No offline-render caches in BasePlayer. Player overrides.
  }

  resetChannels(
    channels: TChannel[] = this.channels,
    scheduleTime?: number,
  ): void {
    // Skip undefined slots left by offline lightweight createChannels.
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      if (!channel) continue;
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

  // Factory for a fresh ControllerState when resetting channels in
  // prepareVoices / cacheVoiceIds. Subclasses with a richer ControllerState
  // (GM2 softPedal/portamento, Midy LSB/delay) must override this; otherwise
  // installing the base class leaves getters undefined and yields silent
  // (NaN gain) output.
  protected createControllerState(): ControllerState {
    return new ControllerState();
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

  suspendAudioContext(): Promise<void> {
    if (this.audioContext instanceof AudioContext) {
      return this.audioContext.suspend();
    }
    return Promise.resolve();
  }

  // Wait for note-release promises, but abort early if seek/pause/stop is
  // requested, or when {@link releaseGraceSec} elapses. Returns "completed"
  // if all settled (or grace expired with no abort), "aborted" if a control
  // flag was raised. Callers that get "aborted" should fall through to the
  // isSeeking/isPausing/isStopping handlers (which force-stop remaining notes
  // via stopNotes).
  // Without this, dense MIDI files can leave hundreds of release tails in
  // notePromises near song end; a blocking Promise.allSettled then makes
  // seek/pause unresponsive until every tail finishes.
  protected async waitNotePromisesInterruptible(
    promises: Promise<void>[],
  ): Promise<"completed" | "aborted"> {
    if (promises.length === 0) return "completed";

    const shouldAbort = () =>
      this.isSeeking || this.isPausing || this.isStopping;

    if (shouldAbort()) return "aborted";

    let remaining = promises.length;
    let finished = false;
    const ac = this.audioContext;
    const graceSec = this.releaseGraceSec;
    const useAudioClock = ac instanceof AudioContext &&
      ac.state === "running" &&
      !!this.scheduler;
    const deadline = useAudioClock
      ? ac.currentTime + graceSec
      : Date.now() + graceSec * 1000;

    await new Promise<void>((resolve) => {
      const tryFinish = () => {
        if (finished) return;
        if (remaining <= 0 || shouldAbort()) {
          finished = true;
          resolve();
        }
      };

      for (let i = 0; i < promises.length; i++) {
        Promise.resolve(promises[i]).then(
          () => {
            remaining--;
            tryFinish();
          },
          () => {
            remaining--;
            tryFinish();
          },
        );
      }

      // Poll for abort / grace timeout. Prefer audio-clock ticks while
      // running so background-tab setTimeout throttling does not leave us
      // stuck past the intended grace window.
      const poll = async () => {
        while (!finished) {
          if (shouldAbort()) {
            tryFinish();
            return;
          }
          if (useAudioClock) {
            if (ac.currentTime >= deadline) {
              // Grace expired: treat as completed so the ended path can
              // force-stop remaining tails via stopNotes.
              if (!finished) {
                finished = true;
                resolve();
              }
              return;
            }
          } else if (Date.now() >= deadline) {
            if (!finished) {
              finished = true;
              resolve();
            }
            return;
          }
          await this.waitTick();
        }
      };
      void poll();
    });

    return shouldAbort() ? "aborted" : "completed";
  }

  // Resolve when bufferSource ends (or after a timeout past stopAt).
  // Guarantees the returned Promise always settles so notePromises cannot
  // hang indefinitely if onended never fires.
  protected waitSourceEnded(
    note: TNote,
    stopAt: number,
    afterDisconnect?: () => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          this.disconnectNote(note);
          afterDisconnect?.();
        } catch {
          // disconnect / modLfo.stop may throw if already torn down
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
        src.stop(stopAt);
      } catch {
        finish();
        return;
      }
      const now = this.audioContext.currentTime;
      const waitMs = Math.max(50, (stopAt - now) * 1000 + 100);
      setTimeout(finish, waitMs);
    });
  }

  async playNotes(): Promise<void> {
    const audioContext = this.audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
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
        this.totalTime < this.currentTime() &&
        this.timeline.length <= queueIndex
      ) {
        const pendingPromises = this.notePromises.slice();
        this.notePromises = [];
        const result = await this.waitNotePromisesInterruptible(
          pendingPromises,
        );
        // If seek/pause/stop interrupted the release wait, fall through to
        // the flag handlers below (which call stopNotes). Otherwise finish
        // the song (or loop).
        if (result === "completed") {
          if (this.loop) {
            this.resetAllStates();
            this.startTime = audioContext.currentTime;
            this.resumeTime = 0;
            queueIndex = 0;
            this.dispatchEvent(new Event("looped"));
            continue;
          } else {
            await this.stopNotes(now);
            await this.suspendAudioContext();
            exitReason = "ended";
            break;
          }
        }
      }
      if (this.isPausing) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
        await this.suspendAudioContext();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
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
        if (note.isTiledGhost) continue;
        // Set the 'ending' flag beforehand to prevent start() from being called after buffer prep completes.
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
      const headers = this.soundFonts[sfIndex].presetHeaders;
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
    const family = BasePlayer.gmFamilyCandidates(programNumber);
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

  async start({ preload = true }: { preload?: boolean } = {}): Promise<void> {
    if (this.isPlaying) return;
    if (this.isPaused) {
      await this.resume();
      return;
    }
    this.resumeTime = 0;
    if (this.voiceCounter.size === 0) this.prepareVoices();
    if (preload) await this.preloadSamplesBase();
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
    const timeScale = this.tempo / tempo;
    this.resumeTime = this.resumeTime * timeScale;
    this.tempo = tempo;
    this.totalTime = this.calcTotalTime();
    this.seekTo(this.currentTime() * timeScale);
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
      if (note.renderedBuffer?.isFull || note.isTiledGhost) return;
      if (!note.bufferSource) return;
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
      cbToRatio(-1000 * voiceParams.sustainVolEnv);
    const delayVolEnvTime = startTime + voiceParams.delayVolEnv;
    const attackVolEnvTime = delayVolEnvTime + voiceParams.attackVolEnv;
    const holdVolEnvTime = attackVolEnvTime + voiceParams.holdVolEnv;
    const decayDuration = voiceParams.decayVolEnv;
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(0, startTime)
      .setValueAtTime(1e-6, delayVolEnvTime)
      .exponentialRampToValueAtTime(attackVolume, attackVolEnvTime)
      .setValueAtTime(attackVolume, holdVolEnvTime)
      .exponentialRampToValueAtTime(
        sustainVolume,
        holdVolEnvTime + decayDuration,
      );
  }

  setDetune(channel: TChannel, note: TNote, scheduleTime: number): void {
    const src = note.bufferSource;
    if (!src) return;
    const detune = this.calcNoteDetune(channel, note);
    const timeConstant = this.perceptualSmoothingTime / 5;
    src.detune
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
      this.centToRate(modEnvToPitch * (1 - voiceParams.sustainModEnv));
    const delayModEnvTime = note.startTime + voiceParams.delayModEnv;
    const attackModEnvTime = delayModEnvTime + voiceParams.attackModEnv;
    const holdModEnvTime = attackModEnvTime + voiceParams.holdModEnv;
    const decayDuration = voiceParams.decayModEnv;
    bufferSource.playbackRate
      .setValueAtTime(baseRate, delayModEnvTime)
      .exponentialRampToValueAtTime(peekRate, attackModEnvTime)
      .setValueAtTime(peekRate, holdModEnvTime)
      .exponentialRampToValueAtTime(
        sustainRate,
        holdModEnvTime + decayDuration,
      );
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
      modEnvToFilterFc * (1 - voiceParams.sustainModEnv);
    const baseFreq = this.centToHz(baseCent);
    const peekFreq = this.centToHz(peekCent);
    const sustainFreq = this.centToHz(sustainCent);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedPeekFreq = this.clampCutoffFrequency(peekFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const delayModEnvTime = startTime + voiceParams.delayModEnv;
    const attackModEnvTime = delayModEnvTime + voiceParams.attackModEnv;
    const holdModEnvTime = attackModEnvTime + voiceParams.holdModEnv;
    const decayDuration = voiceParams.decayModEnv;
    note.adjustedBaseFreq = adjustedBaseFreq;
    note.filterEnvelopeNode.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, delayModEnvTime)
      .exponentialRampToValueAtTime(adjustedPeekFreq, attackModEnvTime)
      .setValueAtTime(adjustedPeekFreq, holdModEnvTime)
      .exponentialRampToValueAtTime(
        adjustedSustainFreq,
        holdModEnvTime + decayDuration,
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

  // --- cache / offline-render implementations ---

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
      (note.voice ? getVoiceParams(note.voice, controllerState) : null);
    note.voiceParams = voiceParams;
    if (!voiceParams) return;
    if (note.isTiledGhost) return;

    const audioBufferId = note.audioBufferId !== undefined
      ? note.audioBufferId
      : this.getVoiceId(channel, noteNumber, velocity);
    let audioBuffer: AudioBuffer | undefined;
    if (audioBufferId !== undefined) {
      audioBuffer = await this.getRawAudioBuffer(audioBufferId, voiceParams);
    } else {
      audioBuffer = await this.createAudioBuffer(voiceParams);
    }
    if (note.ending || !audioBuffer) return;
    note.renderedBuffer = null;
    note.bufferSource = this.createBufferSource(
      channel,
      note.noteNumber,
      voiceParams,
      audioBuffer,
    );
    note.volumeNode = new GainNode(audioContext);

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

    if (!realtime) {
      this.warnIfStartTimeMissed(
        `note (channel ${channel.channelNumber}, note ${note.noteNumber})`,
        startTime,
      );
    }
    if (voiceParams.sample.type === "compressed") {
      note.bufferSource.start(
        startTime,
        voiceParams.start / audioBuffer.sampleRate,
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
  // note (decoding, envelope setup) takes longer than lookAhead,
  // the note's intended start time silently passes
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
    if (note.isTiledGhost) return;
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

  // iOS Safari often retains AudioBuffer memory while it is still attached to
  // an AudioBufferSourceNode. Replacing .buffer with a 1-sample scratch buffer
  // after stop/disconnect helps the native side drop the large PCM.
  protected getScratchBufferForNeuter(): AudioBuffer {
    if (!this.scratchBufferForNeuter) {
      this.scratchBufferForNeuter = this.audioContext.createBuffer(
        1,
        1,
        this.audioContext.sampleRate,
      );
    }
    return this.scratchBufferForNeuter;
  }

  protected neuterBufferSource(
    source: AudioBufferSourceNode | null | undefined,
  ): void {
    if (!source) return;
    try {
      source.onended = null;
    } catch {
      // ignore
    }
    try {
      source.stop();
    } catch {
      // already stopped / never started
    }
    try {
      source.disconnect();
    } catch {
      // already disconnected
    }
    try {
      source.buffer = this.getScratchBufferForNeuter();
    } catch {
      // Chrome/Firefox may throw if buffer is reassigned after start; ignore.
    }
  }

  disconnectNote(note: TNote): void {
    this.soundingNotes.delete(note);
    this.neuterBufferSource(note.bufferSource);
    note.bufferSource = null;
    note.renderedBuffer = null;
    try {
      note.filterEnvelopeNode?.disconnect();
    } catch { /* ignore */ }
    try {
      note.volumeEnvelopeNode?.disconnect();
    } catch { /* ignore */ }
    try {
      note.volumeNode?.disconnect();
    } catch { /* ignore */ }
    note.filterEnvelopeNode = null;
    note.volumeEnvelopeNode = null;
    note.volumeNode = null;
    if (note.modLfoToPitch || note.modLfo) {
      try {
        note.modLfoToFilterFc?.disconnect();
      } catch { /* ignore */ }
      try {
        note.modLfoToVolume?.disconnect?.();
      } catch { /* ignore */ }
      try {
        note.modLfoToPitch?.disconnect?.();
      } catch { /* ignore */ }
      try {
        note.modLfo?.stop();
      } catch {
        // not started / already stopped
      }
      try {
        note.modLfo?.disconnect();
      } catch { /* ignore */ }
      note.modLfo = null;
      note.modLfoToPitch = null;
      note.modLfoToFilterFc = null;
      note.modLfoToVolume = null;
    }
  }

  releaseNote(
    _channel: TChannel,
    note: TNote,
    endTime: number,
  ): Promise<void> | void {
    if (note.isTiledGhost) return;
    const volDuration = note.voiceParams?.releaseVolEnv ?? 0;
    const releaseVolEnvTime = endTime + volDuration;

    if (note.volumeEnvelopeNode) {
      try {
        note.filterEnvelopeNode?.frequency
          .cancelScheduledValues(endTime)
          .exponentialRampToValueAtTime(
            note.adjustedBaseFreq,
            endTime + (note.voiceParams?.releaseModEnv ?? 0),
          );
        note.volumeEnvelopeNode.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    } else {
      try {
        note.volumeNode?.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    }

    // waitSourceEnded always settles (onended or timeout), so notePromises
    // cannot hang if the browser skips onended under load.
    return this.waitSourceEnded(note, releaseVolEnvTime);
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
        // matches offline bakes in subclasses that force-release drums.
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
    if (!note.voice || note.isTiledGhost) {
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
      if (note.renderedBuffer?.isFull || note.isTiledGhost) return;
      const controllerState = this.getControllerState(
        channel,
        note.noteNumber,
        note.velocity,
        note.pressure,
      );
      const voiceParams = note.voice
        ? getVoiceParamsForController(
          note.voice,
          controllerType,
          controllerState,
        )
        : undefined;
      if (!voiceParams) return;
      let applyVolumeEnvelope = false;
      let applyFilterEnvelope = false;
      let applyPitchEnvelope = false;
      const entries = Object.entries(voiceParams);
      const handlers = this.voiceParamsHandlers;
      for (let ei = 0; ei < entries.length; ei++) {
        const key = entries[ei][0];
        const value = entries[ei][1];
        const prevValue = note.voiceParams?.[key as keyof VoiceParams];
        if (value === prevValue) continue;
        (note.voiceParams as Record<keyof VoiceParams, unknown>)[
          key as keyof VoiceParams
        ] = value;
        if (key in handlers) {
          handlers[key](channel, note, scheduleTime);
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
      if (note.renderedBuffer?.isFull || note.isTiledGhost) return;
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
    const isPrimary = channels === this.channels;
    if (isPrimary) {
      this.mode = "GM1";
      this.exclusiveClassNotes.fill(null);
      this.drumExclusiveClassNotes.fill(null);
    }
    // Offline lightweight bakers (createOfflineRenderPlayer with a subset of
    // activeChannelNumbers) leave inactive slots as undefined — skip them.
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      if (!channel) continue;
      channel.allSoundOff(scheduleTime);
    }
    this.resetChannels(channels, scheduleTime);
    if (isPrimary) {
      this.setMasterVolume(1, scheduleTime);
    }
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
    const sources = Array.from(this.pendingSchedulerSources);
    for (let i = 0; i < sources.length; i++) {
      try {
        sources[i].stop();
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
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i];
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

  // Resolve voice IDs / preload entries for the current timeline.
  prepareVoices(): void {
    const { channels, timeline, voiceCounter } = this;
    const settings = (this.constructor as typeof BasePlayer).channelSettings;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.resetSettings(settings);
      // Subclass factory — see Player.createControllerState.
      channel.state = this.createControllerState();
      channel.isDrum = false;
      channel.detune = 0;
      channel.programNumber = 0;
    }
    if (channels[9]) channels[9].isDrum = true;
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
          if (audioBufferId !== undefined) {
            voiceCounter.set(
              audioBufferId,
              (voiceCounter.get(audioBufferId) ?? 0) + 1,
            );
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
              const voiceParams = getVoiceParams(voice, controllerState);
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
    {
      const pairs = Array.from(voiceCounter);
      for (let i = 0; i < pairs.length; i++) {
        if (pairs[i][1] === 1) voiceCounter.delete(pairs[i][0]);
      }
    }
    this.GM1SystemOn(this.audioContext.currentTime);
  }

  async preloadSamplesBase(): Promise<void> {
    const entries = this.preloadEntries;
    const cache = this.rawAudioBufferCache;
    const tasks = new Array<Promise<AudioBuffer>>(entries.length);
    let taskCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (cache.has(entry.audioBufferId)) continue;
      tasks[taskCount++] = this.getRawAudioBuffer(
        entry.audioBufferId,
        entry.voiceParams,
      );
    }
    if (taskCount === 0) return;
    tasks.length = taskCount;
    await Promise.all(tasks);
  }
}
