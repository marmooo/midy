import { parseMidi } from "midi-file";
import { parse, SoundFont } from "@marmooo/soundfont-parser";

// 2-3 times faster than Map
class SparseMap {
  constructor(size) {
    this.data = new Array(size);
    this.activeIndices = [];
  }

  set(key, value) {
    if (this.data[key] === undefined) {
      this.activeIndices.push(key);
    }
    this.data[key] = value;
  }

  get(key) {
    return this.data[key];
  }

  delete(key) {
    if (this.data[key] !== undefined) {
      this.data[key] = undefined;
      const index = this.activeIndices.indexOf(key);
      if (index !== -1) {
        this.activeIndices.splice(index, 1);
      }
      return true;
    }
    return false;
  }

  has(key) {
    return this.data[key] !== undefined;
  }

  get size() {
    return this.activeIndices.length;
  }

  clear() {
    for (let i = 0; i < this.activeIndices.length; i++) {
      const key = this.activeIndices[i];
      this.data[key] = undefined;
    }
    this.activeIndices = [];
  }

  *[Symbol.iterator]() {
    for (let i = 0; i < this.activeIndices.length; i++) {
      const key = this.activeIndices[i];
      yield [key, this.data[key]];
    }
  }

  forEach(callback) {
    for (let i = 0; i < this.activeIndices.length; i++) {
      const key = this.activeIndices[i];
      callback(this.data[key], key, this);
    }
  }
}

class Note {
  index = -1;
  noteOffEvent;
  bufferSource;
  filterNode;
  filterDepth;
  volumeEnvelopeNode;
  volumeDepth;
  volumeNode;
  gainL;
  gainR;
  modulationLFO;
  modulationDepth;
  vibratoLFO;
  vibratoDepth;
  reverbEffectsSend;
  chorusEffectsSend;
  portamentoNoteNumber = -1;
  pressure = 0;

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
  polyphonicKeyPressure: { type: 10, defaultValue: 0 },
  channelPressure: { type: 13, defaultValue: 0 },
  pitchWheel: { type: 14, defaultValue: 8192 / 16383 },
  pitchWheelSensitivity: { type: 16, defaultValue: 2 / 128 },
  link: { type: 127, defaultValue: 0 },
  // bankMSB: { type: 128 + 0, defaultValue: 121, },
  modulationDepth: { type: 128 + 1, defaultValue: 0 },
  portamentoTime: { type: 128 + 5, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volume: { type: 128 + 7, defaultValue: 100 / 127 },
  pan: { type: 128 + 10, defaultValue: 0.5 },
  expression: { type: 128 + 11, defaultValue: 1 },
  // bankLSB: { type: 128 + 32, defaultValue: 0, },
  // dataLSB: { type: 128 + 38, defaultValue: 0, },
  sustainPedal: { type: 128 + 64, defaultValue: 0 },
  portamento: { type: 128 + 65, defaultValue: 0 },
  sostenutoPedal: { type: 128 + 66, defaultValue: 0 },
  softPedal: { type: 128 + 67, defaultValue: 0 },
  filterResonance: { type: 128 + 71, defaultValue: 0.5 },
  releaseTime: { type: 128 + 72, defaultValue: 0.5 },
  attackTime: { type: 128 + 73, defaultValue: 0.5 },
  brightness: { type: 128 + 74, defaultValue: 0.5 },
  decayTime: { type: 128 + 75, defaultValue: 0.5 },
  vibratoRate: { type: 128 + 76, defaultValue: 0.5 },
  vibratoDepth: { type: 128 + 77, defaultValue: 0.5 },
  vibratoDelay: { type: 128 + 78, defaultValue: 0.5 },
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

const filterEnvelopeKeys = [
  "modEnvToPitch",
  "initialFilterFc",
  "modEnvToFilterFc",
  "modDelay",
  "modAttack",
  "modHold",
  "modDecay",
  "modSustain",
  "modRelease",
  "playbackRate",
];
const filterEnvelopeKeySet = new Set(filterEnvelopeKeys);
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

export class Midy {
  mode = "GM2";
  masterFineTuning = 0; // cb
  masterCoarseTuning = 0; // cb
  reverb = {
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
  audioBufferCounter = new Map();
  audioBufferCache = new Map();
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  timeline = [];
  instruments = [];
  notePromises = [];
  exclusiveClassNotes = new Array(128);
  drumExclusiveClassNotes = new Array(
    this.numChannels * drumExclusiveClassCount,
  );

  static channelSettings = {
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

  defaultOptions = {
    reverbAlgorithm: (audioContext) => {
      const { time: rt60, feedback } = this.reverb;

      // const delay = this.calcDelay(rt60, feedback);
      // const impulse = this.createConvolutionReverbImpulse(
      //   audioContext,
      //   rt60,
      //   delay,
      // );
      // return this.createConvolutionReverb(audioContext, impulse);

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
    },
  };

  constructor(audioContext, options = this.defaultOptions) {
    this.audioContext = audioContext;
    this.options = { ...this.defaultOptions, ...options };
    this.masterVolume = new GainNode(audioContext);
    this.scheduler = new GainNode(audioContext, { gain: 0 });
    this.schedulerBuffer = new AudioBuffer({
      length: 1,
      sampleRate: audioContext.sampleRate,
    });
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.reverbEffect = this.options.reverbAlgorithm(audioContext);
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
      table[i] = new SparseMap(128);
    }
    return table;
  }

  addSoundFont(soundFont) {
    const index = this.soundFonts.length;
    this.soundFonts.push(soundFont);
    const presetHeaders = soundFont.parsed.presetHeaders;
    for (let i = 0; i < presetHeaders.length; i++) {
      const presetHeader = presetHeaders[i];
      if (!presetHeader.presetName.startsWith("\u0000")) { // TODO: Only SF3 generated by PolyPone?
        const banks = this.soundFontTable[presetHeader.preset];
        banks.set(presetHeader.bank, index);
      }
    }
  }

  async loadSoundFont(soundFontUrl) {
    const response = await fetch(soundFontUrl);
    const arrayBuffer = await response.arrayBuffer();
    const parsed = parse(new Uint8Array(arrayBuffer));
    const soundFont = new SoundFont(parsed);
    this.addSoundFont(soundFont);
  }

  async loadMIDI(midiUrl) {
    const response = await fetch(midiUrl);
    const arrayBuffer = await response.arrayBuffer();
    const midi = parseMidi(new Uint8Array(arrayBuffer));
    this.ticksPerBeat = midi.header.ticksPerBeat;
    const midiData = this.extractMidiData(midi);
    this.instruments = midiData.instruments;
    this.timeline = midiData.timeline;
    this.totalTime = this.calcTotalTime();
  }

  setChannelAudioNodes(audioContext) {
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

  createChannels(audioContext) {
    const channels = Array.from({ length: this.numChannels }, () => {
      return {
        currentBufferSource: null,
        isDrum: false,
        ...this.constructor.channelSettings,
        state: new ControllerState(),
        controlTable: this.initControlTable(),
        ...this.setChannelAudioNodes(audioContext),
        scheduledNotes: [],
        sustainNotes: [],
        sostenutoNotes: [],
        scaleOctaveTuningTable: new Float32Array(12), // [-100, 100] cent
        channelPressureTable: new Uint8Array([64, 64, 64, 0, 0, 0]),
        polyphonicKeyPressureTable: new Uint8Array([64, 64, 64, 0, 0, 0]),
        keyBasedInstrumentControlTable: new Int8Array(128 * 128), // [-64, 63]
      };
    });
    return channels;
  }

  async createNoteBuffer(voiceParams, isSF3) {
    const sampleStart = voiceParams.start;
    const sampleEnd = voiceParams.sample.length + voiceParams.end;
    if (isSF3) {
      const sample = voiceParams.sample;
      const start = sample.byteOffset + sampleStart;
      const end = sample.byteOffset + sampleEnd;
      const buffer = sample.buffer.slice(start, end);
      const audioBuffer = await this.audioContext.decodeAudioData(buffer);
      return audioBuffer;
    } else {
      const sample = voiceParams.sample;
      const start = sample.byteOffset + sampleStart;
      const end = sample.byteOffset + sampleEnd;
      const buffer = sample.buffer.slice(start, end);
      const audioBuffer = new AudioBuffer({
        numberOfChannels: 1,
        length: sample.length,
        sampleRate: voiceParams.sampleRate,
      });
      const channelData = audioBuffer.getChannelData(0);
      const int16Array = new Int16Array(buffer);
      for (let i = 0; i < int16Array.length; i++) {
        channelData[i] = int16Array[i] / 32768;
      }
      return audioBuffer;
    }
  }

  createBufferSource(voiceParams, audioBuffer) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = voiceParams.sampleModes % 2 !== 0;
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
        case "noteOn": {
          const noteOffEvent = {
            ...event.noteOffEvent,
            startTime: event.noteOffEvent.startTime + delay,
          };
          await this.scheduleNoteOn(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
            noteOffEvent,
          );
          break;
        }
        case "noteAftertouch":
          this.handlePolyphonicKeyPressure(
            event.channel,
            event.noteNumber,
            event.amount,
            startTime,
          );
          break;
        case "controller":
          this.handleControlChange(
            event.channel,
            event.controllerType,
            event.value,
            startTime,
          );
          break;
        case "programChange":
          this.handleProgramChange(
            event.channel,
            event.programNumber,
            startTime,
          );
          break;
        case "channelAftertouch":
          this.handleChannelPressure(event.channel, event.amount, startTime);
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
          this.audioBufferCache.clear();
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
          resolve();
          this.isPausing = false;
          this.isPaused = true;
          return;
        } else if (this.isStopping) {
          await this.stopNotes(0, true, now);
          this.notePromises = [];
          this.exclusiveClassNotes.fill(undefined);
          this.drumExclusiveClassNotes.fill(undefined);
          this.audioBufferCache.clear();
          resolve();
          this.isStopping = false;
          this.isPaused = false;
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

  getAudioBufferId(programNumber, noteNumber, velocity) {
    return `${programNumber}:${noteNumber}:${velocity}`;
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
            const audioBufferId = this.getAudioBufferId(
              channel.programNumber,
              event.noteNumber,
              event.velocity,
            );
            this.audioBufferCounter.set(
              audioBufferId,
              (this.audioBufferCounter.get(audioBufferId) ?? 0) + 1,
            );
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
    for (const [audioBufferId, count] of this.audioBufferCounter) {
      if (count === 1) this.audioBufferCounter.delete(audioBufferId);
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
    const activeNotes = new Array(this.channels.length * 128);
    for (let i = 0; i < activeNotes.length; i++) {
      activeNotes[i] = [];
    }
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "noteOn": {
          const index = event.channel * 128 + event.noteNumber;
          activeNotes[index].push(event);
          break;
        }
        case "noteOff": {
          const index = event.channel * 128 + event.noteNumber;
          const noteOn = activeNotes[index].pop();
          if (noteOn) {
            noteOn.noteOffEvent = event;
          } else {
            const eventString = JSON.stringify(event, null, 2);
            console.warn(`noteOff without matching noteOn: ${eventString}`);
          }
        }
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
        undefined, // portamentoNoteNumber
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
        note,
        velocity,
        scheduleTime,
        force,
      );
      this.notePromises.push(promise);
      promises.push(promise);
    });
    channel.scheduledNotes = [];
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
    await this.playNotes();
    this.isPlaying = false;
  }

  stop() {
    if (!this.isPlaying) return;
    this.isStopping = true;
    for (let i = 0; i < this.channels.length; i++) {
      this.resetAllStates(i);
    }
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
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      callback(note);
    }
  }

  processActiveNotes(channel, scheduleTime, callback) {
    const scheduledNotes = channel.scheduledNotes;
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      const noteOffEvent = note.noteOffEvent;
      if (noteOffEvent && noteOffEvent.startTime < scheduleTime) continue;
      if (scheduleTime < note.startTime) continue;
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
    const pressureDepth = (channel.channelPressureTable[0] - 64) / 37.5; // 2400 / 64;
    const pressure = pressureDepth * channel.state.channelPressure;
    return tuning + pitch + pressure;
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
    const pitchControl = this.getPitchControl(channel, note);
    const detune = channel.detune + noteDetune + pitchControl;
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
    const state = channel.state;
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getAmplitudeControl(channel, note));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack * state.attackTime * 2;
    const volHold = volAttack + voiceParams.volHold;
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(sustainVolume, volHold);
  }

  setVolumeEnvelope(channel, note, scheduleTime) {
    const state = channel.state;
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getAmplitudeControl(channel, note));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack * state.attackTime * 2;
    const volHold = volAttack + voiceParams.volHold;
    const volDecay = volHold + voiceParams.volDecay * state.decayTime * 2;
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
    const state = channel.state;
    const { voiceParams, noteNumber, startTime } = note;
    const softPedalFactor = 1 -
      (0.1 + (noteNumber / 127) * 0.2) * state.softPedal;
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel, note);
    const baseFreq = this.centToHz(baseCent) * softPedalFactor *
      state.brightness * 2;
    const peekFreq = this.centToHz(
      voiceParams.initialFilterFc + voiceParams.modEnvToFilterFc,
    ) * softPedalFactor * state.brightness * 2;
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
    const state = channel.state;
    const { voiceParams, noteNumber, startTime } = note;
    const softPedalFactor = 1 -
      (0.1 + (noteNumber / 127) * 0.2) * state.softPedal;
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel, note);
    const baseFreq = this.centToHz(baseCent) * softPedalFactor *
      state.brightness * 2;
    const peekFreq = this.centToHz(baseCent + voiceParams.modEnvToFilterFc) *
      softPedalFactor * state.brightness * 2;
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
    this.setModLfoToVolume(channel, note, scheduleTime);

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
    programNumber,
    noteNumber,
    velocity,
    voiceParams,
    isSF3,
  ) {
    const audioBufferId = this.getAudioBufferId(
      programNumber,
      noteNumber,
      velocity,
    );
    const cache = this.audioBufferCache.get(audioBufferId);
    if (cache) {
      cache.counter += 1;
      if (cache.maxCount <= cache.counter) {
        this.audioBufferCache.delete(audioBufferId);
      }
      return cache.audioBuffer;
    } else {
      const maxCount = this.audioBufferCounter.get(audioBufferId) ?? 0;
      const audioBuffer = await this.createNoteBuffer(voiceParams, isSF3);
      const cache = { audioBuffer, maxCount, counter: 1 };
      this.audioBufferCache.set(audioBufferId, cache);
      return audioBuffer;
    }
  }

  async createNote(
    channel,
    voice,
    noteNumber,
    velocity,
    startTime,
    isSF3,
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
      channel.programNumber,
      noteNumber,
      velocity,
      voiceParams,
      isSF3,
    );
    note.bufferSource = this.createBufferSource(voiceParams, audioBuffer);
    note.volumeNode = new GainNode(this.audioContext);
    note.gainL = new GainNode(this.audioContext);
    note.gainR = new GainNode(this.audioContext);
    note.volumeEnvelopeNode = new GainNode(this.audioContext);
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 5 * state.filterResonance, // dB
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
    note.volumeEnvelopeNode.connect(note.volumeNode);
    note.volumeNode.connect(note.gainL);
    note.volumeNode.connect(note.gainR);

    if (0 < channel.chorusSendLevel) {
      this.setChorusEffectsSend(channel, note, 0, now);
    }
    if (0 < channel.reverbSendLevel) {
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
          prevNote,
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
        prevNote,
        0, // velocity,
        startTime,
        true, // force
      );
    }
    this.drumExclusiveClassNotes[index] = note;
  }

  isDrumNoteOffException(channel, noteNumber) {
    if (!channel.isDrum) return false;
    const programNumber = channel.programNumber;
    return !((programNumber === 48 && noteNumber === 88) ||
      (programNumber === 56 && 47 <= noteNumber && noteNumber <= 84));
  }

  async scheduleNoteOn(
    channelNumber,
    noteNumber,
    velocity,
    startTime,
    noteOffEvent,
  ) {
    const channel = this.channels[channelNumber];
    const bankNumber = this.calcBank(channel, channelNumber);
    const soundFontIndex = this.soundFontTable[channel.programNumber].get(
      bankNumber,
    );
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(
      bankNumber,
      channel.programNumber,
      noteNumber,
      velocity,
    );
    if (!voice) return;
    const isSF3 = soundFont.parsed.info.version.major === 3;
    const note = await this.createNote(
      channel,
      voice,
      noteNumber,
      velocity,
      startTime,
      isSF3,
    );
    note.noteOffEvent = noteOffEvent;
    note.gainL.connect(channel.gainL);
    note.gainR.connect(channel.gainR);
    if (0.5 <= channel.state.sustainPedal) {
      channel.sustainNotes.push(note);
    }
    this.handleExclusiveClass(note, channelNumber, startTime);
    this.handleDrumExclusiveClass(note, channelNumber, startTime);
    const scheduledNotes = channel.scheduledNotes;
    note.index = scheduledNotes.length;
    scheduledNotes.push(note);
    if (this.isDrumNoteOffException(channel, noteNumber)) {
      const stopTime = startTime + note.bufferSource.buffer.duration;
      const promise = new Promise((resolve) => {
        note.bufferSource.onended = () => {
          scheduledNotes[note.index] = undefined;
          this.disconnectNote(note);
          resolve();
        };
        note.bufferSource.stop(stopTime);
      });
      this.notePromises.push(promise);
    } else if (noteOffEvent) {
      if (0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber) {
        const portamentoTime = this.getPortamentoTime(channel, note);
        const portamentoEndTime = startTime + portamentoTime;
        const notePromise = this.scheduleNoteOff(
          channelNumber,
          note,
          0, // velocity
          Math.max(noteOffEvent.startTime, portamentoEndTime),
          false,
        );
        this.notePromises.push(notePromise);
      } else {
        const notePromise = this.scheduleNoteOff(
          channelNumber,
          note,
          noteOffEvent.velocity,
          noteOffEvent.startTime,
          false,
        );
        this.notePromises.push(notePromise);
      }
    }
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
    note.volumeNode.disconnect();
    note.gainL.disconnect();
    note.gainR.disconnect();
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

  stopNote(channel, note, endTime, stopTime) {
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(endTime)
      .linearRampToValueAtTime(0, stopTime);
    note.ending = true;
    this.scheduleTask(() => {
      note.bufferSource.loop = false;
    }, stopTime);
    return new Promise((resolve) => {
      note.bufferSource.onended = () => {
        channel.scheduledNotes[note.index] = undefined;
        this.disconnectNote(note);
        resolve();
      };
      note.bufferSource.stop(stopTime);
    });
  }

  scheduleNoteOff(
    channelNumber,
    note,
    _velocity,
    endTime,
    force,
  ) {
    const channel = this.channels[channelNumber];
    if (this.isDrumNoteOffException(channel, note.noteNumber)) return;
    const state = channel.state;
    if (!force) {
      if (0.5 <= state.sustainPedal) return;
      if (0.5 <= channel.state.sostenutoPedal) return;
    }
    const volRelease = endTime +
      note.voiceParams.volRelease * channel.state.releaseTime * 2;
    const modRelease = endTime + note.voiceParams.modRelease;
    note.filterNode.frequency
      .cancelScheduledValues(endTime)
      .linearRampToValueAtTime(0, modRelease);
    const stopTime = Math.min(volRelease, modRelease);
    return this.stopNote(channel, note, endTime, stopTime);
  }

  findNoteOffTarget(channel, noteNumber) {
    const scheduledNotes = channel.scheduledNotes;
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      if (note.noteNumber !== noteNumber) continue;
      return note;
    }
  }

  noteOff(channelNumber, noteNumber, velocity, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const note = this.findNoteOffTarget(channel, noteNumber);
    return this.scheduleNoteOff(
      channelNumber,
      note,
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
        channel.sustainNotes[i],
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
        note,
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
      case 0xA0:
        return this.handlePolyphonicKeyPressure(
          channelNumber,
          data1,
          data2,
          scheduleTime,
        );
      case 0xB0:
        return this.handleControlChange(
          channelNumber,
          data1,
          data2,
          scheduleTime,
        );
      case 0xC0:
        return this.handleProgramChange(channelNumber, data1, scheduleTime);
      case 0xD0:
        return this.handleChannelPressure(channelNumber, data1, scheduleTime);
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

  handlePolyphonicKeyPressure(
    channelNumber,
    noteNumber,
    pressure,
    scheduleTime,
  ) {
    const channel = this.channels[channelNumber];
    channel.state.polyphonicKeyPressure = pressure / 127;
    const table = channel.polyphonicKeyPressureTable;
    this.processActiveNotes(channel, scheduleTime, (note) => {
      if (note.noteNumber === noteNumber) {
        this.setControllerParameters(channel, note, table);
      }
    });
    this.applyVoiceParams(channel, 10);
  }

  handleProgramChange(channelNumber, programNumber, _scheduleTime) {
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

  handleChannelPressure(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const prev = channel.state.channelPressure;
    const next = value / 127;
    channel.state.channelPressure = next;
    if (channel.channelPressureTable[0] !== 64) {
      const pressureDepth = (channel.channelPressureTable[0] - 64) / 37.5; // 2400 / 64;
      channel.detune += pressureDepth * (next - prev);
    }
    const table = channel.channelPressureTable;
    this.processActiveNotes(channel, scheduleTime, (note) => {
      this.setControllerParameters(channel, note, table);
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
    const modLfoToPitch = note.voiceParams.modLfoToPitch +
      this.getLFOPitchDepth(channel, note);
    const baseDepth = Math.abs(modLfoToPitch) + channel.state.modulationDepth;
    const modulationDepth = baseDepth * Math.sign(modLfoToPitch);
    note.modulationDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modulationDepth, scheduleTime);
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
      this.getLFOFilterDepth(channel, note);
    note.filterDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modLfoToFilterFc, scheduleTime);
  }

  setModLfoToVolume(channel, note, scheduleTime) {
    const modLfoToVolume = note.voiceParams.modLfoToVolume;
    const baseDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepth = baseDepth * Math.sign(modLfoToVolume) *
      (1 + this.getLFOAmplitudeDepth(channel, note));
    note.volumeDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(volumeDepth, scheduleTime);
  }

  setReverbEffectsSend(channel, note, prevValue, scheduleTime) {
    if (0 < prevValue) {
      if (0 < note.voiceParams.reverbEffectsSend) {
        const keyBasedValue = this.getKeyBasedInstrumentControlValue(
          channel,
          note.noteNumber,
          91,
        );
        const value = note.voiceParams.reverbEffectsSend + keyBasedValue;
        note.reverbEffectsSend.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(value, scheduleTime);
      } else {
        note.reverbEffectsSend.disconnect();
      }
    } else {
      if (0 < note.voiceParams.reverbEffectsSend) {
        if (!note.reverbEffectsSend) {
          note.reverbEffectsSend = new GainNode(this.audioContext, {
            gain: note.voiceParams.reverbEffectsSend,
          });
          note.volumeNode.connect(note.reverbEffectsSend);
        }
        note.reverbEffectsSend.connect(this.reverbEffect.input);
      }
    }
  }

  setChorusEffectsSend(channel, note, prevValue, scheduleTime) {
    if (0 < prevValue) {
      if (0 < note.voiceParams.chorusEffectsSend) {
        const keyBasedValue = this.getKeyBasedInstrumentControlValue(
          channel,
          note.noteNumber,
          93,
        );
        const value = note.voiceParams.chorusEffectsSend + keyBasedValue;
        note.chorusEffectsSend.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(value, scheduleTime);
      } else {
        note.chorusEffectsSend.disconnect();
      }
    } else {
      if (0 < note.voiceParams.chorusEffectsSend) {
        if (!note.chorusEffectsSend) {
          note.chorusEffectsSend = new GainNode(this.audioContext, {
            gain: note.voiceParams.chorusEffectsSend,
          });
          note.volumeNode.connect(note.chorusEffectsSend);
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
    state[10] = state.polyphonicKeyPressure / 127;
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
      let appliedFilterEnvelope = false;
      let appliedVolumeEnvelope = false;
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
        } else if (filterEnvelopeKeySet.has(key)) {
          if (appliedFilterEnvelope) continue;
          appliedFilterEnvelope = true;
          const noteVoiceParams = note.voiceParams;
          for (let i = 0; i < filterEnvelopeKeys.length; i++) {
            const key = filterEnvelopeKeys[i];
            if (key in voiceParams) noteVoiceParams[key] = voiceParams[key];
          }
          if (
            0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber
          ) {
            this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
          } else {
            this.setFilterEnvelope(channel, note, scheduleTime);
          }
          this.setPitchEnvelope(note, scheduleTime);
        } else if (volumeEnvelopeKeySet.has(key)) {
          if (appliedVolumeEnvelope) continue;
          appliedVolumeEnvelope = true;
          const noteVoiceParams = note.voiceParams;
          for (let i = 0; i < volumeEnvelopeKeys.length; i++) {
            const key = volumeEnvelopeKeys[i];
            if (key in voiceParams) noteVoiceParams[key] = voiceParams[key];
          }
          this.setVolumeEnvelope(channel, note, scheduleTime);
        }
      }
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
    handlers[71] = this.setFilterResonance;
    handlers[72] = this.setReleaseTime;
    handlers[73] = this.setAttackTime;
    handlers[74] = this.setBrightness;
    handlers[75] = this.setDecayTime;
    handlers[76] = this.setVibratoRate;
    handlers[77] = this.setVibratoDepth;
    handlers[78] = this.setVibratoDelay;
    handlers[91] = this.setReverbSendLevel;
    handlers[93] = this.setChorusSendLevel;
    handlers[96] = this.dataIncrement;
    handlers[97] = this.dataDecrement;
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

  handleControlChange(channelNumber, controllerType, value, scheduleTime) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value, scheduleTime);
      const channel = this.channels[channelNumber];
      this.applyVoiceParams(channel, controllerType + 128, scheduleTime);
      this.applyControlTable(channel, controllerType);
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
        this.setPitchEnvelope(note, scheduleTime);
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

  setKeyBasedVolume(channel, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      const keyBasedValue = this.getKeyBasedInstrumentControlValue(
        channel,
        note.noteNumber,
        7,
      );
      if (keyBasedValue !== 0) {
        note.volumeNode.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(1 + keyBasedValue, scheduleTime);
      }
    });
  }

  setVolume(channelNumber, volume, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.volume = volume / 127;
    this.updateChannelVolume(channel, scheduleTime);
    this.setKeyBasedVolume(channel, scheduleTime);
  }

  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  setKeyBasedPan(channel, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      const keyBasedValue = this.getKeyBasedInstrumentControlValue(
        channel,
        note.noteNumber,
        10,
      );
      if (keyBasedValue !== 0) {
        const { gainLeft, gainRight } = this.panToGain((keyBasedValue + 1) / 2);
        note.gainL.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(gainLeft, scheduleTime);
        note.gainR.gain
          .cancelScheduledValues(scheduleTime)
          .setValueAtTime(gainRight, scheduleTime);
      }
    });
  }

  setPan(channelNumber, pan, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.pan = pan / 127;
    this.updateChannelVolume(channel, scheduleTime);
    this.setKeyBasedPan(channel, scheduleTime);
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

  setFilterResonance(channelNumber, filterResonance, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const state = channel.state;
    state.filterResonance = filterResonance / 127;
    this.processScheduledNotes(channel, (note) => {
      const Q = note.voiceParams.initialFilterQ / 5 * state.filterResonance;
      note.filterNode.Q.setValueAtTime(Q, scheduleTime);
    });
  }

  setReleaseTime(channelNumber, releaseTime, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.releaseTime = releaseTime / 127;
  }

  setAttackTime(channelNumber, attackTime, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.attackTime = attackTime / 127;
    this.processScheduledNotes(channel, (note) => {
      if (note.startTime < scheduleTime) return false;
      this.setVolumeEnvelope(channel, note);
    });
  }

  setBrightness(channelNumber, brightness, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const state = channel.state;
    scheduleTime ??= this.audioContext.currentTime;
    state.brightness = brightness / 127;
    this.processScheduledNotes(channel, (note) => {
      if (0.5 <= state.portamento && 0 <= note.portamentoNoteNumber) {
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
      } else {
        this.setFilterEnvelope(channel, note);
      }
    });
  }

  setDecayTime(channelNumber, dacayTime, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.decayTime = dacayTime / 127;
    this.processScheduledNotes(channel, (note) => {
      this.setVolumeEnvelope(channel, note, scheduleTime);
    });
  }

  setVibratoRate(channelNumber, vibratoRate, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.vibratoRate = vibratoRate / 127;
    if (channel.vibratoDepth <= 0) return;
    this.processScheduledNotes(channel, (note) => {
      this.setVibLfoToPitch(channel, note, scheduleTime);
    });
  }

  setVibratoDepth(channelNumber, vibratoDepth, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const prev = channel.state.vibratoDepth;
    channel.state.vibratoDepth = vibratoDepth / 127;
    if (0 < prev) {
      this.processScheduledNotes(channel, (note) => {
        this.setFreqVibLFO(channel, note, scheduleTime);
      });
    } else {
      this.processScheduledNotes(channel, (note) => {
        this.startVibrato(channel, note, scheduleTime);
      });
    }
  }

  setVibratoDelay(channelNumber, vibratoDelay) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel.state.vibratoDelay = vibratoDelay / 127;
    if (0 < channel.state.vibratoDepth) {
      this.processScheduledNotes(channel, (note) => {
        this.startVibrato(channel, note, scheduleTime);
      });
    }
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
          note.reverbEffectsSend.disconnect();
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
          note.chorusEffectsSend.disconnect();
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

  handleRPN(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    const rpn = channel.rpnMSB * 128 + channel.rpnLSB;
    switch (rpn) {
      case 0:
        channel.dataLSB += value;
        this.handlePitchBendRangeRPN(channelNumber, scheduleTime);
        break;
      case 1:
        channel.dataLSB += value;
        this.handleFineTuningRPN(channelNumber, scheduleTime);
        break;
      case 2:
        channel.dataMSB += value;
        this.handleCoarseTuningRPN(channelNumber, scheduleTime);
        break;
      case 5:
        channel.dataLSB += value;
        this.handleModulationDepthRangeRPN(channelNumber, scheduleTime);
        break;
      default:
        console.warn(
          `Channel ${channelNumber}: Unsupported RPN MSB=${channel.rpnMSB} LSB=${channel.rpnLSB}`,
        );
    }
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp18.pdf
  dataIncrement(channelNumber) {
    this.handleRPN(channelNumber, 1);
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp18.pdf
  dataDecrement(channelNumber) {
    this.handleRPN(channelNumber, -1);
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
    const channel = this.channels[channelNumber];
    const state = channel.state;
    for (const type of Object.keys(defaultControllerState)) {
      state[type] = defaultControllerState[type].defaultValue;
    }
    for (const type of Object.keys(this.constructor.channelSettings)) {
      channel[type] = this.constructor.channelSettings[type];
    }
    this.mode = "GM2";
    this.masterFineTuning = 0; // cb
    this.masterCoarseTuning = 0; // cb
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
  resetAllControllers(channelNumber) {
    const stateTypes = [
      "polyphonicKeyPressure",
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
    for (let i = 0; i < stateTypes.length; i++) {
      const type = stateTypes[i];
      state[type] = defaultControllerState[type].defaultValue;
    }
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
          case 9:
            // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca21.pdf
            return this.handleScaleOctaveTuning2ByteFormatSysEx(
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
      case 8:
        switch (data[3]) {
          case 8: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca21.pdf
            return this.handleScaleOctaveTuning1ByteFormatSysEx(
              data,
              true,
              scheduleTime,
            );
          case 9:
            // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca21.pdf
            return this.handleScaleOctaveTuning2ByteFormatSysEx(
              data,
              true,
              scheduleTime,
            );
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          case 1: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca22.pdf
            return this.handlePressureSysEx(data, "channelPressureTable");
          case 2: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca22.pdf
            return this.handlePressureSysEx(data, "polyphonicKeyPressureTable");
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
    const { audioContext, options } = this;
    this.reverbEffect = options.reverbAlgorithm(audioContext);
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
    const { audioContext, options } = this;
    this.reverbEffect = options.reverbAlgorithm(audioContext);
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

  handleScaleOctaveTuning2ByteFormatSysEx(data, realtime, scheduleTime) {
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

  getPitchControl(channel, note) {
    const polyphonicKeyPressure = (channel.polyphonicKeyPressureTable[0] - 64) *
      note.pressure;
    return polyphonicKeyPressure * note.pressure / 37.5; // 2400 / 64;
  }

  getFilterCutoffControl(channel, note) {
    const channelPressure = (channel.channelPressureTable[1] - 64) *
      channel.state.channelPressure;
    const polyphonicKeyPressure = (channel.polyphonicKeyPressureTable[1] - 64) *
      note.pressure;
    return (channelPressure + polyphonicKeyPressure) * 15;
  }

  getAmplitudeControl(channel, note) {
    const channelPressure = channel.channelPressureTable[2] *
      channel.state.channelPressure;
    const polyphonicKeyPressure = channel.polyphonicKeyPressureTable[2] *
      note.pressure;
    return (channelPressure + polyphonicKeyPressure) / 128;
  }

  getLFOPitchDepth(channel, note) {
    const channelPressure = channel.channelPressureTable[3] *
      channel.state.channelPressure;
    const polyphonicKeyPressure = channel.polyphonicKeyPressureTable[3] *
      note.pressure;
    return (channelPressure + polyphonicKeyPressure) / 254 * 600;
  }

  getLFOFilterDepth(channel, note) {
    const channelPressure = channel.channelPressureTable[4] *
      channel.state.channelPressure;
    const polyphonicKeyPressure = channel.polyphonicKeyPressureTable[4] *
      note.pressure;
    return (channelPressure + polyphonicKeyPressure) / 254 * 2400;
  }

  getLFOAmplitudeDepth(channel, note) {
    const channelPressure = channel.channelPressureTable[5] *
      channel.state.channelPressure;
    const polyphonicKeyPressure = channel.polyphonicKeyPressureTable[5] *
      note.pressure;
    return (channelPressure + polyphonicKeyPressure) / 254;
  }

  setControllerParameters(channel, note, table) {
    if (table[0] !== 64) this.updateDetune(channel, note);
    if (0.5 <= channel.state.portamemento && 0 <= note.portamentoNoteNumber) {
      if (table[1] !== 64) this.setPortamentoFilterEnvelope(channel, note);
      if (table[2] !== 64) this.setPortamentoVolumeEnvelope(channel, note);
    } else {
      if (table[1] !== 64) this.setFilterEnvelope(channel, note);
      if (table[2] !== 64) this.setVolumeEnvelope(channel, note);
    }
    if (table[3] !== 0) this.setModLfoToPitch(channel, note);
    if (table[4] !== 0) this.setModLfoToFilterFc(channel, note);
    if (table[5] !== 0) this.setModLfoToVolume(channel, note);
  }

  handlePressureSysEx(data, tableName) {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const table = channel[tableName];
    for (let i = 5; i < data.length - 1; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = rr;
    }
  }

  initControlTable() {
    const channelCount = 128;
    const slotSize = 6;
    const defaultValues = [64, 64, 64, 0, 0, 0];
    const table = new Uint8Array(channelCount * slotSize);
    for (let ch = 0; ch < channelCount; ch++) {
      const offset = ch * slotSize;
      table.set(defaultValues, offset);
    }
    return table;
  }

  applyControlTable(channel, controllerType) {
    const slotSize = 6;
    const offset = controllerType * slotSize;
    const table = channel.controlTable.subarray(offset, offset + slotSize);
    this.processScheduledNotes(channel, (note) => {
      this.setControllerParameters(channel, note, table);
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

  getKeyBasedInstrumentControlValue(channel, keyNumber, controllerType) {
    const index = keyNumber * 128 + controllerType;
    const controlValue = channel.keyBasedInstrumentControlTable[index];
    return (controlValue + 64) / 64;
  }

  handleKeyBasedInstrumentControlSysEx(data, scheduleTime) {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const keyNumber = data[5];
    const table = channel.keyBasedInstrumentControlTable;
    for (let i = 6; i < data.length - 1; i += 2) {
      const controllerType = data[i];
      const value = data[i + 1];
      const index = keyNumber * 128 + controllerType;
      table[index] = value - 64;
    }
    this.handleChannelPressure(
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
