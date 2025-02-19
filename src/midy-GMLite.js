import { parseMidi } from "https://cdn.jsdelivr.net/npm/midi-file@1.2.4/+esm";
import {
  parse,
  SoundFont,
} from "https://cdn.jsdelivr.net/npm/@marmooo/soundfont-parser@0.0.2/+esm";

class Note {
  bufferSource;
  gainNode;
  filterNode;
  modLFO;
  modLFOGain;

  constructor(noteNumber, velocity, startTime, instrumentKey) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.instrumentKey = instrumentKey;
  }
}

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
    pan: 0,
    bank: 0,
    dataMSB: 0,
    dataLSB: 0,
    program: 0,
    pitchBend: 0,
    modulationDepthRange: 0.5,
  };

  static effectSettings = {
    expression: 1,
    modulation: 0,
    sustainPedal: false,
    rpnMSB: 127,
    rpnLSB: 127,
    pitchBendRange: 2,
  };

  constructor(audioContext) {
    this.audioContext = audioContext;
    this.masterGain = new GainNode(audioContext);
    this.masterGain.connect(audioContext.destination);
    this.channels = this.createChannels(audioContext);
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
    const gainNode = new GainNode(audioContext, {
      gain: MidyGMLite.channelSettings.volume,
    });
    const pannerNode = new StereoPannerNode(audioContext, {
      pan: MidyGMLite.channelSettings.pan,
    });
    pannerNode.connect(gainNode);
    gainNode.connect(this.masterGain);
    return {
      gainNode,
      pannerNode,
    };
  }

  createChannels(audioContext) {
    const channels = Array.from({ length: 16 }, () => {
      return {
        ...MidyGMLite.channelSettings,
        ...MidyGMLite.effectSettings,
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
          this.handlePitchBend(event.channel, event.value);
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
          await this.stopNotes();
          this.notePromises = [];
          resolve();
          this.isPausing = false;
          this.isPaused = true;
          return;
        } else if (this.isStopping) {
          await this.stopNotes();
          this.notePromises = [];
          resolve();
          this.isStopping = false;
          this.isPaused = false;
          return;
        } else if (this.isSeeking) {
          this.stopNotes();
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
        durationTicks: new Map(),
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
            channel.durationTicks.set(event.noteNumber, {
              ticks: event.ticks,
              noteOn: event,
            });
            break;
          }
          case "noteOff": {
            const { ticks, noteOn } = tmpChannels[event.channel].durationTicks
              .get(event.noteNumber);
            noteOn.durationTicks = event.ticks - ticks;
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
      setTempo: 0,
      controller: 1,
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

  stopNotes() {
    const now = this.audioContext.currentTime;
    const velocity = 0;
    const stopPedal = true;
    this.channels.forEach((channel, channelNumber) => {
      channel.scheduledNotes.forEach((scheduledNotes) => {
        scheduledNotes.forEach((scheduledNote) => {
          if (scheduledNote) {
            const promise = this.scheduleNoteRelease(
              channelNumber,
              scheduledNote.noteNumber,
              velocity,
              now,
              stopPedal,
            );
            this.notePromises.push(promise);
          }
        });
      });
      channel.scheduledNotes.clear();
    });
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
      if (note.startTime < time) return note;
    }
    return noteList[0];
  }

  connectNoteEffects(channel, gainNode) {
    gainNode.connect(channel.pannerNode);
  }

  cbToRatio(cb) {
    return Math.pow(10, cb / 200);
  }

  centToHz(cent) {
    return 8.176 * Math.pow(2, cent / 1200);
  }

  calcSemitoneOffset(channel) {
    return channel.pitchBend * channel.pitchBendRange;
  }

  calcPlaybackRate(instrumentKey, noteNumber, semitoneOffset) {
    return instrumentKey.playbackRate(noteNumber) *
      Math.pow(2, semitoneOffset / 12);
  }

  setVolumeEnvelope(channel, note) {
    const { instrumentKey, startTime, velocity } = note;
    note.gainNode = new GainNode(this.audioContext, {
      gain: 0,
    });
    let volume = (velocity / 127) * channel.volume * channel.expression;
    if (volume === 0) volume = 1e-6; // exponentialRampToValueAtTime() requires a non-zero value
    const attackVolume = this.cbToRatio(-instrumentKey.initialAttenuation) *
      volume;
    const sustainVolume = attackVolume * (1 - instrumentKey.volSustain);
    const volDelay = startTime + instrumentKey.volDelay;
    const volAttack = volDelay + instrumentKey.volAttack;
    const volHold = volAttack + instrumentKey.volHold;
    const volDecay = volHold + instrumentKey.volDecay;
    note.gainNode.gain
      .setValueAtTime(1e-6, volDelay) // exponentialRampToValueAtTime() requires a non-zero value
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .linearRampToValueAtTime(sustainVolume, volDecay);
  }

  setFilterEnvelope(channel, note) {
    const { instrumentKey, startTime, noteNumber } = note;
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
    const modDelay = startTime + instrumentKey.modDelay;
    const modAttack = modDelay + instrumentKey.modAttack;
    const modHold = modAttack + instrumentKey.modHold;
    const modDecay = modHold + instrumentKey.modDecay;
    const adjustedBaseFreq = Math.min(maxFreq, baseFreq);
    const adjustedPeekFreq = Math.min(maxFreq, peekFreq);
    const adjustedSustainFreq = Math.min(maxFreq, sustainFreq);
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
    note.bufferSource.detune.setValueAtTime(
      note.bufferSource.detune.value + instrumentKey.modEnvToPitch,
      modDelay,
    );
  }

  startModulation(channel, note, time) {
    const { instrumentKey } = note;
    note.modLFOGain = new GainNode(this.audioContext, {
      gain: this.cbToRatio(instrumentKey.modLfoToVolume) * channel.modulation,
    });
    note.modLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(instrumentKey.freqModLFO),
    });
    note.modLFO.start(time);
    note.filterNode.frequency.setValueAtTime(
      note.filterNode.frequency.value + instrumentKey.modLfoToFilterFc,
      time,
    );
    note.bufferSource.detune.setValueAtTime(
      note.bufferSource.detune.value + instrumentKey.modLfoToPitch,
      time,
    );
    note.modLFO.connect(note.modLFOGain);
    note.modLFOGain.connect(note.bufferSource.detune);
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
    note.bufferSource.playbackRate.value = this.calcPlaybackRate(
      instrumentKey,
      noteNumber,
      semitoneOffset,
    );
    this.setVolumeEnvelope(channel, note);
    this.setFilterEnvelope(channel, note);
    if (channel.modulation > 0) {
      const delayModLFO = startTime + instrumentKey.delayModLFO;
      this.startModulation(channel, note, delayModLFO);
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.gainNode);
    note.bufferSource.start(
      startTime,
      instrumentKey.start / instrumentKey.sampleRate,
    );
    return note;
  }

  async scheduleNoteOn(channelNumber, noteNumber, velocity, startTime) {
    const channel = this.channels[channelNumber];
    const bankNumber = channel.bank;
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
    this.connectNoteEffects(channel, note.gainNode);

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
    const targetNotes = channel.scheduledNotes.get(noteNumber);
    for (let i = 0; i < targetNotes.length; i++) {
      const targetNote = targetNotes[i];
      if (!targetNote) continue;
      if (targetNote.ending) continue;
      const {
        bufferSource,
        filterNode,
        gainNode,
        modLFO,
        modLFOGain,
        instrumentKey,
      } = targetNote;
      const velocityRate = (velocity + 127) / 127;
      const volEndTime = stopTime + instrumentKey.volRelease * velocityRate;
      gainNode.gain.cancelScheduledValues(stopTime);
      gainNode.gain.linearRampToValueAtTime(0, volEndTime);
      const maxFreq = this.audioContext.sampleRate / 2;
      const baseFreq = this.centToHz(instrumentKey.initialFilterFc);
      const adjustedBaseFreq = Math.min(maxFreq, baseFreq);
      const modEndTime = stopTime + instrumentKey.modRelease * velocityRate;
      filterNode.frequency
        .cancelScheduledValues(stopTime)
        .linearRampToValueAtTime(adjustedBaseFreq, modEndTime);
      targetNote.ending = true;
      this.scheduleTask(() => {
        bufferSource.loop = false;
      }, stopTime);
      return new Promise((resolve) => {
        bufferSource.onended = () => {
          targetNotes[i] = null;
          bufferSource.disconnect(0);
          filterNode.disconnect(0);
          gainNode.disconnect(0);
          if (modLFOGain) modLFOGain.disconnect(0);
          if (modLFO) modLFO.stop();
          resolve();
        };
        bufferSource.stop(volEndTime);
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
    channel.scheduledNotes.forEach((scheduledNotes) => {
      scheduledNotes.forEach((scheduledNote) => {
        if (scheduledNote) {
          const { noteNumber } = scheduledNote;
          const promise = this.releaseNote(channelNumber, noteNumber, velocity);
          promises.push(promise);
        }
      });
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
    const pitchBend = msb * 128 + lsb;
    this.handlePitchBend(channelNumber, pitchBend);
  }

  handlePitchBend(channelNumber, pitchBend) {
    const now = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.pitchBend = (pitchBend - 8192) / 8192;
    const semitoneOffset = this.calcSemitoneOffset(channel);
    const activeNotes = this.getActiveNotes(channel, now);
    activeNotes.forEach((activeNote) => {
      const { bufferSource, instrumentKey, noteNumber } = activeNote;
      const playbackRate = calcPlaybackRate(
        instrumentKey,
        noteNumber,
        semitoneOffset,
      );
      bufferSource.playbackRate
        .cancelScheduledValues(now)
        .setValueAtTime(playbackRate * pressure, now);
    });
  }

  handleControlChange(channelNumber, controller, value) {
    switch (controller) {
      case 1:
        return this.setModulation(channelNumber, value);
      case 6:
        return this.setDataEntry(channelNumber, value, true);
      case 7:
        return this.setVolume(channelNumber, value);
      case 10:
        return this.setPan(channelNumber, value);
      case 11:
        return this.setExpression(channelNumber, value);
      case 38:
        return this.setDataEntry(channelNumber, value, false);
      case 64:
        return this.setSustainPedal(channelNumber, value);
      case 100:
        return this.setRPNMSB(channelNumber, value);
      case 101:
        return this.setRPNLSB(channelNumber, value);
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

  setModulation(channelNumber, modulation) {
    const channel = this.channels[channelNumber];
    channel.modulation = (modulation / 127) *
      (channel.modulationDepthRange * 100);
  }

  setVolume(channelNumber, volume) {
    const channel = this.channels[channelNumber];
    channel.volume = volume / 127;
    this.updateChannelGain(channel);
  }

  setPan(channelNumber, pan) {
    const now = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.pan = pan / 127 * 2 - 1; // -1 (left) - +1 (right)
    channel.pannerNode.pan.cancelScheduledValues(now);
    channel.pannerNode.pan.setValueAtTime(channel.pan, now);
  }

  setExpression(channelNumber, expression) {
    const channel = this.channels[channelNumber];
    channel.expression = expression / 127;
    this.updateChannelGain(channel);
  }

  updateChannelGain(channel) {
    const now = this.audioContext.currentTime;
    const volume = channel.volume * channel.expression;
    channel.gainNode.gain.cancelScheduledValues(now);
    channel.gainNode.gain.setValueAtTime(volume, now);
  }

  setSustainPedal(channelNumber, value) {
    const isOn = value >= 64;
    this.channels[channelNumber].sustainPedal = isOn;
    if (!isOn) {
      this.releaseSustainPedal(channelNumber, value);
    }
  }

  setRPNMSB(channelNumber, value) {
    this.channels[channelNumber].rpnMSB = value;
  }

  setRPNLSB(channelNumber, value) {
    this.channels[channelNumber].rpnLSB = value;
  }

  setDataEntry(channelNumber, value, isMSB) {
    const channel = this.channels[channelNumber];
    const rpn = channel.rpnMSB * 128 + channel.rpnLSB;
    isMSB ? channel.dataMSB = value : channel.dataLSB = value;
    const { dataMSB, dataLSB } = channel;
    switch (rpn) {
      case 0:
        channel.pitchBendRange = dataMSB + dataLSB / 100;
        break;
      default:
        console.warn(
          `Channel ${channelNumber}: Unsupported RPN MSB=${channel.rpnMSB} LSB=${channel.rpnLSB}`,
        );
    }
  }

  allSoundOff(channelNumber) {
    const now = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const velocity = 0;
    const stopPedal = true;
    const promises = [];
    channel.scheduledNotes.forEach((noteList) => {
      const activeNote = this.getActiveNote(noteList, now);
      if (activeNote) {
        const notePromise = this.scheduleNoteRelease(
          channelNumber,
          noteNumber,
          velocity,
          now,
          stopPedal,
        );
        promises.push(notePromise);
      }
    });
    return promises;
  }

  resetAllControllers(channelNumber) {
    Object.assign(this.channels[channelNumber], this.effectSettings);
  }

  allNotesOff(channelNumber) {
    const now = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const velocity = 0;
    const stopPedal = false;
    const promises = [];
    channel.scheduledNotes.forEach((noteList) => {
      const activeNote = this.getActiveNote(noteList, now);
      if (activeNote) {
        const notePromise = this.scheduleNoteRelease(
          channelNumber,
          noteNumber,
          velocity,
          now,
          stopPedal,
        );
        promises.push(notePromise);
      }
    });
    return promises;
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
            console.warn(`Unsupported Exclusive Message ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message ${data}`);
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
            console.warn(`Unsupported Exclusive Message ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message ${data}`);
    }
  }

  handleMasterVolumeSysEx(data) {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.handleMasterVolume(volume);
  }

  handleMasterVolume(volume) {
    if (volume < 0 && 1 < volume) {
      console.error("Master Volume is out of range");
    } else {
      const now = this.audioContext.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(volume * volume, now);
    }
  }

  handleExclusiveMessage(data) {
    console.warn(`Unsupported Exclusive Message ${data}`);
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
