import { parseMidi } from "midi-file";
import { parse, SoundFont } from "@marmooo/soundfont-parser";
import { OggVorbisDecoderWebWorker } from "@wasm-audio-decoders/ogg-vorbis";

// Cache mode
// - "none"  for full real-time control (dynamic CC, LFO, pitch)
// - "ads"   for real-time playback with higher cache hit rate
// - "adsr"  for real-time playback with accurate release envelope
// - "note"  for efficient playback when note behavior is fixed
// - "audio" for fully pre-rendered playback (lowest CPU)
//
// "none"
//   No caching. Envelope processing is done in real time on every note.
//   Uses Web Audio API nodes directly, so LFO and pitch envelope are
//   fully supported. Higher CPU usage.
// "ads"
//   Pre-renders the ADS (Attack-Decay-Sustain) phase into an
//   OfflineAudioContext and caches the result. The sustain tail is
//   aligned to the loop boundary as a fixed buffer. Release is
//   handled by fading volumeNode gain to 0 at note-off.
//   LFO effects (modLfoToPitch, modLfoToFilterFc, modLfoToVolume,
//   vibLfoToPitch) are applied in real time after playback starts.
// "adsr"
//   Pre-renders the full ADSR envelope (Attack-Decay-Sustain-Release)
//   into an OfflineAudioContext. The cache key includes the note
//   duration in ticks (tempo-independent) and the volRelease parameter,
//   so notes with the same duration and release shape share a buffer.
//   LFO effects are applied in real time after playback starts,
//   same as "ads" mode. Higher cache hit rate than "note" mode
//   because LFO variations do not produce separate cache entries.
// "note"
//   Renders the full noteOn-to-noteOff duration per note in an
//   OfflineAudioContext. All events during the note (volume,
//   expression, pitch bend, LFO, CC#1) are baked into the buffer,
//   so no real-time processing is needed during playback. Greatly
//   reduces CPU load for songs with many simultaneous notes.
//   MIDI file playback only — does not respond to real-time CC changes.
// "audio"
//   Renders the entire MIDI file into a single AudioBuffer offline.
//   Call render() to complete rendering before calling start().
//   Playback simply streams an AudioBufferSourceNode, so CPU usage
//   is near zero. Seek and tempo changes are handled in real time.
//   A "rendering" event is dispatched when rendering starts, and a
//   "rendered" event is dispatched when rendering completes.
/** @type {"none"|"ads"|"adsr"|"note"|"audio"} */
const DEFAULT_CACHE_MODE = "ads";

const _f64Buf = new ArrayBuffer(8);
const _f64Array = new Float64Array(_f64Buf);
const _u64Array = new BigUint64Array(_f64Buf);
function f64ToBigInt(value) {
  _f64Array[0] = value;
  return _u64Array[0];
}

let decoderPromise = null;
let decoderQueue = Promise.resolve();

function initDecoder() {
  if (!decoderPromise) {
    const instance = new OggVorbisDecoderWebWorker();
    decoderPromise = instance.ready.then(() => instance);
  }
  return decoderPromise;
}

class Note {
  voice;
  voiceParams;
  adjustedBaseFreq = 20000;
  index = -1;
  ending = false;
  bufferSource;
  timelineIndex = null;
  renderedBuffer = null;
  fullCacheVoiceId = null;
  filterEnvelopeNode;
  volumeEnvelopeNode;
  modLfo; // CC#1 modulation LFO
  modLfoToPitch;
  modLfoToFilterFc;
  modLfoToVolume;

  constructor(noteNumber, velocity, startTime) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
}

class Channel {
  channelNumber = 0;
  isDrum = false;
  programNumber = 0;
  scheduleIndex = 0;
  detune = 0;
  dataMSB = 0;
  dataLSB = 0;
  rpnMSB = 127;
  rpnLSB = 127;
  modulationDepthRange = 50; // cent
  fineTuning = 0; // cent
  coarseTuning = 0; // cent
  scheduledNotes = [];
  sustainNotes = [];
  currentBufferSource = null;

  constructor(channelNumber, audioNodes, settings) {
    this.channelNumber = channelNumber;
    Object.assign(this, audioNodes);
    Object.assign(this, settings);
    this.state = new ControllerState();
  }

  resetSettings(settings) {
    Object.assign(this, settings);
  }
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

class RenderedBuffer {
  buffer;
  isLoop;
  isFull;
  adsDuration;
  loopStart;
  loopDuration;
  noteDuration;
  releaseDuration;

  constructor(buffer, meta = {}) {
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

function cbToRatio(cb) {
  return Math.pow(10, cb / 200);
}

const decayCurve = 1 / (-Math.log(cbToRatio(-1000)));
const releaseCurve = 1 / (-Math.log(cbToRatio(-600)));

export class MidyGM1 extends EventTarget {
  // https://pmc.ncbi.nlm.nih.gov/articles/PMC4191557/
  // https://pubmed.ncbi.nlm.nih.gov/12488797/
  // Gap detection studies indicate humans detect temporal discontinuities
  // around 2–3 ms. Smoothing over ~4 ms is perceived as continuous.
  perceptualSmoothingTime = 0.004;
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
  decodeMethod = "wasm-audio-decoders";
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  totalTimeEventTypes = new Set(["noteOff"]);
  tempo = 1;
  loop = false;
  playPromise;
  timeline = [];
  notePromises = [];
  instruments = new Set();
  exclusiveClassNotes = new Array(128);
  // "adsr" mode
  adsrVoiceCache = new Map();
  // "note" mode
  noteOnDurations = new Map();
  noteOnEvents = new Map();
  fullVoiceCache = new Map();
  // "audio" mode
  renderedAudioBuffer = null;
  isRendering = false;
  audioModeBufferSource = null;

  static channelSettings = {
    scheduleIndex: 0,
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

  constructor(audioContext, options = {}) {
    super();
    this.audioContext = audioContext;
    this.cacheMode = options.cacheMode ?? DEFAULT_CACHE_MODE;
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
    if (this.cacheMode === "audio") {
      await this.render();
    }
  }

  buildNoteOnDurations() {
    const { timeline, totalTime, noteOnDurations, noteOnEvents, numChannels } =
      this;
    noteOnDurations.clear();
    noteOnEvents.clear();
    const inverseTempo = 1 / this.tempo;
    const sustainPedal = new Uint8Array(numChannels);
    const activeNotes = new Map();
    const pendingOff = new Map();
    const finalizeEntry = (entry, endTime, endTicks) => {
      const duration = Math.max(0, endTime - entry.startTime);
      const durationTicks = (endTicks == null || endTicks === Infinity)
        ? Infinity
        : Math.max(0, endTicks - entry.startTicks);
      noteOnDurations.set(entry.idx, duration);
      noteOnEvents.set(entry.idx, {
        duration,
        durationTicks,
        startTime: entry.startTime,
        events: entry.events,
      });
    };
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const t = event.startTime * inverseTempo;
      switch (event.type) {
        case "noteOn": {
          const key = event.noteNumber * numChannels + event.channel;
          if (!activeNotes.has(key)) activeNotes.set(key, []);
          activeNotes.get(key).push({
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
          const ch = event.channel;
          const key = event.noteNumber * numChannels + ch;
          if (sustainPedal[ch]) {
            if (!pendingOff.has(key)) pendingOff.set(key, []);
            pendingOff.get(key).push({ t, ticks: event.ticks });
          } else {
            const stack = activeNotes.get(key);
            if (stack && stack.length > 0) {
              finalizeEntry(stack.shift(), t, event.ticks);
              if (stack.length === 0) activeNotes.delete(key);
            }
          }
          break;
        }
        case "controller": {
          const ch = event.channel;
          for (const [key, entries] of activeNotes) {
            if (key % numChannels !== ch) continue;
            for (const entry of entries) entry.events.push(event);
          }
          switch (event.controllerType) {
            case 64: { // Sustain Pedal
              const on = event.value >= 64;
              sustainPedal[ch] = on ? 1 : 0;
              if (!on) {
                for (const [key, offItems] of pendingOff) {
                  if (key % numChannels !== ch) continue;
                  const activeStack = activeNotes.get(key);
                  for (const { t: offTime, ticks: offTicks } of offItems) {
                    if (activeStack && activeStack.length > 0) {
                      finalizeEntry(activeStack.shift(), offTime, offTicks);
                      if (activeStack.length === 0) activeNotes.delete(key);
                    }
                  }
                  pendingOff.delete(key);
                }
              }
              break;
            }
            case 121: // Reset All Controllers
              sustainPedal[ch] = 0;
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
        case "sysEx":
          if (
            event.data[0] === 126 && event.data[1] === 9 && event.data[2] === 3
          ) {
            // GM1 System On
            if (event.data[3] === 1) {
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
        case "pitchBend":
        case "programChange": {
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

  cacheVoiceIds() {
    const { channels, timeline, voiceCounter, cacheMode } = this;
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "noteOn": {
          const audioBufferId = this.getVoiceId(
            channels[event.channel],
            event.noteNumber,
            event.velocity,
          );
          voiceCounter.set(
            audioBufferId,
            (voiceCounter.get(audioBufferId) ?? 0) + 1,
          );
          break;
        }
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            event.startTime,
          );
      }
    }
    for (const [audioBufferId, count] of voiceCounter) {
      if (count === 1) voiceCounter.delete(audioBufferId);
    }
    this.GM1SystemOn();
    if (cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio") {
      this.buildNoteOnDurations();
    }
  }

  getVoiceId(channel, noteNumber, velocity) {
    const programNumber = channel.programNumber;
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return;
    let bank = channel.isDrum ? 128 : 0;
    if (bankTable[bank] === undefined) {
      if (channel.isDrum) return;
      bank = 0;
    }
    const soundFontIndex = bankTable[bank];
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(bank, programNumber, noteNumber, velocity);
    if (!voice) return;
    const { instrument, sampleID } = voice.generators;
    return soundFontIndex * (2 ** 31) + instrument * (2 ** 24) +
      (sampleID << 8);
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
    return { gainL, gainR, merger };
  }

  createChannels(audioContext) {
    const settings = this.constructor.channelSettings;
    return Array.from(
      { length: this.numChannels },
      (_, ch) =>
        new Channel(ch, this.createChannelAudioNodes(audioContext), settings),
    );
  }

  decodeOggVorbis(sample) {
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
    decoderQueue = task.catch(() => {});
    return task;
  }

  async createAudioBuffer(voiceParams) {
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

  createBufferSource(voiceParams, renderedOrRaw) {
    const isRendered = renderedOrRaw instanceof RenderedBuffer;
    const audioBuffer = isRendered ? renderedOrRaw.buffer : renderedOrRaw;
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    const isLoop = isRendered
      ? renderedOrRaw.isLoop
      : voiceParams.sampleModes % 2 !== 0;
    bufferSource.loop = isLoop;
    if (bufferSource.loop) {
      if (isRendered && renderedOrRaw.adsDuration != null) {
        bufferSource.loopStart = renderedOrRaw.loopStart;
        bufferSource.loopEnd = renderedOrRaw.loopStart +
          renderedOrRaw.loopDuration;
      } else {
        bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
        bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
      }
    }
    return bufferSource;
  }

  scheduleTimelineEvents(scheduleTime, queueIndex) {
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
      switch (event.type) {
        case "noteOn": {
          const note = this.createNote(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
          );
          note.timelineIndex = queueIndex;
          this.setupNote(event.channel, note, startTime);
          break;
        }
        case "noteOff":
          this.noteOff(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
            false, // force
          );
          break;
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
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    for (let i = 0; i < timeline.length; i++) {
      if (second <= timeline[i].startTime * inverseTempo) {
        return i;
      }
    }
    return 0;
  }

  resetAllStates() {
    this.exclusiveClassNotes.fill(undefined);
    this.voiceCache.clear();
    this.realtimeVoiceCache.clear();
    this.adsrVoiceCache.clear();
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      channels[ch].scheduledNotes = [];
      this.resetChannelStates(ch);
    }
  }

  updateStates(queueIndex, nextQueueIndex) {
    const { timeline, resumeTime } = this;
    const inverseTempo = 1 / this.tempo;
    const now = this.audioContext.currentTime;
    if (nextQueueIndex < queueIndex) queueIndex = 0;
    for (let i = queueIndex; i < nextQueueIndex; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "controller":
          this.setControlChange(
            event.channel,
            event.controllerType,
            event.value,
            now - resumeTime + event.startTime * inverseTempo,
          );
          break;
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            now - resumeTime + event.startTime * inverseTempo,
          );
          break;
        case "pitchBend":
          this.setPitchBend(
            event.channel,
            event.value + 8192,
            now - resumeTime + event.startTime * inverseTempo,
          );
          break;
        case "sysEx":
          this.handleSysEx(
            event.data,
            now - resumeTime + event.startTime * inverseTempo,
          );
      }
    }
  }

  async playAudioBuffer() {
    const audioContext = this.audioContext;
    const paused = this.isPaused;
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = audioContext.currentTime;
    if (paused) {
      this.dispatchEvent(new Event("resumed"));
    } else {
      this.dispatchEvent(new Event("started"));
    }
    let exitReason;
    outer: while (true) {
      const buffer = this.renderedAudioBuffer;
      const bufferSource = new AudioBufferSourceNode(audioContext, { buffer });
      bufferSource.playbackRate.value = this.tempo;
      bufferSource.connect(this.masterVolume);
      const offset = Math.min(Math.max(this.resumeTime, 0), buffer.duration);
      bufferSource.start(audioContext.currentTime, offset);
      this.audioModeBufferSource = bufferSource;
      let naturalEnded = false;
      bufferSource.onended = () => {
        naturalEnded = true;
      };
      while (true) {
        const now = audioContext.currentTime;
        await this.scheduleTask(() => {}, now + this.noteCheckInterval);
        if (naturalEnded || this.currentTime() >= this.totalTime) {
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          if (this.loop) {
            this.resumeTime = 0;
            this.startTime = audioContext.currentTime;
            this.dispatchEvent(new Event("looped"));
            continue outer;
          }
          await audioContext.suspend();
          exitReason = "ended";
          break outer;
        }
        if (this.isPausing) {
          this.resumeTime = this.currentTime();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          await audioContext.suspend();
          this.isPausing = false;
          exitReason = "paused";
          break outer;
        } else if (this.isStopping) {
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          await audioContext.suspend();
          this.isStopping = false;
          exitReason = "stopped";
          break outer;
        } else if (this.isSeeking) {
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          this.startTime = audioContext.currentTime;
          this.isSeeking = false;
          this.dispatchEvent(new Event("seeked"));
          continue outer;
        }
      }
    }
    this.isPlaying = false;
    if (exitReason === "paused") {
      this.isPaused = true;
      this.dispatchEvent(new Event("paused"));
    } else if (exitReason !== undefined) {
      this.isPaused = false;
      this.dispatchEvent(new Event(exitReason));
    }
  }

  async playNotes() {
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
    let exitReason;
    this.notePromises = [];
    while (true) {
      const now = audioContext.currentTime;
      if (
        this.totalTime < this.currentTime() ||
        this.timeline.length <= queueIndex
      ) {
        await this.stopNotes(0, true, now);
        if (this.loop) {
          this.resetAllStates();
          this.startTime = audioContext.currentTime;
          this.resumeTime = 0;
          queueIndex = 0;
          this.dispatchEvent(new Event("looped"));
          continue;
        } else {
          await audioContext.suspend();
          exitReason = "ended";
          break;
        }
      }
      if (this.isPausing) {
        await this.stopNotes(0, true, now);
        await audioContext.suspend();
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        await this.stopNotes(0, true, now);
        await audioContext.suspend();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.stopNotes(0, true, now);
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
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      this.stopChannelNotes(ch, velocity, force, scheduleTime);
    }
    const stopPromise = Promise.all(this.notePromises);
    this.notePromises = [];
    return stopPromise;
  }

  async render() {
    if (this.isRendering) return;
    if (this.timeline.length === 0) return;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    this.isRendering = true;
    this.renderedAudioBuffer = null;
    this.dispatchEvent(new Event("rendering"));
    const sampleRate = this.audioContext.sampleRate;
    const totalSamples = Math.ceil(
      (this.totalTime + this.startDelay) * sampleRate,
    );
    const renderProgramNumber = new Uint8Array(this.numChannels);
    const renderIsDrum = new Uint8Array(this.numChannels);
    renderIsDrum[9] = 1;
    const renderControllerStates = Array.from(
      { length: this.numChannels },
      () => {
        const state = new Float32Array(256);
        for (
          const { type, defaultValue } of Object.values(defaultControllerState)
        ) {
          state[type] = defaultValue;
        }
        return state;
      },
    );
    const tasks = [];
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const ch = event.channel;
      switch (event.type) {
        case "noteOn": {
          const noteEvent = this.noteOnEvents.get(i);
          const noteDuration = noteEvent?.duration ??
            this.noteOnDurations.get(i) ??
            0;
          if (noteDuration <= 0) continue;
          const { noteNumber, velocity } = event;
          const isDrum = renderIsDrum[ch] === 1;
          const programNumber = renderProgramNumber[ch];
          const bankTable = this.soundFontTable[programNumber];
          if (!bankTable) continue;
          let bank = isDrum ? 128 : 0;
          if (bankTable[bank] === undefined) {
            if (isDrum) continue;
            bank = 0;
          }
          const soundFontIndex = bankTable[bank];
          if (soundFontIndex === undefined) continue;
          const soundFont = this.soundFonts[soundFontIndex];
          const fakeChannel = {
            channelNumber: ch,
            state: { array: renderControllerStates[ch].slice() },
            programNumber,
            isDrum,
            modulationDepthRange: 50,
            detune: 0,
          };
          const controllerState = this.getControllerState(
            fakeChannel,
            noteNumber,
            velocity,
          );
          const voice = soundFont.getVoice(
            bank,
            programNumber,
            noteNumber,
            velocity,
          );
          if (!voice) continue;
          const voiceParams = voice.getAllParams(controllerState);
          const t = event.startTime * inverseTempo + this.startDelay;
          const fakeNote = { voiceParams, channel: ch, noteNumber, velocity };
          const promise = (async () => {
            try {
              return await this.createFullRenderedBuffer(
                fakeChannel,
                fakeNote,
                voiceParams,
                noteDuration,
                noteEvent,
              );
            } catch (err) {
              console.warn("render: note render failed", err);
              return null;
            }
          })();
          tasks.push({ t, promise, fakeChannel });
          break;
        }
        case "controller": {
          const { controllerType, value } = event;
          const stateIndex = 128 + controllerType;
          if (stateIndex < 256) {
            renderControllerStates[ch][stateIndex] = value / 127;
          }
          break;
        }
        case "pitchBend":
          renderControllerStates[ch][14] = (event.value + 8192) / 16383;
          break;
        case "programChange":
          renderProgramNumber[ch] = event.programNumber;
          break;
        case "sysEx": {
          const data = event.data;
          if (data[0] === 126 && data[1] === 9 && data[2] === 3) {
            if (data[3] === 1) { // GM1 System On
              renderProgramNumber.fill(0);
              renderIsDrum.fill(0);
              renderIsDrum[9] = 1;
              for (let c = 0; c < this.numChannels; c++) {
                for (
                  const { type, defaultValue } of Object.values(
                    defaultControllerState,
                  )
                ) {
                  renderControllerStates[c][type] = defaultValue;
                }
              }
            }
          }
          break;
        }
      }
    }
    const offlineContext = new OfflineAudioContext(2, totalSamples, sampleRate);
    for (let i = 0; i < tasks.length; i++) {
      const { t, promise } = tasks[i];
      const noteBuffer = await promise;
      if (!noteBuffer) continue;
      const audioBuffer = noteBuffer instanceof RenderedBuffer
        ? noteBuffer.buffer
        : noteBuffer;
      const bufferSource = new AudioBufferSourceNode(offlineContext, {
        buffer: audioBuffer,
      });
      bufferSource.connect(offlineContext.destination);
      bufferSource.start(t);
    }
    this.renderedAudioBuffer = await offlineContext.startRendering();
    this.isRendering = false;
    this.dispatchEvent(new Event("rendered"));
    return this.renderedAudioBuffer;
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

  tempoChange(tempo) {
    const cacheMode = this.cacheMode;
    const timeScale = this.tempo / tempo;
    this.resumeTime = this.resumeTime * timeScale;
    this.tempo = tempo;
    this.totalTime = this.calcTotalTime();
    this.seekTo(this.currentTime() * timeScale);
    if (cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio") {
      this.buildNoteOnDurations();
      this.fullVoiceCache.clear();
      this.adsrVoiceCache.clear();
    }
    if (cacheMode === "audio") {
      if (this.audioModeBufferSource) {
        this.audioModeBufferSource.playbackRate.setValueAtTime(
          this.tempo,
          this.audioContext.currentTime,
        );
      }
    }
  }

  calcTotalTime() {
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

  currentTime() {
    if (!this.isPlaying) return this.resumeTime;
    const now = this.audioContext.currentTime;
    if (this.cacheMode === "audio") {
      return this.resumeTime + (now - this.startTime) * this.tempo;
    }
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
    const tuning = channel.coarseTuning + channel.fineTuning;
    const pitchWheel = channel.state.pitchWheel * 2 - 1;
    const pitchWheelSensitivity = channel.state.pitchWheelSensitivity * 12800;
    const pitch = pitchWheel * pitchWheelSensitivity;
    return tuning + pitch;
  }

  updateChannelDetune(channel, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      if (note.renderedBuffer?.isFull) return;
      this.setDetune(channel, note, scheduleTime);
    });
  }

  calcNoteDetune(channel, note) {
    return channel.detune + note.voiceParams.detune;
  }

  setVolumeEnvelope(note, scheduleTime) {
    if (!note.volumeEnvelopeNode) return;
    const { voiceParams, startTime } = note;
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
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
      .setTargetAtTime(sustainVolume, volHold, decayDuration * decayCurve);
  }

  setDetune(channel, note, scheduleTime) {
    const detune = this.calcNoteDetune(channel, note);
    const timeConstant = this.perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    note.bufferSource.detune
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(detune, scheduleTime, timeConstant);
  }

  setPitchEnvelope(note, scheduleTime) {
    const { bufferSource, voiceParams } = note;
    const baseRate = voiceParams.playbackRate;
    bufferSource.playbackRate
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(baseRate, scheduleTime);
    const modEnvToPitch = voiceParams.modEnvToPitch;
    if (modEnvToPitch === 0) return;
    const peekRate = baseRate * this.centToRate(modEnvToPitch);
    const modDelay = note.startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const decayDuration = voiceParams.modDecay;
    bufferSource.playbackRate
      .setValueAtTime(baseRate, modDelay)
      .exponentialRampToValueAtTime(peekRate, modAttack)
      .setValueAtTime(peekRate, modHold)
      .setTargetAtTime(baseRate, modHold, decayDuration * decayCurve);
  }

  clampCutoffFrequency(frequency) {
    const minFrequency = 20; // min Hz of initialFilterFc
    const maxFrequency = 20000; // max Hz of initialFilterFc
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
  }

  setFilterEnvelope(note, scheduleTime) {
    if (!note.filterEnvelopeNode) return;
    const { voiceParams, startTime } = note;
    const modEnvToFilterFc = voiceParams.modEnvToFilterFc;
    const baseCent = voiceParams.initialFilterFc;
    const peekCent = baseCent + modEnvToFilterFc;
    const sustainCent = baseCent +
      modEnvToFilterFc * (1 - voiceParams.modSustain);
    const baseFreq = this.centToHz(baseCent);
    const peekFreq = this.centToHz(peekCent);
    const sustainFreq = this.centToHz(sustainCent);
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
      .setTargetAtTime(
        adjustedSustainFreq,
        modHold,
        decayDuration * decayCurve,
      );
  }

  startModulation(channel, note, scheduleTime) {
    const audioContext = this.audioContext;
    const { voiceParams } = note;
    note.modLfo = new OscillatorNode(audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO),
    });
    note.modLfoToFilterFc = new GainNode(audioContext, {
      gain: voiceParams.modLfoToFilterFc,
    });
    note.modLfoToPitch = new GainNode(audioContext);
    this.setModLfoToPitch(channel, note, scheduleTime);
    note.modLfoToVolume = new GainNode(audioContext);
    this.setModLfoToVolume(note, scheduleTime);

    note.modLfo.start(note.startTime + voiceParams.delayModLFO);
    note.modLfo.connect(note.modLfoToFilterFc);
    if (note.filterEnvelopeNode) {
      note.modLfoToFilterFc.connect(note.filterEnvelopeNode.frequency);
    }
    note.modLfo.connect(note.modLfoToPitch);
    note.modLfoToPitch.connect(note.bufferSource.detune);
    note.modLfo.connect(note.modLfoToVolume);
    const volumeTarget = note.volumeEnvelopeNode ?? note.volumeNode;
    note.modLfoToVolume.connect(volumeTarget.gain);
  }

  async createAdsRenderedBuffer(
    note,
    voiceParams,
    audioBuffer,
    isDrum = false,
  ) {
    const isLoop = isDrum ? false : (voiceParams.sampleModes % 2 !== 0);
    const volAttack = voiceParams.volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    const adsDuration = volHold + decayDuration * decayCurve * 5;
    const sampleLoopStart = voiceParams.loopStart / voiceParams.sampleRate;
    const sampleLoopDuration = isLoop
      ? (voiceParams.loopEnd - voiceParams.loopStart) / voiceParams.sampleRate
      : 0;
    const playbackRate = voiceParams.playbackRate;
    const outputLoopStart = sampleLoopStart / playbackRate;
    const outputLoopDuration = sampleLoopDuration / playbackRate;
    const loopCount = isLoop && adsDuration > outputLoopStart
      ? Math.ceil((adsDuration - outputLoopStart) / outputLoopDuration)
      : 0;
    const alignedLoopStart = outputLoopStart + loopCount * outputLoopDuration;
    const renderDuration = isLoop
      ? alignedLoopStart + outputLoopDuration
      : audioBuffer.duration / playbackRate;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      Math.ceil(renderDuration * sampleRate),
      sampleRate,
    );
    const bufferSource = new AudioBufferSourceNode(offlineContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.playbackRate.value = playbackRate;
    bufferSource.loop = isLoop;
    if (isLoop) {
      bufferSource.loopStart = sampleLoopStart;
      bufferSource.loopEnd = sampleLoopStart + sampleLoopDuration;
    }
    const initialFreq = this.clampCutoffFrequency(
      this.centToHz(voiceParams.initialFilterFc),
    );
    const filterEnvelopeNode = new BiquadFilterNode(offlineContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10, // dB
      frequency: initialFreq,
    });
    const volumeEnvelopeNode = new GainNode(offlineContext);
    const offlineNote = {
      ...note,
      startTime: 0,
      bufferSource,
      filterEnvelopeNode,
      volumeEnvelopeNode,
    };
    this.setVolumeEnvelope(offlineNote, 0);
    this.setFilterEnvelope(offlineNote, 0);
    bufferSource.connect(filterEnvelopeNode);
    filterEnvelopeNode.connect(volumeEnvelopeNode);
    volumeEnvelopeNode.connect(offlineContext.destination);
    if (voiceParams.sample.type === "compressed") {
      bufferSource.start(0, voiceParams.start / audioBuffer.sampleRate);
    } else {
      bufferSource.start(0);
    }
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop,
      adsDuration,
      loopStart: alignedLoopStart,
      loopDuration: outputLoopDuration,
    });
  }

  async createAdsrRenderedBuffer(note, voiceParams, audioBuffer, noteDuration) {
    const isLoop = voiceParams.sampleModes % 2 !== 0;
    const volAttack = voiceParams.volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    const adsDuration = volHold + decayDuration * decayCurve * 5;
    const releaseDuration = voiceParams.volRelease;
    const loopStartTime = voiceParams.loopStart / voiceParams.sampleRate;
    const loopDuration = isLoop
      ? (voiceParams.loopEnd - voiceParams.loopStart) / voiceParams.sampleRate
      : 0;
    const noteLoopCount = isLoop && noteDuration > loopStartTime
      ? Math.ceil((noteDuration - loopStartTime) / loopDuration)
      : 0;
    const alignedNoteEnd = isLoop
      ? loopStartTime + noteLoopCount * loopDuration
      : noteDuration;
    const noteOffTime = alignedNoteEnd;
    const totalDuration = noteOffTime + releaseDuration;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const bufferSource = new AudioBufferSourceNode(offlineContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.playbackRate.value = voiceParams.playbackRate;
    bufferSource.loop = isLoop;
    if (isLoop) {
      bufferSource.loopStart = loopStartTime;
      bufferSource.loopEnd = loopStartTime + loopDuration;
    }
    const initialFreq = this.clampCutoffFrequency(
      this.centToHz(voiceParams.initialFilterFc),
    );
    const filterEnvelopeNode = new BiquadFilterNode(offlineContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10, // dB
      frequency: initialFreq,
    });
    const volumeEnvelopeNode = new GainNode(offlineContext);
    const offlineNote = {
      ...note,
      startTime: 0,
      bufferSource,
      filterEnvelopeNode,
      volumeEnvelopeNode,
    };
    this.setVolumeEnvelope(offlineNote, 0);
    this.setFilterEnvelope(offlineNote, 0);

    const attackVolume = cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelayTime = voiceParams.volDelay;
    const volAttackTime = volDelayTime + voiceParams.volAttack;
    const volHoldTime = volAttackTime + voiceParams.volHold;
    let gainAtNoteOff;
    if (noteOffTime <= volDelayTime) {
      gainAtNoteOff = 0;
    } else if (noteOffTime <= volAttackTime) {
      gainAtNoteOff = 1e-6 + (attackVolume - 1e-6) *
          (noteOffTime - volDelayTime) / voiceParams.volAttack;
    } else if (noteOffTime <= volHoldTime) {
      gainAtNoteOff = attackVolume;
    } else {
      const decayElapsed = noteOffTime - volHoldTime;
      gainAtNoteOff = sustainVolume +
        (attackVolume - sustainVolume) *
          Math.exp(-decayElapsed / (decayCurve * voiceParams.volDecay));
    }
    volumeEnvelopeNode.gain
      .cancelScheduledValues(noteOffTime)
      .setValueAtTime(gainAtNoteOff, noteOffTime)
      .setTargetAtTime(0, noteOffTime, releaseDuration * releaseCurve);
    filterEnvelopeNode.frequency
      .cancelScheduledValues(noteOffTime)
      .setValueAtTime(initialFreq, noteOffTime)
      .setTargetAtTime(
        initialFreq,
        noteOffTime,
        voiceParams.modRelease * releaseCurve,
      );

    bufferSource.connect(filterEnvelopeNode);
    filterEnvelopeNode.connect(volumeEnvelopeNode);
    volumeEnvelopeNode.connect(offlineContext.destination);
    if (isLoop) {
      bufferSource.start(0, voiceParams.start / audioBuffer.sampleRate);
    } else {
      bufferSource.start(0);
    }
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop: false,
      isFull: false,
      adsDuration,
      noteDuration: noteOffTime,
      releaseDuration,
    });
  }

  async createFullRenderedBuffer(
    channel,
    note,
    voiceParams,
    noteDuration,
    noteEvent = {},
  ) {
    const { startTime: noteStartTime = 0, events: noteEvents = [] } = noteEvent;
    const ch = channel.channelNumber;
    const releaseEndDuration = voiceParams.volRelease * releaseCurve * 5;
    const totalDuration = noteDuration + releaseEndDuration;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const offlinePlayer = new this.constructor(offlineContext, {
      cacheMode: "none",
    });
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    const dstChannel = offlinePlayer.channels[ch];
    dstChannel.state.array.set(channel.state.array);
    dstChannel.isDrum = channel.isDrum;
    dstChannel.programNumber = channel.programNumber;
    dstChannel.modulationDepthRange = channel.modulationDepthRange;
    dstChannel.detune = this.calcChannelDetune(dstChannel);
    await offlinePlayer.noteOn(ch, note.noteNumber, note.velocity, 0);
    for (const event of noteEvents) {
      const t = event.startTime / this.tempo - noteStartTime;
      if (t < 0 || t > noteDuration) continue;
      switch (event.type) {
        case "controller":
          offlinePlayer.setControlChange(
            ch,
            event.controllerType,
            event.value,
            t,
          );
          break;
        case "pitchBend":
          offlinePlayer.setPitchBend(ch, event.value + 8192, t);
          break;
        case "sysEx":
          offlinePlayer.handleSysEx(event.data, t);
      }
    }
    offlinePlayer.noteOff(ch, note.noteNumber, 0, noteDuration, true);
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop: false,
      isFull: true,
      noteDuration: noteDuration,
      releaseDuration: releaseEndDuration,
    });
  }

  async getAudioBuffer(channel, note, realtime) {
    const cacheMode = this.cacheMode;
    const { noteNumber, velocity } = note;
    const audioBufferId = this.getVoiceId(channel, noteNumber, velocity);
    if (!realtime) {
      if (cacheMode === "note") {
        return await this.getFullCachedBuffer(channel, note, audioBufferId);
      } else if (cacheMode === "adsr") {
        return await this.getAdsrCachedBuffer(note, audioBufferId);
      }
    }
    if (cacheMode === "none") {
      return await this.createAudioBuffer(note.voiceParams);
    }
    // fallback to ADS cache:
    // - "ads" (realtime or not)
    // - "adsr" + realtime
    // - "note" + realtime
    return await this.getAdsCachedBuffer(
      channel,
      note,
      audioBufferId,
      realtime,
    );
  }

  async getAdsCachedBuffer(channel, note, audioBufferId, realtime) {
    const cacheKey = audioBufferId + (note.noteNumber << 1) + 1;
    const voiceParams = note.voiceParams;
    if (realtime) {
      const cached = this.realtimeVoiceCache.get(cacheKey);
      if (cached) return cached;
      const rawBuffer = await this.createAudioBuffer(voiceParams);
      const rendered = await this.createAdsRenderedBuffer(
        note,
        voiceParams,
        rawBuffer,
        channel.isDrum,
      );
      this.realtimeVoiceCache.set(cacheKey, rendered);
      return rendered;
    } else {
      const cache = this.voiceCache.get(cacheKey);
      if (cache) {
        cache.counter += 1;
        if (cache.maxCount <= cache.counter) {
          this.voiceCache.delete(cacheKey);
        }
        return cache.audioBuffer;
      } else {
        const maxCount = this.voiceCounter.get(cacheKey) ?? 0;
        const rawBuffer = await this.createAudioBuffer(voiceParams);
        const rendered = await this.createAdsRenderedBuffer(
          note,
          voiceParams,
          rawBuffer,
          channel.isDrum,
        );
        const cache = { audioBuffer: rendered, maxCount, counter: 1 };
        this.voiceCache.set(cacheKey, cache);
        return rendered;
      }
    }
  }

  async getAdsrCachedBuffer(note, audioBufferId) {
    const voiceParams = note.voiceParams;
    const timelineIndex = note.timelineIndex;
    const noteEvent = this.noteOnEvents.get(timelineIndex);
    const noteDurationTicks = noteEvent?.durationTicks ?? 0;
    const safeTicks = noteDurationTicks === Infinity
      ? 0xFFFFFFFFn
      : BigInt(noteDurationTicks);
    const volReleaseBits = f64ToBigInt(voiceParams.volRelease);
    const playbackRateBits = f64ToBigInt(voiceParams.playbackRate);
    const cacheKey = (BigInt(audioBufferId) << 160n) |
      (playbackRateBits << 96n) |
      (safeTicks << 64n) |
      volReleaseBits;
    let durationMap = this.adsrVoiceCache.get(audioBufferId);
    if (!durationMap) {
      durationMap = new Map();
      this.adsrVoiceCache.set(audioBufferId, durationMap);
    }
    const cached = durationMap.get(cacheKey);
    if (cached instanceof RenderedBuffer) {
      return cached;
    }
    if (cached instanceof Promise) {
      const buf = await cached;
      if (buf == null) return await this.createAudioBuffer(voiceParams);
      return buf;
    }
    const noteDuration = noteEvent?.duration ?? 0;
    const renderPromise = (async () => {
      try {
        const rawBuffer = await this.createAudioBuffer(voiceParams);
        const rendered = await this.createAdsrRenderedBuffer(
          note,
          voiceParams,
          rawBuffer,
          noteDuration,
        );
        durationMap.set(cacheKey, rendered);
        return rendered;
      } catch (err) {
        durationMap.delete(cacheKey);
        throw err;
      }
    })();
    durationMap.set(cacheKey, renderPromise);
    return await renderPromise;
  }

  async getFullCachedBuffer(channel, note, audioBufferId) {
    const voiceParams = note.voiceParams;
    const timelineIndex = note.timelineIndex;
    const noteEvent = this.noteOnEvents.get(timelineIndex);
    const noteDuration = noteEvent?.duration ?? 0;
    const cacheKey = timelineIndex;
    let durationMap = this.fullVoiceCache.get(audioBufferId);
    if (!durationMap) {
      durationMap = new Map();
      this.fullVoiceCache.set(audioBufferId, durationMap);
    }
    const cached = durationMap.get(cacheKey);
    if (cached instanceof RenderedBuffer) {
      note.fullCacheVoiceId = audioBufferId;
      return cached;
    }
    if (cached instanceof Promise) {
      const buf = await cached;
      if (buf == null) return await this.createAudioBuffer(voiceParams);
      note.fullCacheVoiceId = audioBufferId;
      return buf;
    }
    const renderPromise = (async () => {
      try {
        const rendered = await this.createFullRenderedBuffer(
          channel,
          note,
          voiceParams,
          noteDuration,
          noteEvent,
        );
        durationMap.set(cacheKey, rendered);
        return rendered;
      } catch (err) {
        durationMap.delete(cacheKey);
        throw err;
      }
    })();
    durationMap.set(cacheKey, renderPromise);
    const rendered = await renderPromise;
    note.fullCacheVoiceId = audioBufferId;
    return rendered;
  }

  async setNoteAudioNode(channel, note, realtime) {
    const audioContext = this.audioContext;
    const now = audioContext.currentTime;
    const { noteNumber, velocity, startTime } = note;
    const state = channel.state;
    const controllerState = this.getControllerState(
      channel,
      noteNumber,
      velocity,
    );
    const voiceParams = note.voice.getAllParams(controllerState);
    note.voiceParams = voiceParams;

    const audioBuffer = await this.getAudioBuffer(channel, note, realtime);
    const isRendered = audioBuffer instanceof RenderedBuffer;
    note.renderedBuffer = isRendered ? audioBuffer : null;
    note.bufferSource = this.createBufferSource(voiceParams, audioBuffer);
    note.volumeNode = new GainNode(audioContext);

    const cacheMode = this.cacheMode;
    const isFullCached = isRendered && audioBuffer.isFull === true;
    if (cacheMode === "none") {
      note.volumeEnvelopeNode = new GainNode(audioContext);
      note.filterEnvelopeNode = new BiquadFilterNode(audioContext, {
        type: "lowpass",
        Q: voiceParams.initialFilterQ / 10, // dB
      });
      this.setVolumeEnvelope(note, now);
      this.setFilterEnvelope(note, now);
      this.setPitchEnvelope(note, now);
      this.setDetune(channel, note, now);
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      note.bufferSource.connect(note.filterEnvelopeNode);
      note.filterEnvelopeNode.connect(note.volumeEnvelopeNode);
      note.volumeEnvelopeNode.connect(note.volumeNode);
    } else if (isFullCached) { // "note" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      note.bufferSource.connect(note.volumeNode);
    } else { // "ads" / "asdr" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      this.setDetune(channel, note, now);
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      note.bufferSource.connect(note.volumeNode);
    }
    if (voiceParams.sample.type === "compressed") {
      note.bufferSource.start(startTime);
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

  setNoteRouting(channelNumber, note, startTime) {
    const channel = this.channels[channelNumber];
    const { volumeNode } = note;
    if (note.renderedBuffer?.isFull) {
      volumeNode.connect(this.masterVolume);
    } else {
      volumeNode.connect(channel.gainL);
      volumeNode.connect(channel.gainR);
    }
    this.handleExclusiveClass(note, channelNumber, startTime);
  }

  async noteOn(channelNumber, noteNumber, velocity, startTime) {
    const note = this.createNote(
      channelNumber,
      noteNumber,
      velocity,
      startTime,
    );
    return await this.setupNote(channelNumber, note, startTime);
  }

  createNote(channelNumber, noteNumber, velocity, startTime) {
    if (!(0 <= startTime)) startTime = this.audioContext.currentTime;
    const note = new Note(noteNumber, velocity, startTime);
    note.channel = channelNumber;
    return note;
  }

  async setupNote(channelNumber, note, startTime) {
    const realtime = startTime === undefined;
    const channel = this.channels[channelNumber];
    const programNumber = channel.programNumber;
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return;
    let bank = channel.isDrum ? 128 : 0;
    if (bankTable[bank] === undefined) {
      if (channel.isDrum) return;
      bank = 0;
    }
    const soundFontIndex = bankTable[bank];
    if (soundFontIndex === undefined) return;
    const soundFont = this.soundFonts[soundFontIndex];
    note.voice = soundFont.getVoice(
      bank,
      programNumber,
      note.noteNumber,
      note.velocity,
    );
    if (!note.voice) return;
    note.index = channel.scheduledNotes.length;
    channel.scheduledNotes.push(note);
    await this.setNoteAudioNode(channel, note, realtime);
    this.setNoteRouting(channelNumber, note, startTime);
    note.resolveReady();
    if (0.5 <= channel.state.sustainPedal) {
      channel.sustainNotes.push(note);
    }
    return note;
  }

  disconnectNote(note) {
    note.bufferSource.disconnect();
    note.filterEnvelopeNode?.disconnect();
    note.volumeEnvelopeNode?.disconnect();
    note.volumeNode.disconnect();
    if (note.modLfoToPitch) {
      note.modLfoToVolume.disconnect();
      note.modLfoToPitch.disconnect();
      note.modLfo.stop();
    }
  }

  releaseFullCache(note) {
    if (note.timelineIndex == null || note.fullCacheVoiceId == null) return;
    const durationMap = this.fullVoiceCache.get(note.fullCacheVoiceId);
    if (!durationMap) return;
    const entry = durationMap.get(note.timelineIndex);
    if (entry instanceof RenderedBuffer) {
      durationMap.delete(note.timelineIndex);
      if (durationMap.size === 0) {
        this.fullVoiceCache.delete(note.fullCacheVoiceId);
      }
    }
  }

  releaseNote(channel, note, endTime) {
    endTime ??= this.audioContext.currentTime;
    if (note.renderedBuffer?.isFull) {
      const rb = note.renderedBuffer;
      const naturalEndTime = note.startTime + rb.buffer.duration;
      const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
      const isEarlyCut = endTime < noteOffTime;
      if (isEarlyCut) {
        const volDuration = note.voiceParams.volRelease;
        const volRelease = endTime + volDuration;
        note.volumeNode.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * releaseCurve);
        note.bufferSource.stop(volRelease);
      } else {
        const now = this.audioContext.currentTime;
        if (naturalEndTime <= now) {
          this.disconnectNote(note);
          channel.scheduledNotes[note.index] = undefined;
          this.releaseFullCache(note);
          return Promise.resolve();
        }
        note.bufferSource.stop(naturalEndTime);
      }
      return new Promise((resolve) => {
        note.bufferSource.onended = () => {
          this.disconnectNote(note);
          channel.scheduledNotes[note.index] = undefined;
          this.releaseFullCache(note);
          resolve();
        };
      });
    }
    const volDuration = note.voiceParams.volRelease;
    const volRelease = endTime + volDuration;
    if (note.volumeEnvelopeNode) { // "none" mode
      note.filterEnvelopeNode.frequency
        .cancelScheduledValues(endTime)
        .setTargetAtTime(
          note.adjustedBaseFreq,
          endTime,
          note.voiceParams.modRelease * releaseCurve,
        );
      note.volumeEnvelopeNode.gain
        .cancelScheduledValues(endTime)
        .setTargetAtTime(0, endTime, volDuration * releaseCurve);
    } else { // "ads" / "adsr" mode
      const isAdsr = note.renderedBuffer?.releaseDuration != null &&
        !note.renderedBuffer.isFull;
      if (isAdsr) {
        const rb = note.renderedBuffer;
        const naturalEndTime = note.startTime + rb.buffer.duration;
        const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
        const isEarlyCut = endTime < noteOffTime;
        if (isEarlyCut) {
          note.volumeNode.gain
            .cancelScheduledValues(endTime)
            .setTargetAtTime(0, endTime, volDuration * releaseCurve);
          note.bufferSource.stop(volRelease);
        } else {
          note.bufferSource.stop(naturalEndTime);
        }
        return new Promise((resolve) => {
          note.bufferSource.onended = () => {
            this.disconnectNote(note);
            channel.scheduledNotes[note.index] = undefined;
            resolve();
          };
        });
      }
      note.volumeNode.gain
        .cancelScheduledValues(endTime)
        .setTargetAtTime(0, endTime, volDuration * releaseCurve);
    }
    note.bufferSource.stop(volRelease);
    return new Promise((resolve) => {
      note.bufferSource.onended = () => {
        this.disconnectNote(note);
        channel.scheduledNotes[note.index] = undefined;
        resolve();
      };
    });
  }

  noteOff(channelNumber, noteNumber, _velocity, endTime, force) {
    const channel = this.channels[channelNumber];
    if (!force && 0.5 <= channel.state.sustainPedal) return;
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
        return this.setControlChange(channelNumber, data1, data2, scheduleTime);
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
    if (note.modLfoToPitch) {
      const modLfoToPitch = note.voiceParams.modLfoToPitch;
      const baseDepth = Math.abs(modLfoToPitch) +
        channel.state.modulationDepthMSB;
      const depth = baseDepth * Math.sign(modLfoToPitch);
      note.modLfoToPitch.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(depth, scheduleTime);
    } else {
      this.startModulation(channel, note, scheduleTime);
    }
  }

  setModLfoToFilterFc(note, scheduleTime) {
    const modLfoToFilterFc = note.voiceParams.modLfoToFilterFc;
    note.modLfoToFilterFc.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modLfoToFilterFc, scheduleTime);
  }

  setModLfoToVolume(note, scheduleTime) {
    const modLfoToVolume = note.voiceParams.modLfoToVolume;
    const baseDepth = cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const depth = baseDepth * Math.sign(modLfoToVolume);
    note.modLfoToVolume.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(depth, scheduleTime);
  }

  setDelayModLFO(note, scheduleTime) {
    const startTime = note.startTime;
    if (startTime < scheduleTime) return;
    note.modLfo.stop(scheduleTime);
    note.modLfo.start(startTime + note.voiceParams.delayModLFO);
    note.modLfo.connect(note.modLfoToFilterFc);
  }

  setFreqModLFO(note, scheduleTime) {
    const freqModLFO = note.voiceParams.freqModLFO;
    note.modLfo.frequency
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
      delayModLFO: (channel, note, scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setDelayModLFO(note, scheduleTime);
        }
      },
      freqModLFO: (_channel, note, scheduleTime) => {
        if (0 < channel.state.modulationDepthMSB) {
          this.setFreqModLFO(note, scheduleTime);
        }
      },
      delayVibLFO: (_channel, _note, _scheduleTime) => {},
      freqVibLFO: (_channel, _note, _scheduleTime) => {},
      detune: (channel, note, scheduleTime) => {
        this.setDetune(channel, note, scheduleTime);
      },
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
      if (note.renderedBuffer?.isFull) return;
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
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
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
    const depth = channel.state.modulationDepthMSB *
      channel.modulationDepthRange;
    this.processScheduledNotes(channel, (note) => {
      if (note.renderedBuffer?.isFull) return;
      if (note.modLfoToPitch) {
        note.modLfoToPitch.gain.setValueAtTime(depth, scheduleTime);
      } else {
        this.startModulation(channel, note, scheduleTime);
      }
    });
  }

  setModulationDepth(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.modulationDepthMSB = value / 127;
    this.updateModulation(channel, scheduleTime);
  }

  setVolume(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.volumeMSB = value / 127;
    this.updateChannelVolume(channel, scheduleTime);
  }

  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta),
    };
  }

  setPan(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.panMSB = value / 127;
    this.updateChannelVolume(channel, scheduleTime);
  }

  setExpression(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.state.expressionMSB = value / 127;
    this.updateChannelVolume(channel, scheduleTime);
  }

  dataEntryLSB(channelNumber, value, scheduleTime) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber, scheduleTime);
  }

  updateChannelVolume(channel, scheduleTime) {
    const state = channel.state;
    const gain = state.volumeMSB * state.expressionMSB;
    const { gainLeft, gainRight } = this.panToGain(state.panMSB);
    channel.gainL.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainLeft, scheduleTime);
    channel.gainR.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainRight, scheduleTime);
  }

  setSustainPedal(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const state = channel.state;
    const prevValue = state.sustainPedal;
    state.sustainPedal = value / 127;
    if (64 <= value) {
      if (prevValue < 0.5) {
        this.processScheduledNotes(channel, (note) => {
          channel.sustainNotes.push(note);
        });
      }
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
      case 16383: // NULL
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

  setPitchBendRange(channelNumber, value, scheduleTime) { // [0, 12800] cent
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

  handleFineTuningRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const value = channel.dataMSB * 128 + channel.dataLSB;
    const fineTuning = (value - 8192) / 8192 * 100;
    this.setFineTuning(channelNumber, fineTuning, scheduleTime);
  }

  setFineTuning(channelNumber, value, scheduleTime) { // [-100, 100] cent
    const channel = this.channels[channelNumber];
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const prev = channel.fineTuning;
    const next = value;
    channel.fineTuning = next;
    channel.detune += next - prev;
    this.updateChannelDetune(channel, scheduleTime);
  }

  handleCoarseTuningRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitDataMSB(channel, 0, 127);
    const coarseTuning = (channel.dataMSB - 64) * 100;
    this.setCoarseTuning(channelNumber, coarseTuning, scheduleTime);
  }

  setCoarseTuning(channelNumber, value, scheduleTime) { // [-6400, 6300] cent
    const channel = this.channels[channelNumber];
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const prev = channel.coarseTuning;
    const next = value;
    channel.coarseTuning = next;
    channel.detune += next - prev;
    this.updateChannelDetune(channel, scheduleTime);
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
    channel.resetSettings(this.constructor.channelSettings);
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
    const channels = this.channels;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.mode = "GM1";
    for (let ch = 0; ch < channels.length; ch++) {
      this.allSoundOff(ch, 0, scheduleTime);
      const channel = channels[ch];
      channel.isDrum = false;
    }
    channels[9].isDrum = true;
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
    const timeConstant = this.perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    this.masterVolume.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(value * value, scheduleTime, timeConstant);
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
