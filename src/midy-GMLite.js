import { parseMidi } from "midi-file";
import { parse, SoundFont } from "@marmooo/soundfont-parser";

class Note {
  voice;
  voiceParams;
  index = -1;
  ending = false;
  bufferSource;
  filterNode;
  filterDepth;
  volumeEnvelopeNode;
  volumeDepth;
  modulationLFO;
  modulationDepth;

  constructor(noteNumber, velocity, startTime) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
}

const drumExclusiveClasses = new Uint8Array(128);
drumExclusiveClasses[42] = 1;
drumExclusiveClasses[44] = 1;
drumExclusiveClasses[46] = 1, // HH
  drumExclusiveClasses[71] = 2;
drumExclusiveClasses[72] = 2; // Whistle
drumExclusiveClasses[73] = 3;
drumExclusiveClasses[74] = 3; // Guiro
drumExclusiveClasses[78] = 4;
drumExclusiveClasses[79] = 4; // Cuica
drumExclusiveClasses[80] = 5;
drumExclusiveClasses[81] = 5; // Triangle
const drumExclusiveClassCount = 5;

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

export class MidyGMLite extends EventTarget {
  mode = "GM1";
  numChannels = 16;
  ticksPerBeat = 120;
  totalTime = 0;
  noteCheckInterval = 0.1;
  lookAhead = 1;
  startDelay = 0.1;
  startTime = 0;
  resumeTime = 0;
  soundFonts = [];
  soundFontTable = Array.from({ length: 128 }, () => []);
  voiceCounter = new Map();
  voiceCache = new Map();
  realtimeVoiceCache = new Map();
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  loop = false;
  playPromise;
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
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    modulationDepthRange: 50, // cent
  };

  constructor(audioContext) {
    super();
    this.audioContext = audioContext;
    this.masterVolume = new GainNode(audioContext);
    this.scheduler = new GainNode(audioContext, { gain: 0 });
    this.schedulerBuffer = new AudioBuffer({
      length: 1,
      sampleRate: audioContext.sampleRate,
    });
    this.messageHandlers = this.createMessageHandlers();
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.masterVolume.connect(audioContext.destination);
    this.scheduler.connect(audioContext.destination);
    this.GM1SystemOn();
  }

  addSoundFont(soundFont) {
    const index = this.soundFonts.length;
    this.soundFonts.push(soundFont);
    const presetHeaders = soundFont.parsed.presetHeaders;
    const soundFontTable = this.soundFontTable;
    for (let i = 0; i < presetHeaders.length; i++) {
      const { preset, bank } = presetHeaders[i];
      soundFontTable[preset][bank] = index;
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
    this.GM1SystemOn();
  }

  getVoiceId(channel, noteNumber, velocity) {
    const programNumber = channel.programNumber;
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return;
    const bank = channel.isDrum ? 128 : 0;
    const soundFontIndex = bankTable[bank];
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(bank, programNumber, noteNumber, velocity);
    const { instrument, sampleID } = voice.generators;
    return soundFontIndex * (2 ** 32) + (instrument << 16) + sampleID;
  }

  createChannelAudioNodes(audioContext) {
    const { gainLeft, gainRight } = this.panToGain(
      defaultControllerState.panMSB.defaultValue,
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
        state: new ControllerState(),
        ...this.constructor.channelSettings,
        ...this.createChannelAudioNodes(audioContext),
        scheduledNotes: [],
        sustainNotes: [],
      };
    });
    return channels;
  }

  async createAudioBuffer(voiceParams) {
    const { sample, start, end } = voiceParams;
    const sampleEnd = sample.data.length + end;
    const audioBuffer = await sample.toAudioBuffer(
      this.audioContext,
      start,
      sampleEnd,
    );
    return audioBuffer;
  }

  createBufferSource(channel, voiceParams, audioBuffer) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = voiceParams.sampleModes % 2 !== 0;
    if (channel.isDrum) bufferSource.loop = false;
    if (bufferSource.loop) {
      bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
      bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
    }
    return bufferSource;
  }

  async scheduleTimelineEvents(scheduleTime, queueIndex) {
    const timeOffset = this.resumeTime - this.startTime;
    const lookAheadCheckTime = scheduleTime + timeOffset + this.lookAhead;
    const schedulingOffset = this.startDelay - timeOffset;
    const timeline = this.timeline;
    while (queueIndex < timeline.length) {
      const event = timeline[queueIndex];
      if (lookAheadCheckTime < event.startTime) break;
      const startTime = event.startTime + schedulingOffset;
      switch (event.type) {
        case "noteOn":
          await this.noteOn(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
          );
          break;
        case "noteOff": {
          this.noteOff(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
            false, // force
          );
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

  resetAllStates() {
    this.exclusiveClassNotes.fill(undefined);
    this.drumExclusiveClassNotes.fill(undefined);
    this.voiceCache.clear();
    this.realtimeVoiceCache.clear();
    for (let i = 0; i < this.channels.length; i++) {
      this.channels[i].scheduledNotes = [];
      this.resetChannelStates(i);
    }
  }

  updateStates(queueIndex, nextQueueIndex) {
    const now = this.audioContext.currentTime;
    if (nextQueueIndex < queueIndex) queueIndex = 0;
    for (let i = queueIndex; i < nextQueueIndex; i++) {
      const event = this.timeline[i];
      switch (event.type) {
        case "controller":
          this.setControlChange(
            event.channel,
            event.controllerType,
            event.value,
            now - this.resumeTime + event.startTime,
          );
          break;
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            now - this.resumeTime + event.startTime,
          );
          break;
        case "pitchBend":
          this.setPitchBend(
            event.channel,
            event.value + 8192,
            now - this.resumeTime + event.startTime,
          );
          break;
        case "sysEx":
          this.handleSysEx(event.data, now - this.resumeTime + event.startTime);
      }
    }
  }

  async playNotes() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    const paused = this.isPaused;
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = this.audioContext.currentTime;
    if (paused) {
      this.dispatchEvent(new Event("resumed"));
    } else {
      this.dispatchEvent(new Event("started"));
    }
    let queueIndex = this.getQueueIndex(this.resumeTime);
    let exitReason;
    this.notePromises = [];
    while (true) {
      const now = this.audioContext.currentTime;
      if (this.timeline.length <= queueIndex) {
        await this.stopNotes(0, true, now);
        if (this.loop) {
          this.notePromises = [];
          this.resetAllStates();
          this.startTime = this.audioContext.currentTime;
          this.resumeTime = 0;
          queueIndex = 0;
          this.dispatchEvent(new Event("looped"));
          continue;
        } else {
          await this.audioContext.suspend();
          exitReason = "ended";
          break;
        }
      }
      if (this.isPausing) {
        await this.stopNotes(0, true, now);
        await this.audioContext.suspend();
        this.notePromises = [];
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        await this.stopNotes(0, true, now);
        await this.audioContext.suspend();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.stopNotes(0, true, now);
        this.startTime = this.audioContext.currentTime;
        const nextQueueIndex = this.getQueueIndex(this.resumeTime);
        this.updateStates(queueIndex, nextQueueIndex);
        queueIndex = nextQueueIndex;
        this.isSeeking = false;
        this.dispatchEvent(new Event("seeked"));
        continue;
      }
      queueIndex = await this.scheduleTimelineEvents(now, queueIndex);
      const waitTime = now + this.noteCheckInterval;
      await this.scheduleTask(() => {}, waitTime);
    }
    if (exitReason !== "paused") {
      this.notePromises = [];
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

  ticksToSecond(ticks, secondsPerBeat) {
    return ticks * secondsPerBeat / this.ticksPerBeat;
  }

  secondToTicks(second, secondsPerBeat) {
    return second * this.ticksPerBeat / secondsPerBeat;
  }

  getSoundFontId(channel) {
    const programNumber = channel.programNumber;
    const bank = channel.isDrum ? "128" : "000";
    const program = programNumber.toString().padStart(3, "0");
    return `${bank}:${program}`;
  }

  extractMidiData(midi) {
    const instruments = new Set();
    const timeline = [];
    const channels = this.channels;
    for (let i = 0; i < midi.tracks.length; i++) {
      const track = midi.tracks[i];
      let currentTicks = 0;
      for (let j = 0; j < track.length; j++) {
        const event = track[j];
        currentTicks += event.deltaTime;
        event.ticks = currentTicks;
        switch (event.type) {
          case "noteOn": {
            const channel = channels[event.channel];
            instruments.add(this.getSoundFontId(channel));
            break;
          }
          case "programChange": {
            const channel = channels[event.channel];
            this.setProgramChange(event.channel, event.programNumber);
            instruments.add(this.getSoundFontId(channel));
            break;
          }
        }
        delete event.deltaTime;
        timeline.push(event);
      }
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

  stopActiveNotes(channelNumber, velocity, force, scheduleTime) {
    const channel = this.channels[channelNumber];
    const promises = [];
    this.processActiveNotes(channel, scheduleTime, (note) => {
      const promise = this.noteOff(
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
      const promise = this.noteOff(
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
    this.playPromise = this.playNotes();
    await this.playPromise;
  }

  async stop() {
    if (!this.isPlaying) return;
    this.isStopping = true;
    await this.playPromise;
  }

  async pause() {
    if (!this.isPlaying || this.isPaused) return;
    const now = this.audioContext.currentTime;
    this.resumeTime = now + this.resumeTime - this.startTime;
    this.isPausing = true;
    await this.playPromise;
  }

  async resume() {
    if (!this.isPaused) return;
    this.playPromise = this.playNotes();
    await this.playPromise;
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
    return totalTime + this.startDelay;
  }

  currentTime() {
    if (!this.isPlaying) return this.resumeTime;
    const now = this.audioContext.currentTime;
    return now + this.resumeTime - this.startTime;
  }

  async processScheduledNotes(channel, callback) {
    const scheduledNotes = channel.scheduledNotes;
    const tasks = [];
    for (let i = channel.scheduleIndex; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      const task = note.ready.then(() => callback(note));
      tasks.push(task);
    }
    await Promise.all(tasks);
  }

  async processActiveNotes(channel, scheduleTime, callback) {
    const scheduledNotes = channel.scheduledNotes;
    const tasks = [];
    for (let i = channel.scheduleIndex; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      if (scheduleTime < note.startTime) break;
      const task = note.ready.then(() => callback(note));
      tasks.push(task);
    }
    await Promise.all(tasks);
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
    this.processScheduledNotes(channel, (note) => {
      this.updateDetune(channel, note, scheduleTime);
    });
  }

  updateDetune(channel, note, scheduleTime) {
    note.bufferSource.detune
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(channel.detune, scheduleTime);
  }

  setVolumeEnvelope(note, scheduleTime) {
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation);
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

  setFilterEnvelope(note, scheduleTime) {
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

  async getAudioBuffer(
    channel,
    noteNumber,
    velocity,
    voiceParams,
    realtime,
  ) {
    const audioBufferId = this.getVoiceId(
      channel,
      noteNumber,
      velocity,
    );
    if (realtime) {
      const cachedAudioBuffer = this.realtimeVoiceCache.get(audioBufferId);
      if (cachedAudioBuffer) return cachedAudioBuffer;
      const audioBuffer = await this.createAudioBuffer(voiceParams);
      this.realtimeVoiceCache.set(audioBufferId, audioBuffer);
      return audioBuffer;
    } else {
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
  }

  async setNoteAudioNode(channel, note, realtime) {
    const now = this.audioContext.currentTime;
    const { noteNumber, velocity, startTime } = note;
    const state = channel.state;
    const controllerState = this.getControllerState(
      channel,
      noteNumber,
      velocity,
    );
    const voiceParams = note.voice.getAllParams(controllerState);
    note.voiceParams = voiceParams;
    const audioBuffer = await this.getAudioBuffer(
      channel,
      noteNumber,
      velocity,
      voiceParams,
      realtime,
    );
    note.bufferSource = this.createBufferSource(
      channel,
      voiceParams,
      audioBuffer,
    );
    note.volumeEnvelopeNode = new GainNode(this.audioContext);
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10, // dB
    });
    this.setVolumeEnvelope(note, now);
    this.setFilterEnvelope(note, now);
    this.setPitchEnvelope(note, now);
    this.updateDetune(channel, note, now);
    if (0 < state.modulationDepthMSB) {
      this.startModulation(channel, note, now);
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.volumeEnvelopeNode);
    if (voiceParams.sample.type === "compressed") {
      const offset = voiceParams.start / audioBuffer.sampleRate;
      note.bufferSource.start(startTime, offset);
    } else {
      note.bufferSource.start(startTime);
    }
    return note;
  }

  handleExclusiveClass(note, channelNumber, startTime) {
    const exclusiveClass = note.voiceParams.exclusiveClass;
    if (exclusiveClass === 0) return;
    const prev = this.exclusiveClassNotes[exclusiveClass];
    if (prev) {
      const [prevNote, prevChannelNumber] = prev;
      if (prevNote && !prevNote.ending) {
        this.noteOff(
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
    const drumExclusiveClass = drumExclusiveClasses[note.noteNumber];
    if (drumExclusiveClass === 0) return;
    const index = drumExclusiveClass * this.channels.length + channelNumber;
    const prevNote = this.drumExclusiveClassNotes[index];
    if (prevNote && !prevNote.ending) {
      this.noteOff(
        channelNumber,
        prevNote.noteNumber,
        0, // velocity,
        startTime,
        true, // force
      );
    }
    this.drumExclusiveClassNotes[index] = note;
  }

  setNoteRouting(channelNumber, note, startTime) {
    const channel = this.channels[channelNumber];
    const volumeEnvelopeNode = note.volumeEnvelopeNode;
    volumeEnvelopeNode.connect(channel.gainL);
    volumeEnvelopeNode.connect(channel.gainR);
    if (0.5 <= channel.state.sustainPedal) {
      channel.sustainNotes.push(note);
    }
    this.handleExclusiveClass(note, channelNumber, startTime);
    this.handleDrumExclusiveClass(note, channelNumber, startTime);
  }

  async noteOn(channelNumber, noteNumber, velocity, startTime) {
    const channel = this.channels[channelNumber];
    const realtime = startTime === undefined;
    if (realtime) startTime = this.audioContext.currentTime;
    const note = new Note(noteNumber, velocity, startTime);
    const scheduledNotes = channel.scheduledNotes;
    note.index = scheduledNotes.length;
    scheduledNotes.push(note);
    const programNumber = channel.programNumber;
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return;
    const bank = channel.isDrum ? 128 : 0;
    const soundFontIndex = bankTable[bank];
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    note.voice = soundFont.getVoice(bank, programNumber, noteNumber, velocity);
    if (!note.voice) return;
    await this.setNoteAudioNode(channel, note, realtime);
    this.setNoteRouting(channelNumber, note, startTime);
    note.resolveReady();
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
  }

  releaseNote(channel, note, endTime) {
    endTime ??= this.audioContext.currentTime;
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

  async noteOff(
    channelNumber,
    noteNumber,
    _velocity,
    endTime,
    force,
  ) {
    const channel = this.channels[channelNumber];
    if (!force) {
      if (channel.isDrum) return;
      if (0.5 <= channel.state.sustainPedal) return;
    }
    const index = this.findNoteOffIndex(channel, noteNumber);
    if (index < 0) return;
    const note = channel.scheduledNotes[index];
    note.ending = true;
    this.setNoteIndex(channel, index);
    const promise = note.ready.then(() => {
      return this.releaseNote(channel, note, endTime);
    });
    this.notePromises.push(promise);
    return promise;
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

  releaseSustainPedal(channelNumber, halfVelocity, scheduleTime) {
    const velocity = halfVelocity * 2;
    const channel = this.channels[channelNumber];
    const promises = [];
    for (let i = 0; i < channel.sustainNotes.length; i++) {
      const promise = this.noteOff(
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

  createMessageHandlers() {
    const handlers = new Array(256);
    // Channel Message
    handlers[0x80] = (data, scheduleTime) =>
      this.noteOff(data[0] & 0x0F, data[1], data[2], scheduleTime);
    handlers[0x90] = (data, scheduleTime) =>
      this.noteOn(data[0] & 0x0F, data[1], data[2], scheduleTime);
    handlers[0xB0] = (data, scheduleTime) =>
      this.setControlChange(data[0] & 0x0F, data[1], data[2], scheduleTime);
    handlers[0xC0] = (data, scheduleTime) =>
      this.setProgramChange(data[0] & 0x0F, data[1], scheduleTime);
    handlers[0xE0] = (data, scheduleTime) =>
      this.handlePitchBendMessage(
        data[0] & 0x0F,
        data[1],
        data[2],
        scheduleTime,
      );
    return handlers;
  }

  handleMessage(data, scheduleTime) {
    const status = data[0];
    if (status === 0xF0) {
      return this.handleSysEx(data.subarray(1), scheduleTime);
    }
    const handler = this.messageHandlers[status];
    if (handler) handler(data, scheduleTime);
  }

  handleChannelMessage(statusByte, data1, data2, scheduleTime) {
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
    channel.programNumber = programNumber;
  }

  handlePitchBendMessage(channelNumber, lsb, msb, scheduleTime) {
    const pitchBend = msb * 128 + lsb;
    this.setPitchBend(channelNumber, pitchBend, scheduleTime);
  }

  setPitchBend(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
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
      const modLfoToPitch = note.voiceParams.modLfoToPitch;
      const baseDepth = Math.abs(modLfoToPitch) +
        channel.state.modulationDepthMSB;
      const depth = baseDepth * Math.sign(modLfoToPitch);
      note.modulationDepth.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(depth, scheduleTime);
    } else {
      this.startModulation(channel, note, scheduleTime);
    }
  }

  setModLfoToFilterFc(note, scheduleTime) {
    const modLfoToFilterFc = note.voiceParams.modLfoToFilterFc;
    note.filterDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modLfoToFilterFc, scheduleTime);
  }

  setModLfoToVolume(note, scheduleTime) {
    const modLfoToVolume = note.voiceParams.modLfoToVolume;
    const baseDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepth = baseDepth * Math.sign(modLfoToVolume);
    note.volumeDepth.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(volumeDepth, scheduleTime);
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

  createVoiceParamsHandlers() {
    return {
      modLfoToPitch: (channel, note, scheduleTime) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setModLfoToPitch(channel, note, scheduleTime);
        }
      },
      vibLfoToPitch: (_channel, _note, _scheduleTime) => {},
      modLfoToFilterFc: (channel, note, scheduleTime) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setModLfoToFilterFc(note, scheduleTime);
        }
      },
      modLfoToVolume: (channel, note, scheduleTime) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setModLfoToVolume(note, scheduleTime);
        }
      },
      chorusEffectsSend: (_channel, _note, _scheduleTime) => {},
      reverbEffectsSend: (_channel, _note, _scheduleTime) => {},
      delayModLFO: (_channel, note, scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setDelayModLFO(note, scheduleTime);
        }
      },
      freqModLFO: (_channel, note, scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setFreqModLFO(note, scheduleTime);
        }
      },
      delayVibLFO: (_channel, _note, _scheduleTime) => {},
      freqVibLFO: (_channel, _note, _scheduleTime) => {},
    };
  }

  getControllerState(channel, noteNumber, velocity) {
    const state = new Float32Array(channel.state.array.length);
    state.set(channel.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
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
          this.voiceParamsHandlers[key](channel, note, scheduleTime);
        } else {
          if (volumeEnvelopeKeySet.has(key)) applyVolumeEnvelope = true;
          if (filterEnvelopeKeySet.has(key)) applyFilterEnvelope = true;
          if (pitchEnvelopeKeySet.has(key)) applyPitchEnvelope = true;
        }
      }
      if (applyVolumeEnvelope) this.setVolumeEnvelope(note, scheduleTime);
      if (applyFilterEnvelope) this.setFilterEnvelope(note, scheduleTime);
      if (applyPitchEnvelope) this.setPitchEnvelope(note, scheduleTime);
    });
  }

  createControlChangeHandlers() {
    const handlers = new Array(128);
    handlers[1] = this.setModulationDepth;
    handlers[6] = this.dataEntryMSB;
    handlers[7] = this.setVolume;
    handlers[10] = this.setPan;
    handlers[11] = this.setExpression;
    handlers[38] = this.dataEntryLSB;
    handlers[64] = this.setSustainPedal;
    handlers[100] = this.setRPNLSB;
    handlers[101] = this.setRPNMSB;
    handlers[120] = this.allSoundOff;
    handlers[121] = this.resetAllControllers;
    handlers[123] = this.allNotesOff;
    return handlers;
  }

  setControlChange(channelNumber, controllerType, value, scheduleTime) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value, scheduleTime);
      const channel = this.channels[channelNumber];
      this.applyVoiceParams(channel, controllerType + 128, scheduleTime);
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`,
      );
    }
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
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.modulationDepth = modulation / 127;
    this.updateModulation(channel, scheduleTime);
  }

  setVolume(channelNumber, volume, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
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
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.pan = pan / 127;
    this.updateChannelVolume(channel, scheduleTime);
  }

  setExpression(channelNumber, expression, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
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
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(volume * gainLeft, scheduleTime);
    channel.gainR.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(volume * gainRight, scheduleTime);
  }

  setSustainPedal(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.sustainPedal = value / 127;
    if (64 <= value) {
      this.processScheduledNotes(channel, (note) => {
        channel.sustainNotes.push(note);
      });
    } else {
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
    this.limitData(channel, 0, 127, 0, 127);
    const pitchBendRange = (channel.dataMSB + channel.dataLSB / 128) * 100;
    this.setPitchBendRange(channelNumber, pitchBendRange, scheduleTime);
  }

  setPitchBendRange(channelNumber, value, scheduleTime) { // [0-12800] cent
    const channel = this.channels[channelNumber];
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const state = channel.state;
    const prev = state.pitchWheelSensitivity;
    const next = value / 12800;
    state.pitchWheelSensitivity = next;
    channel.detune += (state.pitchWheel * 2 - 1) * (next - prev) * 12800;
    this.updateChannelDetune(channel, scheduleTime);
    this.applyVoiceParams(channel, 16, scheduleTime);
  }

  allSoundOff(channelNumber, _value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    return this.stopActiveNotes(channelNumber, 0, true, scheduleTime);
  }

  resetChannelStates(channelNumber) {
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
    this.mode = "GM1";
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
  resetAllControllers(channelNumber, _value, scheduleTime) {
    const keys = [
      "pitchWheel",
      "expressionMSB",
      "modulationDepthMSB",
      "sustainPedal",
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
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    return this.stopActiveNotes(channelNumber, 0, false, scheduleTime);
  }

  handleUniversalNonRealTimeExclusiveMessage(data, scheduleTime) {
    switch (data[2]) {
      case 9:
        switch (data[3]) {
          case 1:
            this.GM1SystemOn(scheduleTime);
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

  GM1SystemOn(scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.mode = "GM1";
    for (let i = 0; i < this.channels.length; i++) {
      this.allSoundOff(i, 0, scheduleTime);
      const channel = this.channels[i];
      channel.isDrum = false;
    }
    this.channels[9].isDrum = true;
  }

  handleUniversalRealTimeExclusiveMessage(data, scheduleTime) {
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

  handleMasterVolumeSysEx(data, scheduleTime) {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.setMasterVolume(volume, scheduleTime);
  }

  setMasterVolume(value, scheduleTime) { // [0-1]
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.masterVolume.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(value * value, scheduleTime);
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
