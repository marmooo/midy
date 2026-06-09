// Web Audio API mock utilities shared across all test suites.

import {
  AudioBuffer as WebAudioBuffer,
  AudioContext as WebAudioContext,
} from "web-audio-api";

export { assertAlmostEquals, assertEquals, assertNotEquals } from "@std/assert";

// =========================================================================
// Inject Web Audio API node constructors into globalThis.
// The library instantiates nodes with `new GainNode(ctx)` etc., so these
// globals must exist before the first player instance is created.
// This runs once when the module is first imported.
// =========================================================================
globalThis.AudioContext = WebAudioContext as unknown as typeof AudioContext;
globalThis.AudioBuffer = WebAudioBuffer as unknown as typeof AudioBuffer;

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
    volSustain: 0.5,
    volDelay: 0,
    volAttack: 0.01,
    volHold: 0.01,
    volDecay: 0.1,
    volRelease: 0.2,
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
    modDelay: 0,
    modAttack: 0,
    modHold: 0,
    modDecay: 0,
    modSustain: 0,
    modRelease: 0,
    sample: {
      type: "raw",
      data: new Int16Array(0),
      sampleHeader: { sampleRate: 44100 },
      decodePCM: () => new Float32Array(0),
    },
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
 * `exclusiveClass` is forwarded to `makeDefaultVoiceParams`.
 */
export function installSoundFontStub(
  player: AnyPlayer,
  exclusiveClass = 0,
): void {
  player.soundFontTable[0] = [0];
  player.soundFonts = [
    {
      getVoice: () => ({
        generators: { instrument: 0, sampleID: 0 },
        getParams: () => ({}),
        getAllParams: () => makeDefaultVoiceParams(exclusiveClass),
      }),
    } as unknown as import("@marmooo/soundfont-parser").SoundFont,
  ];
}

// Disable resource/timer/op leak checks — audio graph nodes intentionally
// outlive test boundaries.
export const sanOptions = {
  sanitizeOps: false,
  sanitizeExit: false,
  sanitizeResources: false,
};
