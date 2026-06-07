import { assertEquals, assertNotEquals } from "@std/assert";
import {
  AudioBuffer as WebAudioBuffer,
  AudioContext as WebAudioContext,
} from "npm:web-audio-api";
import { Channel, Midy, Note } from "./midy.ts";

// =========================================================================
// 1. Inject web-audio-api node constructors into globalThis.
//    The library references these globals directly (e.g. `new GainNode(...)`),
//    so they must exist before the first `Midy` instance is created.
// =========================================================================
globalThis.AudioContext = WebAudioContext as unknown as typeof AudioContext;
globalThis.AudioBuffer = WebAudioBuffer as unknown as typeof AudioBuffer;

// Bootstrap a single throwaway context to capture node constructor references.
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
// 2. Helpers
// =========================================================================

/** Override `audioContext.currentTime` with an arbitrary value for testing. */
function setMockCurrentTime(ctx: BaseAudioContext, time: number): void {
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
 * Problem: `releaseNote` returns a Promise that resolves only when
 * `bufferSource.onended` fires.  In the npm:web-audio-api runtime the audio
 * clock never actually advances, so `stop(futureTime)` never triggers the
 * event and the Promise stays pending forever — causing Deno to report
 * "Promise resolution is still pending but the event loop has already resolved".
 *
 * Fix: intercept `AudioBufferSourceNode` construction and wrap `stop()` so
 * that it schedules an immediate microtask that invokes `onended`.
 */
function patchBufferSourceNodes(player: Midy): void {
  const OriginalBufferSource = globalThis.AudioBufferSourceNode as unknown as {
    new (
      ctx: BaseAudioContext,
      options?: AudioBufferSourceOptions,
    ): AudioBufferSourceNode;
    prototype: AudioBufferSourceNode;
  };

  // We patch at the player's audioContext level by monkey-patching the
  // constructor on globalThis temporarily, but that would affect other tests.
  // Instead we override createBufferSource on the player so every node it
  // produces is wrapped.
  const ctx = player.audioContext;
  const origCreate = (ctx as unknown as AudioContext).createBufferSource.bind(
    ctx,
  );

  (ctx as unknown as AudioContext).createBufferSource =
    (): AudioBufferSourceNode => {
      const node = origCreate();
      const origStop = node.stop.bind(node);
      node.stop = (_when?: number): void => {
        // Call the real stop so the node transitions to the stopped state.
        try {
          origStop(0);
        } catch { /* ignore if already stopped */ }
        // Fire onended asynchronously (microtask) so Promise chains resolve.
        Promise.resolve().then(() => {
          if (typeof node.onended === "function") {
            node.onended(new Event("ended"));
          }
        });
      };
      return node;
    };

  // AudioBufferSourceNode constructor is also called directly in some paths.
  // Patch the global constructor so `new AudioBufferSourceNode(ctx, opts)`
  // also returns a wrapped node.
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

  // Copy static members so instanceof checks still work.
  Object.setPrototypeOf(WrappedBufferSource, OriginalBufferSource);
  WrappedBufferSource.prototype = OriginalBufferSource.prototype;
  globalThis.AudioBufferSourceNode = WrappedBufferSource;
}

/**
 * Drain all pending note-release Promises that `noteOffChannel` deposited into
 * `player.notePromises`.  Call this at the end of every test to guarantee the
 * event loop is clean before Deno checks for leaked async ops.
 */
async function flushNotePromises(player: Midy): Promise<void> {
  // Repeat until stable: some releases may enqueue further microtasks.
  for (let i = 0; i < 10; i++) {
    const snapshot = [...player.notePromises];
    if (snapshot.length === 0) break;
    player.notePromises = [];
    await Promise.allSettled(snapshot);
  }
}

/**
 * Build a `Midy` instance wired up for unit testing:
 *   - Minimal soundfont stub (program 0, bank 0).
 *   - `getAudioBuffer` resolves instantly with a tiny AudioBuffer.
 *   - `AudioBufferSourceNode.stop()` immediately fires `onended` so that
 *     release Promises do not hang the event loop.
 */
function setupMidyPlayer(): Midy {
  const ctx = new AudioContext();
  setMockCurrentTime(ctx, 0);

  const player = new Midy(ctx);

  player.soundFontTable[0] = [0];
  player.soundFonts = [
    {
      getVoice: () => ({
        generators: { instrument: 0, sampleID: 0 },
        getParams: () => ({}),
        getAllParams: () => ({
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
          exclusiveClass: 0,
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
        }),
      }),
    } as unknown as import("@marmooo/soundfont-parser").SoundFont,
  ];

  // Replace getAudioBuffer with an instantly-resolving stub.
  // AudioBuffer is a valid member of the real return type union.
  player.getAudioBuffer = (
    _channel: Channel,
    _note: Note,
    _realtime: boolean,
  ): Promise<AudioBuffer> =>
    Promise.resolve(new AudioBuffer({ length: 100, sampleRate: 44100 }));

  // Patch AudioBufferSourceNode so stop() fires onended immediately.
  patchBufferSourceNodes(player);

  return player;
}

// Disable resource/timer/op leak checks: audio graph nodes and the OscillatorNode
// started by createChorusEffect stay alive intentionally across the test boundary.
const sanOptions = {
  sanitizeOps: false,
  sanitizeExit: false,
  sanitizeResources: false,
};

// =========================================================================
// 3. Test cases
// =========================================================================

/**
 * Case 1: noteOff arrives immediately after noteOn for the same note.
 *
 * Expected: the note must be marked `ending` so that the library correctly
 * routed the early noteOff through the release path even though audio loading
 * had not yet finished.
 */
Deno.test(
  "Case 1: noteOff immediately after noteOn triggers release on the note",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 10.0);

    const t = player.audioContext.currentTime;
    const noteOnPromise = channel.noteOn(60, 100, t);
    const noteOffPromise = channel.noteOff(60, 0, t + 0.001);

    await Promise.all([noteOnPromise, noteOffPromise]);
    await flushNotePromises(player);

    // The stack entry may already have been shifted out by removeFromActiveNotes;
    // absence counts as correctly terminated.
    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Note must be in the ending state after noteOff",
    );
  },
);

/**
 * Case 2: noteOff interrupts noteOn before the audio buffer finishes loading.
 *
 * Awaiting noteOff before noteOn reproduces the interleaving that GUI input
 * produces.  The note must end up `ending` regardless of resolution order.
 */
Deno.test(
  "Case 2: noteOff before audio load completes still marks note as ending",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[2];
    setMockCurrentTime(player.audioContext, 15.0);

    const t = player.audioContext.currentTime;
    const noteOnPromise = channel.noteOn(64, 90, t);
    // Await noteOff first to exercise the "not yet ready" code path.
    await channel.noteOff(64, 0, t + 0.002);
    await noteOnPromise;
    await flushNotePromises(player);

    const stack = channel.activeNotes[64];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Note must be ending even when noteOff preceded audio load",
    );
  },
);

/**
 * Case 3: Same note number assigned to two distinct MPE member channels
 * simultaneously.
 *
 * Each channel must hold exactly one active-note entry for that note, and the
 * per-channel pitchWheel values must differ, proving channel isolation.
 */
Deno.test(
  "Case 3: MPE — same note on two member channels stays isolated",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    player.mpeEnabled = true;

    const ch1 = player.channels[1];
    const ch2 = player.channels[2];
    ch1.isMPEMember = true;
    ch2.isMPEMember = true;

    setMockCurrentTime(player.audioContext, 20.0);
    const t = player.audioContext.currentTime;

    const p1 = ch1.noteOn(60, 100, t);
    ch1.setPitchBend(9000, t + 0.001);

    const p2 = ch2.noteOn(60, 110, t + 0.002);
    ch2.setPitchBend(4000, t + 0.003);

    await Promise.all([p1, p2]);
    await flushNotePromises(player);

    assertEquals(
      ch1.activeNotes[60]?.length ?? 0,
      1,
      "ch1 should have exactly one active note for note 60",
    );
    assertEquals(
      ch2.activeNotes[60]?.length ?? 0,
      1,
      "ch2 should have exactly one active note for note 60",
    );
    assertNotEquals(
      ch1.state.pitchWheel,
      ch2.state.pitchWheel,
      "MPE channels must have independent pitchWheel state",
    );
  },
);

/**
 * Case 4: Rapid re-trigger — same note struck again while the first is still
 * in its release tail.
 *
 * The top of the stack after the second noteOn must be a fresh, non-ending
 * note, confirming that the retrigger is tracked separately.
 */
Deno.test(
  "Case 4: Re-trigger after noteOff creates a fresh non-ending note",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[3];
    setMockCurrentTime(player.audioContext, 30.0);

    const t = player.audioContext.currentTime;

    await channel.noteOn(72, 100, t);
    await channel.noteOff(72, 0, t + 0.1);
    await flushNotePromises(player);

    // Second press while first note is still releasing.
    await channel.noteOn(72, 110, t + 0.105);
    await flushNotePromises(player);

    const stack = channel.activeNotes[72];
    assertNotEquals(
      stack,
      undefined,
      "activeNotes[72] must exist after re-trigger",
    );
    const topNote = stack![stack!.length - 1];
    assertEquals(
      topNote.ending,
      false,
      "The re-triggered note must not be in the ending state",
    );
  },
);

/**
 * Case 5: allNotesOff terminates all active notes on a channel.
 *
 * After allNotesOff no note may remain in a non-ending state.
 */
Deno.test(
  "Case 5: allNotesOff clears all active notes on the channel",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[4];
    setMockCurrentTime(player.audioContext, 40.0);

    const t = player.audioContext.currentTime;

    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
      channel.noteOn(67, 100, t),
    ]);

    await channel.allNotesOff(t + 0.1);
    await flushNotePromises(player);

    let hasActiveNote = false;
    for (let n = 0; n < 128; n++) {
      const stack = channel.activeNotes[n];
      if (!stack) continue;
      for (const note of stack) {
        if (!note.ending) {
          hasActiveNote = true;
          break;
        }
      }
    }
    assertEquals(
      hasActiveNote,
      false,
      "No non-ending note should remain after allNotesOff",
    );
  },
);

/**
 * Case 6: Sustain pedal held — noteOff must NOT terminate the note.
 *
 * With sustainPedal >= 64 the release is deferred until the pedal is lifted.
 * The note must still be present and non-ending immediately after noteOff.
 */
Deno.test(
  "Case 6: Sustain pedal defers noteOff (note stays alive)",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[5];
    setMockCurrentTime(player.audioContext, 50.0);

    const t = player.audioContext.currentTime;

    channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    await channel.noteOff(60, 0, t + 0.05);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const note = stack ? stack[0] : undefined;

    assertNotEquals(
      note,
      undefined,
      "Note must still be in activeNotes while pedal is held",
    );
    assertEquals(
      note?.ending,
      false,
      "Note must not be ending while sustain pedal is engaged",
    );
  },
);

/**
 * Case 7: Polyphonic same-note stacking.
 *
 * Two consecutive noteOn calls for the same note number must each create a
 * separate entry in activeNotes, both non-ending.
 */
Deno.test(
  "Case 7: Polyphonic same-note stacking — two notes on the same pitch",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[6];
    setMockCurrentTime(player.audioContext, 60.0);

    const t = player.audioContext.currentTime;

    await Promise.all([
      channel.noteOn(60, 80, t),
      channel.noteOn(60, 90, t + 0.01),
    ]);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    assertNotEquals(stack, undefined, "activeNotes[60] must exist");
    assertEquals(
      stack!.length,
      2,
      "Both notes on the same pitch must be stacked in activeNotes",
    );
    assertEquals(stack![0].ending, false);
    assertEquals(stack![1].ending, false);
  },
);

/**
 * Case 8: Forced noteOff bypasses the sustain pedal.
 *
 * Even with sustainPedal engaged, `force=true` must immediately mark the note
 * as ending.
 */
Deno.test(
  "Case 8: Forced noteOff terminates note regardless of sustain pedal",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[7];
    setMockCurrentTime(player.audioContext, 70.0);

    const t = player.audioContext.currentTime;

    channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    await channel.noteOff(60, 0, t + 0.05, true);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Forced noteOff must mark note as ending even with sustain pedal engaged",
    );
  },
);

// =========================================================================
// MPE-specific test cases
// These use player.noteOn / player.noteOff (the MPE-aware top-level methods)
// rather than channel.noteOn / channel.noteOff, and verify behaviour that
// only activates when mpeEnabled === true and isMPEMember === true.
// =========================================================================

/**
 * Helper: activate MPE lower zone with `members` member channels (ch 1..members)
 * managed by ch 0.  Mirrors what setMIDIPolyphonicExpression does internally.
 */
function activateLowerMPEZone(player: Midy, members: number): void {
  player.setMIDIPolyphonicExpression(0, members);
}

/**
 * Case 9: player.noteOn registers the note in mpeState.channelToNotes.
 *
 * When noteOn is called through the player-level API on an MPE member channel
 * the resulting Note must appear in mpeState.channelToNotes for that channel.
 */
Deno.test(
  "Case 9: MPE — player.noteOn registers note in mpeState.channelToNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3); // ch 0 = manager, ch 1-3 = members
    setMockCurrentTime(player.audioContext, 100.0);

    const t = player.audioContext.currentTime;
    await player.noteOn(1, 60, 100, t);
    await flushNotePromises(player);

    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(
      notes,
      undefined,
      "mpeState.channelToNotes must have an entry for ch 1",
    );
    assertEquals(notes!.size, 1, "Exactly one note must be registered");
    const [note] = notes!;
    assertEquals(note.noteNumber, 60);
    assertEquals(note.ending, false);
  },
);

/**
 * Case 10: player.noteOff removes the note from mpeState.channelToNotes.
 *
 * After a matching noteOff the Set for the channel must be deleted entirely
 * (not just emptied) so that subsequent noteOff calls return early.
 */
Deno.test(
  "Case 10: MPE — player.noteOff cleans up mpeState.channelToNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 110.0);

    const t = player.audioContext.currentTime;
    await player.noteOn(1, 60, 100, t);
    await player.noteOff(1, 60, 0, t + 0.1, false);
    await flushNotePromises(player);

    // The Map entry must be deleted once the Set becomes empty.
    assertEquals(
      player.mpeState.channelToNotes.has(1),
      false,
      "mpeState.channelToNotes entry must be deleted after the last note ends",
    );
  },
);

/**
 * Case 11: player.noteOff before audio load completes (MPE path).
 *
 * Reproduces the GUI race condition through the MPE code path: noteOff arrives
 * before noteOnChannel has finished awaiting getAudioBuffer.  The note must
 * still be marked ending and cleaned up from mpeState.
 */
Deno.test(
  "Case 11: MPE — player.noteOff before audio load still marks note as ending",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 120.0);

    const t = player.audioContext.currentTime;
    const noteOnPromise = player.noteOn(1, 64, 90, t);
    // Fire noteOff immediately, before noteOn's async chain completes.
    await player.noteOff(1, 64, 0, t + 0.001, false);
    await noteOnPromise;
    await flushNotePromises(player);

    // mpeState entry should be gone.
    assertEquals(
      player.mpeState.channelToNotes.has(1),
      false,
      "mpeState entry must be gone after early noteOff",
    );
    // activeNotes must reflect the ended state.
    const stack = player.channels[1].activeNotes[64];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Note must be ending after MPE noteOff preceding audio load",
    );
  },
);

/**
 * Case 12: Two notes on different MPE channels with the same pitch — each
 * channel's mpeState entry is independent.
 *
 * Both notes must appear in their respective channelToNotes Sets.  A noteOff
 * on ch 1 must only remove the ch 1 note and must not touch ch 2.
 */
Deno.test(
  "Case 12: MPE — noteOff on ch1 does not affect the note on ch2",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 130.0);

    const t = player.audioContext.currentTime;
    await Promise.all([
      player.noteOn(1, 60, 100, t),
      player.noteOn(2, 60, 110, t + 0.001),
    ]);

    // Release only ch 1.
    await player.noteOff(1, 60, 0, t + 0.1, false);
    await flushNotePromises(player);

    // ch 1 must be gone.
    assertEquals(
      player.mpeState.channelToNotes.has(1),
      false,
      "ch 1 mpeState entry must be deleted after its noteOff",
    );

    // ch 2 must be untouched.
    const ch2Notes = player.mpeState.channelToNotes.get(2);
    assertNotEquals(
      ch2Notes,
      undefined,
      "ch 2 mpeState entry must still exist",
    );
    assertEquals(ch2Notes!.size, 1, "ch 2 must still have one active note");
    const [ch2Note] = ch2Notes!;
    assertEquals(ch2Note.ending, false, "ch 2 note must not be ending");
  },
);

/**
 * Case 13: setMIDIPolyphonicExpression correctly flags channels.
 *
 * After activating a lower zone with 3 members:
 *   - ch 0 must be isMPEManager
 *   - ch 1-3 must be isMPEMember
 *   - ch 4-15 must be neither
 *   - mpeEnabled must be true
 */
Deno.test(
  "Case 13: MPE zone activation flags channels correctly",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);

    assertEquals(player.mpeEnabled, true, "mpeEnabled must be true");
    assertEquals(player.channels[0].isMPEManager, true, "ch 0 must be manager");
    assertEquals(
      player.channels[0].isMPEMember,
      false,
      "ch 0 must not be member",
    );

    for (let ch = 1; ch <= 3; ch++) {
      assertEquals(
        player.channels[ch].isMPEMember,
        true,
        `ch ${ch} must be member`,
      );
      assertEquals(
        player.channels[ch].isMPEManager,
        false,
        `ch ${ch} must not be manager`,
      );
    }

    for (let ch = 4; ch <= 15; ch++) {
      assertEquals(
        player.channels[ch].isMPEMember,
        false,
        `ch ${ch} must not be member`,
      );
      assertEquals(
        player.channels[ch].isMPEManager,
        false,
        `ch ${ch} must not be manager`,
      );
    }
  },
);

/**
 * Case 14: Disabling MPE (members = 0) clears all member/manager flags.
 *
 * After calling setMIDIPolyphonicExpression(0, 0) every channel must have
 * isMPEMember = false and isMPEManager = false, and mpeEnabled must be false.
 */
Deno.test(
  "Case 14: MPE zone deactivation clears all channel flags",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    // Deactivate.
    player.setMIDIPolyphonicExpression(0, 0);

    assertEquals(
      player.mpeEnabled,
      false,
      "mpeEnabled must be false after deactivation",
    );
    for (let ch = 0; ch < 16; ch++) {
      assertEquals(
        player.channels[ch].isMPEMember,
        false,
        `ch ${ch} must not be member`,
      );
      assertEquals(
        player.channels[ch].isMPEManager,
        false,
        `ch ${ch} must not be manager`,
      );
    }
  },
);

/**
 * Case 15: MPE sustain pedal on a member channel defers noteOff.
 *
 * The MPE path in noteOff checks the channel's sustainPedal state before
 * acting.  With the pedal held the note must remain non-ending in both
 * activeNotes and mpeState.channelToNotes.
 */
Deno.test(
  "Case 15: MPE — sustain pedal on member channel defers player.noteOff",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 140.0);

    const t = player.audioContext.currentTime;
    const ch = player.channels[1];

    ch.setSustainPedal(127, t);
    await player.noteOn(1, 60, 100, t);
    // noteOff must be silently ignored while the pedal is held.
    await player.noteOff(1, 60, 0, t + 0.05, false);
    await flushNotePromises(player);

    // Note must still be alive in mpeState.
    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(
      notes,
      undefined,
      "mpeState entry must still exist while pedal is held",
    );
    assertEquals(notes!.size, 1, "Note must still be registered");
    const [note] = notes!;
    assertEquals(
      note.ending,
      false,
      "Note must not be ending while sustain pedal is held",
    );
  },
);
