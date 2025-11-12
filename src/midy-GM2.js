import { parseMidi } from "midi-file";
import { parse, SoundFont } from "@marmooo/soundfont-parser";

class Note {
  index = -1;
  ending = false;
  bufferSource;
  filterNode;
  filterDepth;
  volumeEnvelopeNode;
  volumeDepth;
  modulationLFO;
  modulationDepth;
  vibratoLFO;
  vibratoDepth;
  reverbEffectsSend;
  chorusEffectsSend;
  portamentoNoteNumber = -1;

  constructor(noteNumber, velocity, startTime, voice, voiceParams) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.voice = voice;
    this.voiceParams = voiceParams;
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
  modulationDepth: { type: 128 + 1, defaultValue: 0 },
  portamentoTime: { type: 128 + 5, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volume: { type: 128 + 7, defaultValue: 100 / 127 },
  pan: { type: 128 + 10, defaultValue: 64 / 127 },
  expression: { type: 128 + 11, defaultValue: 1 },
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

class ControllerState {
  array = new Float32Array(256);
  constructor() {
    const entries = Object.entries(defaultControllerState);
    for (const [name, { type, defaultValue }] of entries) {
      this.array[type] = defaultValue;
      Object.defineProperty(this, name, {
        get: () => this.array[type],
        set: (value) => this.array[type] = value,
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

export class MidyGM2 {
  mode = "GM2";
  masterFineTuning = 0; // cb
  masterCoarseTuning = 0; // cb
  reverb = {
    algorithm: "SchroederReverb",
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
  numChannels = 16;
  ticksPerBeat = 120;
  totalTime = 0;
  noteCheckInterval = 0.1;
  lookAhead = 1;
  startDelay = 0.1;
  startTime = 0;
  resumeTime = 0;
  soundFonts = [];
  soundFontTable = this.initSoundFontTable();
  voiceCounter = new Map();
  voiceCache = new Map();
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  timeline = [];
  notePromises = [];
  instruments = new Set();
  exclusiveClassNotes = new Array(128);
  drumExclusiveClassNotes = new Array(
    this.numChannels * drumExclusiveClassCount,
  );

  static channelSettings = {
    scheduleIndex: 0,
    detune: 0,
    programNumber: 0,
    bank: 121 * 128,
    bankMSB: 121,
    bankLSB: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    mono: false, // CC#124, CC#125
    modulationDepthRange: 50, // cent
    fineTuning: 0, // cb
    coarseTuning: 0, // cb
  };

  constructor(audioContext) {
    this.audioContext = audioContext;
    this.masterVolume = new GainNode(audioContext);
    this.scheduler = new GainNode(audioContext, { gain: 0 });
    this.schedulerBuffer = new AudioBuffer({
      length: 1,
      sampleRate: audioContext.sampleRate,
    });
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.reverbEffect = this.createReverbEffect(audioContext);
    this.chorusEffect = this.createChorusEffect(audioContext);
    this.chorusEffect.output.connect(this.masterVolume);
    this.reverbEffect.output.connect(this.masterVolume);
    this.masterVolume.connect(audioContext.destination);
    this.scheduler.connect(audioContext.destination);
    this.GM2SystemOn();
  }

  initSoundFontTable() {
    const table = new Array(128);
    for (let i = 0; i < 128; i++) {
      table[i] = new Map();
    }
    return table;
  }

  addSoundFont(soundFont) {
    const index = this.soundFonts.length;
    this.soundFonts.push(soundFont);
    const presetHeaders = soundFont.parsed.presetHeaders;
    for (let i = 0; i < presetHeaders.length; i++) {
      const presetHeader = presetHeaders[i];
      const banks = this.soundFontTable[presetHeader.preset];
      banks.set(presetHeader.bank, index);
    }
  }

  async toUint8Array(input) {
    let uint8Array;
    if (typeof input === "string") {
      const response = await fetch(input);
      const arrayBuffer = await response.arrayBuffer();
      uint8Array = new Uint8Array(arrayBuffer);
    } else if (input instanceof Uint8Array) {
      uint8Array = input;
    } else {
      throw new TypeError("input must be a URL string or Uint8Array");
    }
    return uint8Array;
  }

  async loadSoundFont(input) {
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

  async loadMIDI(input) {
    this.voiceCounter.clear();
    const uint8Array = await this.toUint8Array(input);
    const midi = parseMidi(uint8Array);
    this.ticksPerBeat = midi.header.ticksPerBeat;
    const midiData = this.extractMidiData(midi);
    this.instruments = midiData.instruments;
    this.timeline = midiData.timeline;
    this.totalTime = this.calcTotalTime();
  }

  cacheVoiceIds() {
    const timeline = this.timeline;
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "noteOn": {
          const audioBufferId = this.getVoiceId(
            this.channels[event.channel],
            event.noteNumber,
            event.velocity,
          );
          this.voiceCounter.set(
            audioBufferId,
            (this.voiceCounter.get(audioBufferId) ?? 0) + 1,
          );
          break;
        }
        case "controller":
          if (event.controllerType === 0) {
            this.setBankMSB(event.channel, event.value);
          } else if (event.controllerType === 32) {
            this.setBankLSB(event.channel, event.value);
          }
          break;
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            event.startTime,
          );
      }
    }
    for (const [audioBufferId, count] of this.voiceCounter) {
      if (count === 1) this.voiceCounter.delete(audioBufferId);
    }
    this.GM2SystemOn();
  }

  getVoiceId(channel, noteNumber, velocity) {
    const bankNumber = this.calcBank(channel);
    const soundFontIndex = this.soundFontTable[channel.programNumber]
      .get(bankNumber);
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(
      bankNumber,
      channel.programNumber,
      noteNumber,
      velocity,
    );
    const { instrument, sampleID } = voice.generators;
    return soundFontIndex * (2 ** 32) + (instrument << 16) + sampleID;
  }

  createChannelAudioNodes(audioContext) {
    const { gainLeft, gainRight } = this.panToGain(
      defaultControllerState.pan.defaultValue,
    );
    const gainL = new GainNode(audioContext, { gain: gainLeft });
    const gainR = new GainNode(audioContext, { gain: gainRight });
    const merger = new ChannelMergerNode(audioContext, { numberOfInputs: 2 });
    gainL.connect(merger, 0, 0);
    gainR.connect(merger, 0, 1);
    merger.connect(this.masterVolume);
    return {
      gainL,
      gainR,
      merger,
    };
  }

  resetChannelTable(channel) {
    channel.controlTable.fill(-1);
    channel.scaleOctaveTuningTable.fill(0); // [-100, 100] cent
    channel.channelPressureTable.fill(-1);
    channel.keyBasedInstrumentControlTable.fill(-1);
  }

  createChannels(audioContext) {
    const channels = Array.from({ length: this.numChannels }, () => {
      return {
        currentBufferSource: null,
        isDrum: false,
        state: new ControllerState(),
        ...this.constructor.channelSettings,
        ...this.createChannelAudioNodes(audioContext),
        scheduledNotes: [],
        sustainNotes: [],
        sostenutoNotes: [],
        controlTable: this.initControlTable(),
        scaleOctaveTuningTable: new Int8Array(12), // [-64, 63] cent
        channelPressureTable: new Int8Array(6).fill(-1),

        keyBasedInstrumentControlTable: new Int8Array(128 * 128).fill(-1),
        keyBasedGainLs: new Array(128),
        keyBasedGainRs: new Array(128),
      };
    });
    return channels;
  }

  async createAudioBuffer(voiceParams) {
    const sample = voiceParams.sample;
    const sampleStart = voiceParams.start;
    const sampleEnd = sample.data.length + voiceParams.end;
    const audioBuffer = await sample.toAudioBuffer(
      this.audioContext,
      sampleStart,
      sampleEnd,
    );
    return audioBuffer;
  }

  isLoopDrum(channel, noteNumber) {
    const programNumber = channel.programNumber;
    return ((programNumber === 48 && noteNumber === 88) ||
      (programNumber === 56 && 47 <= noteNumber && noteNumber <= 84));
  }

  createBufferSource(channel, noteNumber, voiceParams, audioBuffer) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = channel.isDrum
      ? this.isLoopDrum(channel, noteNumber)
      : (voiceParams.sampleModes % 2 !== 0);
    if (bufferSource.loop) {
      bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
      bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
    }
    return bufferSource;
  }

  async scheduleTimelineEvents(t, resumeTime, queueIndex) {
    while (queueIndex < this.timeline.length) {
      const event = this.timeline[queueIndex];
      if (event.startTime > t + this.lookAhead) break;
      const delay = this.startDelay - resumeTime;
      const startTime = event.startTime + delay;
      switch (event.type) {
        case "noteOn":
          await this.scheduleNoteOn(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
          );
          break;
        case "noteOff": {
          const notePromise = this.scheduleNoteOff(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
            false, // force
          );
          if (notePromise) this.notePromises.push(notePromise);
          break;
        }
        case "controller":
          this.setControlChange(
            event.channel,
            event.controllerType,
            event.value,
            startTime,
          );
          break;
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            startTime,
          );
          break;
        case "channelAftertouch":
          this.setChannelPressure(event.channel, event.amount, startTime);
          break;
        case "pitchBend":
          this.setPitchBend(event.channel, event.value + 8192, startTime);
          break;
        case "sysEx":
          this.handleSysEx(event.data, startTime);
      }
      queueIndex++;
    }
    return queueIndex;
  }

  getQueueIndex(second) {
    for (let i = 0; i < this.timeline.length; i++) {
      if (second <= this.timeline[i].startTime) {
        return i;
      }
    }
    return 0;
  }

  playNotes() {
    return new Promise((resolve) => {
      this.isPlaying = true;
      this.isPaused = false;
      this.startTime = this.audioContext.currentTime;
      let queueIndex = this.getQueueIndex(this.resumeTime);
      let resumeTime = this.resumeTime - this.startTime;
      this.notePromises = [];
      const schedulePlayback = async () => {
        if (queueIndex >= this.timeline.length) {
          await Promise.all(this.notePromises);
          this.notePromises = [];
          this.exclusiveClassNotes.fill(undefined);
          this.drumExclusiveClassNotes.fill(undefined);
          this.voiceCache.clear();
          for (let i = 0; i < this.channels.length; i++) {
            this.channels[i].scheduledNotes = [];
            this.resetAllStates(i);
          }
          resolve();
          return;
        }
        const now = this.audioContext.currentTime;
        const t = now + resumeTime;
        queueIndex = await this.scheduleTimelineEvents(
          t,
          resumeTime,
          queueIndex,
        );
        if (this.isPausing) {
          await this.stopNotes(0, true, now);
          this.notePromises = [];
          this.isPausing = false;
          this.isPaused = true;
          resolve();
          return;
        } else if (this.isStopping) {
          await this.stopNotes(0, true, now);
          this.notePromises = [];
          this.exclusiveClassNotes.fill(undefined);
          this.drumExclusiveClassNotes.fill(undefined);
          this.voiceCache.clear();
          for (let i = 0; i < this.channels.length; i++) {
            this.channels[i].scheduledNotes = [];
            this.resetAllStates(i);
          }
          this.isStopping = false;
          this.isPaused = false;
          resolve();
          return;
        } else if (this.isSeeking) {
          this.stopNotes(0, true, now);
          this.exclusiveClassNotes.fill(undefined);
          this.drumExclusiveClassNotes.fill(undefined);
          this.startTime = this.audioContext.currentTime;
          queueIndex = this.getQueueIndex(this.resumeTime);
          resumeTime = this.resumeTime - this.startTime;
          this.isSeeking = false;
          await schedulePlayback();
        } else {
          const waitTime = now + this.noteCheckInterval;
          await this.scheduleTask(() => {}, waitTime);
          await schedulePlayback();
        }
      };
      schedulePlayback();
    });
  }

  ticksToSecond(ticks, secondsPerBeat) {
    return ticks * secondsPerBeat / this.ticksPerBeat;
  }

  secondToTicks(second, secondsPerBeat) {
    return second * this.ticksPerBeat / secondsPerBeat;
  }

  extractMidiData(midi) {
    const instruments = new Set();
    const timeline = [];
    const tmpChannels = new Array(this.channels.length);
    for (let i = 0; i < tmpChannels.length; i++) {
      tmpChannels[i] = {
        programNumber: -1,
        bankMSB: this.channels[i].bankMSB,
        bankLSB: this.channels[i].bankLSB,
      };
    }
    for (let i = 0; i < midi.tracks.length; i++) {
      const track = midi.tracks[i];
      let currentTicks = 0;
      for (let j = 0; j < track.length; j++) {
        const event = track[j];
        currentTicks += event.deltaTime;
        event.ticks = currentTicks;
        switch (event.type) {
          case "noteOn": {
            const channel = tmpChannels[event.channel];
            if (channel.programNumber < 0) {
              channel.programNumber = event.programNumber;
              switch (channel.bankMSB) {
                case 120:
                  instruments.add(`128:0`);
                  break;
                case 121:
                  instruments.add(`${channel.bankLSB}:0`);
                  break;
                default: {
                  const bankNumber = channel.bankMSB * 128 + channel.bankLSB;
                  instruments.add(`${bankNumber}:0`);
                }
              }
              channel.programNumber = 0;
            }
            break;
          }
          case "controller":
            switch (event.controllerType) {
              case 0:
                tmpChannels[event.channel].bankMSB = event.value;
                break;
              case 32:
                tmpChannels[event.channel].bankLSB = event.value;
                break;
            }
            break;
          case "programChange": {
            const channel = tmpChannels[event.channel];
            channel.programNumber = event.programNumber;
            switch (channel.bankMSB) {
              case 120:
                instruments.add(`128:${channel.programNumber}`);
                break;
              case 121:
                instruments.add(`${channel.bankLSB}:${channel.programNumber}`);
                break;
              default: {
                const bankNumber = channel.bankMSB * 128 + channel.bankLSB;
                instruments.add(`${bankNumber}:${channel.programNumber}`);
              }
            }
          }
        }
        delete event.deltaTime;
        timeline.push(event);
      }
    }
    const priority = {
      controller: 0,
      sysEx: 1,
      noteOff: 2, // for portamento
      noteOn: 3,
    };
    timeline.sort((a, b) => {
      if (a.ticks !== b.ticks) return a.ticks - b.ticks;
      return (priority[a.type] || 4) - (priority[b.type] || 4);
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
        secondsPerBeat = event.microsecondsPerBeat / 1000000;
        prevTempoTicks = event.ticks;
      }
    }
    return { instruments, timeline };
  }

  stopActiveNotes(channelNumber, velocity, force, scheduleTime) {
    const channel = this.channels[channelNumber];
    const promises = [];
    this.processActiveNotes(channel, scheduleTime, (note) => {
      const promise = this.scheduleNoteOff(
        channelNumber,
        note.noteNumber,
        velocity,
        scheduleTime,
        force,
      );
      this.notePromises.push(promise);
      promises.push(promise);
    });
    return Promise.all(promises);
  }

  stopChannelNotes(channelNumber, velocity, force, scheduleTime) {
    const channel = this.channels[channelNumber];
    const promises = [];
    this.processScheduledNotes(channel, (note) => {
      const promise = this.scheduleNoteOff(
        channelNumber,
        note.noteNumber,
        velocity,
        scheduleTime,
        force,
      );
      this.notePromises.push(promise);
      promises.push(promise);
    });
    return Promise.all(promises);
  }

  stopNotes(velocity, force, scheduleTime) {
    const promises = [];
    for (let i = 0; i < this.channels.length; i++) {
      promises.push(this.stopChannelNotes(i, velocity, force, scheduleTime));
    }
    return Promise.all(this.notePromises);
  }

  async start() {
    if (this.isPlaying || this.isPaused) return;
    this.resumeTime = 0;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    await this.playNotes();
    this.isPlaying = false;
  }

  stop() {
    if (!this.isPlaying) return;
    this.isStopping = true;
  }

  pause() {
    if (!this.isPlaying || this.isPaused) return;
    const now = this.audioContext.currentTime;
    this.resumeTime += now - this.startTime - this.startDelay;
    this.isPausing = true;
  }

  async resume() {
    if (!this.isPaused) return;
    await this.playNotes();
    this.isPlaying = false;
  }

  seekTo(second) {
    this.resumeTime = second;
    if (this.isPlaying) {
      this.isSeeking = true;
    }
  }

  calcTotalTime() {
    let totalTime = 0;
    for (let i = 0; i < this.timeline.length; i++) {
      const event = this.timeline[i];
      if (totalTime < event.startTime) totalTime = event.startTime;
    }
    return totalTime;
  }

  currentTime() {
    const now = this.audioContext.currentTime;
    return this.resumeTime + now - this.startTime - this.startDelay;
  }

  processScheduledNotes(channel, callback) {
    const scheduledNotes = channel.scheduledNotes;
    for (let i = channel.scheduleIndex; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      callback(note);
    }
  }

  processActiveNotes(channel, scheduleTime, callback) {
    const scheduledNotes = channel.scheduledNotes;
    for (let i = channel.scheduleIndex; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      if (scheduleTime < note.startTime) break;
      callback(note);
    }
  }

  createConvolutionReverbImpulse(audioContext, decay, preDecay) {
    const sampleRate = audioContext.sampleRate;
    const length = sampleRate * decay;
    const impulse = new AudioBuffer({
      numberOfChannels: 2,
      length,
      sampleRate,
    });
    const preDecayLength = Math.min(sampleRate * preDecay, length);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const channelData = impulse.getChannelData(channel);
      for (let i = 0; i < preDecayLength; i++) {
        channelData[i] = Math.random() * 2 - 1;
      }
      const attenuationFactor = 1 / (sampleRate * decay);
      for (let i = preDecayLength; i < length; i++) {
        const attenuation = Math.exp(
          -(i - preDecayLength) * attenuationFactor,
        );
        channelData[i] = (Math.random() * 2 - 1) * attenuation;
      }
    }
    return impulse;
  }

  createConvolutionReverb(audioContext, impulse) {
    const input = new GainNode(audioContext);
    const convolverNode = new ConvolverNode(audioContext, {
      buffer: impulse,
    });
    input.connect(convolverNode);
    return {
      input,
      output: convolverNode,
      convolverNode,
    };
  }

  createCombFilter(audioContext, input, delay, feedback) {
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

  createAllpassFilter(audioContext, input, delay, feedback) {
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

  generateDistributedArray(
    center,
    count,
    varianceRatio = 0.1,
    randomness = 0.05,
  ) {
    const variance = center * varianceRatio;
    const array = new Array(count);
    for (let i = 0; i < count; i++) {
      const fraction = i / (count - 1 || 1);
      const value = center - variance + fraction * 2 * variance;
      array[i] = value * (1 - (Math.random() * 2 - 1) * randomness);
    }
    return array;
  }

  // https://hajim.rochester.edu/ece/sites/zduan/teaching/ece472/reading/Schroeder_1962.pdf
  //   M.R.Schroeder, "Natural Sounding Artificial Reverberation", J.Audio Eng. Soc., vol.10, p.219, 1962
  createSchroederReverb(
    audioContext,
    combFeedbacks,
    combDelays,
    allpassFeedbacks,
    allpassDelays,
  ) {
    const input = new GainNode(audioContext);
    const mergerGain = new GainNode(audioContext);
    for (let i = 0; i < combDelays.length; i++) {
      const comb = this.createCombFilter(
        audioContext,
        input,
        combDelays[i],
        combFeedbacks[i],
      );
      comb.connect(mergerGain);
    }
    const allpasses = [];
    for (let i = 0; i < allpassDelays.length; i++) {
      const allpass = this.createAllpassFilter(
        audioContext,
        (i === 0) ? mergerGain : allpasses.at(-1),
        allpassDelays[i],
        allpassFeedbacks[i],
      );
      allpasses.push(allpass);
    }
    const output = allpasses.at(-1);
    return { input, output };
  }

  createReverbEffect(audioContext) {
    const { algorithm, time: rt60, feedback } = this.reverb;
    switch (algorithm) {
      case "ConvolutionReverb": {
        const impulse = this.createConvolutionReverbImpulse(
          audioContext,
          rt60,
          this.calcDelay(rt60, feedback),
        );
        return this.createConvolutionReverb(audioContext, impulse);
      }
      case "SchroederReverb": {
        const combFeedbacks = this.generateDistributedArray(feedback, 4);
        const combDelays = combFeedbacks.map((feedback) =>
          this.calcDelay(rt60, feedback)
        );
        const allpassFeedbacks = this.generateDistributedArray(feedback, 4);
        const allpassDelays = allpassFeedbacks.map((feedback) =>
          this.calcDelay(rt60, feedback)
        );
        return this.createSchroederReverb(
          audioContext,
          combFeedbacks,
          combDelays,
          allpassFeedbacks,
          allpassDelays,
        );
      }
    }
  }

  createChorusEffect(audioContext) {
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
    const delayNodes = [];
    const feedbackGains = [];
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

  cbToRatio(cb) {
    return Math.pow(10, cb / 200);
  }

  rateToCent(rate) {
    return 1200 * Math.log2(rate);
  }

  centToRate(cent) {
    return Math.pow(2, cent / 1200);
  }

  centToHz(cent) {
    return 8.176 * this.centToRate(cent);
  }

  calcChannelDetune(channel) {
    const masterTuning = channel.isDrum
      ? 0
      : this.masterCoarseTuning + this.masterFineTuning;
    const channelTuning = channel.coarseTuning + channel.fineTuning;
    const tuning = masterTuning + channelTuning;
    const pitchWheel = channel.state.pitchWheel * 2 - 1;
    const pitchWheelSensitivity = channel.state.pitchWheelSensitivity * 12800;
    const pitch = pitchWheel * pitchWheelSensitivity;
    const channelPressureRaw = channel.channelPressureTable[0];
    if (0 <= channelPressureRaw) {
      const channelPressureDepth = (channelPressureRaw - 64) / 37.5; // 2400 / 64;
      const channelPressure = channelPressureDepth *
        channel.state.channelPressure;
      return tuning + pitch + channelPressure;
    } else {
      return tuning + pitch;
    }
  }

  calcNoteDetune(channel, note) {
    return channel.scaleOctaveTuningTable[note.noteNumber % 12];
  }

  updateChannelDetune(channel, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      this.updateDetune(channel, note, scheduleTime);
    });
  }

  updateDetune(channel, note, scheduleTime) {
    const noteDetune = this.calcNoteDetune(channel, note);
    const detune = channel.detune + noteDetune;
    if (0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber) {
      const startTime = note.startTime;
      const deltaCent = (note.noteNumber - note.portamentoNoteNumber) * 100;
      const portamentoTime = startTime + this.getPortamentoTime(channel, note);
      note.bufferSource.detune
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(detune - deltaCent, scheduleTime)
        .linearRampToValueAtTime(detune, portamentoTime);
    } else {
      note.bufferSource.detune
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(detune, scheduleTime);
    }
  }

  getPortamentoTime(channel, note) {
    const deltaSemitone = Math.abs(note.noteNumber - note.portamentoNoteNumber);
    const value = Math.ceil(channel.state.portamentoTime * 127);
    return deltaSemitone / this.getPitchIncrementSpeed(value) / 10;
  }

  getPitchIncrementSpeed(value) {
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

  setPortamentoVolumeEnvelope(channel, note, scheduleTime) {
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getAmplitudeControl(channel));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(sustainVolume, volHold);
  }

  setVolumeEnvelope(channel, note, scheduleTime) {
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getAmplitudeControl(channel));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const volDecay = volHold + voiceParams.volDecay;
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(0, startTime)
      .setValueAtTime(1e-6, volDelay) // exponentialRampToValueAtTime() requires a non-zero value
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .linearRampToValueAtTime(sustainVolume, volDecay);
  }

  setPortamentoPitchEnvelope(note, scheduleTime) {
    const baseRate = note.voiceParams.playbackRate;
    note.bufferSource.playbackRate
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(baseRate, scheduleTime);
  }

  setPitchEnvelope(note, scheduleTime) {
    const { voiceParams } = note;
    const baseRate = voiceParams.playbackRate;
    note.bufferSource.playbackRate
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(baseRate, scheduleTime);
    const modEnvToPitch = voiceParams.modEnvToPitch;
    if (modEnvToPitch === 0) return;
    const basePitch = this.rateToCent(baseRate);
    const peekPitch = basePitch + modEnvToPitch;
    const peekRate = this.centToRate(peekPitch);
    const modDelay = note.startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const modDecay = modHold + voiceParams.modDecay;
    note.bufferSource.playbackRate
      .setValueAtTime(baseRate, modDelay)
      .exponentialRampToValueAtTime(peekRate, modAttack)
      .setValueAtTime(peekRate, modHold)
      .linearRampToValueAtTime(baseRate, modDecay);
  }

  clampCutoffFrequency(frequency) {
    const minFrequency = 20; // min Hz of initialFilterFc
    const maxFrequency = 20000; // max Hz of initialFilterFc
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
  }

  setPortamentoFilterEnvelope(channel, note, scheduleTime) {
    const { voiceParams, startTime } = note;
    const softPedalFactor = this.getSoftPedalFactor(channel, note);
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel);
    const baseFreq = this.centToHz(baseCent) * softPedalFactor;
    const peekFreq = this.centToHz(
      voiceParams.initialFilterFc + voiceParams.modEnvToFilterFc,
    ) * softPedalFactor;
    const sustainFreq = baseFreq +
      (peekFreq - baseFreq) * (1 - voiceParams.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const portamentoTime = startTime + this.getPortamentoTime(channel, note);
    const modDelay = startTime + voiceParams.modDelay;
    note.filterNode.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .linearRampToValueAtTime(adjustedSustainFreq, portamentoTime);
  }

  setFilterEnvelope(channel, note, scheduleTime) {
    const { voiceParams, startTime } = note;
    const softPedalFactor = this.getSoftPedalFactor(channel, note);
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel);
    const baseFreq = this.centToHz(baseCent) * softPedalFactor;
    const peekFreq = this.centToHz(baseCent + voiceParams.modEnvToFilterFc) *
      softPedalFactor;
    const sustainFreq = baseFreq +
      (peekFreq - baseFreq) * (1 - voiceParams.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedPeekFreq = this.clampCutoffFrequency(peekFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const modDelay = startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const modDecay = modHold + voiceParams.modDecay;
    note.filterNode.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .exponentialRampToValueAtTime(adjustedPeekFreq, modAttack)
      .setValueAtTime(adjustedPeekFreq, modHold)
      .linearRampToValueAtTime(adjustedSustainFreq, modDecay);
  }

  startModulation(channel, note, scheduleTime) {
    const { voiceParams } = note;
    note.modulationLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO),
    });
    note.filterDepth = new GainNode(this.audioContext, {
      gain: voiceParams.modLfoToFilterFc,
    });
    note.modulationDepth = new GainNode(this.audioContext);
    this.setModLfoToPitch(channel, note, scheduleTime);
    note.volumeDepth = new GainNode(this.audioContext);
    this.setModLfoToVolume(note, scheduleTime);

    note.modulationLFO.start(note.startTime + voiceParams.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
    note.filterDepth.connect(note.filterNode.frequency);
    note.modulationLFO.connect(note.modulationDepth);
    note.modulationDepth.connect(note.bufferSource.detune);
    note.modulationLFO.connect(note.volumeDepth);
    note.volumeDepth.connect(note.volumeEnvelopeNode.gain);
  }

  startVibrato(channel, note, scheduleTime) {
    const { voiceParams } = note;
    const state = channel.state;
    note.vibratoLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqVibLFO) * state.vibratoRate * 2,
    });
    note.vibratoLFO.start(
      note.startTime + voiceParams.delayVibLFO * state.vibratoDelay * 2,
    );
    note.vibratoDepth = new GainNode(this.audioContext);
    this.setVibLfoToPitch(channel, note, scheduleTime);
    note.vibratoLFO.connect(note.vibratoDepth);
    note.vibratoDepth.connect(note.bufferSource.detune);
  }

  async getAudioBuffer(
    channel,
    noteNumber,
    velocity,
    voiceParams,
  ) {
    const audioBufferId = this.getVoiceId(
      channel,
      noteNumber,
      velocity,
    );
    const cache = this.voiceCache.get(audioBufferId);
    if (cache) {
      cache.counter += 1;
      if (cache.maxCount <= cache.counter) {
        this.voiceCache.delete(audioBufferId);
      }
      return cache.audioBuffer;
    } else {
      const maxCount = this.voiceCounter.get(audioBufferId) ?? 0;
      const audioBuffer = await this.createAudioBuffer(voiceParams);
      const cache = { audioBuffer, maxCount, counter: 1 };
      this.voiceCache.set(audioBufferId, cache);
      return audioBuffer;
    }
  }

  async createNote(
    channel,
    voice,
    noteNumber,
    velocity,
    startTime,
  ) {
    const now = this.audioContext.currentTime;
    const state = channel.state;
    const controllerState = this.getControllerState(
      channel,
      noteNumber,
      velocity,
    );
    const voiceParams = voice.getAllParams(controllerState);
    const note = new Note(noteNumber, velocity, startTime, voice, voiceParams);
    const audioBuffer = await this.getAudioBuffer(
      channel,
      noteNumber,
      velocity,
      voiceParams,
    );
    note.bufferSource = this.createBufferSource(
      channel,
      noteNumber,
      voiceParams,
      audioBuffer,
    );
    note.volumeEnvelopeNode = new GainNode(this.audioContext);
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10, // dB
    });
    const prevNote = channel.scheduledNotes.at(-1);
    if (prevNote && prevNote.noteNumber !== noteNumber) {
      note.portamentoNoteNumber = prevNote.noteNumber;
    }
    if (0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber) {
      this.setPortamentoVolumeEnvelope(channel, note, now);
      this.setPortamentoFilterEnvelope(channel, note, now);
      this.setPortamentoPitchEnvelope(note, now);
    } else {
      this.setVolumeEnvelope(channel, note, now);
      this.setFilterEnvelope(channel, note, now);
      this.setPitchEnvelope(note, now);
    }
    this.updateDetune(channel, note, now);
    if (0 < state.vibratoDepth) {
      this.startVibrato(channel, note, now);
    }
    if (0 < state.modulationDepth) {
      this.startModulation(channel, note, now);
    }
    if (channel.mono && channel.currentBufferSource) {
      channel.currentBufferSource.stop(startTime);
      channel.currentBufferSource = note.bufferSource;
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.volumeEnvelopeNode);

    if (0 < state.chorusSendLevel) {
      this.setChorusEffectsSend(channel, note, 0, now);
    }
    if (0 < state.reverbSendLevel) {
      this.setReverbEffectsSend(channel, note, 0, now);
    }

    note.bufferSource.start(startTime);
    return note;
  }

  calcBank(channel) {
    switch (this.mode) {
      case "GM1":
        if (channel.isDrum) return 128;
        return 0;
      case "GM2":
        if (channel.bankMSB === 121) return 0;
        if (channel.isDrum) return 128;
        return channel.bank;
      default:
        return channel.bank;
    }
  }

  handleExclusiveClass(note, channelNumber, startTime) {
    const exclusiveClass = note.voiceParams.exclusiveClass;
    if (exclusiveClass === 0) return;
    const prev = this.exclusiveClassNotes[exclusiveClass];
    if (prev) {
      const [prevNote, prevChannelNumber] = prev;
      if (prevNote && !prevNote.ending) {
        this.scheduleNoteOff(
          prevChannelNumber,
          prevNote.noteNumber,
          0, // velocity,
          startTime,
          true, // force
        );
      }
    }
    this.exclusiveClassNotes[exclusiveClass] = [note, channelNumber];
  }

  handleDrumExclusiveClass(note, channelNumber, startTime) {
    const channel = this.channels[channelNumber];
    if (!channel.isDrum) return;
    const kitTable = drumExclusiveClassesByKit[channel.programNumber];
    if (!kitTable) return;
    const drumExclusiveClass = kitTable[note.noteNumber];
    if (drumExclusiveClass === 0) return;
    const index = (drumExclusiveClass - 1) * this.channels.length +
      channelNumber;
    const prevNote = this.drumExclusiveClassNotes[index];
    if (prevNote && !prevNote.ending) {
      this.scheduleNoteOff(
        channelNumber,
        prevNote.noteNumber,
        0, // velocity,
        startTime,
        true, // force
      );
    }
    this.drumExclusiveClassNotes[index] = note;
  }

  async scheduleNoteOn(
    channelNumber,
    noteNumber,
    velocity,
    startTime,
  ) {
    const channel = this.channels[channelNumber];
    const bankNumber = this.calcBank(channel, channelNumber);
    const soundFontIndex = this.soundFontTable[channel.programNumber]
      .get(bankNumber);
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(
      bankNumber,
      channel.programNumber,
      noteNumber,
      velocity,
    );
    if (!voice) return;
    const note = await this.createNote(
      channel,
      voice,
      noteNumber,
      velocity,
      startTime,
    );
    if (channel.isDrum) {
      const audioContext = this.audioContext;
      const { gainL, gainR } = this.createChannelAudioNodes(audioContext);
      channel.keyBasedGainLs[noteNumber] = gainL;
      channel.keyBasedGainRs[noteNumber] = gainR;
      note.volumeEnvelopeNode.connect(gainL);
      note.volumeEnvelopeNode.connect(gainR);
    } else {
      note.volumeEnvelopeNode.connect(channel.gainL);
      note.volumeEnvelopeNode.connect(channel.gainR);
    }
    if (0.5 <= channel.state.sustainPedal) {
      channel.sustainNotes.push(note);
    }
    this.handleExclusiveClass(note, channelNumber, startTime);
    this.handleDrumExclusiveClass(note, channelNumber, startTime);
    const scheduledNotes = channel.scheduledNotes;
    note.index = scheduledNotes.length;
    scheduledNotes.push(note);
  }

  noteOn(channelNumber, noteNumber, velocity, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.scheduleNoteOn(
      channelNumber,
      noteNumber,
      velocity,
      scheduleTime,
      undefined, // noteOff event
    );
  }

  disconnectNote(note) {
    note.bufferSource.disconnect();
    note.filterNode.disconnect();
    note.volumeEnvelopeNode.disconnect();
    if (note.modulationDepth) {
      note.volumeDepth.disconnect();
      note.modulationDepth.disconnect();
      note.modulationLFO.stop();
    }
    if (note.vibratoDepth) {
      note.vibratoDepth.disconnect();
      note.vibratoLFO.stop();
    }
    if (note.reverbEffectsSend) {
      note.reverbEffectsSend.disconnect();
    }
    if (note.chorusEffectsSend) {
      note.chorusEffectsSend.disconnect();
    }
  }

  releaseNote(channel, note, endTime) {
    const volRelease = endTime + note.voiceParams.volRelease;
    const modRelease = endTime + note.voiceParams.modRelease;
    const stopTime = Math.min(volRelease, modRelease);
    note.filterNode.frequency
      .cancelScheduledValues(endTime)
      .linearRampToValueAtTime(0, modRelease);
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(endTime)
      .linearRampToValueAtTime(0, volRelease);
    return new Promise((resolve) => {
      this.scheduleTask(() => {
        const bufferSource = note.bufferSource;
        bufferSource.loop = false;
        bufferSource.stop(stopTime);
        this.disconnectNote(note);
        channel.scheduledNotes[note.index] = undefined;
        resolve();
      }, stopTime);
    });
  }

  scheduleNoteOff(
    channelNumber,
    noteNumber,
    _velocity,
    endTime,
    force,
  ) {
    const channel = this.channels[channelNumber];
    const state = channel.state;
    if (!force) {
      if (channel.isDrum) {
        if (!this.isLoopDrum(channel, noteNumber)) return;
      } else {
        if (0.5 <= state.sustainPedal) return;
        if (0.5 <= state.sostenutoPedal) return;
      }
    }
    const index = this.findNoteOffIndex(channel, noteNumber);
    if (index < 0) return;
    const note = channel.scheduledNotes[index];
    note.ending = true;
    this.setNoteIndex(channel, index);
    this.releaseNote(channel, note, endTime);
  }

  setNoteIndex(channel, index) {
    let allEnds = true;
    for (let i = channel.scheduleIndex; i < index; i++) {
      const note = channel.scheduledNotes[i];
      if (note && !note.ending) {
        allEnds = false;
        break;
      }
    }
    if (allEnds) channel.scheduleIndex = index + 1;
  }

  findNoteOffIndex(channel, noteNumber) {
    const scheduledNotes = channel.scheduledNotes;
    for (let i = channel.scheduleIndex; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      if (note.noteNumber !== noteNumber) continue;
      return i;
    }
    return -1;
  }

  noteOff(channelNumber, noteNumber, velocity, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.scheduleNoteOff(
      channelNumber,
      noteNumber,
      velocity,
      scheduleTime,
      false, // force
    );
  }

  releaseSustainPedal(channelNumber, halfVelocity, scheduleTime) {
    const velocity = halfVelocity * 2;
    const channel = this.channels[channelNumber];
    const promises = [];
    for (let i = 0; i < channel.sustainNotes.length; i++) {
      const promise = this.scheduleNoteOff(
        channelNumber,
        channel.sustainNotes[i].noteNumber,
        velocity,
        scheduleTime,
      );
      promises.push(promise);
    }
    channel.sustainNotes = [];
    return promises;
  }

  releaseSostenutoPedal(channelNumber, halfVelocity, scheduleTime) {
    const velocity = halfVelocity * 2;
    const channel = this.channels[channelNumber];
    const promises = [];
    const sostenutoNotes = channel.sostenutoNotes;
    channel.state.sostenutoPedal = 0;
    for (let i = 0; i < sostenutoNotes.length; i++) {
      const note = sostenutoNotes[i];
      const promise = this.scheduleNoteOff(
        channelNumber,
        note.noteNumber,
        velocity,
        scheduleTime,
      );
      promises.push(promise);
    }
    channel.sostenutoNotes = [];
    return promises;
  }

  handleMIDIMessage(statusByte, data1, data2, scheduleTime) {
    const channelNumber = statusByte & 0x0F;
    const messageType = statusByte & 0xF0;
    switch (messageType) {
      case 0x80:
        return this.noteOff(channelNumber, data1, data2, scheduleTime);
      case 0x90:
        return this.noteOn(channelNumber, data1, data2, scheduleTime);
      case 0xB0:
        return this.setControlChange(
          channelNumber,
          data1,
          data2,
          scheduleTime,
        );
      case 0xC0:
        return this.setProgramChange(channelNumber, data1, scheduleTime);
      case 0xD0:
        return this.setChannelPressure(channelNumber, data1, scheduleTime);
      case 0xE0:
        return this.handlePitchBendMessage(
          channelNumber,
          data1,
          data2,
          scheduleTime,
        );
      default:
        console.warn(`Unsupported MIDI message: ${messageType.toString(16)}`);
    }
  }

  setProgramChange(channelNumber, programNumber, _scheduleTime) {
    const channel = this.channels[channelNumber];
    channel.bank = channel.bankMSB * 128 + channel.bankLSB;
    channel.programNumber = programNumber;
    if (this.mode === "GM2") {
      switch (channel.bankMSB) {
        case 120:
          channel.isDrum = true;
          break;
        case 121:
          channel.isDrum = false;
          break;
      }
    }
  }

  setChannelPressure(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const prev = channel.state.channelPressure;
    const next = value / 127;
    channel.state.channelPressure = next;
    const channelPressureRaw = channel.channelPressureTable[0];
    if (0 <= channelPressureRaw) {
      const channelPressureDepth = (channelPressureRaw - 64) / 37.5; // 2400 / 64;
      channel.detune += channelPressureDepth * (next - prev);
    }
    const table = channel.channelPressureTable;
    this.processActiveNotes(channel, scheduleTime, (note) => {
      this.setEffects(channel, note, table);
    });
    this.applyVoiceParams(channel, 13);
  }

  handlePitchBendMessage(channelNumber, lsb, msb, scheduleTime) {
    const pitchBend = msb * 128 + lsb;
    this.setPitchBend(channelNumber, pitchBend, scheduleTime);
  }

  setPitchBend(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const state = channel.state;
    const prev = state.pitchWheel * 2 - 1;
    const next = (value - 8192) / 8192;
    state.pitchWheel = value / 16383;
    channel.detune += (next - prev) * state.pitchWheelSensitivity * 12800;
    this.updateChannelDetune(channel, scheduleTime);
    this.applyVoiceParams(channel, 14, scheduleTime);
  }

  setModLfoToPitch(channel, note, scheduleTime) {
    if (note.modulationDepth) {
      const modLfoToPitch = note.voiceParams.modLfoToPitch +
        this.getLFOPitchDepth(channel, note);
      const baseDepth = Math.abs(modLfoToPitch) + channel.state.modulationDepth;
      const modulationDepth = baseDepth * Math.sign(modLfoToPitch);
      note.modulationDepth.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(modulationDepth, scheduleTime);
    } else {
      this.startModulation(channel, note, scheduleTime);
    }
  }

  setVibLfoToPitch(channel, note, scheduleTime) {
    const vibLfoToPitch = note.voiceParams.vibLfoToPitch;
    const vibratoDepth = Math.abs(vibLfoToPitch) * channel.state.vibratoDepth *
      2;
    const vibratoDepthSign = 0 < vibLfoToPitch;
    note.vibratoDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(vibratoDepth * vibratoDepthSign, scheduleTime);
  }

  setModLfoToFilterFc(channel, note, scheduleTime) {
    const modLfoToFilterFc = note.voiceParams.modLfoToFilterFc +
      this.getLFOFilterDepth(channel);
    note.filterDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modLfoToFilterFc, scheduleTime);
  }

  setModLfoToVolume(channel, note, scheduleTime) {
    const modLfoToVolume = note.voiceParams.modLfoToVolume;
    const baseDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepth = baseDepth * Math.sign(modLfoToVolume) *
      (1 + this.getLFOAmplitudeDepth(channel));
    note.volumeDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(volumeDepth, scheduleTime);
  }

  setReverbEffectsSend(channel, note, prevValue, scheduleTime) {
    let value = note.voiceParams.reverbEffectsSend;
    if (channel.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel, note.noteNumber, 91);
      if (0 <= keyBasedValue) {
        value *= keyBasedValue / 127 / channel.state.reverbSendLevel;
      }
    }
    if (0 < prevValue) {
      if (0 < value) {
        note.reverbEffectsSend.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(value, scheduleTime);
      } else {
        note.reverbEffectsSend.disconnect();
      }
    } else {
      if (0 < value) {
        if (!note.reverbEffectsSend) {
          note.reverbEffectsSend = new GainNode(this.audioContext, {
            gain: value,
          });
          note.volumeNode.connect(note.reverbEffectsSend);
        }
        note.reverbEffectsSend.connect(this.reverbEffect.input);
      }
    }
  }

  setChorusEffectsSend(channel, note, prevValue, scheduleTime) {
    let value = note.voiceParams.chorusEffectsSend;
    if (channel.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel, note.noteNumber, 93);
      if (0 <= keyBasedValue) {
        value *= keyBasedValue / 127 / channel.state.chorusSendLevel;
      }
    }
    if (0 < prevValue) {
      if (0 < value) {
        note.chorusEffectsSend.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(value, scheduleTime);
      } else {
        note.chorusEffectsSend.disconnect();
      }
    } else {
      if (0 < value) {
        if (!note.chorusEffectsSend) {
          note.chorusEffectsSend = new GainNode(this.audioContext, {
            gain: value,
          });
          note.volumeEnvelopeNode.connect(note.chorusEffectsSend);
        }
        note.chorusEffectsSend.connect(this.chorusEffect.input);
      }
    }
  }

  setDelayModLFO(note, scheduleTime) {
    const startTime = note.startTime;
    if (startTime < scheduleTime) return;
    note.modulationLFO.stop(scheduleTime);
    note.modulationLFO.start(startTime + note.voiceParams.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
  }

  setFreqModLFO(note, scheduleTime) {
    const freqModLFO = note.voiceParams.freqModLFO;
    note.modulationLFO.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(freqModLFO, scheduleTime);
  }

  setFreqVibLFO(channel, note, scheduleTime) {
    const freqVibLFO = note.voiceParams.freqVibLFO;
    note.vibratoLFO.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(freqVibLFO * channel.state.vibratoRate * 2, scheduleTime);
  }

  createVoiceParamsHandlers() {
    return {
      modLfoToPitch: (channel, note, _prevValue, scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setModLfoToPitch(channel, note, scheduleTime);
        }
      },
      vibLfoToPitch: (channel, note, _prevValue, scheduleTime) => {
        if (0 < channel.state.vibratoDepth) {
          this.setVibLfoToPitch(channel, note, scheduleTime);
        }
      },
      modLfoToFilterFc: (channel, note, _prevValue, scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setModLfoToFilterFc(channel, note, scheduleTime);
        }
      },
      modLfoToVolume: (channel, note, _prevValue, scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setModLfoToVolume(channel, note, scheduleTime);
        }
      },
      chorusEffectsSend: (channel, note, prevValue, scheduleTime) => {
        this.setChorusEffectsSend(channel, note, prevValue, scheduleTime);
      },
      reverbEffectsSend: (channel, note, prevValue, scheduleTime) => {
        this.setReverbEffectsSend(channel, note, prevValue, scheduleTime);
      },
      delayModLFO: (_channel, note, _prevValue, scheduleTime) =>
        this.setDelayModLFO(note, scheduleTime),
      freqModLFO: (_channel, note, _prevValue, scheduleTime) =>
        this.setFreqModLFO(note, scheduleTime),
      delayVibLFO: (channel, note, prevValue, scheduleTime) => {
        if (0 < channel.state.vibratoDepth) {
          const vibratoDelay = channel.state.vibratoDelay * 2;
          const prevStartTime = note.startTime + prevValue * vibratoDelay;
          if (scheduleTime < prevStartTime) return;
          const value = note.voiceParams.delayVibLFO;
          const startTime = note.startTime + value * vibratoDelay;
          note.vibratoLFO.stop(scheduleTime);
          note.vibratoLFO.start(startTime);
        }
      },
      freqVibLFO: (channel, note, _prevValue, scheduleTime) => {
        if (0 < channel.state.vibratoDepth) {
          this.setFreqVibLFO(channel, note, scheduleTime);
        }
      },
    };
  }

  getControllerState(channel, noteNumber, velocity) {
    const state = new Float32Array(channel.state.array.length);
    state.set(channel.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    state[13] = state.channelPressure / 127;
    return state;
  }

  applyVoiceParams(channel, controllerType, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      const controllerState = this.getControllerState(
        channel,
        note.noteNumber,
        note.velocity,
      );
      const voiceParams = note.voice.getParams(controllerType, controllerState);
      let applyVolumeEnvelope = false;
      let applyFilterEnvelope = false;
      let applyPitchEnvelope = false;
      for (const [key, value] of Object.entries(voiceParams)) {
        const prevValue = note.voiceParams[key];
        if (value === prevValue) continue;
        note.voiceParams[key] = value;
        if (key in this.voiceParamsHandlers) {
          this.voiceParamsHandlers[key](
            channel,
            note,
            prevValue,
            scheduleTime,
          );
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

  createControlChangeHandlers() {
    const handlers = new Array(128);
    handlers[0] = this.setBankMSB;
    handlers[1] = this.setModulationDepth;
    handlers[5] = this.setPortamentoTime;
    handlers[6] = this.dataEntryMSB;
    handlers[7] = this.setVolume;
    handlers[10] = this.setPan;
    handlers[11] = this.setExpression;
    handlers[32] = this.setBankLSB;
    handlers[38] = this.dataEntryLSB;
    handlers[64] = this.setSustainPedal;
    handlers[65] = this.setPortamento;
    handlers[66] = this.setSostenutoPedal;
    handlers[67] = this.setSoftPedal;
    handlers[91] = this.setReverbSendLevel;
    handlers[93] = this.setChorusSendLevel;
    handlers[100] = this.setRPNLSB;
    handlers[101] = this.setRPNMSB;
    handlers[120] = this.allSoundOff;
    handlers[121] = this.resetAllControllers;
    handlers[123] = this.allNotesOff;
    handlers[124] = this.omniOff;
    handlers[125] = this.omniOn;
    handlers[126] = this.monoOn;
    handlers[127] = this.polyOn;
    return handlers;
  }

  setControlChange(channelNumber, controllerType, value, scheduleTime) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value, scheduleTime);
      const channel = this.channels[channelNumber];
      this.applyVoiceParams(channel, controllerType + 128, scheduleTime);
      this.setControlChangeEffects(channel, controllerType, scheduleTime);
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`,
      );
    }
  }

  setBankMSB(channelNumber, msb) {
    this.channels[channelNumber].bankMSB = msb;
  }

  updateModulation(channel, scheduleTime) {
    const depth = channel.state.modulationDepth * channel.modulationDepthRange;
    this.processScheduledNotes(channel, (note) => {
      if (note.modulationDepth) {
        note.modulationDepth.gain.setValueAtTime(depth, scheduleTime);
      } else {
        this.startModulation(channel, note, scheduleTime);
      }
    });
  }

  setModulationDepth(channelNumber, modulation, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.modulationDepth = modulation / 127;
    this.updateModulation(channel, scheduleTime);
  }

  updatePortamento(channel, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      if (0.5 <= channel.state.portamento) {
        if (0 <= note.portamentoNoteNumber) {
          this.setPortamentoVolumeEnvelope(channel, note, scheduleTime);
          this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
          this.setPortamentoPitchEnvelope(note, scheduleTime);
          this.updateDetune(channel, note, scheduleTime);
        }
      } else {
        if (0 <= note.portamentoNoteNumber) {
          this.setVolumeEnvelope(channel, note, scheduleTime);
          this.setFilterEnvelope(channel, note, scheduleTime);
          this.setPitchEnvelope(note, scheduleTime);
          this.updateDetune(channel, note, scheduleTime);
        }
      }
    });
  }

  setPortamentoTime(channelNumber, portamentoTime, scheduleTime) {
    const channel = this.channels[channelNumber];
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.portamentoTime = portamentoTime / 127;
    if (channel.isDrum) return;
    this.updatePortamento(channel, scheduleTime);
  }

  setVolume(channelNumber, volume, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.volume = volume / 127;
    this.updateChannelVolume(channel, scheduleTime);
    this.updateKeyBasedVolume(channel, scheduleTime);
  }

  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  setPan(channelNumber, pan, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.pan = pan / 127;
    this.updateChannelVolume(channel, scheduleTime);
    this.updateKeyBasedVolume(channel, scheduleTime);
  }

  setExpression(channelNumber, expression, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.expression = expression / 127;
    this.updateChannelVolume(channel, scheduleTime);
  }

  setBankLSB(channelNumber, lsb) {
    this.channels[channelNumber].bankLSB = lsb;
  }

  dataEntryLSB(channelNumber, value, scheduleTime) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber, scheduleTime);
  }

  updateChannelVolume(channel, scheduleTime) {
    const state = channel.state;
    const volume = state.volume * state.expression;
    const { gainLeft, gainRight } = this.panToGain(state.pan);
    channel.gainL.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(volume * gainLeft, scheduleTime);
    channel.gainR.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(volume * gainRight, scheduleTime);
  }

  updateKeyBasedVolume(channel, scheduleTime) {
    if (!channel.isDrum) return;
    const state = channel.state;
    const defaultVolume = state.volume * state.expression;
    const defaultPan = state.pan;
    for (let i = 0; i < 128; i++) {
      const gainL = channel.keyBasedGainLs[i];
      const gainR = channel.keyBasedGainLs[i];
      if (!gainL) continue;
      if (!gainR) continue;
      const keyBasedVolume = this.getKeyBasedValue(channel, i, 7);
      const volume = (0 <= keyBasedVolume)
        ? defaultVolume * keyBasedVolume / 64
        : defaultVolume;
      const keyBasedPan = this.getKeyBasedValue(channel, i, 10);
      const pan = (0 <= keyBasedPan) ? keyBasedPan / 127 : defaultPan;
      const { gainLeft, gainRight } = this.panToGain(pan);
      gainL.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(volume * gainLeft, scheduleTime);
      gainR.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(volume * gainRight, scheduleTime);
    }
  }

  setSustainPedal(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.sustainPedal = value / 127;
    if (64 <= value) {
      this.processScheduledNotes(channel, (note) => {
        channel.sustainNotes.push(note);
      });
    } else {
      this.releaseSustainPedal(channelNumber, value, scheduleTime);
    }
  }

  setPortamento(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.portamento = value / 127;
    this.updatePortamento(channel, scheduleTime);
  }

  setSostenutoPedal(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.sostenutoPedal = value / 127;
    if (64 <= value) {
      const sostenutoNotes = [];
      this.processActiveNotes(channel, scheduleTime, (note) => {
        sostenutoNotes.push(note);
      });
      channel.sostenutoNotes = sostenutoNotes;
    } else {
      this.releaseSostenutoPedal(channelNumber, value, scheduleTime);
    }
  }

  getSoftPedalFactor(channel, note) {
    return 1 - (0.1 + (note.noteNumber / 127) * 0.2) * channel.state.softPedal;
  }

  setSoftPedal(channelNumber, softPedal, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const state = channel.state;
    scheduleTime ??= this.audioContext.currentTime;
    state.softPedal = softPedal / 127;
    this.processScheduledNotes(channel, (note) => {
      if (0.5 <= state.portamento && 0 <= note.portamentoNoteNumber) {
        this.setPortamentoVolumeEnvelope(channel, note, scheduleTime);
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
      } else {
        this.setVolumeEnvelope(channel, note, scheduleTime);
        this.setFilterEnvelope(channel, note, scheduleTime);
      }
    });
  }

  setReverbSendLevel(channelNumber, reverbSendLevel, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const reverbEffect = this.reverbEffect;
    if (0 < state.reverbSendLevel) {
      if (0 < reverbSendLevel) {
        state.reverbSendLevel = reverbSendLevel / 127;
        reverbEffect.input.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(state.reverbSendLevel, scheduleTime);
      } else {
        this.processScheduledNotes(channel, (note) => {
          if (note.voiceParams.reverbEffectsSend <= 0) return false;
          if (note.reverbEffectsSend) note.reverbEffectsSend.disconnect();
        });
      }
    } else {
      if (0 < reverbSendLevel) {
        this.processScheduledNotes(channel, (note) => {
          this.setReverbEffectsSend(channel, note, 0, scheduleTime);
        });
        state.reverbSendLevel = reverbSendLevel / 127;
        reverbEffect.input.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(state.reverbSendLevel, scheduleTime);
      }
    }
  }

  setChorusSendLevel(channelNumber, chorusSendLevel, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const chorusEffect = this.chorusEffect;
    if (0 < state.chorusSendLevel) {
      if (0 < chorusSendLevel) {
        state.chorusSendLevel = chorusSendLevel / 127;
        chorusEffect.input.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(state.chorusSendLevel, scheduleTime);
      } else {
        this.processScheduledNotes(channel, (note) => {
          if (note.voiceParams.chorusEffectsSend <= 0) return false;
          if (note.chorusEffectsSend) note.chorusEffectsSend.disconnect();
        });
      }
    } else {
      if (0 < chorusSendLevel) {
        this.processScheduledNotes(channel, (note) => {
          this.setChorusEffectsSend(channel, note, 0, scheduleTime);
        });
        state.chorusSendLevel = chorusSendLevel / 127;
        chorusEffect.input.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(state.chorusSendLevel, scheduleTime);
      }
    }
  }

  limitData(channel, minMSB, maxMSB, minLSB, maxLSB) {
    if (maxLSB < channel.dataLSB) {
      channel.dataMSB++;
      channel.dataLSB = minLSB;
    } else if (channel.dataLSB < 0) {
      channel.dataMSB--;
      channel.dataLSB = maxLSB;
    }
    if (maxMSB < channel.dataMSB) {
      channel.dataMSB = maxMSB;
      channel.dataLSB = maxLSB;
    } else if (channel.dataMSB < 0) {
      channel.dataMSB = minMSB;
      channel.dataLSB = minLSB;
    }
  }

  limitDataMSB(channel, minMSB, maxMSB) {
    if (maxMSB < channel.dataMSB) {
      channel.dataMSB = maxMSB;
    } else if (channel.dataMSB < 0) {
      channel.dataMSB = minMSB;
    }
  }

  handleRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    const rpn = channel.rpnMSB * 128 + channel.rpnLSB;
    switch (rpn) {
      case 0:
        this.handlePitchBendRangeRPN(channelNumber, scheduleTime);
        break;
      case 1:
        this.handleFineTuningRPN(channelNumber, scheduleTime);
        break;
      case 2:
        this.handleCoarseTuningRPN(channelNumber, scheduleTime);
        break;
      case 5:
        this.handleModulationDepthRangeRPN(channelNumber, scheduleTime);
        break;
      default:
        console.warn(
          `Channel ${channelNumber}: Unsupported RPN MSB=${channel.rpnMSB} LSB=${channel.rpnLSB}`,
        );
    }
  }

  setRPNMSB(channelNumber, value) {
    this.channels[channelNumber].rpnMSB = value;
  }

  setRPNLSB(channelNumber, value) {
    this.channels[channelNumber].rpnLSB = value;
  }

  dataEntryMSB(channelNumber, value, scheduleTime) {
    this.channels[channelNumber].dataMSB = value;
    this.handleRPN(channelNumber, scheduleTime);
  }

  handlePitchBendRangeRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 99);
    const pitchBendRange = channel.dataMSB + channel.dataLSB / 100;
    this.setPitchBendRange(channelNumber, pitchBendRange, scheduleTime);
  }

  setPitchBendRange(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const state = channel.state;
    const prev = state.pitchWheelSensitivity;
    const next = value / 128;
    state.pitchWheelSensitivity = next;
    channel.detune += (state.pitchWheel * 2 - 1) * (next - prev) * 12800;
    this.updateChannelDetune(channel, scheduleTime);
    this.applyVoiceParams(channel, 16, scheduleTime);
  }

  handleFineTuningRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const fineTuning = channel.dataMSB * 128 + channel.dataLSB;
    this.setFineTuning(channelNumber, fineTuning, scheduleTime);
  }

  setFineTuning(channelNumber, value, scheduleTime) { // [0, 16383]
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const prev = channel.fineTuning;
    const next = (value - 8192) / 8.192; // cent
    channel.fineTuning = next;
    channel.detune += next - prev;
    this.updateChannelDetune(channel, scheduleTime);
  }

  handleCoarseTuningRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitDataMSB(channel, 0, 127);
    const coarseTuning = channel.dataMSB;
    this.setCoarseTuning(channelNumber, coarseTuning, scheduleTime);
  }

  setCoarseTuning(channelNumber, value, scheduleTime) { // [0, 127]
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const prev = channel.coarseTuning;
    const next = (value - 64) * 100; // cent
    channel.coarseTuning = next;
    channel.detune += next - prev;
    this.updateChannelDetune(channel, scheduleTime);
  }

  handleModulationDepthRangeRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const modulationDepthRange = (dataMSB + dataLSB / 128) * 100;
    this.setModulationDepthRange(
      channelNumber,
      modulationDepthRange,
      scheduleTime,
    );
  }

  setModulationDepthRange(channelNumber, modulationDepthRange, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.modulationDepthRange = modulationDepthRange;
    this.updateModulation(channel, scheduleTime);
  }

  allSoundOff(channelNumber, _value, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.stopActiveNotes(channelNumber, 0, true, scheduleTime);
  }

  resetAllStates(channelNumber) {
    const scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const entries = Object.entries(defaultControllerState);
    for (const [key, { type, defaultValue }] of entries) {
      if (128 <= type) {
        this.setControlChange(
          channelNumber,
          type - 128,
          Math.ceil(defaultValue * 127),
          scheduleTime,
        );
      } else {
        state[key] = defaultValue;
      }
    }
    for (const key of Object.keys(this.constructor.channelSettings)) {
      channel[key] = this.constructor.channelSettings[key];
    }
    this.resetChannelTable(channel);
    this.mode = "GM2";
    this.masterFineTuning = 0; // cb
    this.masterCoarseTuning = 0; // cb
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
  resetAllControllers(channelNumber, _value, scheduleTime) {
    const keys = [
      "channelPressure",
      "pitchWheel",
      "expression",
      "modulationDepth",
      "sustainPedal",
      "portamento",
      "sostenutoPedal",
      "softPedal",
    ];
    const channel = this.channels[channelNumber];
    const state = channel.state;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const { type, defaultValue } = defaultControllerState[key];
      if (128 <= type) {
        this.setControlChange(
          channelNumber,
          type - 128,
          Math.ceil(defaultValue * 127),
          scheduleTime,
        );
      } else {
        state[key] = defaultValue;
      }
    }
    this.setPitchBend(channelNumber, 8192, scheduleTime);
    const settingTypes = [
      "rpnMSB",
      "rpnLSB",
    ];
    for (let i = 0; i < settingTypes.length; i++) {
      const type = settingTypes[i];
      channel[type] = this.constructor.channelSettings[type];
    }
  }

  allNotesOff(channelNumber, _value, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.stopActiveNotes(channelNumber, 0, false, scheduleTime);
  }

  omniOff(channelNumber, value, scheduleTime) {
    this.allNotesOff(channelNumber, value, scheduleTime);
  }

  omniOn(channelNumber, value, scheduleTime) {
    this.allNotesOff(channelNumber, value, scheduleTime);
  }

  monoOn(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.allNotesOff(channelNumber, value, scheduleTime);
    channel.mono = true;
  }

  polyOn(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.allNotesOff(channelNumber, value, scheduleTime);
    channel.mono = false;
  }

  handleUniversalNonRealTimeExclusiveMessage(data, scheduleTime) {
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
            this.GM1SystemOn(scheduleTime);
            break;
          case 2: // GM System Off
            break;
          case 3:
            this.GM2SystemOn(scheduleTime);
            break;
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  GM1SystemOn(scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.mode = "GM1";
    for (let i = 0; i < this.channels.length; i++) {
      this.allSoundOff(i, 0, scheduleTime);
      const channel = this.channels[i];
      channel.bankMSB = 0;
      channel.bankLSB = 0;
      channel.bank = 0;
      channel.isDrum = false;
    }
    this.channels[9].bankMSB = 1;
    this.channels[9].bank = 128;
    this.channels[9].isDrum = true;
  }

  GM2SystemOn(scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.mode = "GM2";
    for (let i = 0; i < this.channels.length; i++) {
      this.allSoundOff(i, 0, scheduleTime);
      const channel = this.channels[i];
      channel.bankMSB = 121;
      channel.bankLSB = 0;
      channel.bank = 121 * 128;
      channel.isDrum = false;
    }
    this.channels[9].bankMSB = 120;
    this.channels[9].bank = 120 * 128;
    this.channels[9].isDrum = true;
  }

  handleUniversalRealTimeExclusiveMessage(data, scheduleTime) {
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
            return this.handlePressureSysEx(
              data,
              "channelPressureTable",
              scheduleTime,
            );
          case 3: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca22.pdf
            return this.handleControlChangeSysEx(data);
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

  handleMasterVolumeSysEx(data, scheduleTime) {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.setMasterVolume(volume, scheduleTime);
  }

  setMasterVolume(volume, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    if (volume < 0 && 1 < volume) {
      console.error("Master Volume is out of range");
    } else {
      this.masterVolume.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(volume * volume, scheduleTime);
    }
  }

  handleMasterFineTuningSysEx(data, scheduleTime) {
    const fineTuning = data[5] * 128 + data[4];
    this.setMasterFineTuning(fineTuning, scheduleTime);
  }

  setMasterFineTuning(value, scheduleTime) { // [0, 16383]
    const prev = this.masterFineTuning;
    const next = (value - 8192) / 8.192; // cent
    this.masterFineTuning = next;
    const detuneChange = next - prev;
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      if (channel.isDrum) continue;
      channel.detune += detuneChange;
      this.updateChannelDetune(channel, scheduleTime);
    }
  }

  handleMasterCoarseTuningSysEx(data, scheduleTime) {
    const coarseTuning = data[4];
    this.setMasterCoarseTuning(coarseTuning, scheduleTime);
  }

  setMasterCoarseTuning(value, scheduleTime) { // [0, 127]
    const prev = this.masterCoarseTuning;
    const next = (value - 64) * 100; // cent
    this.masterCoarseTuning = next;
    const detuneChange = next - prev;
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      if (channel.isDrum) continue;
      channel.detune += detuneChange;
      this.updateChannelDetune(channel, scheduleTime);
    }
  }

  handleGlobalParameterControlSysEx(data, scheduleTime) {
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

  handleReverbParameterSysEx(data) {
    switch (data[9]) {
      case 0:
        return this.setReverbType(data[10]);
      case 1:
        return this.setReverbTime(data[10]);
    }
  }

  setReverbType(type) {
    this.reverb.time = this.getReverbTimeFromType(type);
    this.reverb.feedback = (type === 8) ? 0.9 : 0.8;
    this.reverbEffect = this.createReverbEffect(this.audioContext);
  }

  getReverbTimeFromType(type) {
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

  setReverbTime(value) {
    this.reverb.time = this.getReverbTime(value);
    this.reverbEffect = this.createReverbEffect(this.audioContext);
  }

  getReverbTime(value) {
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
  calcDelay(rt60, feedback) {
    return -rt60 * Math.log10(feedback) / 3;
  }

  handleChorusParameterSysEx(data, scheduleTime) {
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

  setChorusType(type, scheduleTime) {
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

  setChorusParameter(modRate, modDepth, feedback, sendToReverb, scheduleTime) {
    this.setChorusModRate(modRate, scheduleTime);
    this.setChorusModDepth(modDepth, scheduleTime);
    this.setChorusFeedback(feedback, scheduleTime);
    this.setChorusSendToReverb(sendToReverb, scheduleTime);
  }

  setChorusModRate(value, scheduleTime) {
    const modRate = this.getChorusModRate(value);
    this.chorus.modRate = modRate;
    this.chorusEffect.lfo.frequency.setValueAtTime(modRate, scheduleTime);
  }

  getChorusModRate(value) {
    return value * 0.122; // Hz
  }

  setChorusModDepth(value, scheduleTime) {
    const modDepth = this.getChorusModDepth(value);
    this.chorus.modDepth = modDepth;
    this.chorusEffect.lfoGain.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modDepth / 2, scheduleTime);
  }

  getChorusModDepth(value) {
    return (value + 1) / 3200; // second
  }

  setChorusFeedback(value, scheduleTime) {
    const feedback = this.getChorusFeedback(value);
    this.chorus.feedback = feedback;
    const chorusEffect = this.chorusEffect;
    for (let i = 0; i < chorusEffect.feedbackGains.length; i++) {
      chorusEffect.feedbackGains[i].gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(feedback, scheduleTime);
    }
  }

  getChorusFeedback(value) {
    return value * 0.00763;
  }

  setChorusSendToReverb(value, scheduleTime) {
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

  getChorusSendToReverb(value) {
    return value * 0.00787;
  }

  getChannelBitmap(data) {
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

  handleScaleOctaveTuning1ByteFormatSysEx(data, realtime, scheduleTime) {
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

  getFilterCutoffControl(channel) {
    const channelPressureRaw = channel.channelPressureTable[1];
    const channelPressure = (0 <= channelPressureRaw)
      ? (channelPressureRaw - 64) * channel.state.channelPressure
      : 0;
    return channelPressure * 15;
  }

  getAmplitudeControl(channel) {
    const channelPressureRaw = channel.channelPressureTable[2];
    const channelPressure = (0 <= channelPressureRaw)
      ? channelPressureRaw * channel.state.channelPressure
      : 0;
    return channelPressure / 64;
  }

  getLFOPitchDepth(channel) {
    const channelPressureRaw = channel.channelPressureTable[3];
    const channelPressure = (0 <= channelPressureRaw)
      ? channelPressureRaw * channel.state.channelPressure
      : 0;
    return channelPressure / 127 * 600;
  }

  getLFOFilterDepth(channel) {
    const channelPressureRaw = channel.channelPressureTable[4];
    const channelPressure = (0 <= channelPressureRaw)
      ? channelPressureRaw * channel.state.channelPressure
      : 0;
    return channelPressure / 127 * 2400;
  }

  getLFOAmplitudeDepth(channel) {
    const channelPressureRaw = channel.channelPressureTable[5];
    const channelPressure = (0 <= channelPressureRaw)
      ? channelPressureRaw * channel.state.channelPressure
      : 0;
    return channelPressure / 127;
  }

  setEffects(channel, note, table, scheduleTime) {
    if (0 <= table[0]) this.updateDetune(channel, note, scheduleTime);
    if (0.5 <= channel.state.portamemento && 0 <= note.portamentoNoteNumber) {
      if (0 <= table[1]) {
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
      }
      if (0 <= table[2]) {
        this.setPortamentoVolumeEnvelope(channel, note, scheduleTime);
      }
    } else {
      if (0 <= table[1]) this.setFilterEnvelope(channel, note, scheduleTime);
      if (0 <= table[2]) this.setVolumeEnvelope(channel, note, scheduleTime);
    }
    if (0 <= table[3]) this.setModLfoToPitch(channel, note, scheduleTime);
    if (0 <= table[4]) this.setModLfoToFilterFc(channel, note, scheduleTime);
    if (0 <= table[5]) this.setModLfoToVolume(channel, note, scheduleTime);
  }

  handlePressureSysEx(data, tableName, scheduleTime) {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const table = channel[tableName];
    for (let i = 5; i < data.length - 1; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = rr;
    }
    this.processActiveNotes(channel, scheduleTime, (note) => {
      this.setEffects(channel, note, table, scheduleTime);
    });
  }

  initControlTable() {
    const ccCount = 128;
    const slotSize = 6;
    return new Int8Array(ccCount * slotSize).fill(-1);
  }

  setControlChangeEffects(channel, controllerType, scheduleTime) {
    const slotSize = 6;
    const offset = controllerType * slotSize;
    const table = channel.controlTable.subarray(offset, offset + slotSize);
    this.processScheduledNotes(channel, (note) => {
      this.setEffects(channel, note, table, scheduleTime);
    });
  }

  handleControlChangeSysEx(data) {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const controllerType = data[5];
    const table = channel.controlTable[controllerType];
    for (let i = 6; i < data.length - 1; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = rr;
    }
  }

  getKeyBasedValue(channel, keyNumber, controllerType) {
    const index = keyNumber * 128 + controllerType;
    const controlValue = channel.keyBasedInstrumentControlTable[index];
    return controlValue;
  }

  handleKeyBasedInstrumentControlSysEx(data, scheduleTime) {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (!channel.isDrum) return;
    const keyNumber = data[5];
    const table = channel.keyBasedInstrumentControlTable;
    for (let i = 6; i < data.length - 1; i += 2) {
      const controllerType = data[i];
      const value = data[i + 1];
      const index = keyNumber * 128 + controllerType;
      table[index] = value;
    }
    this.setChannelPressure(
      channelNumber,
      channel.state.channelPressure * 127,
      scheduleTime,
    );
  }

  handleSysEx(data, scheduleTime) {
    switch (data[0]) {
      case 126:
        return this.handleUniversalNonRealTimeExclusiveMessage(
          data,
          scheduleTime,
        );
      case 127:
        return this.handleUniversalRealTimeExclusiveMessage(data, scheduleTime);
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  // https://github.com/marmooo/js-timer-benchmark
  scheduleTask(callback, scheduleTime) {
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
