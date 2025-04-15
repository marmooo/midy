import { parseMidi } from "https://cdn.jsdelivr.net/npm/midi-file@1.2.4/+esm";
import {
  parse,
  SoundFont,
} from "https://cdn.jsdelivr.net/npm/@marmooo/soundfont-parser@0.0.4/+esm";

class Note {
  bufferSource;
  filterNode;
  volumeNode;
  volumeDepth;
  modulationLFO;
  modulationDepth;
  vibratoLFO;
  vibratoDepth;

  constructor(noteNumber, velocity, startTime, instrumentKey) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.instrumentKey = instrumentKey;
  }
}

export class MidyGM1 {
  ticksPerBeat = 120;
  totalTime = 0;
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

  static channelSettings = {
    volume: 100 / 127,
    pan: 64,
    bank: 0,
    dataMSB: 0,
    dataLSB: 0,
    program: 0,
    pitchBend: 0,
    fineTuning: 0, // cb
    coarseTuning: 0, // cb
    modulationDepthRange: 50, // cent
  };

  static effectSettings = {
    expression: 1,
    modulationDepth: 0,
    sustainPedal: false,
    rpnMSB: 127,
    rpnLSB: 127,
    pitchBendRange: 2,
  };

  constructor(audioContext) {
    this.audioContext = audioContext;
    this.masterGain = new GainNode(audioContext);
    this.channels = this.createChannels(audioContext);
    this.masterGain.connect(audioContext.destination);
    this.GM1SystemOn();
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
    soundFont.parsed.presetHeaders.forEach((presetHeader) => {
      if (!presetHeader.presetName.startsWith("\u0000")) { // TODO: Only SF3 generated by PolyPone?
        const banks = this.soundFontTable[presetHeader.preset];
        banks.set(presetHeader.bank, index);
      }
    });
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
      this.constructor.channelSettings.pan,
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
        ...this.constructor.effectSettings,
        ...this.setChannelAudioNodes(audioContext),
        scheduledNotes: new Map(),
      };
    });
    return channels;
  }

  async createNoteBuffer(instrumentKey, isSF3) {
    const sampleEnd = instrumentKey.sample.length + instrumentKey.end;
    if (isSF3) {
      const sample = new Uint8Array(instrumentKey.sample.length);
      sample.set(instrumentKey.sample);
      const audioBuffer = await this.audioContext.decodeAudioData(
        sample.buffer,
      );
      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        channelData.set(channelData.subarray(0, sampleEnd));
      }
      return audioBuffer;
    } else {
      const sample = instrumentKey.sample.subarray(0, sampleEnd);
      const floatSample = this.convertToFloat32Array(sample);
      const audioBuffer = new AudioBuffer({
        numberOfChannels: 1,
        length: sample.length,
        sampleRate: instrumentKey.sampleRate,
      });
      const channelData = audioBuffer.getChannelData(0);
      channelData.set(floatSample);
      return audioBuffer;
    }
  }

  async createNoteBufferNode(instrumentKey, isSF3) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    const audioBuffer = await this.createNoteBuffer(instrumentKey, isSF3);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = instrumentKey.sampleModes % 2 !== 0;
    if (bufferSource.loop) {
      bufferSource.loopStart = instrumentKey.loopStart /
        instrumentKey.sampleRate;
      bufferSource.loopEnd = instrumentKey.loopEnd / instrumentKey.sampleRate;
    }
    return bufferSource;
  }

  convertToFloat32Array(uint8Array) {
    const int16Array = new Int16Array(uint8Array.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }
    return float32Array;
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
            );
            break;
          }
          /* falls through */
        case "noteOff": {
          const notePromise = this.scheduleNoteRelease(
            event.channel,
            event.noteNumber,
            event.velocity,
            event.startTime + this.startDelay - offset,
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
          );
          break;
        case "programChange":
          this.handleProgramChange(event.channel, event.programNumber);
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
          this.notePromises = [];
          resolve();
          this.isStopping = false;
          this.isPaused = false;
          return;
        } else if (this.isSeeking) {
          this.stopNotes(0, true);
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
        bank: this.channels[i].bank,
      };
    }
    midi.tracks.forEach((track) => {
      let currentTicks = 0;
      track.forEach((event) => {
        currentTicks += event.deltaTime;
        event.ticks = currentTicks;
        switch (event.type) {
          case "noteOn": {
            const channel = tmpChannels[event.channel];
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
      });
    });
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

  async stopChannelNotes(channelNumber, velocity, stopPedal) {
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
          stopPedal,
        );
        this.notePromises.push(promise);
      }
    });
    channel.scheduledNotes.clear();
    await Promise.all(this.notePromises);
  }

  stopNotes(velocity, stopPedal) {
    for (let i = 0; i < this.channels.length; i++) {
      this.stopChannelNotes(i, velocity, stopPedal);
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

  cbToRatio(cb) {
    return Math.pow(10, cb / 200);
  }

  centToHz(cent) {
    return 8.176 * Math.pow(2, cent / 1200);
  }

  calcSemitoneOffset(channel) {
    const tuning = channel.coarseTuning + channel.fineTuning;
    return channel.pitchBend * channel.pitchBendRange + tuning;
  }

  calcPlaybackRate(instrumentKey, noteNumber, semitoneOffset) {
    return instrumentKey.playbackRate(noteNumber) *
      Math.pow(2, semitoneOffset / 12);
  }

  setVolumeEnvelope(note) {
    const { instrumentKey, startTime } = note;
    note.volumeNode = new GainNode(this.audioContext, { gain: 0 });
    const attackVolume = this.cbToRatio(-instrumentKey.initialAttenuation);
    const sustainVolume = attackVolume * (1 - instrumentKey.volSustain);
    const volDelay = startTime + instrumentKey.volDelay;
    const volAttack = volDelay + instrumentKey.volAttack;
    const volHold = volAttack + instrumentKey.volHold;
    const volDecay = volHold + instrumentKey.volDecay;
    note.volumeNode.gain
      .setValueAtTime(1e-6, volDelay) // exponentialRampToValueAtTime() requires a non-zero value
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .linearRampToValueAtTime(sustainVolume, volDecay);
  }

  setPitch(note, semitoneOffset) {
    const { instrumentKey, noteNumber, startTime } = note;
    const modEnvToPitch = instrumentKey.modEnvToPitch / 100;
    note.bufferSource.playbackRate.value = this.calcPlaybackRate(
      instrumentKey,
      noteNumber,
      semitoneOffset,
    );
    if (modEnvToPitch === 0) return;
    const basePitch = note.bufferSource.playbackRate.value;
    const peekPitch = this.calcPlaybackRate(
      instrumentKey,
      noteNumber,
      semitoneOffset + modEnvToPitch,
    );
    const modDelay = startTime + instrumentKey.modDelay;
    const modAttack = modDelay + instrumentKey.modAttack;
    const modHold = modAttack + instrumentKey.modHold;
    const modDecay = modHold + instrumentKey.modDecay;
    note.bufferSource.playbackRate.value
      .setValueAtTime(basePitch, modDelay)
      .exponentialRampToValueAtTime(peekPitch, modAttack)
      .setValueAtTime(peekPitch, modHold)
      .linearRampToValueAtTime(basePitch, modDecay);
  }

  setFilterNode(channel, note) {
    const { instrumentKey, noteNumber, startTime } = note;
    const softPedalFactor = 1 -
      (0.1 + (noteNumber / 127) * 0.2) * channel.softPedal;
    const maxFreq = this.audioContext.sampleRate / 2;
    const baseFreq = this.centToHz(instrumentKey.initialFilterFc) *
      softPedalFactor;
    const peekFreq = this.centToHz(
      instrumentKey.initialFilterFc + instrumentKey.modEnvToFilterFc,
    ) * softPedalFactor;
    const sustainFreq = (baseFreq +
      (peekFreq - baseFreq) * (1 - instrumentKey.modSustain)) * softPedalFactor;
    const adjustedBaseFreq = Math.min(maxFreq, baseFreq);
    const adjustedPeekFreq = Math.min(maxFreq, peekFreq);
    const adjustedSustainFreq = Math.min(maxFreq, sustainFreq);
    const modDelay = startTime + instrumentKey.modDelay;
    const modAttack = modDelay + instrumentKey.modAttack;
    const modHold = modAttack + instrumentKey.modHold;
    const modDecay = modHold + instrumentKey.modDecay;
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: instrumentKey.initialFilterQ / 10, // dB
      frequency: adjustedBaseFreq,
    });
    note.filterNode.frequency
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .exponentialRampToValueAtTime(adjustedPeekFreq, modAttack)
      .setValueAtTime(adjustedPeekFreq, modHold)
      .linearRampToValueAtTime(adjustedSustainFreq, modDecay);
  }

  startModulation(channel, note, startTime) {
    const { instrumentKey } = note;
    const { modLfoToPitch, modLfoToVolume } = instrumentKey;
    note.modulationLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(instrumentKey.freqModLFO),
    });
    note.filterDepth = new GainNode(this.audioContext, {
      gain: instrumentKey.modLfoToFilterFc,
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
    note.modulationLFO.start(startTime + instrumentKey.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
    note.filterDepth.connect(note.filterNode.frequency);
    note.modulationLFO.connect(note.modulationDepth);
    note.modulationDepth.connect(note.bufferSource.detune);
    note.modulationLFO.connect(note.volumeDepth);
    note.volumeDepth.connect(note.volumeNode.gain);
  }

  async createNote(
    channel,
    instrumentKey,
    noteNumber,
    velocity,
    startTime,
    isSF3,
  ) {
    const semitoneOffset = this.calcSemitoneOffset(channel);
    const note = new Note(noteNumber, velocity, startTime, instrumentKey);
    note.bufferSource = await this.createNoteBufferNode(instrumentKey, isSF3);
    this.setFilterNode(channel, note);
    this.setVolumeEnvelope(note);
    if (0 < channel.modulationDepth) {
      this.setPitch(note, semitoneOffset);
      this.startModulation(channel, note, startTime);
    } else {
      note.bufferSource.playbackRate.value = this.calcPlaybackRate(
        instrumentKey,
        noteNumber,
        semitoneOffset,
      );
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.volumeNode);
    note.bufferSource.start(
      startTime,
      instrumentKey.start / instrumentKey.sampleRate,
    );
    return note;
  }

  async scheduleNoteOn(channelNumber, noteNumber, velocity, startTime) {
    const channel = this.channels[channelNumber];
    const bankNumber = 0;
    const soundFontIndex = this.soundFontTable[channel.program].get(bankNumber);
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const isSF3 = soundFont.parsed.info.version.major === 3;
    const instrumentKey = soundFont.getInstrumentKey(
      bankNumber,
      channel.program,
      noteNumber,
    );
    if (!instrumentKey) return;
    const note = await this.createNote(
      channel,
      instrumentKey,
      noteNumber,
      velocity,
      startTime,
      isSF3,
    );
    note.volumeNode.connect(channel.gainL);
    note.volumeNode.connect(channel.gainR);
    const scheduledNotes = channel.scheduledNotes;
    if (scheduledNotes.has(noteNumber)) {
      scheduledNotes.get(noteNumber).push(note);
    } else {
      scheduledNotes.set(noteNumber, [note]);
    }
  }

  noteOn(channelNumber, noteNumber, velocity) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteOn(channelNumber, noteNumber, velocity, now);
  }

  scheduleNoteRelease(
    channelNumber,
    noteNumber,
    velocity,
    stopTime,
    stopPedal = false,
  ) {
    const channel = this.channels[channelNumber];
    if (stopPedal && channel.sustainPedal) return;
    if (!channel.scheduledNotes.has(noteNumber)) return;
    const scheduledNotes = channel.scheduledNotes.get(noteNumber);
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      const velocityRate = (velocity + 127) / 127;
      const volEndTime = stopTime +
        note.instrumentKey.volRelease * velocityRate;
      note.volumeNode.gain
        .cancelScheduledValues(stopTime)
        .linearRampToValueAtTime(0, volEndTime);
      const modRelease = stopTime +
        note.instrumentKey.modRelease * velocityRate;
      note.filterNode.frequency
        .cancelScheduledValues(stopTime)
        .linearRampToValueAtTime(0, modRelease);
      note.ending = true;
      this.scheduleTask(() => {
        note.bufferSource.loop = false;
      }, stopTime);
      return new Promise((resolve) => {
        note.bufferSource.onended = () => {
          scheduledNotes[i] = null;
          note.bufferSource.disconnect();
          note.volumeNode.disconnect();
          note.filterNode.disconnect();
          if (note.volumeDepth) note.volumeDepth.disconnect();
          if (note.modulationDepth) note.modulationDepth.disconnect();
          if (note.modulationLFO) note.modulationLFO.stop();
          resolve();
        };
        note.bufferSource.stop(volEndTime);
      });
    }
  }

  releaseNote(channelNumber, noteNumber, velocity) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteRelease(channelNumber, noteNumber, velocity, now);
  }

  releaseSustainPedal(channelNumber, halfVelocity) {
    const velocity = halfVelocity * 2;
    const channel = this.channels[channelNumber];
    const promises = [];
    channel.sustainPedal = false;
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

  handleMIDIMessage(statusByte, data1, data2) {
    const channelNumber = statusByte & 0x0F;
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
      case 0xE0:
        return this.handlePitchBendMessage(channelNumber, data1, data2);
      default:
        console.warn(`Unsupported MIDI message: ${messageType.toString(16)}`);
    }
  }

  handleProgramChange(channelNumber, program) {
    const channel = this.channels[channelNumber];
    channel.program = program;
  }

  handlePitchBendMessage(channelNumber, lsb, msb) {
    const pitchBend = msb * 128 + lsb - 8192;
    this.setPitchBend(channelNumber, pitchBend);
  }

  setPitchBend(channelNumber, pitchBend) {
    const channel = this.channels[channelNumber];
    const prevPitchBend = channel.pitchBend;
    channel.pitchBend = pitchBend / 8192;
    const detuneChange = (channel.pitchBend - prevPitchBend) *
      channel.pitchBendRange * 100;
    this.updateDetune(channel, detuneChange);
  }

  handleControlChange(channelNumber, controller, value) {
    switch (controller) {
      case 1:
        return this.setModulationDepth(channelNumber, value);
      case 6:
        return this.dataEntryMSB(channelNumber, value);
      case 7:
        return this.setVolume(channelNumber, value);
      case 10:
        return this.setPan(channelNumber, value);
      case 11:
        return this.setExpression(channelNumber, value);
      case 38:
        return this.dataEntryLSB(channelNumber, value);
      case 64:
        return this.setSustainPedal(channelNumber, value);
      case 100:
        return this.setRPNLSB(channelNumber, value);
      case 101:
        return this.setRPNMSB(channelNumber, value);
      case 120:
        return this.allSoundOff(channelNumber);
      case 121:
        return this.resetAllControllers(channelNumber);
      case 123:
        return this.allNotesOff(channelNumber);
      default:
        console.warn(
          `Unsupported Control change: controller=${controller} value=${value}`,
        );
    }
  }

  updateModulation(channel) {
    const now = this.audioContext.currentTime;
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        if (note.modulationDepth) {
          note.modulationDepth.gain.setValueAtTime(
            channel.modulationDepth,
            now,
          );
        } else {
          const semitoneOffset = this.calcSemitoneOffset(channel);
          this.setPitch(note, semitoneOffset);
          this.startModulation(channel, note, now);
        }
      }
    });
  }

  setModulationDepth(channelNumber, modulation) {
    const channel = this.channels[channelNumber];
    channel.modulationDepth = (modulation / 127) * channel.modulationDepthRange;
    this.updateModulation(channel);
  }
  setVolume(channelNumber, volume) {
    const channel = this.channels[channelNumber];
    channel.volume = volume / 127;
    this.updateChannelGain(channel);
  }

  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  setPan(channelNumber, pan) {
    const channel = this.channels[channelNumber];
    channel.pan = pan;
    this.updateChannelGain(channel);
  }

  setExpression(channelNumber, expression) {
    const channel = this.channels[channelNumber];
    channel.expression = expression / 127;
    this.updateChannelGain(channel);
  }

  dataEntryLSB(channelNumber, value) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber, 0);
  }

  updateChannelGain(channel) {
    const now = this.audioContext.currentTime;
    const volume = channel.volume * channel.expression;
    const { gainLeft, gainRight } = this.panToGain(channel.pan);
    channel.gainL.gain
      .cancelScheduledValues(now)
      .setValueAtTime(volume * gainLeft, now);
    channel.gainR.gain
      .cancelScheduledValues(now)
      .setValueAtTime(volume * gainRight, now);
  }

  setSustainPedal(channelNumber, value) {
    const isOn = value >= 64;
    this.channels[channelNumber].sustainPedal = isOn;
    if (!isOn) {
      this.releaseSustainPedal(channelNumber, value);
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

  setPitchBendRange(channelNumber, pitchBendRange) {
    const channel = this.channels[channelNumber];
    const prevPitchBendRange = channel.pitchBendRange;
    channel.pitchBendRange = pitchBendRange;
    const detuneChange = (channel.pitchBendRange - prevPitchBendRange) *
      channel.pitchBend * 100;
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

  allSoundOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, true);
  }

  resetAllControllers(channelNumber) {
    Object.assign(this.channels[channelNumber], this.effectSettings);
  }

  allNotesOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, false);
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
    this.channels.forEach((channel) => {
      channel.bankMSB = 0;
      channel.bankLSB = 0;
      channel.bank = 0;
    });
    this.channels[9].bankMSB = 1;
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
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(volume * volume, now);
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
