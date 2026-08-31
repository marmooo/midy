// Web Audio API mock utilities shared across all test suites.

import {
  AudioBuffer as WebAudioBuffer,
  AudioContext as WebAudioContext,
  OfflineAudioContext as WebOfflineAudioContext,
} from "web-audio-api";

export { assertAlmostEquals, assertEquals, assertNotEquals } from "@std/assert";

// =========================================================================
// Inject Web Audio API node constructors into globalThis.
// The library instantiates nodes with `new GainNode(ctx)` etc., so these
// globals must exist before the first player instance is created.
// This runs once when the module is first imported.
// =========================================================================
globalThis.AudioBuffer = WebAudioBuffer as unknown as typeof AudioBuffer;
globalThis.AudioContext = WebAudioContext as unknown as typeof AudioContext;
globalThis.OfflineAudioContext =
  WebOfflineAudioContext as unknown as typeof OfflineAudioContext;

const _bootstrapCtx = new WebAudioContext() as unknown as AudioContext;

type FactoryName = keyof {
  [
    K in keyof AudioContext as AudioContext[K] extends () => AudioNode ? K
      : never
  ]: AudioContext[K];
};

const nodeFactoryMap: Record<string, FactoryName> = {
  GainNode: "createGain",
  ChannelMergerNode: "createChannelMerger",
  ChannelSplitterNode: "createChannelSplitter",
  DelayNode: "createDelay",
  OscillatorNode: "createOscillator",
  BiquadFilterNode: "createBiquadFilter",
  ConvolverNode: "createConvolver",
  PannerNode: "createPanner",
  StereoPannerNode: "createStereoPanner",
  DynamicsCompressorNode: "createDynamicsCompressor",
  AnalyserNode: "createAnalyser",
  WaveShaperNode: "createWaveShaper",
  ConstantSourceNode: "createConstantSource",
  AudioBufferSourceNode: "createBufferSource",
};

for (const [nodeName, factoryMethod] of Object.entries(nodeFactoryMap)) {
  try {
    const factory = _bootstrapCtx[factoryMethod as FactoryName] as
      | (() => AudioNode)
      | undefined;
    if (typeof factory === "function") {
      const instance = factory.call(_bootstrapCtx);
      (globalThis as Record<string, unknown>)[nodeName] = instance.constructor;
    }
  } catch {
    // Skip nodes not supported by this runtime.
  }
}

await (_bootstrapCtx as unknown as { close(): Promise<void> }).close();

// =========================================================================
// Generic player interface
// Each concrete player class (MidyGMLite, MidyGM2, Midy …) satisfies this.
// =========================================================================

/** Minimal shape every midy player must expose for shared test helpers. */
export interface AnyPlayer {
  audioContext: AudioContext | OfflineAudioContext;
  notePromises: Promise<void>[];
  soundFontTable: number[][];
  soundFonts: unknown[];
  // deno-lint-ignore no-explicit-any
  getAudioBuffer?: (...args: any[]) => Promise<unknown>;
}

// =========================================================================
// Helpers
// =========================================================================

/** Override `audioContext.currentTime` with an arbitrary value for testing. */
export function setMockCurrentTime(ctx: BaseAudioContext, time: number): void {
  Object.defineProperty(ctx, "currentTime", {
    value: time,
    writable: true,
    configurable: true,
  });
}

/**
 * Default soundfont voice params.
 * Pass `exclusiveClass` to test mutual-exclusion behaviour.
 */
export function makeDefaultVoiceParams(exclusiveClass = 0) {
  return {
    initialAttenuation: 0,
    sustainVolEnv: 0.5,
    delayVolEnv: 0,
    attackVolEnv: 0.01,
    holdVolEnv: 0.01,
    decayVolEnv: 0.1,
    releaseVolEnv: 0.2,
    sampleRate: 44100,
    playbackRate: 1,
    initialFilterFc: 1000,
    initialFilterQ: 1,
    freqModLFO: 0,
    freqVibLFO: 0,
    delayModLFO: 0,
    delayVibLFO: 0,
    modLfoToPitch: 0,
    modLfoToFilterFc: 0,
    modLfoToVolume: 0,
    vibLfoToPitch: 0,
    loopStart: 0,
    loopEnd: 0,
    sampleModes: 0,
    start: 0,
    end: 0,
    exclusiveClass,
    modEnvToPitch: 0,
    modEnvToFilterFc: 0,
    delayModEnv: 0,
    attackModEnv: 0,
    holdModEnv: 0,
    decayModEnv: 0,
    sustainModEnv: 0,
    releaseModEnv: 0,
    sample: {
      type: "raw",
      data: new Int16Array(0),
      sampleHeader: { sampleRate: 44100 },
      decodePCM: () => new Float32Array(0),
    },
  };
}

// Raw SF2 generator values (spec units: timecents, tenths of a percent,
// ...) that, once run through base-player.ts's real interpretation math
// (getVoiceParams / getVoiceParamsForController), reproduce exactly
// makeDefaultVoiceParams() above. Kept in one place so the mock voice
// stays a genuine (if minimal) raw-generator source instead of a
// pre-interpreted stand-in.
function makeDefaultGeneratorValues(exclusiveClass = 0): {
  get(key: string): number;
  clone(): ReturnType<typeof makeDefaultGeneratorValues>;
  set(key: string, value: number): void;
} {
  // timecentToSecond(x) = 2^(x/1200); Infinity/-Infinity map to 1/0
  // exactly, and finite targets are solved by inverting that formula.
  const secondsToTimecent = (seconds: number) =>
    seconds === 0 ? -Infinity : 1200 * Math.log2(seconds);
  const values: Record<string, number> = {
    initialAttenuation: 0,
    initialFilterFc: 1000,
    initialFilterQ: 1,
    freqModLFO: 0,
    freqVibLFO: 0,
    modLfoToPitch: 0,
    modLfoToFilterFc: 0,
    modLfoToVolume: 0,
    vibLfoToPitch: 0,
    modEnvToPitch: 0,
    modEnvToFilterFc: 0,
    pan: 0,
    chorusEffectsSend: 0,
    reverbEffectsSend: 0,
    sustainVolEnv: 0.5 * 1000,
    sustainModEnv: 0,
    delayVolEnv: secondsToTimecent(0),
    attackVolEnv: secondsToTimecent(0.01),
    holdVolEnv: secondsToTimecent(0.01),
    keynumToVolEnvHold: 0,
    decayVolEnv: secondsToTimecent(0.1),
    keynumToVolEnvDecay: 0,
    releaseVolEnv: secondsToTimecent(0.2),
    delayModLFO: secondsToTimecent(0),
    delayVibLFO: secondsToTimecent(0),
    delayModEnv: secondsToTimecent(0),
    attackModEnv: secondsToTimecent(0),
    holdModEnv: secondsToTimecent(0),
    keynumToModEnvHold: 0,
    decayModEnv: secondsToTimecent(0),
    keynumToModEnvDecay: 0,
    releaseModEnv: secondsToTimecent(0),
    coarseTune: 0,
    fineTune: 0,
    // scaleTuning 0 pins playbackRate to 1 regardless of key/rootKey.
    scaleTuning: 0,
    overridingRootKey: -1,
    startAddrsOffset: 0,
    startAddrsCoarseOffset: 0,
    endAddrsOffset: 0,
    endAddrsCoarseOffset: 0,
    startloopAddrsOffset: 0,
    startloopAddrsCoarseOffset: 0,
    endloopAddrsOffset: 0,
    endloopAddrsCoarseOffset: 0,
    instrument: 0,
    sampleID: 0,
    sampleModes: 0,
    exclusiveClass,
  };
  return {
    get(key: string) {
      return values[key] ?? 0;
    },
    clone: () => makeDefaultGeneratorValues(exclusiveClass),
    set(key: string, value: number) {
      values[key] = value;
    },
  };
}

// A minimal stand-in satisfying the surface base-player.ts's getVoiceParams
// / getVoiceParamsForController actually read from a Voice: .key,
// .generators (raw, spec-unit), .sample, .sampleHeader, and the two
// modulator-application methods (here: no modulators, so both are simple
// pass-throughs — matches @marmooo/soundfont's own Voice#transformAllParams
// fast path when no controller is active).
function makeMockVoice(exclusiveClass = 0) {
  const generators = makeDefaultGeneratorValues(exclusiveClass);
  const sampleHeader = {
    sampleName: "",
    start: 0,
    end: 0,
    loopStart: 0,
    loopEnd: 0,
    sampleRate: 44100,
    originalPitch: 60,
    pitchCorrection: 0,
  };
  return {
    key: 60,
    generators,
    sampleHeader,
    sample: {
      type: "raw",
      data: new Int16Array(0),
      sampleHeader: { sampleRate: 44100 },
      decodePCM: () => new Float32Array(0),
    },
    transformAllParams: () => generators,
    transformParams: () => ({}),
  };
}

/**
 * Patch every AudioBufferSourceNode created inside `player.audioContext` so
 * that `stop()` immediately fires `onended`.
 *
 * In the npm:web-audio-api runtime the audio clock never advances, so
 * `stop(futureTime)` never triggers onended and release Promises hang forever.
 * We intercept both `createBufferSource()` on the context and the global
 * `AudioBufferSourceNode` constructor so every node the library produces is
 * wrapped.
 *
 * NOTE: the extra microtask this injects delays `note.ready` resolution past
 * certain `await` boundaries; see suite-specific setup files for workarounds.
 */
export function patchBufferSourceNodes(player: AnyPlayer): void {
  const OriginalBufferSource = globalThis.AudioBufferSourceNode as unknown as {
    new (
      ctx: BaseAudioContext,
      options?: AudioBufferSourceOptions,
    ): AudioBufferSourceNode;
    prototype: AudioBufferSourceNode;
  };

  const ctx = player.audioContext;
  const origCreate = (ctx as unknown as AudioContext).createBufferSource.bind(
    ctx,
  );

  (ctx as unknown as AudioContext).createBufferSource =
    (): AudioBufferSourceNode => {
      const node = origCreate();
      const origStop = node.stop.bind(node);
      node.stop = (_when?: number): void => {
        try {
          origStop(0);
        } catch { /* ignore if already stopped */ }
        Promise.resolve().then(() => {
          if (typeof node.onended === "function") {
            node.onended(new Event("ended"));
          }
        });
      };
      return node;
    };

  const WrappedBufferSource = function (
    this: AudioBufferSourceNode,
    audioCtx: BaseAudioContext,
    options?: AudioBufferSourceOptions,
  ) {
    const node = new OriginalBufferSource(audioCtx, options);
    const origStop = node.stop.bind(node);
    node.stop = (_when?: number): void => {
      try {
        origStop(0);
      } catch { /* ignore */ }
      Promise.resolve().then(() => {
        if (typeof node.onended === "function") {
          node.onended(new Event("ended"));
        }
      });
    };
    return node;
  } as unknown as typeof AudioBufferSourceNode;

  Object.setPrototypeOf(WrappedBufferSource, OriginalBufferSource);
  WrappedBufferSource.prototype = OriginalBufferSource.prototype;
  globalThis.AudioBufferSourceNode = WrappedBufferSource;
}

/**
 * Drain all pending note-release Promises in `player.notePromises`.
 * Call at the end of every async test to keep the event loop clean.
 */
export async function flushNotePromises(player: AnyPlayer): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const snapshot = [...player.notePromises];
    if (snapshot.length === 0) break;
    player.notePromises = [];
    await Promise.allSettled(snapshot);
  }
}

/**
 * Wire up the minimal soundfont stub that all player classes need.
 * `exclusiveClass` is forwarded to the mock voice's generator values;
 * running it through base-player.ts's real getVoiceParams reproduces
 * makeDefaultVoiceParams(exclusiveClass).
 */
export function installSoundFontStub(
  player: AnyPlayer,
  exclusiveClass = 0,
): void {
  player.soundFontTable[0] = [0];
  player.soundFonts = [
    {
      getVoice: () => makeMockVoice(exclusiveClass),
    } as unknown as import("@marmooo/soundfont").SoundFont,
  ];
}

// Disable resource/timer/op leak checks — audio graph nodes intentionally
// outlive test boundaries.
export const sanOptions = {
  sanitizeOps: false,
  sanitizeExit: false,
  sanitizeResources: false,
};
