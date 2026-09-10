// MPE test setup: Midy player factory, patchBufferSourceNodes, MPE helpers.
import {
  AudioBuffer as WebAudioBuffer,
  AudioContext as WebAudioContext,
  OfflineAudioContext as WebOfflineAudioContext,
} from "web-audio-api";
import { Channel, Midy, Note } from "../../src/midy.ts";

export { Channel, Midy, Note };
export { assertAlmostEquals, assertEquals, assertNotEquals } from "@std/assert";

// =========================================================================
// Inject web-audio-api node constructors into globalThis.
// The library references these globals directly (e.g. `new GainNode(...)`),
// so they must exist before the first `Midy` instance is created.
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
 * Patch every AudioBufferSourceNode created inside `player` so that calling
 * `stop()` immediately fires `onended`.
 *
 * In the npm:web-audio-api runtime the audio clock never actually advances, so
 * `stop(futureTime)` never triggers onended and release Promises hang forever.
 * We intercept construction via createBufferSource and the global constructor
 * so every node the library produces is wrapped.
 *
 * NOTE: this is also why setSostenutoPedal / setSustainPedal need to be
 * awaited via processActiveNotes/processScheduledNotes directly in some tests
 * — the extra microtask injected here delays note.ready resolution past the
 * point where those methods complete their await.
 */
function patchBufferSourceNodes(player: Midy): void {
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
export async function flushNotePromises(player: Midy): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const snapshot = [...player.notePromises];
    if (snapshot.length === 0) break;
    player.notePromises = [];
    await Promise.allSettled(snapshot);
  }
}

/** Default soundfont voice params with exclusiveClass=0 (no mutual exclusion). */
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
export function makeMockVoice(exclusiveClass = 0) {
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
 * Build a `Midy` instance wired up for unit testing.
 * Pass `exclusiveClass` to override the soundfont voice's exclusiveClass.
 */
export function setupMidyPlayer(exclusiveClass = 0): Midy {
  const ctx = new AudioContext();
  setMockCurrentTime(ctx, 0);

  const player = new Midy(ctx);

  player.soundFontTable[0] = [0];
  player.soundFonts = [
    {
      getVoice: () => makeMockVoice(exclusiveClass),
    } as unknown as import("@marmooo/soundfont").SoundFont,
  ];

  player.getAudioBuffer = (
    _channel: Channel,
    _note: Note,
    _realtime: boolean,
  ): Promise<AudioBuffer> =>
    Promise.resolve(new AudioBuffer({ length: 100, sampleRate: 44100 }));

  patchBufferSourceNodes(player);

  return player;
}

/**
 * Activate MPE lower zone: ch 0 = manager, ch 1..members = members.
 */
export function activateLowerMPEZone(player: Midy, members: number): void {
  player.setMIDIPolyphonicExpression(0, members);
}

/**
 * Await processActiveNotes directly to capture notes into sostenutoNotes.
 *
 * setSostenutoPedal is async but patchBufferSourceNodes adds a microtask that
 * delays note.ready beyond its await. Use this helper instead of calling
 * setSostenutoPedal in tests that need sostenutoNotes to be populated.
 */
export async function captureSostenutoNotes(
  channel: Channel,
  scheduleTime: number,
): Promise<void> {
  channel.state.sostenutoPedal = 1;
  const captured: Note[] = [];
  await (
    channel as unknown as {
      processActiveNotes(
        t: number,
        cb: (n: Note) => void,
      ): Promise<void[]>;
    }
  ).processActiveNotes(scheduleTime, (note: Note) => {
    captured.push(note);
  });
  channel.sostenutoNotes = captured;
}

// Disable resource/timer/op leak checks: audio graph nodes stay alive
// intentionally across the test boundary.
export const sanOptions = {
  sanitizeOps: false,
  sanitizeExit: false,
  sanitizeResources: false,
};
