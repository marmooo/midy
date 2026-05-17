import { parseMidi } from "midi-file";
import { parse, SoundFont } from "@marmooo/soundfont-parser";
import { OggVorbisDecoderWebWorker } from "@wasm-audio-decoders/ogg-vorbis";
import {
  createConvolutionReverb,
  createConvolutionReverbImpulse,
  createDattorroReverb,
  createFDNDefault,
  createFreeverb,
  createMoorerReverbDefault,
  createSchroederReverb,
  createVelvetNoiseReverb,
} from "./reverb.js";

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
  volumeNode; // polyphonic key pressure
  modLfo; // CC#1 modulation LFO
  modLfoToPitch;
  modLfoToFilterFc;
  modLfoToVolume;
  vibLfo; // vibrato LFO
  vibLfoToPitch;
  reverbSend;
  chorusSend;
  portamentoNoteNumber = -1;
  pressure = 0;

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
  detune = 0;
  bankMSB = 121;
  bankLSB = 0;
  dataMSB = 0;
  dataLSB = 0;
  rpnMSB = 127;
  rpnLSB = 127;
  mono = false; // CC#124, CC#125
  modulationDepthRange = 50; // cent
  fineTuning = 0; // cent
  coarseTuning = 0; // cent
  activeNotes = new Array(128);
  sustainNotes = [];
  sostenutoNotes = [];
  controlTable = new Int8Array(defaultControlValues);
  scaleOctaveTuningTable = new Float32Array(12); // [-100, 100] cent
  channelPressureTable = new Int8Array(defaultPressureValues);
  polyphonicKeyPressureTable = new Int8Array(defaultPressureValues);
  keyBasedTable = new Int8Array(128 * 128).fill(-1);
  keyBasedGainLs = new Array(128);
  keyBasedGainRs = new Array(128);
  lastNote = null;
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

  resetTable() {
    this.controlTable.set(defaultControlValues);
    this.scaleOctaveTuningTable.fill(0); // [-100, 100] cent
    this.channelPressureTable.set(defaultPressureValues);
    this.polyphonicKeyPressureTable.set(defaultPressureValues);
    this.keyBasedTable.fill(-1);
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
  modulationDepthMSB: { type: 128 + 1, defaultValue: 0 },
  portamentoTimeMSB: { type: 128 + 5, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volumeMSB: { type: 128 + 7, defaultValue: 100 / 127 },
  panMSB: { type: 128 + 10, defaultValue: 64 / 127 },
  expressionMSB: { type: 128 + 11, defaultValue: 1 },
  // bankLSB: { type: 128 + 32, defaultValue: 0, },
  modulationDepthLSB: { type: 128 + 33, defaultValue: 0 },
  portamentoTimeLSB: { type: 128 + 37, defaultValue: 0 },
  // dataLSB: { type: 128 + 38, defaultValue: 0, },
  volumeLSB: { type: 128 + 39, defaultValue: 0 },
  panLSB: { type: 128 + 42, defaultValue: 0 },
  expressionLSB: { type: 128 + 43, defaultValue: 0 },
  sustainPedal: { type: 128 + 64, defaultValue: 0 },
  portamento: { type: 128 + 65, defaultValue: 0 },
  sostenutoPedal: { type: 128 + 66, defaultValue: 0 },
  softPedal: { type: 128 + 67, defaultValue: 0 },
  filterResonance: { type: 128 + 71, defaultValue: 64 / 127 },
  releaseTime: { type: 128 + 72, defaultValue: 64 / 127 },
  attackTime: { type: 128 + 73, defaultValue: 64 / 127 },
  brightness: { type: 128 + 74, defaultValue: 64 / 127 },
  decayTime: { type: 128 + 75, defaultValue: 64 / 127 },
  vibratoRate: { type: 128 + 76, defaultValue: 64 / 127 },
  vibratoDepth: { type: 128 + 77, defaultValue: 64 / 127 },
  vibratoDelay: { type: 128 + 78, defaultValue: 64 / 127 },
  portamentoNoteNumber: { type: 128 + 84, defaultValue: 0 },
  reverbSendLevel: { type: 128 + 91, defaultValue: 0 },
  chorusSendLevel: { type: 128 + 93, defaultValue: 0 },
  // dataIncrement: { type: 128 + 96, defaultValue: 0 },
  // dataDecrement: { type: 128 + 97, defaultValue: 0 },
  // rpnLSB: { type: 128 + 100, defaultValue: 127 },
  // rpnMSB: { type: 128 + 101, defaultValue: 127 },
  // rpgMakerLoop: { type: 128 + 111, defaultValue: 0 },
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

const effectParameters = [
  2400 / 64, // cent
  9600 / 64, // cent
  1 / 64,
  600 / 127, // cent
  2400 / 127, // cent
  1 / 127,
];
const pressureBaselines = new Int8Array([64, 64, 0, 0, 0, 0]);
const defaultPressureValues = new Int8Array([64, 64, 64, 0, 0, 0]);
const defaultControlValues = new Int8Array([
  ...[-1, -1, -1, -1, -1, -1],
  ...defaultPressureValues,
]);

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

export class Midy extends EventTarget {
  // https://pmc.ncbi.nlm.nih.gov/articles/PMC4191557/
  // https://pubmed.ncbi.nlm.nih.gov/12488797/
  // Gap detection studies indicate humans detect temporal discontinuities
  // around 2–3 ms. Smoothing over ~4 ms is perceived as continuous.
  perceptualSmoothingTime = 0.004;
  mode = "GM2";
  masterFineTuning = 0; // cent
  masterCoarseTuning = 0; // cent
  reverb = {
    algorithm: "Schroeder",
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
  lastActiveSensing = 0;
  activeSensingThreshold = 0.3;
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
  loopStart = 0;
  playPromise;
  timeline = [];
  notePromises = [];
  instruments = new Set();
  exclusiveClassNotes = new Array(128);
  drumExclusiveClassNotes = new Array(
    this.numChannels * drumExclusiveClassCount,
  );
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
  // MPE
  mpeEnabled = false;
  lowerMPEMembers = 0;
  upperMPEMembers = 0;
  mpeState = {
    channelToNotes: new Map(),
  };

  static channelSettings = {
    detune: 0,
    programNumber: 0,
    bankMSB: 121,
    bankLSB: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    mono: false, // CC#124, CC#125
    modulationDepthRange: 50, // cent
    fineTuning: 0, // cent
    coarseTuning: 0, // cent
    portamentoControl: false,
    isMPEMember: false,
    isMPEManager: false,
  };

  constructor(audioContext) {
    super();
    this.audioContext = audioContext;
    this.cacheMode = DEFAULT_CACHE_MODE;
    this.masterVolume = new GainNode(audioContext);
    this.scheduler = new GainNode(audioContext, { gain: 0 });
    this.schedulerBuffer = new AudioBuffer({
      length: 1,
      sampleRate: audioContext.sampleRate,
    });
    this.messageHandlers = this.createMessageHandlers();
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.keyBasedControllerHandlers = this.createKeyBasedControllerHandlers();
    this.effectHandlers = this.createEffectHandlers();
    this.channels = this.createChannels();
    this.reverbEffect = this.createReverbEffect(this.reverb.algorithm);
    this.chorusEffect = this.createChorusEffect();
    this.chorusEffect.output.connect(this.masterVolume);
    this.reverbEffect.output.connect(this.masterVolume);
    this.masterVolume.connect(audioContext.destination);
    this.scheduler.connect(audioContext.destination);
    this.GM2SystemOn();
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
    const sostenutoPedal = new Uint8Array(numChannels);
    const sostenutoKeys = new Array(numChannels).fill(null).map(() =>
      new Set()
    );
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
          const isSostenuto = sostenutoKeys[ch].has(key);
          if (sustainPedal[ch] || isSostenuto) {
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
            case 66: { // Sostenuto Pedal
              const on = event.value >= 64;
              if (on && !sostenutoPedal[ch]) {
                for (const [key] of activeNotes) {
                  if (key % numChannels === ch) sostenutoKeys[ch].add(key);
                }
              } else if (!on) {
                sostenutoKeys[ch].clear();
              }
              sostenutoPedal[ch] = on ? 1 : 0;
              break;
            }
            case 121: // Reset All Controllers
              sustainPedal[ch] = 0;
              sostenutoPedal[ch] = 0;
              sostenutoKeys[ch].clear();
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
            // GM1 System On / GM2 System On
            if (event.data[3] === 1 || event.data[3] === 3) {
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
        case "programChange":
        case "channelAftertouch":
        case "noteAftertouch": {
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
    for (const [audioBufferId, count] of voiceCounter) {
      if (count === 1) voiceCounter.delete(audioBufferId);
    }
    this.GM2SystemOn();
    if (cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio") {
      this.buildNoteOnDurations();
    }
  }

  getVoiceId(channel, noteNumber, velocity) {
    const programNumber = channel.programNumber;
    const bankTable = this.soundFontTable[programNumber];
    if (!bankTable) return;
    let bank = channel.isDrum ? 128 : channel.bankLSB;
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

  createChannels() {
    const settings = this.constructor.channelSettings;
    const audioContext = this.audioContext;
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

  isLoopDrum(channel, noteNumber) {
    const programNumber = channel.programNumber;
    return ((programNumber === 48 && noteNumber === 88) ||
      (programNumber === 56 && 47 <= noteNumber && noteNumber <= 84));
  }

  createBufferSource(channel, noteNumber, voiceParams, renderedOrRaw) {
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
          break;
        case "channelAftertouch":
          this.setChannelPressure(event.channel, event.amount, startTime);
          break;
        case "noteAftertouch":
          this.setPolyphonicKeyPressure(
            event.channel,
            event.noteNumber,
            event.amount,
            startTime,
          );
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
    this.drumExclusiveClassNotes.fill(undefined);
    this.voiceCache.clear();
    this.realtimeVoiceCache.clear();
    this.adsrVoiceCache.clear();
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.lastNote = null;
      channel.activeNotes = new Array(128);
      channel.sustainNotes = [];
      channel.sostenutoNotes = [];
      this.resetChannelStates(ch);
    }
    this.mpeState.channelToNotes.clear();
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
          break;
        case "channelAftertouch":
          this.setChannelPressure(
            event.channel,
            event.amount,
            now - resumeTime + event.startTime * inverseTempo,
          );
          break;
        case "noteAftertouch":
          this.setPolyphonicKeyPressure(
            event.channel,
            event.noteNumber,
            event.amount,
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
        0 < this.lastActiveSensing &&
        this.activeSensingThreshold < performance.now() - this.lastActiveSensing
      ) {
        await this.stopNotes(now);
        await audioContext.suspend();
        exitReason = "aborted";
        break;
      }
      if (
        this.totalTime < this.currentTime() ||
        this.timeline.length <= queueIndex
      ) {
        const pendingPromises = this.notePromises.slice();
        this.notePromises = [];
        await Promise.allSettled(pendingPromises);
        if (this.loop) {
          this.resetAllStates();
          this.startTime = audioContext.currentTime;
          this.resumeTime = this.loopStart;
          if (0 < this.loopStart) {
            const nextQueueIndex = this.getQueueIndex(this.resumeTime);
            this.updateStates(queueIndex, nextQueueIndex);
            queueIndex = nextQueueIndex;
          } else {
            queueIndex = 0;
          }
          this.dispatchEvent(new Event("looped"));
          continue;
        } else {
          await audioContext.suspend();
          exitReason = "ended";
          break;
        }
      }
      if (this.isPausing) {
        await this.stopNotes(now);
        await audioContext.suspend();
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        await this.stopNotes(now);
        await audioContext.suspend();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.stopNotes(now);
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
      this.lastActiveSensing = 0;
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
    const bankNumber = channel.isDrum ? 128 : channel.bankLSB;
    const bank = bankNumber.toString().padStart(3, "0");
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
          case "controller":
            switch (event.controllerType) {
              case 0:
                this.setBankMSB(event.channel, event.value);
                break;
              case 32:
                this.setBankLSB(event.channel, event.value);
                break;
            }
            break;
          case "programChange": {
            const channel = channels[event.channel];
            this.setProgramChange(event.channel, event.programNumber);
            instruments.add(this.getSoundFontId(channel));
            break;
          }
          case "sysEx": {
            const data = event.data;
            if (data[0] === 126 && data[1] === 9 && data[2] === 3) {
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

  async stopChannelNotes(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    const promises = [];
    const timeConstant = this.perceptualSmoothingTime / 5;
    for (let i = 0; i < 128; i++) {
      const stack = channel.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        const promise = note.ready.then(() => {
          if (!note.voice) return;
          const now = this.audioContext.currentTime;
          const startTime = Math.max(scheduleTime, now);
          note.volumeNode.gain
            .cancelScheduledValues(startTime)
            .setTargetAtTime(0, startTime, timeConstant);
          note.bufferSource.stop(startTime + this.perceptualSmoothingTime);
        });
        promises.push(promise);
      }
    }
    await Promise.all(promises);
    channel.lastNote = null;
    channel.activeNotes = new Array(128);
    channel.sustainNotes = [];
    channel.sostenutoNotes = [];
    this.notePromises = [];
  }

  async stopNotes(scheduleTime) {
    for (let ch = 0; ch < this.channels.length; ch++) {
      await this.stopChannelNotes(ch, scheduleTime);
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
    const renderBankMSB = new Uint8Array(this.numChannels);
    const renderBankLSB = new Uint8Array(this.numChannels);
    const renderProgramNumber = new Uint8Array(this.numChannels);
    const renderIsDrum = new Uint8Array(this.numChannels);
    const renderNoteAftertouch = new Uint8Array(this.numChannels * 128);
    renderBankMSB.fill(121);
    renderIsDrum[9] = 1;
    renderBankMSB[9] = 120;
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
          let bank = isDrum ? 128 : renderBankLSB[ch];
          if (bankTable[bank] === undefined) {
            if (isDrum) continue;
            bank = 0;
          }
          const soundFontIndex = bankTable[bank];
          if (soundFontIndex === undefined) continue;
          const soundFont = this.soundFonts[soundFontIndex];
          const pressure = renderNoteAftertouch[ch * 128 + noteNumber];
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
            pressure,
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
          switch (controllerType) {
            case 0: // bankMSB
              renderBankMSB[ch] = value;
              if (this.mode === "GM2") {
                if (value === 120) {
                  renderIsDrum[ch] = 1;
                } else if (value === 121) {
                  renderIsDrum[ch] = 0;
                }
              }
              break;
            case 32: // bankLSB
              renderBankLSB[ch] = value;
              break;
            default: {
              const stateIndex = 128 + controllerType;
              if (stateIndex < 256) {
                renderControllerStates[ch][stateIndex] = value / 127;
              }
              break;
            }
          }
          break;
        }
        case "pitchBend":
          renderControllerStates[ch][14] = (event.value + 8192) / 16383;
          break;
        case "programChange":
          renderProgramNumber[ch] = event.programNumber;
          if (this.mode === "GM2") {
            if (renderBankMSB[ch] === 120) {
              renderIsDrum[ch] = 1;
            } else if (renderBankMSB[ch] === 121) {
              renderIsDrum[ch] = 0;
            }
          }
          break;
        case "sysEx": {
          const data = event.data;
          if (data[0] === 126 && data[1] === 9 && data[2] === 3) {
            if (data[3] === 1) { // GM1 System On
              renderBankMSB.fill(0);
              renderBankLSB.fill(0);
              renderProgramNumber.fill(0);
              renderIsDrum.fill(0);
              renderIsDrum[9] = 1;
              renderBankMSB[9] = 1;
              for (let c = 0; c < this.numChannels; c++) {
                for (
                  const { type, defaultValue } of Object.values(
                    defaultControllerState,
                  )
                ) {
                  renderControllerStates[c][type] = defaultValue;
                }
              }
              renderNoteAftertouch.fill(0);
            } else if (data[3] === 3) { // GM2 System On
              renderBankMSB.fill(121);
              renderBankLSB.fill(0);
              renderProgramNumber.fill(0);
              renderIsDrum.fill(0);
              renderIsDrum[9] = 1;
              renderBankMSB[9] = 120;
              for (let c = 0; c < this.numChannels; c++) {
                for (
                  const { type, defaultValue } of Object.values(
                    defaultControllerState,
                  )
                ) {
                  renderControllerStates[c][type] = defaultValue;
                }
              }
              renderNoteAftertouch.fill(0);
            }
          }
          break;
        }
        case "channelAftertouch":
          renderControllerStates[ch][13] = event.amount / 127;
          break;
        case "noteAftertouch":
          renderNoteAftertouch[ch * 128 + event.noteNumber] = event.amount;
          break;
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
    const tasks = [];
    for (let i = 0; i < 128; i++) {
      const stack = channel.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        if (note.ending) continue;
        const task = note.ready.then(() => callback(note));
        tasks.push(task);
      }
    }
    return await Promise.all(tasks);
  }

  async processActiveNotes(channel, scheduleTime, callback) {
    const tasks = [];
    for (let i = 0; i < 128; i++) {
      const stack = channel.activeNotes[i];
      if (!stack) continue;
      for (let j = 0; j < stack.length; j++) {
        const note = stack[j];
        if (note.ending) continue;
        if (scheduleTime < note.startTime) continue;
        const task = note.ready.then(() => callback(note));
        tasks.push(task);
      }
    }
    return await Promise.all(tasks);
  }

  applyToMPEChannels(channelNumber, fn) {
    fn(channelNumber);
    const channel = this.channels[channelNumber];
    if (!channel.isMPEManager) return;
    if (channelNumber === 0) {
      for (let ch = 1; ch <= this.lowerMPEMembers; ch++) {
        fn(ch);
      }
    } else if (channelNumber === 15) {
      for (let ch = 15 - this.upperMPEMembers; ch <= 14; ch++) {
        fn(ch);
      }
    }
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

  setReverbEffect(algorithm) {
    if (this.reverbEffect) this.reverbEffect.output.disconnect();
    this.reverbEffect = this.createReverbEffect(algorithm);
    this.reverb.algorithm = algorithm;
  }

  createReverbEffect(algorithm) {
    const { audioContext, reverb } = this;
    const { time: rt60, feedback } = reverb;
    switch (algorithm) {
      case "Convolution": {
        const impulse = createConvolutionReverbImpulse(
          audioContext,
          rt60,
          this.calcDelay(rt60, feedback),
        );
        return createConvolutionReverb(audioContext, impulse);
      }
      case "Schroeder": {
        const combFeedbacks = this.generateDistributedArray(feedback, 4);
        const combDelays = combFeedbacks.map((fb) => this.calcDelay(rt60, fb));
        const allpassFeedbacks = this.generateDistributedArray(feedback, 4);
        const allpassDelays = allpassFeedbacks.map((fb) =>
          this.calcDelay(rt60, fb)
        );
        return createSchroederReverb(
          audioContext,
          combFeedbacks,
          combDelays,
          allpassFeedbacks,
          allpassDelays,
        );
      }
      case "Moorer":
        return createMoorerReverbDefault(audioContext, {
          rt60,
          damping: 1 - feedback,
        });
      case "FDN":
        return createFDNDefault(audioContext, { rt60, damping: 1 - feedback });
      case "Dattorro": {
        const decay = feedback * 0.28 + 0.7;
        return createDattorroReverb(audioContext, {
          decay,
          damping: 1 - feedback,
        });
      }
      case "Freeverb": {
        const damping = 1 - feedback;
        const { inputL, inputR, outputL, outputR } = createFreeverb(
          audioContext,
          { roomSize: feedback, damping },
        );
        const inputMerger = new GainNode(audioContext);
        const outputMerger = new GainNode(audioContext, { gain: 0.5 });
        inputMerger.connect(inputL);
        inputMerger.connect(inputR);
        outputL.connect(outputMerger);
        outputR.connect(outputMerger);
        return { input: inputMerger, output: outputMerger };
      }
      case "VelvetNoise":
        return createVelvetNoiseReverb(audioContext, rt60);
      default:
        throw new Error(`Unknown reverb algorithm: ${algorithm}`);
    }
  }

  createChorusEffect() {
    const audioContext = this.audioContext;
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
    const effect = this.getChannelPitchControl(channel);
    return tuning + pitch + effect;
  }

  updateChannelDetune(channel, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      if (note.renderedBuffer?.isFull) return;
      if (this.isPortamento(channel, note)) {
        this.setPortamentoDetune(channel, note, scheduleTime);
      } else {
        this.setDetune(channel, note, scheduleTime);
      }
    });
  }

  calcScaleOctaveTuning(channel, note) {
    return channel.scaleOctaveTuningTable[note.noteNumber % 12];
  }

  calcNoteDetune(channel, note) {
    const noteDetune = note.voiceParams.detune +
      this.calcScaleOctaveTuning(channel, note);
    const pitchControl = this.getNotePitchControl(channel, note);
    return channel.detune + noteDetune + pitchControl;
  }

  getPortamentoTime(channel, note) {
    const { portamentoTimeMSB, portamentoTimeLSB } = channel.state;
    const portamentoTime = portamentoTimeMSB + portamentoTimeLSB / 128;
    const deltaSemitone = Math.abs(note.noteNumber - note.portamentoNoteNumber);
    const value = Math.ceil(portamentoTime * 128);
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
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getChannelAmplitudeControl(channel));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const portamentoTime = startTime + this.getPortamentoTime(channel, note);
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .exponentialRampToValueAtTime(sustainVolume, portamentoTime);
  }

  setVolumeEnvelope(channel, note, scheduleTime) {
    if (!note.volumeEnvelopeNode) return;
    const { voiceParams, startTime, noteNumber } = note;
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation) *
      (1 + this.getChannelAmplitudeControl(channel));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const attackTime = this.getRelativeKeyBasedValue(channel, noteNumber, 73) *
      2;
    const volAttack = volDelay + voiceParams.volAttack * attackTime;
    const volHold = volAttack + voiceParams.volHold;
    const decayTime = this.getRelativeKeyBasedValue(channel, noteNumber, 75) *
      2;
    const decayDuration = voiceParams.volDecay * decayTime;
    note.volumeEnvelopeNode.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(0, startTime)
      .setValueAtTime(1e-6, volDelay)
      .exponentialRampToValueAtTime(attackVolume, volAttack)
      .setValueAtTime(attackVolume, volHold)
      .setTargetAtTime(sustainVolume, volHold, decayDuration * decayCurve);
  }

  setVolumeNode(channel, note, scheduleTime) {
    const depth = 1 + this.getNoteAmplitudeControl(channel, note);
    const timeConstant = this.perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    note.volumeNode.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(depth, scheduleTime, timeConstant);
  }

  setPortamentoDetune(channel, note, scheduleTime) {
    if (channel.portamentoControl) {
      const state = channel.state;
      const portamentoNoteNumber = Math.ceil(state.portamentoNoteNumber * 127);
      note.portamentoNoteNumber = portamentoNoteNumber;
      channel.portamentoControl = false;
      state.portamentoNoteNumber = 0;
    }
    const detune = this.calcNoteDetune(channel, note);
    const startTime = note.startTime;
    const deltaCent = (note.noteNumber - note.portamentoNoteNumber) * 100;
    const portamentoTime = startTime + this.getPortamentoTime(channel, note);
    note.bufferSource.detune
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(detune - deltaCent, scheduleTime)
      .linearRampToValueAtTime(detune, portamentoTime);
  }

  setDetune(channel, note, scheduleTime) {
    const detune = this.calcNoteDetune(channel, note);
    const timeConstant = this.perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    note.bufferSource.detune
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(detune, scheduleTime, timeConstant);
  }

  setPortamentoPitchEnvelope(channel, note, scheduleTime) {
    const baseRate = note.voiceParams.playbackRate;
    const portamentoTime = note.startTime +
      this.getPortamentoTime(channel, note);
    note.bufferSource.playbackRate
      .cancelScheduledValues(scheduleTime)
      .exponentialRampToValueAtTime(baseRate, portamentoTime);
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

  setPortamentoFilterEnvelope(channel, note, scheduleTime) {
    if (!note.filterEnvelopeNode) return;
    const { voiceParams, startTime, noteNumber } = note;
    const softPedalFactor = this.getSoftPedalFactor(channel, note);
    const brightness = this.getRelativeKeyBasedValue(channel, noteNumber, 74) *
      2;
    const scale = softPedalFactor * brightness;
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel, note);
    const sustainCent = baseCent +
      voiceParams.modEnvToFilterFc * (1 - voiceParams.modSustain);
    const baseFreq = this.centToHz(baseCent) * scale;
    const sustainFreq = this.centToHz(sustainCent) * scale;
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const portamentoTime = startTime + this.getPortamentoTime(channel, note);
    const modDelay = startTime + voiceParams.modDelay;
    note.adjustedBaseFreq = adjustedSustainFreq;
    note.filterEnvelopeNode.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(adjustedBaseFreq, startTime)
      .setValueAtTime(adjustedBaseFreq, modDelay)
      .exponentialRampToValueAtTime(adjustedSustainFreq, portamentoTime);
  }

  setFilterEnvelope(channel, note, scheduleTime) {
    if (!note.filterEnvelopeNode) return;
    const { voiceParams, startTime, noteNumber } = note;
    const modEnvToFilterFc = voiceParams.modEnvToFilterFc;
    const baseCent = voiceParams.initialFilterFc +
      this.getFilterCutoffControl(channel, note);
    const peekCent = baseCent + modEnvToFilterFc;
    const sustainCent = baseCent +
      modEnvToFilterFc * (1 - voiceParams.modSustain);
    const softPedalFactor = this.getSoftPedalFactor(channel, note);
    const brightness = this.getRelativeKeyBasedValue(channel, noteNumber, 74) *
      2;
    const scale = softPedalFactor * brightness;
    const baseFreq = this.centToHz(baseCent) * scale;
    const peekFreq = this.centToHz(peekCent) * scale;
    const sustainFreq = this.centToHz(sustainCent) * scale;
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
    this.setModLfoToVolume(channel, note, scheduleTime);

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

  startVibrato(channel, note, scheduleTime) {
    const audioContext = this.audioContext;
    const { voiceParams, noteNumber } = note;
    const vibratoRate = this.getRelativeKeyBasedValue(channel, noteNumber, 76) *
      2;
    const vibratoDelay =
      this.getRelativeKeyBasedValue(channel, noteNumber, 78) * 2;
    note.vibLfo = new OscillatorNode(audioContext, {
      frequency: this.centToHz(voiceParams.freqVibLFO) * vibratoRate,
    });
    note.vibLfo.start(
      note.startTime + voiceParams.delayVibLFO * vibratoDelay,
    );
    note.vibLfoToPitch = new GainNode(audioContext);
    this.setVibLfoToPitch(channel, note, scheduleTime);
    note.vibLfo.connect(note.vibLfoToPitch);
    note.vibLfoToPitch.connect(note.bufferSource.detune);
  }

  async createAdsRenderedBuffer(
    channel,
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
    this.setVolumeEnvelope(channel, offlineNote, 0);
    this.setFilterEnvelope(channel, offlineNote, 0);
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

  async createAdsrRenderedBuffer(
    channel,
    note,
    voiceParams,
    audioBuffer,
    noteDuration,
  ) {
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
    this.setVolumeEnvelope(channel, offlineNote, 0);
    this.setFilterEnvelope(channel, offlineNote, 0);

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
          break;
        case "channelAftertouch":
          offlinePlayer.setChannelPressure(ch, event.amount, t);
          break;
        case "noteAftertouch":
          offlinePlayer.setPolyphonicKeyPressure(
            ch,
            event.noteNumber,
            event.amount,
            t,
          );
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
        return await this.getAdsrCachedBuffer(channel, note, audioBufferId);
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
        channel,
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
          channel,
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

  async getAdsrCachedBuffer(channel, note, audioBufferId) {
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
          channel,
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
      0, // polyphonicKeyPressure
    );
    const voiceParams = note.voice.getAllParams(controllerState);
    note.voiceParams = voiceParams;

    const audioBuffer = await this.getAudioBuffer(channel, note, realtime);
    const isRendered = audioBuffer instanceof RenderedBuffer;
    note.renderedBuffer = isRendered ? audioBuffer : null;
    note.bufferSource = this.createBufferSource(
      channel,
      noteNumber,
      voiceParams,
      audioBuffer,
    );
    note.volumeNode = new GainNode(audioContext);

    const cacheMode = this.cacheMode;
    const isFullCached = isRendered && audioBuffer.isFull === true;
    if (cacheMode === "none") {
      note.volumeEnvelopeNode = new GainNode(audioContext);
      note.filterEnvelopeNode = new BiquadFilterNode(audioContext, {
        type: "lowpass",
        Q: voiceParams.initialFilterQ / 10, // dB
      });
      const prevNote = channel.lastNote;
      if (prevNote && prevNote.noteNumber !== noteNumber) {
        note.portamentoNoteNumber = prevNote.noteNumber;
      }
      if (!channel.isDrum && this.isPortamento(channel, note)) {
        this.setPortamentoVolumeEnvelope(channel, note, now);
        this.setPortamentoFilterEnvelope(channel, note, now);
        this.setPortamentoPitchEnvelope(channel, note, now);
        this.setPortamentoDetune(channel, note, now);
      } else {
        this.setVolumeEnvelope(channel, note, now);
        this.setFilterEnvelope(channel, note, now);
        this.setPitchEnvelope(note, now);
        this.setDetune(channel, note, now);
      }
      if (0 < state.vibratoDepth) {
        this.startVibrato(channel, note, now);
      }
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      if (channel.mono && channel.currentBufferSource) {
        channel.currentBufferSource.stop(startTime);
        channel.currentBufferSource = note.bufferSource;
      }
      note.bufferSource.connect(note.filterEnvelopeNode);
      note.filterEnvelopeNode.connect(note.volumeEnvelopeNode);
      note.volumeEnvelopeNode.connect(note.volumeNode);
      this.setChorusSend(channel, note, now);
      this.setReverbSend(channel, note, now);
    } else if (isFullCached) { // "note" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      note.bufferSource.connect(note.volumeNode);
      this.setChorusSend(channel, note, now);
      this.setReverbSend(channel, note, now);
    } else { // "ads" / "asdr" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      this.setDetune(channel, note, now);
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      note.bufferSource.connect(note.volumeNode);
      this.setChorusSend(channel, note, now);
      this.setReverbSend(channel, note, now);
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
    const { volumeNode } = note;
    if (note.renderedBuffer?.isFull) {
      volumeNode.connect(this.masterVolume);
    } else {
      if (channel.isDrum) {
        const noteNumber = note.noteNumber;
        const { keyBasedGainLs, keyBasedGainRs } = channel;
        let gainL = keyBasedGainLs[noteNumber];
        let gainR = keyBasedGainRs[noteNumber];
        if (!gainL) {
          const audioNodes = this.createChannelAudioNodes(this.audioContext);
          gainL = keyBasedGainLs[noteNumber] = audioNodes.gainL;
          gainR = keyBasedGainRs[noteNumber] = audioNodes.gainR;
        }
        volumeNode.connect(gainL);
        volumeNode.connect(gainR);
      } else {
        volumeNode.connect(channel.gainL);
        volumeNode.connect(channel.gainR);
      }
    }
    this.handleExclusiveClass(note, channelNumber, startTime);
    this.handleDrumExclusiveClass(note, channelNumber, startTime);
  }

  async noteOn(channelNumber, noteNumber, velocity, startTime) {
    if (this.mpeEnabled) {
      if (!this.mpeState.channelToNotes.has(channelNumber)) {
        this.mpeState.channelToNotes.set(channelNumber, new Set());
      }
    }
    const note = this.createNote(
      channelNumber,
      noteNumber,
      velocity,
      startTime,
    );
    const result = await this.setupNote(channelNumber, note, startTime);
    if (this.mpeEnabled && result) {
      this.mpeState.channelToNotes.get(channelNumber).add(result);
    }
    return result;
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
    let bank = channel.isDrum ? 128 : channel.bankLSB;
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
    if (!channel.activeNotes[note.noteNumber]) {
      channel.activeNotes[note.noteNumber] = [];
    }
    channel.activeNotes[note.noteNumber].push(note);
    await this.setNoteAudioNode(channel, note, realtime);
    channel.lastNote = note;
    this.setNoteRouting(channelNumber, note, startTime);
    note.resolveReady();
    if (0.5 <= channel.state.sustainPedal) {
      channel.sustainNotes.push(note);
    }
    if (0.5 <= channel.state.sostenutoPedal) {
      channel.sostenutoNotes.push(note);
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
    if (note.vibLfoToPitch) {
      note.vibLfoToPitch.disconnect();
      note.vibLfo.stop();
    }
    if (note.reverbSend) {
      note.reverbSend.disconnect();
    }
    if (note.chorusSend) {
      note.chorusSend.disconnect();
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
    const now = this.audioContext.currentTime;
    endTime ??= now;

    const onEnded = () => {
      this.disconnectNote(note);
    };

    if (note.renderedBuffer?.isFull) {
      const rb = note.renderedBuffer;
      const naturalEndTime = note.startTime + rb.buffer.duration;
      const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
      const isEarlyCut = endTime < noteOffTime;
      if (isEarlyCut) {
        const releaseTime =
          this.getRelativeKeyBasedValue(channel, note.noteNumber, 72) * 2;
        const volDuration = note.voiceParams.volRelease * releaseTime;
        const volRelease = endTime + volDuration;
        note.volumeNode.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * releaseCurve);
        note.bufferSource.stop(volRelease);
      } else {
        if (naturalEndTime <= now) {
          onEnded();
          this.releaseFullCache(note);
          return Promise.resolve();
        }
        note.bufferSource.stop(naturalEndTime);
      }
      return new Promise((resolve) => {
        note.bufferSource.onended = () => {
          onEnded();
          this.releaseFullCache(note);
          resolve();
        };
      });
    }
    const releaseTime =
      this.getRelativeKeyBasedValue(channel, note.noteNumber, 72) * 2;
    const volDuration = note.voiceParams.volRelease * releaseTime;
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
            onEnded();
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
        onEnded();
        resolve();
      };
    });
  }

  noteOff(channelNumber, noteNumber, velocity, endTime, force) {
    if (this.mpeEnabled) {
      const notes = this.mpeState.channelToNotes.get(channelNumber);
      if (!notes || notes.size === 0) return;
      let targetNote = undefined;
      for (const note of notes) {
        if (note.noteNumber === noteNumber && !note.ending) {
          targetNote = note;
          break;
        }
      }
      if (!targetNote) return;
      const channel = this.channels[channelNumber];
      targetNote.ending = true;
      notes.delete(targetNote);
      if (notes.size === 0) {
        this.mpeState.channelToNotes.delete(channelNumber);
      }
      const promise = targetNote.ready.then(() => {
        return this.releaseNote(channel, targetNote, endTime);
      });
      return promise;
    } else {
      return this.stopNote(
        channelNumber,
        noteNumber,
        velocity,
        endTime,
        force,
      );
    }
  }

  stopNote(
    channelNumber,
    noteNumber,
    _velocity,
    endTime,
    force,
  ) {
    const channel = this.channels[channelNumber];
    const state = channel.state;
    if (!force) {
      if (channel.isDrum && !this.isLoopDrum(channel, noteNumber)) {
        this.removeFromActiveNotes(channel, noteNumber);
        return;
      }
      if (0.5 <= state.sustainPedal) return;
      if (0.5 <= state.sostenutoPedal) return;
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

  findNoteForOff(channel, noteNumber) {
    const stack = channel.activeNotes[noteNumber];
    if (!stack) return;
    for (let i = 0; i < stack.length; i++) {
      if (!stack[i].ending) return stack[i];
    }
  }

  removeFromActiveNotes(channel, noteNumber) {
    const stack = channel.activeNotes[noteNumber];
    if (!stack || stack.length === 0) return;
    stack.shift();
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
        true,
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
      const promise = this.noteOff(
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

  soundOffNote(note, scheduleTime) {
    note.ending = true;
    if (!note.voice) return Promise.resolve();
    const now = this.audioContext.currentTime;
    const startTime = Math.max(scheduleTime, now);
    const perceptualSmoothingTime = this.perceptualSmoothingTime;
    const timeConstant = perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    note.volumeNode.gain
      .cancelScheduledValues(startTime)
      .setTargetAtTime(0, startTime, timeConstant);
    note.bufferSource.stop(startTime + perceptualSmoothingTime);
    return new Promise((resolve) => {
      note.bufferSource.onended = () => {
        this.disconnectNote(note);
        resolve();
      };
    });
  }

  soundOff(channelNumber, noteNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    const note = this.findNoteForOff(channel, noteNumber);
    if (!note) return Promise.resolve();
    this.removeFromActiveNotes(channel, note.noteNumber);
    return this.soundOffNote(note, scheduleTime);
  }

  createMessageHandlers() {
    const handlers = new Array(256);
    // Channel Message
    handlers[0x80] = (data, scheduleTime) =>
      this.noteOff(data[0] & 0x0F, data[1], data[2], scheduleTime);
    handlers[0x90] = (data, scheduleTime) =>
      this.noteOn(data[0] & 0x0F, data[1], data[2], scheduleTime);
    handlers[0xA0] = (data, scheduleTime) =>
      this.setPolyphonicKeyPressure(
        data[0] & 0x0F,
        data[1],
        data[2],
        scheduleTime,
      );
    handlers[0xB0] = (data, scheduleTime) =>
      this.setControlChange(data[0] & 0x0F, data[1], data[2], scheduleTime);
    handlers[0xC0] = (data, scheduleTime) =>
      this.setProgramChange(data[0] & 0x0F, data[1], scheduleTime);
    handlers[0xD0] = (data, scheduleTime) =>
      this.setChannelPressure(data[0] & 0x0F, data[1], scheduleTime);
    handlers[0xE0] = (data, scheduleTime) =>
      this.handlePitchBendMessage(
        data[0] & 0x0F,
        data[1],
        data[2],
        scheduleTime,
      );
    // System Common Message
    // handlers[0xF1] = (_data, _scheduleTime) => {}; // MTC Quarter Frame
    // handlers[0xF2] = (_data, _scheduleTime) => {}; // Song Position Pointer
    // handlers[0xF3] = (_data, _scheduleTime) => {}; // Song Select
    // handlers[0xF6] = (_data, _scheduleTime) => {}; // Tune Request
    // handlers[0xF7] = (_data, _scheduleTime) => {}; // End of Exclusive (EOX)
    // System Real Time Message
    // handlers[0xF8] = (_data, _scheduleTime) => {}; // Timing Clock
    // handlers[0xFA] = (_data, _scheduleTime) => {}; // Start
    // handlers[0xFB] = (_data, _scheduleTime) => {}; // Continue
    // handlers[0xFC] = (_data, _scheduleTime) => {}; // Stop
    handlers[0xFE] = (_data, _scheduleTime) => this.activeSensing();
    // handlers[0xFF] = (_data, _scheduleTime) => {}; // Reset
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

  activeSensing() {
    this.lastActiveSensing = performance.now();
  }

  setPolyphonicKeyPressure(
    channelNumber,
    noteNumber,
    pressure,
    scheduleTime,
  ) {
    const channel = this.channels[channelNumber];
    if (channel.isMPEMember) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.processActiveNotes(channel, scheduleTime, (note) => {
      if (note.noteNumber === noteNumber) {
        note.pressure = pressure;
        this.setPolyphonicKeyPressureEffects(channel, note, scheduleTime);
      }
    });
    this.applyVoiceParams(channel, 10, scheduleTime);
  }

  setProgramChange(channelNumber, programNumber, scheduleTime) {
    this.applyToMPEChannels(channelNumber, (ch) => {
      this.applyProgramChange(ch, programNumber, scheduleTime);
    });
  }

  applyProgramChange(channelNumber, programNumber, _scheduleTime) {
    const channel = this.channels[channelNumber];
    channel.programNumber = programNumber;
    if (this.mode === "GM2") {
      switch (channel.bankMSB) {
        case 120:
          channel.isDrum = true;
          channel.keyBasedTable.fill(-1);
          break;
        case 121:
          channel.isDrum = false;
          break;
      }
    }
  }

  setChannelPressure(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.applyToMPEChannels(channelNumber, (ch) => {
      this.applyChannelPressure(ch, value, scheduleTime);
    });
  }

  applyChannelPressure(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const prev = this.calcChannelPressureEffectValue(channel, 0);
    channel.state.channelPressure = value / 127;
    const next = this.calcChannelPressureEffectValue(channel, 0);
    channel.detune += next - prev;
    this.processActiveNotes(channel, scheduleTime, (note) => {
      this.setChannelPressureEffects(channel, note, scheduleTime);
    });
    this.applyVoiceParams(channel, 13, scheduleTime);
  }

  handlePitchBendMessage(channelNumber, lsb, msb, scheduleTime) {
    const pitchBend = msb * 128 + lsb;
    this.setPitchBend(channelNumber, pitchBend, scheduleTime);
  }

  setPitchBend(channelNumber, value, scheduleTime) {
    this.applyToMPEChannels(channelNumber, (ch) => {
      this.applyPitchBend(ch, value, scheduleTime);
    });
  }

  applyPitchBend(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
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
      const { modulationDepthMSB, modulationDepthLSB } = channel.state;
      const modulationDepth = modulationDepthMSB + modulationDepthLSB / 128;
      const modLfoToPitch = note.voiceParams.modLfoToPitch +
        this.getLFOPitchDepth(channel, note);
      const baseDepth = Math.abs(modLfoToPitch) + modulationDepth;
      const depth = baseDepth * Math.sign(modLfoToPitch);
      note.modLfoToPitch.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(depth, scheduleTime);
    } else {
      this.startModulation(channel, note, scheduleTime);
    }
  }

  setVibLfoToPitch(channel, note, scheduleTime) {
    if (note.vibLfoToPitch) {
      const vibratoDepth =
        this.getRelativeKeyBasedValue(channel, note.noteNumber, 77) * 2;
      const vibLfoToPitch = note.voiceParams.vibLfoToPitch;
      const baseDepth = Math.abs(vibLfoToPitch) * vibratoDepth;
      const depth = baseDepth * Math.sign(vibLfoToPitch);
      note.vibLfoToPitch.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(depth, scheduleTime);
    } else {
      this.startVibrato(channel, note, scheduleTime);
    }
  }

  setModLfoToFilterFc(channel, note, scheduleTime) {
    const modLfoToFilterFc = note.voiceParams.modLfoToFilterFc +
      this.getLFOFilterDepth(channel, note);
    note.modLfoToFilterFc.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(modLfoToFilterFc, scheduleTime);
  }

  setModLfoToVolume(channel, note, scheduleTime) {
    const modLfoToVolume = note.voiceParams.modLfoToVolume;
    const baseDepth = cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const depth = baseDepth * Math.sign(modLfoToVolume) *
      (1 + this.getLFOAmplitudeDepth(channel, note));
    note.modLfoToVolume.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(depth, scheduleTime);
  }

  setReverbSend(channel, note, scheduleTime) {
    let value = note.voiceParams.reverbEffectsSend *
      channel.state.reverbSendLevel;
    if (channel.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel, note.noteNumber, 91);
      if (0 <= keyBasedValue) value = keyBasedValue / 127;
    }
    if (!note.reverbSend) {
      if (0 < value) {
        note.reverbSend = new GainNode(this.audioContext, { gain: value });
        note.volumeNode.connect(note.reverbSend);
        note.reverbSend.connect(this.reverbEffect.input);
      }
    } else {
      note.reverbSend.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(value, scheduleTime);
      if (0 < value) {
        note.volumeNode.connect(note.reverbSend);
      } else {
        try {
          note.volumeNode.disconnect(note.reverbSend);
        } catch { /* empty */ }
      }
    }
  }

  setChorusSend(channel, note, scheduleTime) {
    let value = note.voiceParams.chorusEffectsSend *
      channel.state.chorusSendLevel;
    if (channel.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel, note.noteNumber, 93);
      if (0 <= keyBasedValue) value = keyBasedValue / 127;
    }
    if (!note.chorusSend) {
      if (0 < value) {
        note.chorusSend = new GainNode(this.audioContext, { gain: value });
        note.volumeNode.connect(note.chorusSend);
        note.chorusSend.connect(this.chorusEffect.input);
      }
    } else {
      note.chorusSend.gain
        .cancelScheduledValues(scheduleTime)
        .setValueAtTime(value, scheduleTime);
      if (0 < value) {
        note.volumeNode.connect(note.chorusSend);
      } else {
        try {
          note.volumeNode.disconnect(note.chorusSend);
        } catch { /* empty */ }
      }
    }
  }

  setDelayModLFO(note) {
    const startTime = note.startTime + note.voiceParams.delayModLFO;
    try {
      note.modLfo.start(startTime);
    } catch { /* empty */ }
  }

  setFreqModLFO(note, scheduleTime) {
    const freqModLFO = note.voiceParams.freqModLFO;
    note.modLfo.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(freqModLFO, scheduleTime);
  }

  setDelayVibLFO(channel, note) {
    const vibratoDelay =
      this.getRelativeKeyBasedValue(channel, note.noteNumber, 78) * 2;
    const value = note.voiceParams.delayVibLFO;
    const startTime = note.startTime + value * vibratoDelay;
    try {
      note.vibLfo.start(startTime);
    } catch { /* empty */ }
  }

  setFreqVibLFO(channel, note, scheduleTime) {
    const vibratoRate =
      this.getRelativeKeyBasedValue(channel, note.noteNumber, 76) * 2;
    const freqVibLFO = note.voiceParams.freqVibLFO;
    note.vibLfo.frequency
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(freqVibLFO * vibratoRate, scheduleTime);
  }

  createVoiceParamsHandlers() {
    return {
      modLfoToPitch: (channel, note, scheduleTime) => {
        const { modulationDepthMSB, modulationDepthLSB } = channel.state;
        if (0 < modulationDepthMSB + modulationDepthLSB) {
          this.setModLfoToPitch(channel, note, scheduleTime);
        }
      },
      vibLfoToPitch: (channel, note, scheduleTime) => {
        if (0 < channel.state.vibratoDepth) {
          this.setVibLfoToPitch(channel, note, scheduleTime);
        }
      },
      modLfoToFilterFc: (channel, note, scheduleTime) => {
        const { modulationDepthMSB, modulationDepthLSB } = channel.state;
        if (0 < modulationDepthMSB + modulationDepthLSB) {
          this.setModLfoToFilterFc(channel, note, scheduleTime);
        }
      },
      modLfoToVolume: (channel, note, scheduleTime) => {
        const { modulationDepthMSB, modulationDepthLSB } = channel.state;
        if (0 < modulationDepthMSB + modulationDepthLSB) {
          this.setModLfoToVolume(channel, note, scheduleTime);
        }
      },
      chorusEffectsSend: (channel, note, scheduleTime) => {
        this.setChorusSend(channel, note, scheduleTime);
      },
      reverbEffectsSend: (channel, note, scheduleTime) => {
        this.setReverbSend(channel, note, scheduleTime);
      },
      delayModLFO: (channel, note, _scheduleTime) => {
        const { modulationDepthMSB, modulationDepthLSB } = channel.state;
        if (0 < modulationDepthMSB + modulationDepthLSB) {
          this.setDelayModLFO(note);
        }
      },
      freqModLFO: (_channel, note, scheduleTime) => {
        const { modulationDepthMSB, modulationDepthLSB } = channel.state;
        if (0 < modulationDepthMSB + modulationDepthLSB) {
          this.setFreqModLFO(note, scheduleTime);
        }
      },
      delayVibLFO: (channel, note, _scheduleTime) => {
        if (0 < channel.state.vibratoDepth) {
          this.setDelayVibLFO(channel, note);
        }
      },
      freqVibLFO: (channel, note, scheduleTime) => {
        if (0 < channel.state.vibratoDepth) {
          this.setFreqVibLFO(channel, note, scheduleTime);
        }
      },
      detune: (channel, note, scheduleTime) => {
        if (this.isPortamento(channel, note)) {
          this.setPortamentoDetune(channel, note, scheduleTime);
        } else {
          this.setDetune(channel, note, scheduleTime);
        }
      },
    };
  }

  getControllerState(channel, noteNumber, velocity, polyphonicKeyPressure) {
    const state = new Float32Array(channel.state.array.length);
    state.set(channel.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    state[10] = polyphonicKeyPressure / 127;
    return state;
  }

  applyVoiceParams(channel, controllerType, scheduleTime) {
    this.processScheduledNotes(channel, (note) => {
      if (note.renderedBuffer?.isFull) return;
      const controllerState = this.getControllerState(
        channel,
        note.noteNumber,
        note.velocity,
        note.pressure,
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
    handlers[33] = this.setModulationDepth;
    handlers[37] = this.setPortamentoTime;
    handlers[38] = this.dataEntryLSB;
    handlers[39] = this.setVolume;
    handlers[42] = this.setPan;
    handlers[43] = this.setExpression;
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
    handlers[84] = this.setPortamentoNoteNumber;
    handlers[91] = this.setReverbSendLevel;
    handlers[93] = this.setChorusSendLevel;
    handlers[96] = this.dataIncrement;
    handlers[97] = this.dataDecrement;
    handlers[100] = this.setRPNLSB;
    handlers[101] = this.setRPNMSB;
    handlers[111] = this.setRPGMakerLoop;
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
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.applyToMPEChannels(channelNumber, (ch) => {
      this.applyControlChange(ch, controllerType, value, scheduleTime);
    });
  }

  applyControlChange(channelNumber, controllerType, value, scheduleTime) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value, scheduleTime);
      const channel = this.channels[channelNumber];
      this.applyVoiceParams(channel, controllerType + 128, scheduleTime);
      this.processActiveNotes(channel, scheduleTime, (note) => {
        this.setControlChangeEffects(channel, note, scheduleTime);
      });
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
    const { modulationDepthMSB, modulationDepthLSB } = channel.state;
    const modulationDepth = modulationDepthMSB + modulationDepthLSB / 128;
    const depth = modulationDepth * channel.modulationDepthRange;
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
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const state = channel.state;
    const intPart = Math.trunc(value);
    state.modulationDepthMSB = intPart / 127;
    state.modulationDepthLSB = value - intPart;
    this.updateModulation(channel, scheduleTime);
  }

  updatePortamento(channel, scheduleTime) {
    if (channel.isDrum) return;
    this.processScheduledNotes(channel, (note) => {
      if (this.isPortamento(channel, note)) {
        this.setPortamentoVolumeEnvelope(channel, note, scheduleTime);
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
        this.setPortamentoPitchEnvelope(channel, note, scheduleTime);
        this.setPortamentoDetune(channel, note, scheduleTime);
      } else {
        this.setVolumeEnvelope(channel, note, scheduleTime);
        this.setFilterEnvelope(channel, note, scheduleTime);
        this.setPitchEnvelope(note, scheduleTime);
        this.setDetune(channel, note, scheduleTime);
      }
    });
  }

  setPortamentoTime(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const intPart = Math.trunc(value);
    state.portamentoTimeMSB = intPart / 127;
    state.portamentoTimeLSB = value - 127;
    if (channel.isDrum) return;
    this.updatePortamento(channel, scheduleTime);
  }

  setVolume(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const intPart = Math.trunc(value);
    state.volumeMSB = intPart / 127;
    state.volumeLSB = value - intPart;
    this.applyVolume(channel, scheduleTime);
  }

  applyVolume(channel, scheduleTime) {
    if (channel.isDrum) {
      for (let i = 0; i < 128; i++) {
        this.updateKeyBasedVolume(channel, i, scheduleTime);
      }
    } else {
      this.updateChannelVolume(channel, scheduleTime);
    }
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
    const state = channel.state;
    const intPart = Math.trunc(value);
    state.panMSB = intPart / 127;
    state.panLSB = value - intPart;
    if (channel.isDrum) {
      for (let i = 0; i < 128; i++) {
        this.updateKeyBasedVolume(channel, i, scheduleTime);
      }
    } else {
      this.updateChannelVolume(channel, scheduleTime);
    }
  }

  setExpression(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    const intPart = Math.trunc(value);
    state.expressionMSB = intPart / 127;
    state.expressionLSB = value - intPart;
    this.updateChannelVolume(channel, scheduleTime);
  }

  setBankLSB(channelNumber, lsb) {
    this.channels[channelNumber].bankLSB = lsb;
  }

  dataEntryLSB(channelNumber, value, scheduleTime) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber, 0, scheduleTime);
  }

  updateChannelVolume(channel, scheduleTime) {
    const {
      expressionMSB,
      expressionLSB,
      volumeMSB,
      volumeLSB,
      panMSB,
      panLSB,
    } = channel.state;
    const volume = volumeMSB + volumeLSB / 128;
    const expression = expressionMSB + expressionLSB / 128;
    const pan = panMSB + panLSB / 128;
    const effect = this.getChannelAmplitudeControl(channel);
    const gain = volume * expression * (1 + effect);
    const { gainLeft, gainRight } = this.panToGain(pan);
    channel.gainL.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainLeft, scheduleTime);
    channel.gainR.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainRight, scheduleTime);
  }

  updateKeyBasedVolume(channel, keyNumber, scheduleTime) {
    const gainL = channel.keyBasedGainLs[keyNumber];
    if (!gainL) return;
    const gainR = channel.keyBasedGainRs[keyNumber];
    const {
      expressionMSB,
      expressionLSB,
      volumeMSB,
      volumeLSB,
      panMSB,
      panLSB,
    } = channel.state;
    const volume = volumeMSB + volumeLSB / 128;
    const expression = expressionMSB + expressionLSB / 128;
    const defaultGain = volume * expression;
    const defaultPan = panMSB + panLSB / 128;
    const keyBasedVolume = this.getKeyBasedValue(channel, keyNumber, 7);
    const gain = (0 <= keyBasedVolume)
      ? defaultGain * keyBasedVolume / 64
      : defaultGain;
    const keyBasedPan = this.getKeyBasedValue(channel, keyNumber, 10);
    const pan = (0 <= keyBasedPan) ? keyBasedPan / 127 : defaultPan;
    const { gainLeft, gainRight } = this.panToGain(pan);
    gainL.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainLeft, scheduleTime);
    gainR.gain
      .cancelScheduledValues(scheduleTime)
      .setValueAtTime(gain * gainRight, scheduleTime);
  }

  setSustainPedal(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
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

  isPortamento(channel, note) {
    return 0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber;
  }

  setPortamento(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.portamento = value / 127;
    this.updatePortamento(channel, scheduleTime);
  }

  setSostenutoPedal(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const state = channel.state;
    const prevValue = state.sostenutoPedal;
    state.sostenutoPedal = value / 127;
    if (64 <= value) {
      if (prevValue < 0.5) {
        const sostenutoNotes = [];
        this.processActiveNotes(channel, scheduleTime, (note) => {
          sostenutoNotes.push(note);
        });
        channel.sostenutoNotes = sostenutoNotes;
      }
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
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    state.softPedal = softPedal / 127;
    this.processScheduledNotes(channel, (note) => {
      if (this.isPortamento(channel, note)) {
        this.setPortamentoVolumeEnvelope(channel, note, scheduleTime);
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
      } else {
        this.setVolumeEnvelope(channel, note, scheduleTime);
        this.setFilterEnvelope(channel, note, scheduleTime);
      }
    });
  }

  setFilterQ(channel, note, scheduleTime) {
    if (!note.filterEnvelopeNode) return;
    const filterResonance = this.getRelativeKeyBasedValue(
      channel,
      note.noteNumber,
      71,
    );
    const Q = note.voiceParams.initialFilterQ / 5 * filterResonance;
    note.filterEnvelopeNode.Q.setValueAtTime(Q, scheduleTime);
  }

  setFilterResonance(channelNumber, ccValue, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const state = channel.state;
    state.filterResonance = ccValue / 127;
    this.processScheduledNotes(channel, (note) => {
      this.setFilterQ(channel, note, scheduleTime);
    });
  }

  setReleaseTime(channelNumber, releaseTime, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.releaseTime = releaseTime / 127;
  }

  setAttackTime(channelNumber, attackTime, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.attackTime = attackTime / 127;
    this.processScheduledNotes(channel, (note) => {
      if (scheduleTime < note.startTime) {
        this.setVolumeEnvelope(channel, note, scheduleTime);
      }
    });
  }

  setBrightness(channelNumber, brightness, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const state = channel.state;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    state.brightness = brightness / 127;
    this.processScheduledNotes(channel, (note) => {
      if (this.isPortamento(channel, note)) {
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
      } else {
        this.setFilterEnvelope(channel, note, scheduleTime);
      }
    });
  }

  setDecayTime(channelNumber, dacayTime, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.decayTime = dacayTime / 127;
    this.processScheduledNotes(channel, (note) => {
      this.setVolumeEnvelope(channel, note, scheduleTime);
    });
  }

  setVibratoRate(channelNumber, vibratoRate, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.vibratoRate = vibratoRate / 127;
    if (channel.vibratoDepth <= 0) return;
    this.processScheduledNotes(channel, (note) => {
      this.setVibLfoToPitch(channel, note, scheduleTime);
    });
  }

  setVibratoDepth(channelNumber, vibratoDepth, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
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

  setVibratoDelay(channelNumber, vibratoDelay, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.state.vibratoDelay = vibratoDelay / 127;
    if (0 < channel.state.vibratoDepth) {
      this.processScheduledNotes(channel, (note) => {
        this.startVibrato(channel, note, scheduleTime);
      });
    }
  }

  setPortamentoNoteNumber(channelNumber, value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.portamentoControl = true;
    channel.state.portamentoNoteNumber = value / 127;
  }

  setReverbSendLevel(channelNumber, reverbSendLevel, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    state.reverbSendLevel = reverbSendLevel / 127;
    this.processScheduledNotes(channel, (note) => {
      this.setReverbSend(channel, note, scheduleTime);
    });
  }

  setChorusSendLevel(channelNumber, chorusSendLevel, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const state = channel.state;
    state.chorusSendLevel = chorusSendLevel / 127;
    this.processScheduledNotes(channel, (note) => {
      this.setChorusSend(channel, note, scheduleTime);
    });
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
      case 6: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp053.pdf
        channel.dataLSB += value;
        this.handleMIDIPolyphonicExpressionRPN(channelNumber, scheduleTime);
        break;
      case 16383: // NULL
        break;
      default:
        console.warn(
          `Channel ${channelNumber}: Unsupported RPN MSB=${channel.rpnMSB} LSB=${channel.rpnLSB}`,
        );
    }
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp18.pdf
  dataIncrement(channelNumber, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.handleRPN(channelNumber, 1, scheduleTime);
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp18.pdf
  dataDecrement(channelNumber, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.handleRPN(channelNumber, -1, scheduleTime);
  }

  setRPNMSB(channelNumber, value) {
    this.channels[channelNumber].rpnMSB = value;
  }

  setRPNLSB(channelNumber, value) {
    this.channels[channelNumber].rpnLSB = value;
  }

  dataEntryMSB(channelNumber, value, scheduleTime) {
    this.channels[channelNumber].dataMSB = value;
    this.handleRPN(channelNumber, 0, scheduleTime);
  }

  handlePitchBendRangeRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const pitchBendRange = (channel.dataMSB + channel.dataLSB / 128) * 100;
    this.setPitchBendRange(channelNumber, pitchBendRange, scheduleTime);
  }

  setPitchBendRange(channelNumber, value, scheduleTime) { // [0, 12800] cent
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
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
    if (channel.isDrum) return;
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
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const prev = channel.coarseTuning;
    const next = value;
    channel.coarseTuning = next;
    channel.detune += next - prev;
    this.updateChannelDetune(channel, scheduleTime);
  }

  handleModulationDepthRangeRPN(channelNumber, scheduleTime) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const value = (channel.dataMSB + channel.dataLSB / 128) * 100;
    this.setModulationDepthRange(channelNumber, value, scheduleTime);
  }

  setModulationDepthRange(channelNumber, value, scheduleTime) { // [0, 12800] cent
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    channel.modulationDepthRange = value;
    this.updateModulation(channel, scheduleTime);
  }

  handleMIDIPolyphonicExpressionRPN(channelNumber, _scheduleTime) {
    const channel = this.channels[channelNumber];
    this.setMIDIPolyphonicExpression(channelNumber, channel.dataMSB);
  }

  setMIDIPolyphonicExpression(channelNumber, value) {
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
    const upperStart = 16 - this.upperMPEMembers;
    const upperEnd = 14;
    const { channels, lowerMPEMembers, upperMPEMembers, mpeEnabled } = this;
    for (let ch = 0; ch < 16; ch++) {
      const isLower = lowerMPEMembers && lowerStart <= ch && ch <= lowerEnd;
      const isUpper = upperMPEMembers && upperStart <= ch && ch <= upperEnd;
      channels[ch].isMPEMember = mpeEnabled && (isLower || isUpper);
      channels[ch].isMPEManager = mpeEnabled && (ch === 0 || ch === 15);
    }
  }

  setRPGMakerLoop(_channelNumber, _value, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.loopStart = scheduleTime + this.resumeTime - this.startTime;
  }

  allSoundOff(channelNumber, value, scheduleTime) {
    if (this.channels[channelNumber].isMPEManager) return;
    this.applyAllSoundOff(channelNumber, value, scheduleTime);
  }

  applyAllSoundOff(channelNumber, _value, scheduleTime) {
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const promises = [];
    this.processActiveNotes(channel, scheduleTime, (note) => {
      promises.push(this.soundOffNote(channel, note, scheduleTime));
    });
    return Promise.all(promises);
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
    channel.resetTable();
    this.mode = "GM2";
    this.masterFineTuning = 0; // cent
    this.masterCoarseTuning = 0; // cent
  }

  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
  resetAllControllers(channelNumber, _value, scheduleTime) {
    const keys = [
      "polyphonicKeyPressure",
      "channelPressure",
      "pitchWheel",
      "expressionMSB",
      "expressionLSB",
      "modulationDepthMSB",
      "modulationDepthLSB",
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
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    const promises = [];
    this.processActiveNotes(channel, scheduleTime, (note) => {
      const promise = this.noteOff(
        channelNumber,
        note.noteNumber,
        0, // velocity
        scheduleTime,
        false, // force
      );
      promises.push(promise);
    });
    return Promise.all(promises);
  }

  omniOff(channelNumber, value, scheduleTime) {
    if (this.mpeEnabled) return;
    this.allNotesOff(channelNumber, value, scheduleTime);
  }

  omniOn(channelNumber, value, scheduleTime) {
    if (this.mpeEnabled) return;
    this.allNotesOff(channelNumber, value, scheduleTime);
  }

  monoOn(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isMPEManager) return;
    this.allNotesOff(channelNumber, value, scheduleTime);
    channel.mono = true;
  }

  polyOn(channelNumber, value, scheduleTime) {
    const channel = this.channels[channelNumber];
    if (channel.isMPEManager) return;
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
    const channels = this.channels;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.mode = "GM1";
    for (let ch = 0; ch < channels.length; ch++) {
      this.applyAllSoundOff(ch, 0, scheduleTime);
      const channel = channels[ch];
      channel.bankMSB = 0;
      channel.bankLSB = 0;
      channel.isDrum = false;
    }
    channels[9].bankMSB = 1;
    channels[9].isDrum = true;
  }

  GM2SystemOn(scheduleTime) {
    const channels = this.channels;
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    this.mode = "GM2";
    for (let ch = 0; ch < channels.length; ch++) {
      this.applyAllSoundOff(ch, 0, scheduleTime);
      const channel = channels[ch];
      channel.bankMSB = 121;
      channel.bankLSB = 0;
      channel.isDrum = false;
    }
    channels[9].bankMSB = 120;
    channels[9].isDrum = true;
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
            return this.handleChannelPressureSysEx(data, scheduleTime);
          case 2: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca22.pdf
            return this.handlePolyphonicKeyPressureSysEx(data, scheduleTime);
          case 3: // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/ca22.pdf
            return this.handleControlChangeSysEx(data, scheduleTime);
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

  setMasterVolume(value, scheduleTime) { // [0-1]
    if (!(0 <= scheduleTime)) scheduleTime = this.audioContext.currentTime;
    const timeConstant = this.perceptualSmoothingTime / 5; // 99.3% (5 * tau)
    this.masterVolume.gain
      .cancelAndHoldAtTime(scheduleTime)
      .setTargetAtTime(value * value, scheduleTime, timeConstant);
  }

  handleMasterFineTuningSysEx(data, scheduleTime) {
    const value = (data[5] * 128 + data[4]) / 16383;
    const fineTuning = (value - 8192) / 8192 * 100;
    this.setMasterFineTuning(fineTuning, scheduleTime);
  }

  setMasterFineTuning(value, scheduleTime) { // [-100, 100] cent
    const prev = this.masterFineTuning;
    const next = value;
    this.masterFineTuning = next;
    const detuneChange = next - prev;
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      if (channel.isDrum) continue;
      channel.detune += detuneChange;
      this.updateChannelDetune(channel, scheduleTime);
    }
  }

  handleMasterCoarseTuningSysEx(data, scheduleTime) {
    const coarseTuning = (data[4] - 64) * 100;
    this.setMasterCoarseTuning(coarseTuning, scheduleTime);
  }

  setMasterCoarseTuning(value, scheduleTime) { // [-6400, 6300] cent
    const prev = this.masterCoarseTuning;
    const next = value;
    this.masterCoarseTuning = next;
    const detuneChange = next - prev;
    const channels = this.channels;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
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
    this.reverbEffect = this.setReverbEffect(this.reverb.algorithm);
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
    this.reverbEffect = this.setReverbEffect(this.reverb.algorithm);
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

  calcEffectValue(channel, note, destination) {
    return this.calcChannelEffectValue(channel, destination) +
      this.calcNoteEffectValue(channel, note, destination);
  }

  calcChannelEffectValue(channel, destination) {
    return this.calcControlChangeEffectValue(channel, destination) +
      this.calcChannelPressureEffectValue(channel, destination);
  }

  calcControlChangeEffectValue(channel, destination) {
    const controlType = channel.controlTable[destination];
    if (controlType < 0) return 0;
    const pressure = channel.state.array[controlType];
    if (pressure <= 0) return 0;
    const baseline = pressureBaselines[destination];
    const tableValue = channel.controlTable[destination + 6];
    const value = (tableValue - baseline) * pressure;
    return value * effectParameters[destination];
  }

  calcChannelPressureEffectValue(channel, destination) {
    const pressure = channel.state.channelPressure;
    if (pressure <= 0) return 0;
    const baseline = pressureBaselines[destination];
    const tableValue = channel.channelPressureTable[destination];
    const value = (tableValue - baseline) * pressure;
    return value * effectParameters[destination];
  }

  calcNoteEffectValue(channel, note, destination) {
    const pressure = note.pressure;
    if (pressure <= 0) return 0;
    const baseline = pressureBaselines[destination];
    const tableValue = channel.polyphonicKeyPressureTable[destination];
    const value = (tableValue - baseline) * pressure / 127;
    return value * effectParameters[destination];
  }

  getChannelPitchControl(channel) {
    return this.calcChannelEffectValue(channel, 0);
  }

  getNotePitchControl(channel, note) {
    return this.calcNoteEffectValue(channel, note, 0);
  }

  getPitchControl(channel, note) {
    return this.calcEffectValue(channel, note, 0);
  }

  getFilterCutoffControl(channel, note) {
    return this.calcEffectValue(channel, note, 1);
  }

  getChannelAmplitudeControl(channel) {
    return this.calcChannelEffectValue(channel, 2);
  }

  getNoteAmplitudeControl(channel, note) {
    return this.calcNoteEffectValue(channel, note, 2);
  }

  getAmplitudeControl(channel, note) {
    return this.calcEffectValue(channel, note, 2);
  }

  getLFOPitchDepth(channel, note) {
    return this.calcEffectValue(channel, note, 3);
  }

  getLFOFilterDepth(channel, note) {
    return this.calcEffectValue(channel, note, 4);
  }

  getLFOAmplitudeDepth(channel, note) {
    return this.calcEffectValue(channel, note, 5);
  }

  createEffectHandlers() {
    const handlers = new Array(6);
    handlers[0] = (channel, note, _tableName, scheduleTime) => {
      if (this.isPortamento(channel, note)) {
        this.setPortamentoDetune(channel, note, scheduleTime);
      } else {
        this.setDetune(channel, note, scheduleTime);
      }
    };
    handlers[1] = (channel, note, _tableName, scheduleTime) => {
      if (0.5 <= channel.state.portamento && 0 <= note.portamentoNoteNumber) {
        this.setPortamentoFilterEnvelope(channel, note, scheduleTime);
      } else {
        this.setFilterEnvelope(channel, note, scheduleTime);
      }
    };
    handlers[2] = (channel, note, tableName, scheduleTime) => {
      if (tableName === "polyphonicKeyPressureTable") {
        this.setVolumeNode(channel, note, scheduleTime);
      } else {
        this.applyVolume(channel, scheduleTime);
      }
    };
    handlers[3] = (channel, note, _tableName, scheduleTime) =>
      this.setModLfoToPitch(channel, note, scheduleTime);
    handlers[4] = (channel, note, _tableName, scheduleTime) =>
      this.setModLfoToFilterFc(channel, note, scheduleTime);
    handlers[5] = (channel, note, _tableName, scheduleTime) =>
      this.setModLfoToVolume(channel, note, scheduleTime);
    return handlers;
  }

  setControlChangeEffects(channel, note, scheduleTime) {
    const handlers = this.effectHandlers;
    for (let i = 0; i < handlers.length; i++) {
      const baseline = pressureBaselines[i];
      const tableValue = channel.controlTable[i + 6];
      if (baseline === tableValue) continue;
      handlers[i](channel, note, "controlTable", scheduleTime);
    }
  }

  setChannelPressureEffects(channel, note, scheduleTime) {
    this.setPressureEffects(
      channel,
      note,
      "channelPressureTable",
      scheduleTime,
    );
  }

  setPolyphonicKeyPressureEffects(channel, note, scheduleTime) {
    this.setPressureEffects(
      channel,
      note,
      "polyphonicKeyPressureTable",
      scheduleTime,
    );
  }

  setPressureEffects(channel, note, tableName, scheduleTime) {
    const handlers = this.effectHandlers;
    const table = channel[tableName];
    for (let i = 0; i < handlers.length; i++) {
      const baseline = pressureBaselines[i];
      const tableValue = table[i];
      if (baseline === tableValue) continue;
      handlers[i](channel, note, tableName, scheduleTime);
    }
  }

  handleChannelPressureSysEx(data, scheduleTime) {
    this.handlePressureSysEx(data, "channelPressureTable", scheduleTime);
  }

  handlePolyphonicKeyPressureSysEx(data, scheduleTime) {
    this.handlePressureSysEx(data, "polyphonicKeyPressureTable", scheduleTime);
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
      const handler = this.effectHandlers[pp];
      this.processActiveNotes(channel, scheduleTime, (note) => {
        if (handler) handler(channel, note, tableName, scheduleTime);
      });
    }
  }

  handleControlChangeSysEx(data, scheduleTime) {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (channel.isDrum) return;
    const table = channel.controlTable;
    table.set(defaultControlValues);
    const controllerType = data[5];
    for (let i = 6; i < data.length; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = controllerType;
      table[pp + 6] = rr;
      const handler = this.effectHandlers[pp];
      this.processActiveNotes(channel, scheduleTime, (note) => {
        if (handler) handler(channel, note, "controlTable", scheduleTime);
      });
    }
  }

  getRelativeKeyBasedValue(channel, keyNumber, controllerType) {
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

  getKeyBasedValue(channel, keyNumber, controllerType) {
    const index = keyNumber * 128 + controllerType;
    const controlValue = channel.keyBasedTable[index];
    return controlValue;
  }

  createKeyBasedControllerHandlers() {
    const handlers = new Array(128);
    handlers[7] = (channel, keyNumber, scheduleTime) =>
      this.updateKeyBasedVolume(channel, keyNumber, scheduleTime);
    handlers[10] = (channel, keyNumber, scheduleTime) =>
      this.updateKeyBasedVolume(channel, keyNumber, scheduleTime);
    handlers[71] = (channel, keyNumber, scheduleTime) =>
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setFilterQ(channel, note, scheduleTime);
        }
      });
    handlers[73] = (channel, keyNumber, scheduleTime) =>
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setVolumeEnvelope(channel, note, scheduleTime);
        }
      });
    handlers[74] = (channel, keyNumber, scheduleTime) =>
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setFilterEnvelope(channel, note, scheduleTime);
        }
      });
    handlers[75] = (channel, keyNumber, scheduleTime) =>
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setVolumeEnvelope(channel, note, scheduleTime);
        }
      });
    handlers[76] = (channel, keyNumber, scheduleTime) => {
      if (channel.state.vibratoDepth <= 0) return;
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setFreqVibLFO(channel, note, scheduleTime);
        }
      });
    };
    handlers[77] = (channel, keyNumber, scheduleTime) => {
      if (channel.state.vibratoDepth <= 0) return;
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setVibLfoToPitch(channel, note, scheduleTime);
        }
      });
    };
    handlers[78] = (channel, keyNumber) => {
      if (channel.state.vibratoDepth <= 0) return;
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) this.setDelayVibLFO(channel, note);
      });
    };
    handlers[91] = (channel, keyNumber, scheduleTime) =>
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setReverbSend(channel, note, scheduleTime);
        }
      });
    handlers[93] = (channel, keyNumber, scheduleTime) =>
      this.processScheduledNotes(channel, (note) => {
        if (note.noteNumber === keyNumber) {
          this.setChorusSend(channel, note, scheduleTime);
        }
      });
    return handlers;
  }

  handleKeyBasedInstrumentControlSysEx(data, scheduleTime) {
    const channelNumber = data[4];
    const channel = this.channels[channelNumber];
    if (!channel.isDrum) return;
    const keyNumber = data[5];
    const table = channel.keyBasedTable;
    for (let i = 6; i < data.length; i += 2) {
      const controllerType = data[i];
      const value = data[i + 1];
      const index = keyNumber * 128 + controllerType;
      table[index] = value;
      const handler = this.keyBasedControllerHandlers[controllerType];
      if (handler) handler(channel, keyNumber, scheduleTime);
    }
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
