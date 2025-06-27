import { parseMidi } from "midi-file";
import { parse, SoundFont } from "@marmooo/soundfont-parser";

class Note {
  bufferSource;
  filterNode;
  volumeNode;
  volumeDepth;
  modulationLFO;
  modulationDepth;
  vibratoLFO;
  vibratoDepth;
  reverbEffectsSend;
  chorusEffectsSend;

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
  polyPressure: { type: 10, defaultValue: 0 },
  channelPressure: { type: 13, defaultValue: 0 },
  pitchWheel: { type: 14, defaultValue: 0 },
  pitchWheelSensitivity: { type: 16, defaultValue: 2 },
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
  dataIncrement: { type: 128 + 96, defaultValue: 0 },
  dataDecrement: { type: 128 + 97, defaultValue: 0 },
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

export class MidyGM2 {
  ticksPerBeat = 120;
  totalTime = 0;
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
  mono = false; // CC#124, CC#125
  omni = false; // CC#126, CC#127
  noteCheckInterval = 0.1;
  lookAhead = 1;
  startDelay = 0.1;
  startTime = 0;
  resumeTime = 0;
  soundFonts = [];
  soundFontTable = this.initSoundFontTable();
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  timeline = [];
  instruments = [];
  notePromises = [];
  exclusiveClassMap = new Map();

  static channelSettings = {
    currentBufferSource: null,
    program: 0,
    bank: 121 * 128,
    bankMSB: 121,
    bankLSB: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    fineTuning: 0, // cb
    coarseTuning: 0, // cb
    modulationDepthRange: 50, // cent
  };

  static controllerDestinationSettings = {
    pitchControl: 0,
    filterCutoffControl: 0,
    amplitudeControl: 1,
    lfoPitchDepth: 0,
    lfoFilterDepth: 0,
    lfoAmplitudeDepth: 0,
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
    this.masterGain = new GainNode(audioContext);
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.reverbEffect = this.options.reverbAlgorithm(audioContext);
    this.chorusEffect = this.createChorusEffect(audioContext);
    this.chorusEffect.output.connect(this.masterGain);
    this.reverbEffect.output.connect(this.masterGain);
    this.masterGain.connect(audioContext.destination);
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
    merger.connect(this.masterGain);
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
        scheduledNotes: new Map(),
        sostenutoNotes: new Map(),
        channelPressure: {
          ...this.constructor.controllerDestinationSettings,
        },
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

  async createNoteBufferNode(voiceParams, isSF3) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    const audioBuffer = await this.createNoteBuffer(voiceParams, isSF3);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = voiceParams.sampleModes % 2 !== 0;
    if (bufferSource.loop) {
      bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
      bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
    }
    return bufferSource;
  }

  findPortamentoTarget(queueIndex) {
    const endEvent = this.timeline[queueIndex];
    if (!this.channels[endEvent.channel].portamento) return;
    const endTime = endEvent.startTime;
    let target;
    while (++queueIndex < this.timeline.length) {
      const event = this.timeline[queueIndex];
      if (endTime !== event.startTime) break;
      if (event.type !== "noteOn") continue;
      if (!target || event.noteNumber < target.noteNumber) {
        target = event;
      }
    }
    return target;
  }

  async scheduleTimelineEvents(t, offset, queueIndex) {
    while (queueIndex < this.timeline.length) {
      const event = this.timeline[queueIndex];
      if (event.startTime > t + this.lookAhead) break;
      switch (event.type) {
        case "noteOn":
          if (event.velocity !== 0) {
            await this.scheduleNoteOn(
              event.channel,
              event.noteNumber,
              event.velocity,
              event.startTime + this.startDelay - offset,
              event.portamento,
            );
            break;
          }
          /* falls through */
        case "noteOff": {
          const portamentoTarget = this.findPortamentoTarget(queueIndex);
          if (portamentoTarget) portamentoTarget.portamento = true;
          const notePromise = this.scheduleNoteRelease(
            this.omni ? 0 : event.channel,
            event.noteNumber,
            event.velocity,
            event.startTime + this.startDelay - offset,
            portamentoTarget?.noteNumber,
            false, // force
          );
          if (notePromise) {
            this.notePromises.push(notePromise);
          }
          break;
        }
        case "controller":
          this.handleControlChange(
            this.omni ? 0 : event.channel,
            event.controllerType,
            event.value,
          );
          break;
        case "programChange":
          this.handleProgramChange(event.channel, event.programNumber);
          break;
        case "channelAftertouch":
          this.handleChannelPressure(event.channel, event.amount);
          break;
        case "pitchBend":
          this.setPitchBend(event.channel, event.value);
          break;
        case "sysEx":
          this.handleSysEx(event.data);
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
          resolve();
          return;
        }
        const t = this.audioContext.currentTime + offset;
        queueIndex = await this.scheduleTimelineEvents(t, offset, queueIndex);
        if (this.isPausing) {
          await this.stopNotes(0, true);
          this.notePromises = [];
          resolve();
          this.isPausing = false;
          this.isPaused = true;
          return;
        } else if (this.isStopping) {
          await this.stopNotes(0, true);
          this.exclusiveClassMap.clear();
          this.notePromises = [];
          resolve();
          this.isStopping = false;
          this.isPaused = false;
          return;
        } else if (this.isSeeking) {
          this.stopNotes(0, true);
          this.exclusiveClassMap.clear();
          this.startTime = this.audioContext.currentTime;
          queueIndex = this.getQueueIndex(this.resumeTime);
          offset = this.resumeTime - this.startTime;
          this.isSeeking = false;
          await schedulePlayback();
        } else {
          const now = this.audioContext.currentTime;
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
    const tmpChannels = new Array(16);
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

  async stopChannelNotes(channelNumber, velocity, force) {
    const now = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const promise = this.scheduleNoteRelease(
          channelNumber,
          note.noteNumber,
          velocity,
          now,
          undefined, // portamentoNoteNumber
          force,
        );
        this.notePromises.push(promise);
      }
    });
    channel.scheduledNotes.clear();
    await Promise.all(this.notePromises);
  }

  stopNotes(velocity, force) {
    for (let i = 0; i < this.channels.length; i++) {
      this.stopChannelNotes(i, velocity, force);
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

  getActiveNotes(channel, time) {
    const activeNotes = new Map();
    channel.scheduledNotes.forEach((noteList) => {
      const activeNote = this.getActiveNote(noteList, time);
      if (activeNote) {
        activeNotes.set(activeNote.noteNumber, activeNote);
      }
    });
    return activeNotes;
  }

  getActiveNote(noteList, time) {
    for (let i = noteList.length - 1; i >= 0; i--) {
      const note = noteList[i];
      if (!note) return;
      if (time < note.startTime) continue;
      return (note.ending) ? null : note;
    }
    return noteList[0];
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

  centToHz(cent) {
    return 8.176 * Math.pow(2, cent / 1200);
  }

  calcSemitoneOffset(channel) {
    const masterTuning = this.masterCoarseTuning + this.masterFineTuning;
    const channelTuning = channel.coarseTuning + channel.fineTuning;
    const tuning = masterTuning + channelTuning;
    const state = channel.state;
    return state.pitchWheel * state.pitchWheelSensitivity + tuning;
  }

  setPortamentoStartVolumeEnvelope(channel, note) {
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const portamentoTime = volDelay + channel.state.portamentoTime;
    note.volumeNode.gain
      .cancelScheduledValues(startTime)
      .setValueAtTime(0, volDelay)
      .linearRampToValueAtTime(sustainVolume, portamentoTime);
  }

  setVolumeEnvelope(note) {
    const { voiceParams, startTime } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const volDecay = volHold + voiceParams.volDecay;
    note.volumeNode.gain
      .cancelScheduledValues(startTime)
      .setValueAtTime(0, startTime)
      .setValueAtTime(1e-6, volDelay) // exponentialRampToValueAtTime() requires a non-zero value
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .linearRampToValueAtTime(sustainVolume, volDecay);
  }

  setPlaybackRate(note) {
    const now = this.audioContext.currentTime;
    note.bufferSource.playbackRate
      .cancelScheduledValues(now)
      .setValueAtTime(note.voiceParams.playbackRate, now);
  }

  setPitch(channel, note) {
    const now = this.audioContext.currentTime;
    const { startTime } = note;
    const basePitch = this.calcSemitoneOffset(channel) * 100;
    note.bufferSource.detune
      .cancelScheduledValues(now)
      .setValueAtTime(basePitch, startTime);
    const modEnvToPitch = note.voiceParams.modEnvToPitch;
    if (modEnvToPitch === 0) return;
    const peekPitch = basePitch + modEnvToPitch;
    const modDelay = startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const modDecay = modHold + voiceParams.modDecay;
    note.bufferSource.detune
      .setValueAtTime(basePitch, modDelay)
      .exponentialRampToValueAtTime(peekPitch, modAttack)
      .setValueAtTime(peekPitch, modHold)
      .linearRampToValueAtTime(basePitch, modDecay);
  }

  clampCutoffFrequency(frequency) {
    const minFrequency = 20; // min Hz of initialFilterFc
    const maxFrequency = 20000; // max Hz of initialFilterFc
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
  }

  setPortamentoStartFilterEnvelope(channel, note) {
    const state = channel.state;
    const { voiceParams, noteNumber, startTime } = note;
    const softPedalFactor = 1 -
      (0.1 + (noteNumber / 127) * 0.2) * state.softPedal;
    const baseFreq = this.centToHz(voiceParams.initialFilterFc) *
      softPedalFactor;
    const peekFreq = this.centToHz(
      voiceParams.initialFilterFc + voiceParams.modEnvToFilterFc,
    ) * softPedalFactor;
    const sustainFreq = baseFreq +
      (peekFreq - baseFreq) * (1 - voiceParams.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const portamentoTime = startTime + channel.state.portamentoTime;
    const modDelay = startTime + voiceParams.modDelay;
    note.filterNode.frequency
      .cancelScheduledValues(startTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .linearRampToValueAtTime(adjustedSustainFreq, portamentoTime);
  }

  setFilterEnvelope(channel, note) {
    const state = channel.state;
    const { voiceParams, noteNumber, startTime } = note;
    const softPedalFactor = 1 -
      (0.1 + (noteNumber / 127) * 0.2) * state.softPedal;
    const baseFreq = this.centToHz(voiceParams.initialFilterFc) *
      softPedalFactor;
    const peekFreq = this.centToHz(
      voiceParams.initialFilterFc + voiceParams.modEnvToFilterFc,
    ) * softPedalFactor;
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
      .cancelScheduledValues(startTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .exponentialRampToValueAtTime(adjustedPeekFreq, modAttack)
      .setValueAtTime(adjustedPeekFreq, modHold)
      .linearRampToValueAtTime(adjustedSustainFreq, modDecay);
  }

  startModulation(channel, note, startTime) {
    const { voiceParams } = note;
    const { modLfoToPitch, modLfoToVolume } = voiceParams;
    note.modulationLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO),
    });
    note.filterDepth = new GainNode(this.audioContext, {
      gain: voiceParams.modLfoToFilterFc,
    });
    const modulationDepth = Math.abs(modLfoToPitch) + channel.modulationDepth;
    const modulationDepthSign = (0 < modLfoToPitch) ? 1 : -1;
    note.modulationDepth = new GainNode(this.audioContext, {
      gain: modulationDepth * modulationDepthSign,
    });
    const volumeDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepthSign = (0 < modLfoToVolume) ? 1 : -1;
    note.volumeDepth = new GainNode(this.audioContext, {
      gain: volumeDepth * volumeDepthSign,
    });
    note.modulationLFO.start(startTime + voiceParams.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
    note.filterDepth.connect(note.filterNode.frequency);
    note.modulationLFO.connect(note.modulationDepth);
    note.modulationDepth.connect(note.bufferSource.detune);
    note.modulationLFO.connect(note.volumeDepth);
    note.volumeDepth.connect(note.volumeNode.gain);
  }

  startVibrato(channel, note, startTime) {
    const { voiceParams } = note;
    const { vibLfoToPitch } = voiceParams;
    const state = channel.state;
    note.vibratoLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqVibLFO) *
        state.vibratoRate,
    });
    const vibratoDepth = Math.abs(vibLfoToPitch) * state.vibratoDepth * 2;
    const vibratoDepthSign = 0 < vibLfoToPitch;
    note.vibratoDepth = new GainNode(this.audioContext, {
      gain: vibratoDepth * vibratoDepthSign,
    });
    note.vibratoLFO.start(
      startTime + voiceParams.delayVibLFO * state.vibratoDelay * 2,
    );
    note.vibratoLFO.connect(note.vibratoDepth);
    note.vibratoDepth.connect(note.bufferSource.detune);
  }

  async createNote(
    channel,
    voice,
    noteNumber,
    velocity,
    startTime,
    portamento,
    isSF3,
  ) {
    const state = channel.state;
    const voiceParams = voice.getAllParams(state.array);
    const note = new Note(noteNumber, velocity, startTime, voice, voiceParams);
    note.bufferSource = await this.createNoteBufferNode(voiceParams, isSF3);
    note.volumeNode = new GainNode(this.audioContext);
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10, // dB
    });
    if (portamento) {
      this.setPortamentoStartVolumeEnvelope(channel, note);
      this.setPortamentoStartFilterEnvelope(channel, note);
    } else {
      this.setVolumeEnvelope(note);
      this.setFilterEnvelope(channel, note);
    }
    if (0 < state.vibratoDepth) {
      this.startVibrato(channel, note, startTime);
    }
    this.setPlaybackRate(note);
    if (0 < state.modulationDepth) {
      this.setPitch(channel, note);
      this.startModulation(channel, note, startTime);
    }
    if (this.mono && channel.currentBufferSource) {
      channel.currentBufferSource.stop(startTime);
      channel.currentBufferSource = note.bufferSource;
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.volumeNode);

    if (0 < channel.chorusSendLevel) {
      this.setChorusEffectsSend(channel, note, 0);
    }
    if (0 < channel.reverbSendLevel) {
      this.setReverbEffectsSend(channel, note, 0);
    }

    note.bufferSource.start(startTime);
    return note;
  }

  calcBank(channel, channelNumber) {
    if (channel.bankMSB === 121) {
      return 0;
    }
    if (channelNumber % 9 <= 1 && channel.bankMSB === 120) {
      return 128;
    }
    return channel.bank;
  }

  async scheduleNoteOn(
    channelNumber,
    noteNumber,
    velocity,
    startTime,
    portamento,
  ) {
    const channel = this.channels[channelNumber];
    const bankNumber = this.calcBank(channel, channelNumber);
    const soundFontIndex = this.soundFontTable[channel.program].get(bankNumber);
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const isSF3 = soundFont.parsed.info.version.major === 3;
    const voice = soundFont.getVoice(
      bankNumber,
      channel.program,
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
      portamento,
      isSF3,
    );
    note.volumeNode.connect(channel.gainL);
    note.volumeNode.connect(channel.gainR);
    if (channel.state.sostenutoPedal) {
      channel.sostenutoNotes.set(noteNumber, note);
    }
    const exclusiveClass = note.voiceParams.exclusiveClass;
    if (exclusiveClass !== 0) {
      if (this.exclusiveClassMap.has(exclusiveClass)) {
        const prevEntry = this.exclusiveClassMap.get(exclusiveClass);
        const [prevNote, prevChannelNumber] = prevEntry;
        if (!prevNote.ending) {
          this.scheduleNoteRelease(
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

  noteOn(channelNumber, noteNumber, velocity, portamento) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteOn(
      channelNumber,
      noteNumber,
      velocity,
      now,
      portamento,
    );
  }

  stopNote(endTime, stopTime, scheduledNotes, index) {
    const note = scheduledNotes[index];
    note.volumeNode.gain
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
        note.volumeNode.disconnect();
        note.filterNode.disconnect();
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
        resolve();
      };
      note.bufferSource.stop(stopTime);
    });
  }

  scheduleNoteRelease(
    channelNumber,
    noteNumber,
    _velocity,
    endTime,
    portamentoNoteNumber,
    force,
  ) {
    const channel = this.channels[channelNumber];
    const state = channel.state;
    if (!force) {
      if (0.5 < state.sustainPedal) return;
      if (channel.sostenutoNotes.has(noteNumber)) return;
    }
    if (!channel.scheduledNotes.has(noteNumber)) return;
    const scheduledNotes = channel.scheduledNotes.get(noteNumber);
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      if (portamentoNoteNumber === undefined) {
        const volRelease = endTime + note.voiceParams.volRelease;
        const modRelease = endTime + note.voiceParams.modRelease;
        note.filterNode.frequency
          .cancelScheduledValues(endTime)
          .linearRampToValueAtTime(0, modRelease);
        const stopTime = Math.min(volRelease, modRelease);
        return this.stopNote(endTime, stopTime, scheduledNotes, i);
      } else {
        const portamentoTime = endTime + state.portamentoTime;
        const detuneChange = (portamentoNoteNumber - noteNumber) * 100;
        const detune = note.bufferSource.detune.value + detuneChange;
        note.bufferSource.detune
          .cancelScheduledValues(endTime)
          .linearRampToValueAtTime(detune, portamentoTime);
        return this.stopNote(endTime, portamentoTime, scheduledNotes, i);
      }
    }
  }

  releaseNote(channelNumber, noteNumber, velocity, portamentoNoteNumber) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteRelease(
      channelNumber,
      noteNumber,
      velocity,
      now,
      portamentoNoteNumber,
      false,
    );
  }

  releaseSustainPedal(channelNumber, halfVelocity) {
    const velocity = halfVelocity * 2;
    const channel = this.channels[channelNumber];
    const promises = [];
    channel.state.sustainPedal = halfVelocity;
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const { noteNumber } = note;
        const promise = this.releaseNote(channelNumber, noteNumber, velocity);
        promises.push(promise);
      }
    });
    return promises;
  }

  releaseSostenutoPedal(channelNumber, halfVelocity) {
    const velocity = halfVelocity * 2;
    const channel = this.channels[channelNumber];
    const promises = [];
    channel.state.sostenutoPedal = 0;
    channel.sostenutoNotes.forEach((activeNote) => {
      const { noteNumber } = activeNote;
      const promise = this.releaseNote(channelNumber, noteNumber, velocity);
      promises.push(promise);
    });
    channel.sostenutoNotes.clear();
    return promises;
  }

  handleMIDIMessage(statusByte, data1, data2) {
    const channelNumber = omni ? 0 : statusByte & 0x0F;
    const messageType = statusByte & 0xF0;
    switch (messageType) {
      case 0x80:
        return this.releaseNote(channelNumber, data1, data2);
      case 0x90:
        return this.noteOn(channelNumber, data1, data2);
      case 0xB0:
        return this.handleControlChange(channelNumber, data1, data2);
      case 0xC0:
        return this.handleProgramChange(channelNumber, data1);
      case 0xD0:
        return this.handleChannelPressure(channelNumber, data1);
      case 0xE0:
        return this.handlePitchBendMessage(channelNumber, data1, data2);
      default:
        console.warn(`Unsupported MIDI message: ${messageType.toString(16)}`);
    }
  }

  handleProgramChange(channelNumber, program) {
    const channel = this.channels[channelNumber];
    channel.bank = channel.bankMSB * 128 + channel.bankLSB;
    channel.program = program;
  }

  handleChannelPressure(channelNumber, pressure) {
    const now = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    pressure /= 64;
    channel.channelPressure = pressure;
    const activeNotes = this.getActiveNotes(channel, now);
    if (channel.channelPressure.amplitudeControl !== 1) {
      activeNotes.forEach((activeNote) => {
        const gain = activeNote.volumeNode.gain.value;
        activeNote.volumeNode.gain
          .cancelScheduledValues(now)
          .setValueAtTime(gain * pressure, now);
      });
    }
  }

  handlePitchBendMessage(channelNumber, lsb, msb) {
    const pitchBend = msb * 128 + lsb - 8192;
    this.setPitchBend(channelNumber, pitchBend);
  }

  setPitchBend(channelNumber, pitchWheel) {
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const prevPitchWheel = state.pitchWheel;
    state.pitchWheel = pitchWheel / 8192;
    const detuneChange = (state.pitchWheel - prevPitchWheel) *
      state.pitchWheelSensitivity * 100;
    this.updateDetune(channel, detuneChange);
  }

  setChorusEffectsSend(note, prevValue) {
    if (0 < prevValue) {
      if (0 < note.voiceParams.chorusEffectsSend) {
        const now = this.audioContext.currentTime;
        const value = note.voiceParams.chorusEffectsSend;
        note.chorusEffectsSend.gain
          .cancelScheduledValues(now)
          .setValueAtTime(value, now);
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

  setReverbEffectsSend(note, prevValue) {
    if (0 < prevValue) {
      if (0 < note.voiceParams.reverbEffectsSend) {
        const now = this.audioContext.currentTime;
        const value = note.voiceParams.reverbEffectsSend;
        note.reverbEffectsSend.gain
          .cancelScheduledValues(now)
          .setValueAtTime(value, now);
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

  createControlChangeHandlers() {
    return {
      0: this.setBankMSB,
      1: this.setModulationDepth,
      5: this.setPortamentoTime,
      6: this.dataEntryMSB,
      7: this.setVolume,
      10: this.setPan,
      11: this.setExpression,
      32: this.setBankLSB,
      38: this.dataEntryLSB,
      64: this.setSustainPedal,
      65: this.setPortamento,
      66: this.setSostenutoPedal,
      67: this.setSoftPedal,
      91: this.setReverbSendLevel,
      93: this.setChorusSendLevel,
      100: this.setRPNLSB,
      101: this.setRPNMSB,
      120: this.allSoundOff,
      121: this.resetAllControllers,
      123: this.allNotesOff,
      124: this.omniOff,
      125: this.omniOn,
      126: this.monoOn,
      127: this.polyOn,
    };
  }

  handleControlChange(channelNumber, controllerType, value) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value);
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`,
      );
    }
  }

  setBankMSB(channelNumber, msb) {
    this.channels[channelNumber].bankMSB = msb;
  }

  updateModulation(channel) {
    const now = this.audioContext.currentTime;
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        if (note.modulationDepth) {
          note.modulationDepth.gain.setValueAtTime(
            channel.state.modulationDepth,
            now,
          );
        } else {
          this.setPitch(channel, note);
          this.startModulation(channel, note, now);
        }
      }
    });
  }

  setModulationDepth(channelNumber, modulation) {
    const channel = this.channels[channelNumber];
    channel.state.modulationDepth = (modulation / 127) *
      channel.modulationDepthRange;
    this.updateModulation(channel);
  }

  setPortamentoTime(channelNumber, portamentoTime) {
    const channel = this.channels[channelNumber];
    const factor = 5 * Math.log(10) / 127;
    channel.state.portamentoTime = Math.exp(factor * portamentoTime);
  }

  setVolume(channelNumber, volume) {
    const channel = this.channels[channelNumber];
    channel.state.volume = volume / 127;
    this.updateChannelVolume(channel);
  }

  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  setPan(channelNumber, pan) {
    const channel = this.channels[channelNumber];
    channel.state.pan = pan / 127;
    this.updateChannelVolume(channel);
  }

  setExpression(channelNumber, expression) {
    const channel = this.channels[channelNumber];
    channel.state.expression = expression / 127;
    this.updateChannelVolume(channel);
  }

  setBankLSB(channelNumber, lsb) {
    this.channels[channelNumber].bankLSB = lsb;
  }

  dataEntryLSB(channelNumber, value) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber);
  }

  updateChannelVolume(channel) {
    const now = this.audioContext.currentTime;
    const state = channel.state;
    const volume = state.volume * state.expression;
    const { gainLeft, gainRight } = this.panToGain(state.pan);
    channel.gainL.gain
      .cancelScheduledValues(now)
      .setValueAtTime(volume * gainLeft, now);
    channel.gainR.gain
      .cancelScheduledValues(now)
      .setValueAtTime(volume * gainRight, now);
  }

  setSustainPedal(channelNumber, value) {
    this.channels[channelNumber].state.sustainPedal = value / 127;
    if (value < 64) {
      this.releaseSustainPedal(channelNumber, value);
    }
  }

  setPortamento(channelNumber, value) {
    this.channels[channelNumber].state.portamento = value / 127;
  }

  setReverbSendLevel(channelNumber, reverbSendLevel) {
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const reverbEffect = this.reverbEffect;
    if (0 < state.reverbSendLevel) {
      if (0 < reverbSendLevel) {
        const now = this.audioContext.currentTime;
        state.reverbSendLevel = reverbSendLevel / 127;
        reverbEffect.input.gain.cancelScheduledValues(now);
        reverbEffect.input.gain.setValueAtTime(state.reverbSendLevel, now);
      } else {
        channel.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            if (note.voiceParams.reverbEffectsSend <= 0) continue;
            note.reverbEffectsSend.disconnect();
          }
        });
      }
    } else {
      if (0 < reverbSendLevel) {
        const now = this.audioContext.currentTime;
        channel.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            this.setReverbEffectsSend(note, 0);
          }
        });
        state.reverbSendLevel = reverbSendLevel / 127;
        reverbEffect.input.gain.cancelScheduledValues(now);
        reverbEffect.input.gain.setValueAtTime(state.reverbSendLevel, now);
      }
    }
  }

  setChorusSendLevel(channelNumber, chorusSendLevel) {
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const chorusEffect = this.chorusEffect;
    if (0 < state.chorusSendLevel) {
      if (0 < chorusSendLevel) {
        const now = this.audioContext.currentTime;
        state.chorusSendLevel = chorusSendLevel / 127;
        chorusEffect.input.gain.cancelScheduledValues(now);
        chorusEffect.input.gain.setValueAtTime(state.chorusSendLevel, now);
      } else {
        channel.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            if (note.voiceParams.chorusEffectsSend <= 0) continue;
            note.chorusEffectsSend.disconnect();
          }
        });
      }
    } else {
      if (0 < chorusSendLevel) {
        const now = this.audioContext.currentTime;
        channel.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            this.setChorusEffectsSend(note, 0);
          }
        });
        state.chorusSendLevel = chorusSendLevel / 127;
        chorusEffect.input.gain.cancelScheduledValues(now);
        chorusEffect.input.gain.setValueAtTime(state.chorusSendLevel, now);
      }
    }
  }

  setSostenutoPedal(channelNumber, value) {
    const channel = this.channels[channelNumber];
    channel.state.sostenutoPedal = value / 127;
    if (64 <= value) {
      const now = this.audioContext.currentTime;
      const activeNotes = this.getActiveNotes(channel, now);
      channel.sostenutoNotes = new Map(activeNotes);
    } else {
      this.releaseSostenutoPedal(channelNumber, value);
    }
  }

  setSoftPedal(channelNumber, softPedal) {
    const channel = this.channels[channelNumber];
    channel.state.softPedal = softPedal / 127;
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

  handleRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    const rpn = channel.rpnMSB * 128 + channel.rpnLSB;
    switch (rpn) {
      case 0:
        this.handlePitchBendRangeRPN(channelNumber);
        break;
      case 1:
        this.handleFineTuningRPN(channelNumber);
        break;
      case 2:
        this.handleCoarseTuningRPN(channelNumber);
        break;
      case 5:
        this.handleModulationDepthRangeRPN(channelNumber);
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

  dataEntryMSB(channelNumber, value) {
    this.channels[channelNumber].dataMSB = value;
    this.handleRPN(channelNumber);
  }

  updateDetune(channel, detuneChange) {
    const now = this.audioContext.currentTime;
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const { bufferSource } = note;
        const detune = bufferSource.detune.value + detuneChange;
        bufferSource.detune
          .cancelScheduledValues(now)
          .setValueAtTime(detune, now);
      }
    });
  }

  handlePitchBendRangeRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 99);
    const pitchBendRange = channel.dataMSB + channel.dataLSB / 100;
    this.setPitchBendRange(channelNumber, pitchBendRange);
  }

  setPitchBendRange(channelNumber, pitchWheelSensitivity) {
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const prevPitchWheelSensitivity = state.pitchWheelSensitivity;
    channel.pitchWheelSensitivity = pitchWheelSensitivity;
    const detuneChange =
      (state.pitchWheelSensitivity - prevPitchWheelSensitivity) *
      state.pitchWheel * 100;
    this.updateDetune(channel, detuneChange);
  }

  handleFineTuningRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const fineTuning = (channel.dataMSB * 128 + channel.dataLSB - 8192) / 8192;
    this.setFineTuning(channelNumber, fineTuning);
  }

  setFineTuning(channelNumber, fineTuning) {
    const channel = this.channels[channelNumber];
    const prevFineTuning = channel.fineTuning;
    channel.fineTuning = fineTuning;
    const detuneChange = channel.fineTuning - prevFineTuning;
    this.updateDetune(channel, detuneChange);
  }

  handleCoarseTuningRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    this.limitDataMSB(channel, 0, 127);
    const coarseTuning = channel.dataMSB - 64;
    this.setFineTuning(channelNumber, coarseTuning);
  }

  setCoarseTuning(channelNumber, coarseTuning) {
    const channel = this.channels[channelNumber];
    const prevCoarseTuning = channel.coarseTuning;
    channel.coarseTuning = coarseTuning;
    const detuneChange = channel.coarseTuning - prevCoarseTuning;
    this.updateDetune(channel, detuneChange);
  }

  handleModulationDepthRangeRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const modulationDepthRange = (dataMSB + dataLSB / 128) * 100;
    this.setModulationDepthRange(channelNumber, modulationDepthRange);
  }

  setModulationDepthRange(channelNumber, modulationDepthRange) {
    const channel = this.channels[channelNumber];
    channel.modulationDepthRange = modulationDepthRange;
    channel.modulationDepth = (modulation / 127) * modulationDepthRange;
    this.updateModulation(channel);
  }

  allSoundOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, true);
  }

  resetAllControllers(channelNumber) {
    const stateTypes = [
      "expression",
      "modulationDepth",
      "sustainPedal",
      "portamento",
      "sostenutoPedal",
      "softPedal",
      "channelPressure",
      "pitchWheelSensitivity",
    ];
    const channel = this.channels[channelNumber];
    const state = channel.state;
    for (let i = 0; i < stateTypes.length; i++) {
      const type = stateTypes[i];
      state[type] = defaultControllerState[type];
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

  allNotesOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, false);
  }

  omniOff() {
    this.omni = false;
  }

  omniOn() {
    this.omni = true;
  }

  monoOn() {
    this.mono = true;
  }

  polyOn() {
    this.mono = false;
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
          case 3:
            this.GM2SystemOn();
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
      channel.bankMSB = 0;
      channel.bankLSB = 0;
      channel.bank = 0;
    }
    this.channels[9].bankMSB = 1;
    this.channels[9].bank = 128;
  }

  GM2SystemOn() {
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      channel.bankMSB = 121;
      channel.bankLSB = 0;
      channel.bank = 121 * 128;
    }
    this.channels[9].bankMSB = 120;
    this.channels[9].bank = 120 * 128;
  }

  handleUniversalRealTimeExclusiveMessage(data) {
    switch (data[2]) {
      case 4:
        switch (data[3]) {
          case 1:
            return this.handleMasterVolumeSysEx(data);
          case 3: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca25.pdf
            return this.handleMasterFineTuningSysEx(data);
          case 4: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca25.pdf
            return this.handleMasterCoarseTuningSysEx(data);
          case 5:
            return this.handleGlobalParameterControlSysEx(data);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 8:
        switch (data[3]) {
          // case 8:
          //   // TODO
          //   return this.handleScaleOctaveTuning1ByteFormat();
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          // case 1:
          //   // TODO
          //   return this.setChannelPressure();
          // case 3:
          //   // TODO
          //   return this.setControlChange();
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 10:
        switch (data[3]) {
          // case 1:
          //   // TODO
          //   return this.handleKeyBasedInstrumentControl();
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
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(volume * volume, now);
    }
  }

  handleMasterFineTuningSysEx(data) {
    const fineTuning = (data[5] * 128 + data[4] - 8192) / 8192;
    this.setMasterFineTuning(fineTuning);
  }

  setMasterFineTuning(fineTuning) {
    if (fineTuning < -1 && 1 < fineTuning) {
      console.error("Master Fine Tuning value is out of range");
    } else {
      this.masterFineTuning = fineTuning;
    }
  }

  handleMasterCoarseTuningSysEx(data) {
    const coarseTuning = data[4];
    this.setMasterCoarseTuning(coarseTuning);
  }

  setMasterCoarseTuning(coarseTuning) {
    if (coarseTuning < 0 && 127 < coarseTuning) {
      console.error("Master Coarse Tuning value is out of range");
    } else {
      this.masterCoarseTuning = coarseTuning - 64;
    }
  }

  handleGlobalParameterControlSysEx(data) {
    if (data[7] === 1) {
      switch (data[8]) {
        case 1:
          return this.handleReverbParameterSysEx(data);
        case 2:
          return this.handleChorusParameterSysEx(data);
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
    return Math.pow(Math.E, (value - 40) * 0.025);
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

  handleChorusParameterSysEx(data) {
    switch (data[9]) {
      case 0:
        return this.setChorusType(data[10]);
      case 1:
        return this.setChorusModRate(data[10]);
      case 2:
        return this.setChorusModDepth(data[10]);
      case 3:
        return this.setChorusFeedback(data[10]);
      case 4:
        return this.setChorusSendToReverb(data[10]);
    }
  }

  setChorusType(type) {
    switch (type) {
      case 0:
        return this.setChorusParameter(3, 5, 0, 0);
      case 1:
        return this.setChorusParameter(9, 19, 5, 0);
      case 2:
        return this.setChorusParameter(3, 19, 8, 0);
      case 3:
        return this.setChorusParameter(9, 16, 16, 0);
      case 4:
        return this.setChorusParameter(2, 24, 64, 0);
      case 5:
        return this.setChorusParameter(1, 5, 112, 0);
      default:
        console.warn(`Unsupported Chorus Type: ${type}`);
    }
  }

  setChorusParameter(modRate, modDepth, feedback, sendToReverb) {
    this.setChorusModRate(modRate);
    this.setChorusModDepth(modDepth);
    this.setChorusFeedback(feedback);
    this.setChorusSendToReverb(sendToReverb);
  }

  setChorusModRate(value) {
    const now = this.audioContext.currentTime;
    const modRate = this.getChorusModRate(value);
    this.chorus.modRate = modRate;
    this.chorusEffect.lfo.frequency.setValueAtTime(modRate, now);
  }

  getChorusModRate(value) {
    return value * 0.122; // Hz
  }

  setChorusModDepth(value) {
    const now = this.audioContext.currentTime;
    const modDepth = this.getChorusModDepth(value);
    this.chorus.modDepth = modDepth;
    this.chorusEffect.lfoGain.gain
      .cancelScheduledValues(now)
      .setValueAtTime(modDepth / 2, now);
  }

  getChorusModDepth(value) {
    return (value + 1) / 3200; // second
  }

  setChorusFeedback(value) {
    const now = this.audioContext.currentTime;
    const feedback = this.getChorusFeedback(value);
    this.chorus.feedback = feedback;
    const chorusEffect = this.chorusEffect;
    for (let i = 0; i < chorusEffect.feedbackGains.length; i++) {
      chorusEffect.feedbackGains[i].gain
        .cancelScheduledValues(now)
        .setValueAtTime(feedback, now);
    }
  }

  getChorusFeedback(value) {
    return value * 0.00763;
  }

  setChorusSendToReverb(value) {
    const sendToReverb = this.getChorusSendToReverb(value);
    const sendGain = this.chorusEffect.sendGain;
    if (0 < this.chorus.sendToReverb) {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        const now = this.audioContext.currentTime;
        sendGain.gain
          .cancelScheduledValues(now)
          .setValueAtTime(sendToReverb, now);
      } else {
        sendGain.disconnect();
      }
    } else {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        const now = this.audioContext.currentTime;
        sendGain.connect(this.reverbEffect.input);
        sendGain.gain
          .cancelScheduledValues(now)
          .setValueAtTime(sendToReverb, now);
      }
    }
  }

  getChorusSendToReverb(value) {
    return value * 0.00787;
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
