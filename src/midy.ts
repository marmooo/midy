// Full-featured Midy (GM2 + MPE + delay + poly pressure + extended CCs).
// Inherits the shared GM2 engine from midy-GM2.ts (itself built on player.ts)
// and only adds / overrides the pieces that go beyond plain GM2.
import {
  Channel as GM2Channel,
  ControllerState as GM2ControllerState,
  MidyGM2,
  Note as GM2Note,
  RenderedBuffer,
} from "./midy-GM2.ts";
import { cbToRatio, type MessageHandler } from "./player.ts";

export { RenderedBuffer };

// ---------------------------------------------------------------------------
// Note - GM2 note + delay send
// ---------------------------------------------------------------------------
export class Note extends GM2Note {
  delaySend: GainNode | null = null;
}

// ---------------------------------------------------------------------------
// ControllerState - GM2 state + LSB / sound controllers / delay / poly pressure
// ---------------------------------------------------------------------------
const extraControllerDefaults: Record<
  string,
  { type: number; defaultValue: number }
> = {
  polyphonicKeyPressure: { type: 10, defaultValue: 0 },
  modulationDepthLSB: { type: 128 + 33, defaultValue: 0 },
  portamentoTimeLSB: { type: 128 + 37, defaultValue: 0 },
  volumeLSB: { type: 128 + 39, defaultValue: 0 },
  panLSB: { type: 128 + 42, defaultValue: 0 },
  expressionLSB: { type: 128 + 43, defaultValue: 0 },
  filterResonance: { type: 128 + 71, defaultValue: 64 / 127 },
  releaseTime: { type: 128 + 72, defaultValue: 64 / 127 },
  attackTime: { type: 128 + 73, defaultValue: 64 / 127 },
  brightness: { type: 128 + 74, defaultValue: 64 / 127 },
  decayTime: { type: 128 + 75, defaultValue: 64 / 127 },
  vibratoRate: { type: 128 + 76, defaultValue: 64 / 127 },
  vibratoDepth: { type: 128 + 77, defaultValue: 64 / 127 },
  vibratoDelay: { type: 128 + 78, defaultValue: 64 / 127 },
  portamentoNoteNumber: { type: 128 + 84, defaultValue: 0 },
  delaySendLevel: { type: 128 + 94, defaultValue: 0 },
};

const extraControllerStateArray = new Float32Array(256);
for (const { type, defaultValue } of Object.values(extraControllerDefaults)) {
  extraControllerStateArray[type] = defaultValue;
}

export class ControllerState extends GM2ControllerState {
  constructor() {
    super();
    // Only write the Midy-specific slots. Do NOT array.set() a mostly-zero
    // buffer — that would wipe GM2 defaults (volumeMSB=100/127, expression=1,
    // pan center, pitch wheel center, etc.) and kill/colour the output.
    for (
      const { type, defaultValue } of Object.values(extraControllerDefaults)
    ) {
      this.array[type] = defaultValue;
    }
  }

  get polyphonicKeyPressure(): number {
    return this.array[10];
  }
  set polyphonicKeyPressure(value: number) {
    this.array[10] = value;
  }

  get modulationDepthLSB(): number {
    return this.array[128 + 33];
  }
  set modulationDepthLSB(value: number) {
    this.array[128 + 33] = value;
  }

  get portamentoTimeLSB(): number {
    return this.array[128 + 37];
  }
  set portamentoTimeLSB(value: number) {
    this.array[128 + 37] = value;
  }

  get volumeLSB(): number {
    return this.array[128 + 39];
  }
  set volumeLSB(value: number) {
    this.array[128 + 39] = value;
  }

  get panLSB(): number {
    return this.array[128 + 42];
  }
  set panLSB(value: number) {
    this.array[128 + 42] = value;
  }

  get expressionLSB(): number {
    return this.array[128 + 43];
  }
  set expressionLSB(value: number) {
    this.array[128 + 43] = value;
  }

  get filterResonance(): number {
    return this.array[128 + 71];
  }
  set filterResonance(value: number) {
    this.array[128 + 71] = value;
  }

  get releaseTime(): number {
    return this.array[128 + 72];
  }
  set releaseTime(value: number) {
    this.array[128 + 72] = value;
  }

  get attackTime(): number {
    return this.array[128 + 73];
  }
  set attackTime(value: number) {
    this.array[128 + 73] = value;
  }

  get brightness(): number {
    return this.array[128 + 74];
  }
  set brightness(value: number) {
    this.array[128 + 74] = value;
  }

  get decayTime(): number {
    return this.array[128 + 75];
  }
  set decayTime(value: number) {
    this.array[128 + 75] = value;
  }

  get vibratoRate(): number {
    return this.array[128 + 76];
  }
  set vibratoRate(value: number) {
    this.array[128 + 76] = value;
  }

  get vibratoDepth(): number {
    return this.array[128 + 77];
  }
  set vibratoDepth(value: number) {
    this.array[128 + 77] = value;
  }

  get vibratoDelay(): number {
    return this.array[128 + 78];
  }
  set vibratoDelay(value: number) {
    this.array[128 + 78] = value;
  }

  get portamentoNoteNumber(): number {
    return this.array[128 + 84];
  }
  set portamentoNoteNumber(value: number) {
    this.array[128 + 84] = value;
  }

  get delaySendLevel(): number {
    return this.array[128 + 94];
  }
  set delaySendLevel(value: number) {
    this.array[128 + 94] = value;
  }
}

// ---------------------------------------------------------------------------
// Channel - GM2 channel + MPE / poly pressure / portamentoControl
// ---------------------------------------------------------------------------
const defaultPressureValues = new Int8Array([64, 64, 64, 0, 0, 0]);
const defaultControlValues = new Int8Array([
  ...[-1, -1, -1, -1, -1, -1],
  ...defaultPressureValues,
]);

export class Channel extends GM2Channel {
  declare player: Midy;
  declare state: ControllerState;
  declare sustainNotes: Note[];
  declare sostenutoNotes: Note[];
  declare activeNotes: (Note[] | undefined)[];

  portamentoControl: boolean = false;
  isMPEMember: boolean = false;
  isMPEManager: boolean = false;
  polyphonicKeyPressureTable = new Int8Array(defaultPressureValues);

  constructor(
    channelNumber: number,
    settings: ConstructorParameters<typeof GM2Channel>[1],
    audioNodes?: ConstructorParameters<typeof GM2Channel>[2],
  ) {
    super(channelNumber, settings, audioNodes);
    this.state = new ControllerState();
    this.controlTable = new Int8Array(defaultControlValues);
    this.channelPressureTable = new Int8Array(defaultPressureValues);
    this.polyphonicKeyPressureTable = new Int8Array(defaultPressureValues);
  }

  override resetTable(): void {
    super.resetTable();
    this.polyphonicKeyPressureTable.set(defaultPressureValues);
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
        player.setControlChangeEffects(this, note as Note, t);
      });
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`,
      );
    }
  }

  setPolyphonicKeyPressure(
    noteNumber: number,
    pressure: number,
    scheduleTime?: number,
  ): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.processActiveNotes(t, (note) => {
      if (note.noteNumber === noteNumber) {
        note.pressure = pressure;
        player.setPolyphonicKeyPressureEffects(this, note as Note, t);
      }
    });
    player.applyVoiceParams(this, 10, t);
  }

  override setModulationDepth(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const intPart = Math.trunc(value);
    this.state.modulationDepthMSB = intPart / 127;
    this.state.modulationDepthLSB = (value - intPart) / 127;
    player.updateModulation(this, t);
  }

  setModulationDepthMSB(value: number, scheduleTime?: number): void {
    this.setModulationDepth(value, scheduleTime);
  }

  setModulationDepthLSB(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.modulationDepthLSB = value / 127;
    player.updateModulation(this, t);
  }

  override setPortamentoTime(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const intPart = Math.trunc(value);
    this.state.portamentoTimeMSB = intPart / 127;
    this.state.portamentoTimeLSB = (value - intPart) / 127;
    if (this.isDrum) return;
    player.updatePortamento(this, t);
  }

  setPortamentoTimeMSB(value: number, scheduleTime?: number): void {
    this.setPortamentoTime(value, scheduleTime);
  }

  setPortamentoTimeLSB(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.portamentoTimeLSB = value / 127;
    if (this.isDrum) return;
    player.updatePortamento(this, t);
  }

  override setVolume(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const intPart = Math.trunc(value);
    this.state.volumeMSB = intPart / 127;
    this.state.volumeLSB = (value - intPart) / 127;
    player.applyVolume(this, t);
  }

  setVolumeMSB(value: number, scheduleTime?: number): void {
    this.setVolume(value, scheduleTime);
  }

  setVolumeLSB(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.volumeLSB = value / 127;
    player.applyVolume(this, t);
  }

  override setPan(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    const intPart = Math.trunc(value);
    this.state.panMSB = intPart / 127;
    this.state.panLSB = (value - intPart) / 127;
    if (this.isDrum) {
      for (let i = 0; i < 128; i++) {
        player.updateKeyBasedVolume(this, i, t);
      }
    } else {
      player.updateChannelVolume(this, t);
    }
  }

  setPanMSB(value: number, scheduleTime?: number): void {
    this.setPan(value, scheduleTime);
  }

  setPanLSB(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.panLSB = value / 127;
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
    const intPart = Math.trunc(value);
    this.state.expressionMSB = intPart / 127;
    this.state.expressionLSB = (value - intPart) / 127;
    player.updateChannelVolume(this, t);
  }

  setExpressionMSB(value: number, scheduleTime?: number): void {
    this.setExpression(value, scheduleTime);
  }

  setExpressionLSB(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.expressionLSB = value / 127;
    player.updateChannelVolume(this, t);
  }

  setPortamentoNoteNumber(value: number): void {
    this.state.portamentoNoteNumber = value / 127;
    this.portamentoControl = true;
  }

  dataIncrement(scheduleTime?: number): void {
    if (this.isDrum) return;
    this.dataLSB++;
    this.limitData(0, 127, 0, 127);
    this.handleRPN(scheduleTime);
  }

  dataDecrement(scheduleTime?: number): void {
    if (this.isDrum) return;
    this.dataLSB--;
    this.limitData(0, 127, 0, 127);
    this.handleRPN(scheduleTime);
  }

  setFilterResonance(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.filterResonance = value / 127;
    this.processScheduledNotes((note) => {
      player.setFilterQ(this, note as Note, t);
    });
  }

  setReleaseTime(value: number): void {
    if (this.isDrum) return;
    this.state.releaseTime = value / 127;
  }

  setAttackTime(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.attackTime = value / 127;
    this.processScheduledNotes((note) => {
      if (player.isPortamento(this, note as Note)) {
        player.ensureFilterEnvelopeNode(note);
        player.setPortamentoVolumeEnvelope(this, note as Note, t);
        player.setPortamentoFilterEnvelope(this, note as Note, t);
      } else {
        player.setVolumeEnvelope(this, note as Note, t);
        player.setFilterEnvelope(this, note as Note, t);
      }
    });
  }

  setBrightness(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.brightness = value / 127;
    this.processScheduledNotes((note) => {
      player.setFilterEnvelope(this, note as Note, t);
    });
  }

  setDecayTime(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.decayTime = value / 127;
    this.processScheduledNotes((note) => {
      if (player.isPortamento(this, note as Note)) {
        player.ensureFilterEnvelopeNode(note);
        player.setPortamentoVolumeEnvelope(this, note as Note, t);
        player.setPortamentoFilterEnvelope(this, note as Note, t);
      } else {
        player.setVolumeEnvelope(this, note as Note, t);
        player.setFilterEnvelope(this, note as Note, t);
      }
    });
  }

  setVibratoRate(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.vibratoRate = value / 127;
    this.processScheduledNotes((note) => {
      player.setFreqVibLFO(note, t);
    });
  }

  setVibratoDepth(value: number, scheduleTime?: number): void {
    if (this.isDrum) return;
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.vibratoDepth = value / 127;
    this.processScheduledNotes((note) => {
      player.setVibLfoToPitch(this, note as Note, t);
    });
  }

  setVibratoDelay(value: number, _scheduleTime?: number): void {
    if (this.isDrum) return;
    this.state.vibratoDelay = value / 127;
  }

  setDelaySendLevel(value: number, scheduleTime?: number): void {
    const player = this.player;
    const t: number = scheduleTime ?? player.audioContext.currentTime;
    this.state.delaySendLevel = value / 127;
    this.processScheduledNotes((note) => {
      player.setDelaySend(this, note as Note, t);
    });
  }

  override omniOff(_t?: number): void {
    if (this.player.mpeEnabled) return;
  }
  override omniOn(_t?: number): void {
    if (this.player.mpeEnabled) return;
  }
  override monoOn(_t?: number): void {
    if (this.isMPEManager) return;
    this.mono = true;
  }
  override polyOn(_t?: number): void {
    if (this.isMPEManager) return;
    this.mono = false;
  }
}

// ---------------------------------------------------------------------------
// Extended CC handlers
// ---------------------------------------------------------------------------
type ControlChangeHandler = (ch: Channel, v: number, t: number) => void;
type KeyBasedHandler = (
  channel: Channel,
  keyNumber: number,
  scheduleTime: number,
) => void;

type ChannelOptionalMethods = {
  dataIncrement?: (t: number) => void;
  dataDecrement?: (t: number) => void;
  setRPGMakerLoop?: (t: number) => void;
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
controlChangeHandlers[33] = (ch, v, t) => ch.setModulationDepthLSB(v, t);
controlChangeHandlers[37] = (ch, v, t) => ch.setPortamentoTimeLSB(v, t);
controlChangeHandlers[38] = (ch, v, t) => ch.dataEntryLSB(v, t);
controlChangeHandlers[39] = (ch, v, t) => ch.setVolumeLSB(v, t);
controlChangeHandlers[42] = (ch, v, t) => ch.setPanLSB(v, t);
controlChangeHandlers[43] = (ch, v, t) => ch.setExpressionLSB(v, t);
controlChangeHandlers[64] = (ch, v, t) => ch.setSustainPedal(v, t);
controlChangeHandlers[65] = (ch, v, t) => ch.setPortamento(v, t);
controlChangeHandlers[66] = (ch, v, t) => ch.setSostenutoPedal(v, t);
controlChangeHandlers[67] = (ch, v, t) => ch.setSoftPedal(v, t);
controlChangeHandlers[71] = (ch, v, t) => ch.setFilterResonance(v, t);
controlChangeHandlers[72] = (ch, v, _t) => ch.setReleaseTime(v);
controlChangeHandlers[73] = (ch, v, t) => ch.setAttackTime(v, t);
controlChangeHandlers[74] = (ch, v, t) => ch.setBrightness(v, t);
controlChangeHandlers[75] = (ch, v, t) => ch.setDecayTime(v, t);
controlChangeHandlers[76] = (ch, v, t) => ch.setVibratoRate(v, t);
controlChangeHandlers[77] = (ch, v, t) => ch.setVibratoDepth(v, t);
controlChangeHandlers[78] = (ch, v, t) => ch.setVibratoDelay(v, t);
controlChangeHandlers[84] = (ch, v, _t) => ch.setPortamentoNoteNumber(v);
controlChangeHandlers[91] = (ch, v, t) => ch.setReverbSendLevel(v, t);
controlChangeHandlers[93] = (ch, v, t) => ch.setChorusSendLevel(v, t);
controlChangeHandlers[94] = (ch, v, t) => ch.setDelaySendLevel(v, t);
controlChangeHandlers[96] = (ch, _v, t) => ch.dataIncrement(t);
controlChangeHandlers[97] = (ch, _v, t) => ch.dataDecrement(t);
controlChangeHandlers[100] = (ch, v, _t) => ch.setRPNLSB(v);
controlChangeHandlers[101] = (ch, v, _t) => ch.setRPNMSB(v);
controlChangeHandlers[111] = (ch, _v, t) =>
  (ch as Channel & ChannelOptionalMethods).setRPGMakerLoop?.(t);
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
      channel.player.setReverbSend(channel, note as Note, t);
    }
  });
keyBasedControllerHandlers[93] = (channel, keyNumber, t) =>
  channel.processScheduledNotes((note) => {
    if (note.noteNumber === keyNumber) {
      channel.player.setChorusSend(channel, note as Note, t);
    }
  });
keyBasedControllerHandlers[94] = (channel, keyNumber, t) =>
  channel.processScheduledNotes((note) => {
    if (note.noteNumber === keyNumber) {
      channel.player.setDelaySend(channel, note as Note, t);
    }
  });

const effectParameters = [
  2400 / 64,
  9600 / 64,
  1 / 64,
  600 / 127,
  2400 / 127,
  1 / 127,
];
const pressureBaselines = new Int8Array([64, 64, 0, 0, 0, 0]);

type DelayEffect = {
  input: GainNode;
  output: GainNode;
  delayNode: DelayNode;
  feedbackGain: GainNode;
  wetGain: GainNode;
};

// ---------------------------------------------------------------------------
// Midy
// ---------------------------------------------------------------------------
export class Midy extends MidyGM2 {
  declare channels: Channel[];

  delay = {
    time: 0.34,
    feedback: 16 / 63,
    wet: 1,
  };
  delayEffect!: DelayEffect;

  mpeEnabled: boolean = false;
  lowerMPEMembers: number = 0;
  upperMPEMembers: number = 0;
  lowerFreeChannels: number[] = [];
  upperFreeChannels: number[] = [];
  // Lazy so base-class constructor hooks (resetAllStates etc.) never see undefined.
  private _mpeState: { channelToNotes: Map<number, Set<Note>> } | undefined;
  get mpeState(): { channelToNotes: Map<number, Set<Note>> } {
    if (!this._mpeState) {
      this._mpeState = { channelToNotes: new Map() };
    }
    return this._mpeState;
  }

  static override channelSettings = {
    ...MidyGM2.channelSettings,
    portamentoControl: false,
    isMPEMember: false,
    isMPEManager: false,
  };

  constructor(
    audioContext: AudioContext | OfflineAudioContext,
    options?: { activeChannelNumbers?: Iterable<number> },
  ) {
    super(audioContext, options);
    this.controlChangeHandlers =
      controlChangeHandlers as typeof this.controlChangeHandlers;
    this.keyBasedControllerHandlers =
      keyBasedControllerHandlers as typeof this.keyBasedControllerHandlers;
    this.delayEffect = this.createDelayEffect();
    this.delayEffect.output.connect(this.masterVolume);
  }

  override createChannelInstance(
    channelNumber: number,
    settings: typeof MidyGM2.channelSettings,
    audioNodes?: ReturnType<MidyGM2["createChannelAudioNodes"]>,
  ): Channel {
    return new Channel(
      channelNumber,
      settings as ConstructorParameters<typeof GM2Channel>[1],
      audioNodes,
    );
  }

  override createNoteInstance(
    noteNumber: number,
    velocity: number,
    startTime: number,
  ): Note {
    return new Note(noteNumber, velocity, startTime);
  }

  // Player-level noteOn with MPE channelToNotes tracking.
  async noteOn(
    channelNumber: number,
    noteNumber: number,
    velocity: number,
    startTime?: number,
  ): Promise<Note | void> {
    const channel = this.channels[channelNumber];
    if (!channel) return;
    const note = await channel.noteOn(noteNumber, velocity, startTime) as
      | Note
      | void;
    if (note && this.mpeEnabled) {
      let set = this.mpeState.channelToNotes.get(channelNumber);
      if (!set) {
        set = new Set<Note>();
        this.mpeState.channelToNotes.set(channelNumber, set);
      }
      set.add(note);
    }
    return note;
  }

  // Player-level noteOff with MPE channelToNotes cleanup.
  async noteOff(
    channelNumber: number,
    noteNumber: number,
    velocity: number,
    endTime?: number,
    force: boolean = false,
  ): Promise<void> {
    const channel = this.channels[channelNumber];
    if (!channel) return;
    const t = endTime ?? this.audioContext.currentTime;
    // Find the note before noteOff mutates state
    const stack = channel.activeNotes[noteNumber];
    let target: Note | undefined;
    if (stack) {
      for (const n of stack) {
        if (!n.ending) {
          target = n as Note;
          break;
        }
      }
    }
    // If sostenuto is held and the note is active, ensure it is tracked in
    // sostenutoNotes so noteOffChannel's heldBySostenuto check defers release.
    // (Tests / hosts may set state.sostenutoPedal without going through
    // setSostenutoPedal's capture path.)
    if (
      !force &&
      target &&
      0.5 <= channel.state.sostenutoPedal &&
      !channel.sostenutoNotes.includes(target)
    ) {
      channel.sostenutoNotes.push(target);
    }
    await channel.noteOff(noteNumber, velocity, t, force);
    if (this.mpeEnabled && target) {
      // When pedal holds the note, keep it in mpeState
      if (
        !force &&
        (0.5 <= channel.state.sustainPedal ||
          0.5 <= channel.state.sostenutoPedal)
      ) {
        // note still held — leave in map
        return;
      }
      const set = this.mpeState.channelToNotes.get(channelNumber);
      if (set) {
        set.delete(target);
        if (set.size === 0) this.mpeState.channelToNotes.delete(channelNumber);
      }
    }
  }

  // Player-level pitch bend; propagates from MPE manager to zone members.
  setPitchBend(
    channelNumber: number,
    value: number,
    scheduleTime?: number,
  ): void {
    const channel = this.channels[channelNumber];
    if (!channel) return;
    const t = scheduleTime ?? this.audioContext.currentTime;
    if (channel.isMPEManager && this.mpeEnabled) {
      // Apply to manager + all members in the same zone
      channel.setPitchBend(value, t);
      const isLower = channelNumber === 0;
      if (isLower) {
        for (let ch = 1; ch <= this.lowerMPEMembers; ch++) {
          this.channels[ch]?.setPitchBend(value, t);
        }
      } else if (channelNumber === 15) {
        for (let ch = 15 - this.upperMPEMembers; ch < 15; ch++) {
          this.channels[ch]?.setPitchBend(value, t);
        }
      }
    } else {
      channel.setPitchBend(value, t);
    }
  }

  // Player-level control change; propagates from MPE manager to zone members.
  setControlChange(
    channelNumber: number,
    controllerType: number,
    value: number,
    scheduleTime?: number,
  ): void {
    const channel = this.channels[channelNumber];
    if (!channel) return;
    const t = scheduleTime ?? this.audioContext.currentTime;
    if (channel.isMPEManager && this.mpeEnabled) {
      this.applyToMPEChannels(channelNumber, (ch) => {
        this.channels[ch]?.setControlChange(controllerType, value, t);
      });
      channel.setControlChange(controllerType, value, t);
    } else {
      channel.setControlChange(controllerType, value, t);
    }
  }

  /** Player-level program change; propagates from MPE manager. */
  setProgramChange(channelNumber: number, programNumber: number): void {
    const channel = this.channels[channelNumber];
    if (!channel) return;
    if (channel.isMPEManager && this.mpeEnabled) {
      channel.setProgramChange(programNumber);
      const isLower = channelNumber === 0;
      if (isLower) {
        for (let ch = 1; ch <= this.lowerMPEMembers; ch++) {
          this.channels[ch]?.setProgramChange(programNumber);
        }
      } else if (channelNumber === 15) {
        for (let ch = 15 - this.upperMPEMembers; ch < 15; ch++) {
          this.channels[ch]?.setProgramChange(programNumber);
        }
      }
    } else {
      channel.setProgramChange(programNumber);
    }
  }

  // Player-level channel pressure; propagates from MPE manager.
  setChannelPressure(
    channelNumber: number,
    value: number,
    scheduleTime?: number,
  ): void {
    const channel = this.channels[channelNumber];
    if (!channel) return;
    const t = scheduleTime ?? this.audioContext.currentTime;
    if (channel.isMPEManager && this.mpeEnabled) {
      channel.setChannelPressure(value, t);
      const isLower = channelNumber === 0;
      if (isLower) {
        for (let ch = 1; ch <= this.lowerMPEMembers; ch++) {
          this.channels[ch]?.setChannelPressure(value, t);
        }
      } else if (channelNumber === 15) {
        for (let ch = 15 - this.upperMPEMembers; ch < 15; ch++) {
          this.channels[ch]?.setChannelPressure(value, t);
        }
      }
    } else {
      channel.setChannelPressure(value, t);
    }
  }

  createDelayEffect(): DelayEffect {
    const audioContext = this.audioContext;
    const input = new GainNode(audioContext);
    const output = new GainNode(audioContext);
    const delayNode = new DelayNode(audioContext, {
      maxDelayTime: 2,
      delayTime: this.delay.time,
    });
    const feedbackGain = new GainNode(audioContext, {
      gain: this.delay.feedback,
    });
    const wetGain = new GainNode(audioContext, {
      gain: this.delay.wet,
    });
    input.connect(delayNode);
    delayNode.connect(feedbackGain);
    feedbackGain.connect(delayNode);
    delayNode.connect(wetGain);
    wetGain.connect(output);
    return { input, output, delayNode, feedbackGain, wetGain };
  }

  getRelativeKeyBasedValue(
    channel: Channel,
    keyNumber: number,
    controllerType: number,
  ): number {
    const ccState = channel.state.array[128 + controllerType];
    if (!channel.isDrum) return ccState;
    const keyBasedValue = this.getKeyBasedValue(
      channel,
      keyNumber,
      controllerType,
    );
    if (keyBasedValue < 0) return ccState;
    return ccState * keyBasedValue / 64;
  }

  calcCombinedEffectValue(
    channel: Channel,
    note: Note,
    destination: number,
  ): number {
    return this.calcChannelEffectValue(channel, destination) +
      this.calcNoteEffectValue(channel, note, destination);
  }

  calcNoteEffectValue(
    channel: Channel,
    note: Note,
    destination: number,
  ): number {
    const pressure = note.pressure;
    if (pressure <= 0) return 0;
    const baseline = pressureBaselines[destination];
    const tableValue = channel.polyphonicKeyPressureTable[destination];
    const value = (tableValue - baseline) * pressure / 127;
    return value * effectParameters[destination];
  }

  getNotePitchControl(channel: Channel, note: Note): number {
    return this.calcNoteEffectValue(channel, note, 0);
  }

  getNoteAmplitudeControl(channel: Channel, note: Note): number {
    return this.calcNoteEffectValue(channel, note, 2);
  }

  setPolyphonicKeyPressureEffects(
    channel: Channel,
    note: Note,
    scheduleTime: number,
  ): void {
    this.setPressureEffects(
      channel,
      note,
      "polyphonicKeyPressureTable",
      scheduleTime,
    );
  }

  override setPressureEffects(
    channel: GM2Channel,
    note: GM2Note,
    tableName: "channelPressureTable" | "polyphonicKeyPressureTable",
    scheduleTime: number,
  ): void {
    const handlers = this.effectHandlers;
    const ch = channel as unknown as Channel;
    const table = (ch as Channel & Record<typeof tableName, Int8Array>)[
      tableName
    ];
    for (let i = 0; i < handlers.length; i++) {
      const baseline = pressureBaselines[i];
      const tableValue = table[i];
      if (baseline === tableValue) continue;
      handlers[i](ch, note as unknown as Note, scheduleTime);
    }
  }

  handlePolyphonicKeyPressureSysEx(
    data: Uint8Array,
    scheduleTime: number,
  ): void {
    this.handlePressureSysEx(data, "polyphonicKeyPressureTable", scheduleTime);
  }

  override setVolumeEnvelope(
    channel: GM2Channel,
    note: GM2Note,
    scheduleTime: number,
  ): void {
    const ch = channel as unknown as Channel;
    const n = note as unknown as Note;
    if (!n.volumeEnvelopeNode) return;
    const { voiceParams, startTime, noteNumber } = n;
    if (!voiceParams) return;
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getChannelAmplitudeControl(ch));
    const sustainVolume = attackVolume *
      cbToRatio(-1000 * voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const attackTime = this.getRelativeKeyBasedValue(ch, noteNumber, 73) * 2;
    const volAttack = volDelay + voiceParams.volAttack * attackTime;
    const volHold = volAttack + voiceParams.volHold;
    const decayTime = this.getRelativeKeyBasedValue(ch, noteNumber, 75) * 2;
    const decayDuration = voiceParams.volDecay * decayTime;
    n.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(0, startTime)
      .setValueAtTime(1e-6, volDelay)
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .exponentialRampToValueAtTime(sustainVolume, volHold + decayDuration);
  }

  setVolumeNode(channel: Channel, note: Note, scheduleTime: number): void {
    const depth = 1 + this.getNoteAmplitudeControl(channel, note);
    const timeConstant = this.perceptualSmoothingTime / 5;
    note.volumeNode?.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(depth, scheduleTime, timeConstant);
  }

  override calcNoteDetune(channel: GM2Channel, note: GM2Note): number {
    const ch = channel as unknown as Channel;
    const n = note as unknown as Note;
    const scaleOctaveTuning = this.calcScaleOctaveTuning(ch, n);
    const pitchControl = this.getNotePitchControl(ch, n);
    return super.calcNoteDetune(channel, note) + scaleOctaveTuning +
      pitchControl;
  }

  setDelaySend(channel: Channel, note: Note, scheduleTime: number): void {
    const sendLevel = this.getRelativeKeyBasedValue(
      channel,
      note.noteNumber,
      94,
    );
    if (!note.delaySend) {
      if (sendLevel <= 0) return;
      note.delaySend = new GainNode(this.audioContext, { gain: sendLevel });
      note.volumeNode?.connect(note.delaySend);
      note.delaySend.connect(this.delayEffect.input);
    } else {
      const timeConstant = this.perceptualSmoothingTime / 5;
      note.delaySend.gain
        .cancelAndHoldAtTime(scheduleTime)
        .setTargetAtTime(sendLevel, scheduleTime, timeConstant);
    }
  }

  applyToMPEChannels(channelNumber: number, fn: (ch: number) => void): void {
    if (!this.mpeEnabled) {
      fn(channelNumber);
      return;
    }
    const channel = this.channels[channelNumber] as Channel;
    if (channel?.isMPEManager) {
      const isLower = channelNumber === 0;
      const start = isLower ? 1 : 15 - this.upperMPEMembers;
      const end = isLower ? this.lowerMPEMembers : 14;
      for (let ch = start; ch <= end; ch++) fn(ch);
    } else {
      fn(channelNumber);
    }
  }

  handleMIDIPolyphonicExpressionRPN(channelNumber: number): void {
    const channel = this.channels[channelNumber];
    this.setMIDIPolyphonicExpression(channelNumber, channel.dataMSB);
  }

  setMIDIPolyphonicExpression(channelNumber: number, value: number): void {
    if (channelNumber !== 0 && channelNumber !== 15) return;
    const members = value & 15;
    if (channelNumber === 0) {
      this.lowerMPEMembers = members;
    } else {
      this.upperMPEMembers = members;
    }
    this.mpeEnabled = this.lowerMPEMembers > 0 || this.upperMPEMembers > 0;
    const lowerStart = 1;
    const lowerEnd = this.lowerMPEMembers;
    const upperStart = 15 - this.upperMPEMembers;
    const upperEnd = 14;
    const { channels, lowerMPEMembers, upperMPEMembers, mpeEnabled } = this;
    for (let ch = 0; ch < 16; ch++) {
      const isLower = lowerMPEMembers > 0 && lowerStart <= ch && ch <= lowerEnd;
      const isUpper = upperMPEMembers > 0 && upperStart <= ch && ch <= upperEnd;
      const channel = channels[ch] as Channel;
      channel.isMPEMember = mpeEnabled && (isLower || isUpper);
      channel.isMPEManager = mpeEnabled &&
        ((ch === 0 && lowerMPEMembers > 0) ||
          (ch === 15 && upperMPEMembers > 0));
    }
    this.rebuildMPEFreeChannels();
  }

  rebuildMPEFreeChannels(): void {
    this.lowerFreeChannels = [];
    for (let ch = 1; ch <= this.lowerMPEMembers; ch++) {
      this.lowerFreeChannels.push(ch);
    }
    this.upperFreeChannels = [];
    const upperStart = 15 - this.upperMPEMembers;
    for (let ch = upperStart; ch <= 14; ch++) {
      this.upperFreeChannels.push(ch);
    }
  }

  allocMPEChannel(zone: 0 | 1): number | null {
    const pool = zone === 0 ? this.lowerFreeChannels : this.upperFreeChannels;
    return pool.length > 0 ? pool.shift()! : null;
  }

  releaseMPEChannel(channelNumber: number): void {
    if (1 <= channelNumber && channelNumber <= this.lowerMPEMembers) {
      if (!this.lowerFreeChannels.includes(channelNumber)) {
        this.lowerFreeChannels.push(channelNumber);
      }
    } else if (
      this.upperMPEMembers > 0 &&
      15 - this.upperMPEMembers <= channelNumber &&
      channelNumber <= 14
    ) {
      if (!this.upperFreeChannels.includes(channelNumber)) {
        this.upperFreeChannels.push(channelNumber);
      }
    }
  }

  override handleUniversalRealTimeExclusiveMessage(
    data: Uint8Array,
    scheduleTime: number,
  ): void {
    switch (data[2]) {
      case 8:
        switch (data[3]) {
          case 9:
            return this.handleScaleOctaveTuning2ByteFormatSysEx(
              data,
              true,
              scheduleTime,
            );
        }
        break;
      case 9:
        switch (data[3]) {
          case 2:
            return this.handlePolyphonicKeyPressureSysEx(data, scheduleTime);
        }
        break;
    }
    super.handleUniversalRealTimeExclusiveMessage(data, scheduleTime);
  }

  handleScaleOctaveTuning2ByteFormatSysEx(
    data: Uint8Array,
    realtime: boolean,
    scheduleTime: number,
  ): void {
    if (data.length < 31) {
      console.error("Data length is too short");
      return;
    }
    const channelBitmap = this.getChannelBitmap(data);
    for (let i = 0; i < channelBitmap.length; i++) {
      if (!channelBitmap[i]) continue;
      const channel = this.channels[i];
      if (channel.isDrum) continue;
      for (let j = 0; j < 12; j++) {
        const index = 7 + j * 2;
        const msb = data[index] & 0x7F;
        const lsb = data[index + 1] & 0x7F;
        const value14bit = msb * 128 + lsb;
        const centValue = (value14bit - 8192) / 8.192;
        channel.scaleOctaveTuningTable[j] = centValue;
      }
      if (realtime) this.updateChannelDetune(channel, scheduleTime);
    }
  }

  override resetAllStates(): void {
    super.resetAllStates();
    // mpeState is a derived-class field; base constructor may call this
    // before field initializers run, so guard against undefined.
    this.mpeState.channelToNotes.clear();
    this.lowerFreeChannels = [];
    this.upperFreeChannels = [];
  }

  override GM1SystemOn(
    scheduleTime: number,
    channels: GM2Channel[] = this.channels as unknown as GM2Channel[],
  ): void {
    if ((channels as unknown) === (this.channels as unknown)) {
      this.mpeEnabled = false;
      this.lowerMPEMembers = 0;
      this.upperMPEMembers = 0;
      this.mpeState.channelToNotes.clear();
      this.lowerFreeChannels = [];
      this.upperFreeChannels = [];
    }
    super.GM1SystemOn(scheduleTime, channels);
  }

  override GM2SystemOn(
    scheduleTime: number,
    channels: GM2Channel[] = this.channels as unknown as GM2Channel[],
  ): void {
    if ((channels as unknown) === (this.channels as unknown)) {
      this.mpeEnabled = false;
      this.lowerMPEMembers = 0;
      this.upperMPEMembers = 0;
      this.mpeState.channelToNotes.clear();
      this.lowerFreeChannels = [];
      this.upperFreeChannels = [];
    }
    super.GM2SystemOn(scheduleTime, channels as unknown as GM2Channel[]);
  }

  /** Keep channel.state as Midy ControllerState (LSB / delay / poly pressure). */
  override createControllerState(): ReturnType<
    MidyGM2["createControllerState"]
  > {
    // Parallel hierarchy vs Player's base ControllerState; cast is intentional.
    return new ControllerState() as ReturnType<
      MidyGM2["createControllerState"]
    >;
  }

  // CCs that change Midy's offline bake beyond Player.COMPLEX_KEY_CONTROLLER_TYPES.
  // LSB, sound controllers, portamento control, delay send.
  static readonly EXTRA_COMPLEX_KEY_CONTROLLERS: ReadonlySet<number> = new Set([
    33, // modulation depth LSB
    37, // portamento time LSB
    39, // volume LSB
    42, // pan LSB
    43, // expression LSB
    71, // filter resonance
    72, // release time
    73, // attack time
    74, // brightness
    75, // decay time
    76, // vibrato rate
    77, // vibrato depth
    78, // vibrato delay
    84, // portamento control (note number)
    94, // delay send level
  ]);

  override isComplexKeyController(controllerType: number): boolean {
    return super.isComplexKeyController(controllerType) ||
      Midy.EXTRA_COMPLEX_KEY_CONTROLLERS.has(controllerType);
  }

  /**
   * Midy-only channel-state slots for simple/complex note cache keys.
   * Avoids copying makeSimpleNoteKey / makeComplexNoteKey; base still
   * writes volumeMSB/panMSB/expressionMSB.
   */
  override appendNoteKeyStateParts(
    parts: (string | number)[],
    channelStateArray: Float32Array,
    bakeChannelMix: boolean,
  ): void {
    super.appendNoteKeyStateParts(parts, channelStateArray, bakeChannelMix);
    const st = channelStateArray;
    // Always: shape the offline sample (filter / env / vib / portamento / delay)
    // whether the channel bus is mix-baked or left live (segment dry).
    parts.push(
      Math.round((st[128 + 33] ?? 0) * 1e4),
      Math.round((st[128 + 37] ?? 0) * 1e4),
      Math.round((st[128 + 71] ?? 0) * 1e4),
      Math.round((st[128 + 72] ?? 0) * 1e4),
      Math.round((st[128 + 73] ?? 0) * 1e4),
      Math.round((st[128 + 74] ?? 0) * 1e4),
      Math.round((st[128 + 75] ?? 0) * 1e4),
      Math.round((st[128 + 76] ?? 0) * 1e4),
      Math.round((st[128 + 77] ?? 0) * 1e4),
      Math.round((st[128 + 78] ?? 0) * 1e4),
      Math.round((st[128 + 84] ?? 0) * 1e4),
      Math.round((st[128 + 94] ?? 0) * 1e4),
    );
    if (bakeChannelMix) {
      parts.push(
        Math.round((st[128 + 39] ?? 0) * 1e4),
        Math.round((st[128 + 42] ?? 0) * 1e4),
        Math.round((st[128 + 43] ?? 0) * 1e4),
      );
    }
  }

  override createMessageHandlers(): MessageHandler[] {
    const handlers = super.createMessageHandlers();
    handlers[0x80] = (data, t) =>
      this.noteOff(data[0] & 0x0F, data[1], data[2], t);
    handlers[0x90] = (data, t) =>
      this.noteOn(data[0] & 0x0F, data[1], data[2], t);
    handlers[0xA0] = (data, t) =>
      (this.channels[data[0] & 0x0F] as Channel).setPolyphonicKeyPressure(
        data[1],
        data[2],
        t,
      );
    handlers[0xB0] = (data, t) =>
      this.setControlChange(data[0] & 0x0F, data[1], data[2], t);
    handlers[0xC0] = (data, _t) =>
      this.setProgramChange(data[0] & 0x0F, data[1]);
    handlers[0xD0] = (data, t) =>
      this.setChannelPressure(data[0] & 0x0F, data[1], t);
    handlers[0xE0] = (data, t) =>
      this.setPitchBend(data[0] & 0x0F, data[2] * 128 + data[1], t);
    return handlers;
  }

  override setNoteRouting(
    channel: GM2Channel,
    note: GM2Note,
    startTime: number,
  ): void {
    super.setNoteRouting(channel, note, startTime);
    const ch = channel as unknown as Channel;
    const n = note as unknown as Note;
    if (0 < ch.state.delaySendLevel) {
      this.setDelaySend(ch, n, startTime);
    }
  }

  setFilterQ(channel: Channel, note: Note, scheduleTime: number): void {
    if (!note.filterEnvelopeNode) return;
    if (!note.voiceParams) return;
    const filterResonance = this.getRelativeKeyBasedValue(
      channel,
      note.noteNumber,
      71,
    );
    const Q = note.voiceParams.initialFilterQ / 5 * filterResonance;
    note.filterEnvelopeNode.Q.setValueAtTime(Q, scheduleTime);
  }

  override setFilterEnvelope(
    channel: GM2Channel,
    note: GM2Note,
    scheduleTime: number,
  ): void {
    const ch = channel as unknown as Channel;
    const n = note as unknown as Note;
    if (!n.filterEnvelopeNode || !n.voiceParams) return;
    const { voiceParams, startTime, noteNumber } = n;
    // CC#74 brightness: default 64 → multiplier ≈ 1. Scale mod-env depth.
    const brightness = this.getRelativeKeyBasedValue(ch, noteNumber, 74) * 2;
    // Work in cents (SF2), then convert to Hz for BiquadFilterNode.frequency.
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(ch);
    const peekCent = baseCent + voiceParams.modEnvToFilterFc * brightness;
    // SF2 modSustain is the fraction of the envelope depth that is removed
    // at sustain (same shape as MidyGM2).
    const sustainCent = baseCent +
      voiceParams.modEnvToFilterFc * brightness * (1 - voiceParams.modSustain);
    const softPedalFactor = this.getSoftPedalFactor(ch, n);
    const baseFreq = this.clampCutoffFrequency(
      this.centToHz(baseCent) * softPedalFactor,
    );
    const peekFreq = this.clampCutoffFrequency(
      this.centToHz(peekCent) * softPedalFactor,
    );
    const sustainFreq = this.clampCutoffFrequency(
      this.centToHz(sustainCent) * softPedalFactor,
    );
    const attackTime = this.getRelativeKeyBasedValue(ch, noteNumber, 73) * 2;
    const decayTime = this.getRelativeKeyBasedValue(ch, noteNumber, 75) * 2;
    const modDelay = startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack * attackTime;
    const modHold = modAttack + voiceParams.modHold;
    const decayDuration = voiceParams.modDecay * decayTime;
    n.adjustedBaseFreq = baseFreq;
    n.filterEnvelopeNode.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(baseFreq, startTime)
      .setValueAtTime(baseFreq, modDelay)
      .exponentialRampToValueAtTime(Math.max(20, peekFreq), modAttack)
      .setValueAtTime(Math.max(20, peekFreq), modHold)
      .exponentialRampToValueAtTime(
        Math.max(20, sustainFreq),
        modHold + decayDuration,
      );
  }

  override disconnectNote(note: GM2Note): void {
    super.disconnectNote(note);
    const n = note as unknown as Note;
    n.delaySend?.disconnect();
    n.delaySend = null;
  }

  override updateModulation(channel: GM2Channel, scheduleTime: number): void {
    const ch = channel as unknown as Channel;
    const state = ch.state as ControllerState;
    const depth = (state.modulationDepthMSB + state.modulationDepthLSB / 128) *
      ch.modulationDepthRange;
    const timeConstant = this.perceptualSmoothingTime / 5;
    ch.processScheduledNotes((note) => {
      const n = note as unknown as Note;
      if (n.renderedBuffer?.isFull || n.isSegmentGhost) {
        return;
      }
      if (n.modLfoToPitch) {
        n.modLfoToPitch.gain
          .cancelAndHoldAtTime(scheduleTime)
          .setTargetAtTime(depth, scheduleTime, timeConstant);
      } else {
        this.startModulation(ch, n, scheduleTime);
      }
    });
  }

  override getPortamentoTime(channel: GM2Channel, note: GM2Note): number {
    const state = (channel as unknown as Channel).state as ControllerState;
    const n = note as unknown as Note;
    const portamentoTime = state.portamentoTimeMSB +
      state.portamentoTimeLSB / 128;
    const deltaSemitone = Math.abs(
      n.noteNumber - n.portamentoNoteNumber,
    );
    const value = Math.ceil(portamentoTime * 128);
    return deltaSemitone / this.getPitchIncrementSpeed(value) / 10;
  }
}
