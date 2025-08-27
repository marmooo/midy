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
  bufferSource;
  filterNode;
  filterDepth;
  volumeEnvelopeNode;
  volumeDepth;
  modulationLFO;
  modulationDepth;

  constructor(noteNumber, velocity, startTime, voice, voiceParams) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.voice = voice;
    this.voiceParams = voiceParams;
  }
}

// normalized to 0-1 for use with the SF2 modulator model
const defaultControllerState = {
  noteOnVelocity: { type: 2, defaultValue: 0 },
  noteOnKeyNumber: { type: 3, defaultValue: 0 },
  pitchWheel: { type: 14, defaultValue: 8192 / 16383 },
  pitchWheelSensitivity: { type: 16, defaultValue: 2 / 128 },
  link: { type: 127, defaultValue: 0 },
  // bankMSB: { type: 128 + 0, defaultValue: 121, },
  modulationDepth: { type: 128 + 1, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volume: { type: 128 + 7, defaultValue: 100 / 127 },
  pan: { type: 128 + 10, defaultValue: 0.5 },
  expression: { type: 128 + 11, defaultValue: 1 },
  // bankLSB: { type: 128 + 32, defaultValue: 0, },
  // dataLSB: { type: 128 + 38, defaultValue: 0, },
  sustainPedal: { type: 128 + 64, defaultValue: 0 },
  // rpnLSB: { type: 128 + 100, defaultValue: 127 },
  // rpnMSB: { type: 128 + 101, defaultValue: 127 },
  // allSoundOff: { type: 128 + 120, defaultValue: 0 },
  // resetAllControllers: { type: 128 + 121, defaultValue: 0 },
  // allNotesOff: { type: 128 + 123, defaultValue: 0 },
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

export class MidyGMLite {
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
  exclusiveClassMap = new SparseMap(128);

  static channelSettings = {
    currentBufferSource: null,
    detune: 0,
    program: 0,
    bank: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
  };

  constructor(audioContext) {
    this.audioContext = audioContext;
    this.masterVolume = new GainNode(audioContext);
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.masterVolume.connect(audioContext.destination);
    this.GM1SystemOn();
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
    const channels = Array.from({ length: 16 }, () => {
      return {
        ...this.constructor.channelSettings,
        state: new ControllerState(),
        ...this.setChannelAudioNodes(audioContext),
        scheduledNotes: new SparseMap(128),
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

  createNoteBufferNode(audioBuffer, voiceParams) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = voiceParams.sampleModes % 2 !== 0;
    if (bufferSource.loop) {
      bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
      bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
    }
    return bufferSource;
  }

  async scheduleTimelineEvents(t, offset, queueIndex) {
    while (queueIndex < this.timeline.length) {
      const event = this.timeline[queueIndex];
      if (event.startTime > t + this.lookAhead) break;
      const startTime = event.startTime + this.startDelay - offset;
      switch (event.type) {
        case "noteOn":
          if (event.velocity !== 0) {
            await this.scheduleNoteOn(
              event.channel,
              event.noteNumber,
              event.velocity,
              startTime,
            );
            break;
          }
          /* falls through */
        case "noteOff": {
          const notePromise = this.scheduleNoteOff(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
          );
          if (notePromise) {
            this.notePromises.push(notePromise);
          }
          break;
        }
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
      let offset = this.resumeTime - this.startTime;
      this.notePromises = [];
      const schedulePlayback = async () => {
        if (queueIndex >= this.timeline.length) {
          await Promise.all(this.notePromises);
          this.notePromises = [];
          this.exclusiveClassMap.clear();
          this.audioBufferCache.clear();
          resolve();
          return;
        }
        const now = this.audioContext.currentTime;
        const t = now + offset;
        queueIndex = await this.scheduleTimelineEvents(t, offset, queueIndex);
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
          this.exclusiveClassMap.clear();
          this.audioBufferCache.clear();
          resolve();
          this.isStopping = false;
          this.isPaused = false;
          return;
        } else if (this.isSeeking) {
          this.stopNotes(0, true, now);
          this.exclusiveClassMap.clear();
          this.startTime = this.audioContext.currentTime;
          queueIndex = this.getQueueIndex(this.resumeTime);
          offset = this.resumeTime - this.startTime;
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
    const tmpChannels = new Array(16);
    for (let i = 0; i < tmpChannels.length; i++) {
      tmpChannels[i] = {
        programNumber: -1,
        bank: this.channels[i].bank,
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
              instruments.add(`${channel.bank}:0`);
              channel.programNumber = 0;
            }
            break;
          }
          case "programChange": {
            const channel = tmpChannels[event.channel];
            channel.programNumber = event.programNumber;
            instruments.add(`${channel.bankNumber}:${channel.programNumber}`);
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
    };
    timeline.sort((a, b) => {
      if (a.ticks !== b.ticks) return a.ticks - b.ticks;
      return (priority[a.type] || 2) - (priority[b.type] || 2);
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

  stopChannelNotes(channelNumber, velocity, force, scheduleTime) {
    const channel = this.channels[channelNumber];
    const promises = [];
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const promise = this.scheduleNoteOff(
          channelNumber,
          note.noteNumber,
          velocity,
          scheduleTime,
          force,
        );
        this.notePromises.push(promise);
        promises.push(promise);
      }
    });
    channel.scheduledNotes.clear();
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

  processScheduledNotes(channel, scheduleTime, callback) {
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        if (scheduleTime < note.startTime) continue;
        callback(note);
      }
    });
  }

  getActiveNotes(channel, scheduleTime) {
    const activeNotes = new SparseMap(128);
    channel.scheduledNotes.forEach((noteList) => {
      const activeNote = this.getActiveNote(noteList, scheduleTime);
      if (activeNote) {
        activeNotes.set(activeNote.noteNumber, activeNote);
      }
    });
    return activeNotes;
  }

  getActiveNote(noteList, scheduleTime) {
    for (let i = noteList.length - 1; i >= 0; i--) {
      const note = noteList[i];
      if (!note) return;
      if (scheduleTime < note.startTime) continue;
      return (note.ending) ? null : note;
    }
    return noteList[0];
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
    const pitchWheel = channel.state.pitchWheel * 2 - 1;
    const pitchWheelSensitivity = channel.state.pitchWheelSensitivity * 12800;
    return pitchWheel * pitchWheelSensitivity;
  }

  updateChannelDetune(channel, scheduleTime) {
    this.processScheduledNotes(channel, scheduleTime, (note) => {
      this.updateDetune(channel, note, scheduleTime);
    });
  }

  updateDetune(channel, note, scheduleTime) {
    note.bufferSource.detune
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(channel.detune, scheduleTime);
  }

  setVolumeEnvelope(note) {
    const now = this.audioContext.currentTime;
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const volDecay = volHold + voiceParams.volDecay;
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(now)
      .setValueAtTime(0, startTime)
      .setValueAtTime(1e-6, volDelay) // exponentialRampToValueAtTime() requires a non-zero value
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .linearRampToValueAtTime(sustainVolume, volDecay);
  }

  setPitchEnvelope(note, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
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

  setFilterEnvelope(note) {
    const now = this.audioContext.currentTime;
    const { voiceParams, startTime } = note;
    const baseFreq = this.centToHz(voiceParams.initialFilterFc);
    const peekFreq = this.centToHz(
      voiceParams.initialFilterFc + voiceParams.modEnvToFilterFc,
    );
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
      .cancelScheduledValues(now)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .exponentialRampToValueAtTime(adjustedPeekFreq, modAttack)
      .setValueAtTime(adjustedPeekFreq, modHold)
      .linearRampToValueAtTime(adjustedSustainFreq, modDecay);
  }

  startModulation(channel, note, startTime) {
    const { voiceParams } = note;
    note.modulationLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO),
    });
    note.filterDepth = new GainNode(this.audioContext, {
      gain: voiceParams.modLfoToFilterFc,
    });
    note.modulationDepth = new GainNode(this.audioContext);
    this.setModLfoToPitch(channel, note);
    note.volumeDepth = new GainNode(this.audioContext);
    this.setModLfoToVolume(note);

    note.modulationLFO.start(startTime + voiceParams.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
    note.filterDepth.connect(note.filterNode.frequency);
    note.modulationLFO.connect(note.modulationDepth);
    note.modulationDepth.connect(note.bufferSource.detune);
    note.modulationLFO.connect(note.volumeDepth);
    note.volumeDepth.connect(note.volumeEnvelopeNode.gain);
  }

  async getAudioBuffer(program, noteNumber, velocity, voiceParams, isSF3) {
    const audioBufferId = this.getAudioBufferId(program, noteNumber, velocity);
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
    const state = channel.state;
    const controllerState = this.getControllerState(
      channel,
      noteNumber,
      velocity,
    );
    const voiceParams = voice.getAllParams(controllerState);
    const note = new Note(noteNumber, velocity, startTime, voice, voiceParams);
    const audioBuffer = await this.getAudioBuffer(
      channel.program,
      noteNumber,
      velocity,
      voiceParams,
      isSF3,
    );
    note.bufferSource = this.createNoteBufferNode(audioBuffer, voiceParams);
    note.volumeEnvelopeNode = new GainNode(this.audioContext);
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10, // dB
    });
    this.setVolumeEnvelope(note);
    this.setFilterEnvelope(note);
    this.setPitchEnvelope(note);
    if (0 < state.modulationDepth) {
      this.startModulation(channel, note, startTime);
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.volumeEnvelopeNode);
    note.bufferSource.start(startTime);
    return note;
  }

  async scheduleNoteOn(channelNumber, noteNumber, velocity, startTime) {
    const channel = this.channels[channelNumber];
    const bankNumber = channel.bank;
    const soundFontIndex = this.soundFontTable[channel.program].get(bankNumber);
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(
      bankNumber,
      channel.program,
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
    note.volumeEnvelopeNode.connect(channel.gainL);
    note.volumeEnvelopeNode.connect(channel.gainR);
    const exclusiveClass = note.voiceParams.exclusiveClass;
    if (exclusiveClass !== 0) {
      if (this.exclusiveClassMap.has(exclusiveClass)) {
        const prevEntry = this.exclusiveClassMap.get(exclusiveClass);
        const [prevNote, prevChannelNumber] = prevEntry;
        if (!prevNote.ending) {
          this.scheduleNoteOff(
            prevChannelNumber,
            prevNote.noteNumber,
            0, // velocity,
            startTime,
            undefined, // portamentoNoteNumber
            true, // force
          );
        }
      }
      this.exclusiveClassMap.set(exclusiveClass, [note, channelNumber]);
    }
    const scheduledNotes = channel.scheduledNotes;
    if (scheduledNotes.has(noteNumber)) {
      scheduledNotes.get(noteNumber).push(note);
    } else {
      scheduledNotes.set(noteNumber, [note]);
    }
  }

  noteOn(channelNumber, noteNumber, velocity) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.scheduleNoteOn(
      channelNumber,
      noteNumber,
      velocity,
      scheduleTime,
    );
  }

  stopNote(endTime, stopTime, scheduledNotes, index) {
    const note = scheduledNotes[index];
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(endTime)
      .linearRampToValueAtTime(0, stopTime);
    note.ending = true;
    this.scheduleTask(() => {
      note.bufferSource.loop = false;
    }, stopTime);
    return new Promise((resolve) => {
      note.bufferSource.onended = () => {
        scheduledNotes[index] = null;
        note.bufferSource.disconnect();
        note.filterNode.disconnect();
        note.volumeEnvelopeNode.disconnect();
        if (note.modulationDepth) {
          note.volumeDepth.disconnect();
          note.modulationDepth.disconnect();
          note.modulationLFO.stop();
        }
        resolve();
      };
      note.bufferSource.stop(stopTime);
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
    if (!force && 0.5 < channel.state.sustainPedal) return;
    if (!channel.scheduledNotes.has(noteNumber)) return;
    const scheduledNotes = channel.scheduledNotes.get(noteNumber);
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      const volRelease = endTime + note.voiceParams.volRelease;
      const modRelease = endTime + note.voiceParams.modRelease;
      note.filterNode.frequency
        .cancelScheduledValues(endTime)
        .linearRampToValueAtTime(0, modRelease);
      const stopTime = Math.min(volRelease, modRelease);
      return this.stopNote(endTime, stopTime, scheduledNotes, i);
    }
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
    this.processScheduledNotes(channel, scheduleTime, (note) => {
      const { noteNumber } = note;
      const promise = this.noteOff(channelNumber, noteNumber, velocity);
      promises.push(promise);
    });
    return promises;
  }

  handleMIDIMessage(statusByte, data1, data2, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channelNumber = statusByte & 0x0F;
    const messageType = statusByte & 0xF0;
    switch (messageType) {
      case 0x80:
        return this.noteOff(channelNumber, data1, data2, scheduleTime);
      case 0x90:
        return this.noteOn(channelNumber, data1, data2, scheduleTime);
      case 0xB0:
        return this.handleControlChange(
          channelNumber,
          data1,
          data2,
          scheduleTime,
        );
      case 0xC0:
        return this.handleProgramChange(channelNumber, data1, scheduleTime);
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

  handleProgramChange(channelNumber, program, _scheduleTime) {
    const channel = this.channels[channelNumber];
    channel.program = program;
  }

  handlePitchBendMessage(channelNumber, lsb, msb, scheduleTime) {
    const pitchBend = msb * 128 + lsb;
    this.setPitchBend(channelNumber, pitchBend, scheduleTime);
  }

  setPitchBend(channelNumber, value, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const prev = state.pitchWheel * 2 - 1;
    const next = (value - 8192) / 8192;
    state.pitchWheel = value / 16383;
    channel.detune += (next - prev) * state.pitchWheelSensitivity * 12800;
    this.updateChannelDetune(channel, scheduleTime);
    this.applyVoiceParams(channel, 14, scheduleTime);
  }

  setModLfoToPitch(channel, note) {
    const now = this.audioContext.currentTime;
    const modLfoToPitch = note.voiceParams.modLfoToPitch;
    const baseDepth = Math.abs(modLfoToPitch) +
      channel.state.modulationDepth;
    const modulationDepth = baseDepth * Math.sign(modLfoToPitch);
    note.modulationDepth.gain
      .cancelScheduledValues(now)
      .setValueAtTime(modulationDepth, now);
  }

  setModLfoToFilterFc(note) {
    const now = this.audioContext.currentTime;
    const modLfoToFilterFc = note.voiceParams.modLfoToFilterFc;
    note.filterDepth.gain
      .cancelScheduledValues(now)
      .setValueAtTime(modLfoToFilterFc, now);
  }

  setModLfoToVolume(note) {
    const now = this.audioContext.currentTime;
    const modLfoToVolume = note.voiceParams.modLfoToVolume;
    const baseDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepth = baseDepth * Math.sign(modLfoToVolume);
    note.volumeDepth.gain
      .cancelScheduledValues(now)
      .setValueAtTime(volumeDepth, now);
  }

  setDelayModLFO(note) {
    const now = this.audioContext.currentTime;
    const startTime = note.startTime;
    if (startTime < now) return;
    note.modulationLFO.stop(now);
    note.modulationLFO.start(startTime + note.voiceParams.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
  }

  setFreqModLFO(note) {
    const now = this.audioContext.currentTime;
    const freqModLFO = note.voiceParams.freqModLFO;
    note.modulationLFO.frequency
      .cancelScheduledValues(now)
      .setValueAtTime(freqModLFO, now);
  }

  createVoiceParamsHandlers() {
    return {
      modLfoToPitch: (channel, note, _prevValue) => {
        if (0 < channel.state.modulationDepth) {
          this.setModLfoToPitch(channel, note);
        }
      },
      vibLfoToPitch: (_channel, _note, _prevValue) => {},
      modLfoToFilterFc: (channel, note, _prevValue) => {
        if (0 < channel.state.modulationDepth) this.setModLfoToFilterFc(note);
      },
      modLfoToVolume: (channel, note, _prevValue) => {
        if (0 < channel.state.modulationDepth) this.setModLfoToVolume(note);
      },
      chorusEffectsSend: (_channel, _note, _prevValue) => {},
      reverbEffectsSend: (_channel, _note, _prevValue) => {},
      delayModLFO: (_channel, note, _prevValue) => this.setDelayModLFO(note),
      freqModLFO: (_channel, note, _prevValue) => this.setFreqModLFO(note),
      delayVibLFO: (_channel, _note, _prevValue) => {},
      freqVibLFO: (_channel, _note, _prevValue) => {},
    };
  }

  getControllerState(channel, noteNumber, velocity) {
    const state = new Float32Array(channel.state.array.length);
    state.set(channel.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    return state;
  }

  applyVoiceParams(channel, controllerType) {
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const controllerState = this.getControllerState(
          channel,
          note.noteNumber,
          note.velocity,
        );
        const voiceParams = note.voice.getParams(
          controllerType,
          controllerState,
        );
        let appliedFilterEnvelope = false;
        let appliedVolumeEnvelope = false;
        for (const [key, value] of Object.entries(voiceParams)) {
          const prevValue = note.voiceParams[key];
          if (value === prevValue) continue;
          note.voiceParams[key] = value;
          if (key in this.voiceParamsHandlers) {
            this.voiceParamsHandlers[key](channel, note, prevValue);
          } else if (filterEnvelopeKeySet.has(key)) {
            if (appliedFilterEnvelope) continue;
            appliedFilterEnvelope = true;
            const noteVoiceParams = note.voiceParams;
            for (let i = 0; i < filterEnvelopeKeys.length; i++) {
              const key = filterEnvelopeKeys[i];
              if (key in voiceParams) noteVoiceParams[key] = voiceParams[key];
            }
            this.setFilterEnvelope(note);
            this.setPitchEnvelope(note);
          } else if (volumeEnvelopeKeySet.has(key)) {
            if (appliedVolumeEnvelope) continue;
            appliedVolumeEnvelope = true;
            const noteVoiceParams = note.voiceParams;
            for (let i = 0; i < volumeEnvelopeKeys.length; i++) {
              const key = volumeEnvelopeKeys[i];
              if (key in voiceParams) noteVoiceParams[key] = voiceParams[key];
            }
            this.setVolumeEnvelope(channel, note);
          }
        }
      }
    });
  }

  createControlChangeHandlers() {
    return {
      1: this.setModulationDepth,
      6: this.dataEntryMSB,
      7: this.setVolume,
      10: this.setPan,
      11: this.setExpression,
      38: this.dataEntryLSB,
      64: this.setSustainPedal,
      100: this.setRPNLSB,
      101: this.setRPNMSB,
      120: this.allSoundOff,
      121: this.resetAllControllers,
      123: this.allNotesOff,
    };
  }

  handleControlChange(channelNumber, controllerType, value, scheduleTime) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value, scheduleTime);
      const channel = this.channels[channelNumber];
      this.applyVoiceParams(channel, controllerType + 128);
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`,
      );
    }
  }

  updateModulation(channel, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const depth = channel.state.modulationDepth * channel.modulationDepthRange;
    this.processScheduledNotes(channel, scheduleTime, (note) => {
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
    channel.state.modulationDepth = modulation / 127;
    this.updateModulation(channel, scheduleTime);
  }

  setVolume(channelNumber, volume, scheduleTime) {
    const channel = this.channels[channelNumber];
    channel.state.volume = volume / 127;
    this.updateChannelVolume(channel, scheduleTime);
  }

  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  setPan(channelNumber, pan, scheduleTime) {
    const channel = this.channels[channelNumber];
    channel.state.pan = pan / 127;
    this.updateChannelVolume(channel, scheduleTime);
  }

  setExpression(channelNumber, expression, scheduleTime) {
    const channel = this.channels[channelNumber];
    channel.state.expression = expression / 127;
    this.updateChannelVolume(channel, scheduleTime);
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
      .cancelScheduledValues(now)
      .setValueAtTime(volume * gainLeft, scheduleTime);
    channel.gainR.gain
      .cancelScheduledValues(now)
      .setValueAtTime(volume * gainRight, scheduleTime);
  }

  setSustainPedal(channelNumber, value, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.channels[channelNumber].state.sustainPedal = value / 127;
    if (value < 64) {
      this.releaseSustainPedal(channelNumber, value, scheduleTime);
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

  handleRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    const rpn = channel.rpnMSB * 128 + channel.rpnLSB;
    switch (rpn) {
      case 0:
        this.handlePitchBendRangeRPN(channelNumber, scheduleTime);
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
    scheduleTime ??= this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const prev = state.pitchWheelSensitivity;
    const next = value / 128;
    state.pitchWheelSensitivity = next;
    channel.detune += (state.pitchWheel * 2 - 1) * (next - prev) * 12800;
    this.updateChannelDetune(channel, scheduleTime);
    this.applyVoiceParams(channel, 16);
  }

  allSoundOff(channelNumber, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.stopChannelNotes(channelNumber, 0, true, scheduleTime);
  }

  resetAllControllers(channelNumber) {
    const stateTypes = [
      "expression",
      "modulationDepth",
      "sustainPedal",
      "pitchWheelSensitivity",
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

  allNotesOff(channelNumber, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.stopChannelNotes(channelNumber, 0, false, scheduleTime);
  }

  handleUniversalNonRealTimeExclusiveMessage(data) {
    switch (data[2]) {
      case 9:
        switch (data[3]) {
          case 1:
            this.GM1SystemOn();
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

  GM1SystemOn() {
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      channel.bank = 0;
    }
    this.channels[9].bank = 128;
  }

  handleUniversalRealTimeExclusiveMessage(data) {
    switch (data[2]) {
      case 4:
        switch (data[3]) {
          case 1:
            return this.handleMasterVolumeSysEx(data);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }

  handleMasterVolumeSysEx(data) {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.setMasterVolume(volume);
  }

  setMasterVolume(volume) {
    if (volume < 0 && 1 < volume) {
      console.error("Master Volume is out of range");
    } else {
      const now = this.audioContext.currentTime;
      this.masterVolume.gain.cancelScheduledValues(now);
      this.masterVolume.gain.setValueAtTime(volume * volume, now);
    }
  }

  handleExclusiveMessage(data) {
    console.warn(`Unsupported Exclusive Message: ${data}`);
  }

  handleSysEx(data) {
    switch (data[0]) {
      case 126:
        return this.handleUniversalNonRealTimeExclusiveMessage(data);
      case 127:
        return this.handleUniversalRealTimeExclusiveMessage(data);
      default:
        return this.handleExclusiveMessage(data);
    }
  }

  scheduleTask(callback, startTime) {
    return new Promise((resolve) => {
      const bufferSource = new AudioBufferSourceNode(this.audioContext);
      bufferSource.onended = () => {
        callback();
        resolve();
      };
      bufferSource.start(startTime);
      bufferSource.stop(startTime);
    });
  }
}
