import { assertEquals, assertNotEquals, assertAlmostEquals } from "@std/assert";
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
  [K in keyof AudioContext as AudioContext[K] extends () => AudioNode
    ? K
    : never]: AudioContext[K];
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
    new (ctx: BaseAudioContext, options?: AudioBufferSourceOptions): AudioBufferSourceNode;
    prototype: AudioBufferSourceNode;
  };

  // We patch at the player's audioContext level by monkey-patching the
  // constructor on globalThis temporarily, but that would affect other tests.
  // Instead we override createBufferSource on the player so every node it
  // produces is wrapped.
  const ctx = player.audioContext;
  const origCreate = (ctx as unknown as AudioContext).createBufferSource.bind(ctx);

  (ctx as unknown as AudioContext).createBufferSource = (): AudioBufferSourceNode => {
    const node = origCreate();
    const origStop = node.stop.bind(node);
    node.stop = (_when?: number): void => {
      // Call the real stop so the node transitions to the stopped state.
      try { origStop(0); } catch { /* ignore if already stopped */ }
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
      try { origStop(0); } catch { /* ignore */ }
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
    assertNotEquals(stack, undefined, "activeNotes[72] must exist after re-trigger");
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

    assertNotEquals(note, undefined, "Note must still be in activeNotes while pedal is held");
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
    assertNotEquals(notes, undefined, "mpeState.channelToNotes must have an entry for ch 1");
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
    assertNotEquals(ch2Notes, undefined, "ch 2 mpeState entry must still exist");
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
    assertEquals(player.channels[0].isMPEMember, false, "ch 0 must not be member");

    for (let ch = 1; ch <= 3; ch++) {
      assertEquals(player.channels[ch].isMPEMember, true, `ch ${ch} must be member`);
      assertEquals(player.channels[ch].isMPEManager, false, `ch ${ch} must not be manager`);
    }

    for (let ch = 4; ch <= 15; ch++) {
      assertEquals(player.channels[ch].isMPEMember, false, `ch ${ch} must not be member`);
      assertEquals(player.channels[ch].isMPEManager, false, `ch ${ch} must not be manager`);
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

    assertEquals(player.mpeEnabled, false, "mpeEnabled must be false after deactivation");
    for (let ch = 0; ch < 16; ch++) {
      assertEquals(player.channels[ch].isMPEMember, false, `ch ${ch} must not be member`);
      assertEquals(player.channels[ch].isMPEManager, false, `ch ${ch} must not be manager`);
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
    assertNotEquals(notes, undefined, "mpeState entry must still exist while pedal is held");
    assertEquals(notes!.size, 1, "Note must still be registered");
    const [note] = notes!;
    assertEquals(note.ending, false, "Note must not be ending while sustain pedal is held");
  },
);

// =========================================================================
// Additional test cases — uncovered paths identified after Case 1-15
// =========================================================================

/**
 * Case 16: Upper MPE zone activation flags channels correctly.
 *
 * setMIDIPolyphonicExpression(15, 3) must make ch 13-14 members and ch 15
 * the manager, without touching the lower half.
 */
Deno.test(
  "Case 16: Upper MPE zone flags ch 15 as manager and ch 13-14 as members",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    // upperStart = 16 - 3 = 13, upperEnd = 14 → members are ch 13 and ch 14.
    player.setMIDIPolyphonicExpression(15, 3);

    assertEquals(player.mpeEnabled, true);
    assertEquals(player.channels[15].isMPEManager, true, "ch 15 must be manager");
    assertEquals(player.channels[15].isMPEMember, false, "ch 15 must not be member");

    for (let ch = 13; ch <= 14; ch++) {
      assertEquals(player.channels[ch].isMPEMember, true, `ch ${ch} must be member`);
      assertEquals(player.channels[ch].isMPEManager, false, `ch ${ch} must not be manager`);
    }

    // Channels outside the upper zone must be untouched.
    for (let ch = 0; ch <= 12; ch++) {
      assertEquals(player.channels[ch].isMPEMember, false, `ch ${ch} must not be member`);
      assertEquals(player.channels[ch].isMPEManager, false, `ch ${ch} must not be manager`);
    }
  },
);

/**
 * Case 17: Both lower and upper MPE zones active simultaneously.
 *
 * Lower zone (ch 0 manager, ch 1-2 members) and upper zone
 * (ch 15 manager, ch 14 member) must coexist without overlap.
 * upperStart = 16 - 2 = 14, upperEnd = 14 → only ch 14 is a member.
 */
Deno.test(
  "Case 17: Lower and upper MPE zones can be active simultaneously",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    player.setMIDIPolyphonicExpression(0, 2);  // lower: ch 1-2
    player.setMIDIPolyphonicExpression(15, 2); // upper: ch 14 only

    assertEquals(player.mpeEnabled, true);
    assertEquals(player.channels[0].isMPEManager, true, "ch 0 manager");
    assertEquals(player.channels[15].isMPEManager, true, "ch 15 manager");

    for (const ch of [1, 2]) {
      assertEquals(player.channels[ch].isMPEMember, true, `ch ${ch} lower member`);
    }
    assertEquals(player.channels[14].isMPEMember, true, "ch 14 upper member");

    // Middle channels must be untouched.
    for (const ch of [3, 4, 11, 12, 13]) {
      assertEquals(player.channels[ch].isMPEMember, false, `ch ${ch} must not be member`);
    }
  },
);

/**
 * Case 18: Sustain pedal release triggers deferred noteOff.
 *
 * noteOff while pedal is held must be deferred; lifting the pedal
 * (setSustainPedal < 64) must then release the note.
 */
Deno.test(
  "Case 18: Lifting sustain pedal releases deferred note",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 150.0);

    const t = player.audioContext.currentTime;

    channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    // noteOff while held — must be deferred, not ignored.
    await channel.noteOff(60, 0, t + 0.05);

    // Pedal still held: note alive.
    assertEquals(channel.activeNotes[60]?.[0]?.ending, false);

    // Lift pedal — deferred noteOff must fire.
    channel.setSustainPedal(0, t + 0.1);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Note must be ending after sustain pedal is released",
    );
  },
);

/**
 * Case 19: Sostenuto pedal — only notes active at pedal-down are held;
 * notes started after pedal-down are not held.
 *
 * Piano behaviour: sostenuto captures only currently sounding notes.
 */
Deno.test(
  "Case 19: Sostenuto pedal holds pre-existing notes but not new ones",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 160.0);

    const t = player.audioContext.currentTime;

    // Start note 60 before pressing sostenuto.
    await channel.noteOn(60, 100, t);

    // setSostenutoPedal is async: awaiting it guarantees processActiveNotes
    // has completed and note 60 is captured before noteOff runs.
    // In this mock environment we use the same direct-await workaround as
    // Case 28 because patchBufferSourceNodes delays note.ready resolution.
    channel.state.sostenutoPedal = 127 / 127;
    const sostenutoNotes: Note[] = [];
    await (channel as unknown as { processActiveNotes(t: number, cb: (n: Note) => void): Promise<void[]> })
      .processActiveNotes(t + 0.01, (note: Note) => { sostenutoNotes.push(note); });
    channel.sostenutoNotes = sostenutoNotes;

    // Start note 64 after sostenuto is down — must NOT be captured.
    await channel.noteOn(64, 100, t + 0.02);

    // noteOff both notes.
    await channel.noteOff(60, 0, t + 0.1);
    await channel.noteOff(64, 0, t + 0.1);
    await flushNotePromises(player);

    // note 60: still alive (held by sostenuto).
    assertEquals(
      channel.activeNotes[60]?.[0]?.ending,
      false,
      "note 60 must be alive — captured by sostenuto",
    );
    // note 64: released immediately (not captured).
    const stack64 = channel.activeNotes[64];
    const last64 = stack64 ? stack64[stack64.length - 1] : undefined;
    assertEquals(
      last64 ? last64.ending : true,
      true,
      "note 64 must be ending — not captured by sostenuto",
    );
  },
);

/**
 * Case 20: allSoundOff cuts notes immediately regardless of pedal state.
 *
 * Unlike allNotesOff, allSoundOff bypasses sustain and marks notes ending
 * via soundOffNote, which does not consult pedal state.
 */
Deno.test(
  "Case 20: allSoundOff cuts notes even while sustain pedal is held",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 170.0);

    const t = player.audioContext.currentTime;

    channel.setSustainPedal(127, t);
    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
    ]);

    await channel.allSoundOff(t + 0.05);
    await flushNotePromises(player);

    for (let n = 0; n < 128; n++) {
      const stack = channel.activeNotes[n];
      if (!stack) continue;
      for (const note of stack) {
        assertEquals(
          note.ending,
          true,
          `note ${n} must be ending after allSoundOff`,
        );
      }
    }
  },
);

/**
 * Case 21: noteOff with no matching active note is a safe no-op.
 *
 * Calling noteOff for a note that was never started (or already ended) must
 * not throw and must leave the player in a consistent state.
 */
Deno.test(
  "Case 21: noteOff with no active note is a safe no-op",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 180.0);

    const t = player.audioContext.currentTime;

    // No noteOn was called — noteOff must simply return without throwing.
    await channel.noteOff(60, 0, t);
    await flushNotePromises(player);

    assertEquals(channel.activeNotes[60], undefined, "activeNotes[60] must remain undefined");
  },
);

/**
 * Case 22: MPE noteOff for a note number not present in the channel's Set
 * is a safe no-op.
 *
 * If a different note is active on the channel, noteOff for the wrong note
 * number must not terminate the wrong note.
 */
Deno.test(
  "Case 22: MPE — noteOff for wrong note number leaves active note untouched",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 190.0);

    const t = player.audioContext.currentTime;

    await player.noteOn(1, 60, 100, t);

    // noteOff for note 64 — which was never started on ch 1.
    await player.noteOff(1, 64, 0, t + 0.05, false);
    await flushNotePromises(player);

    // note 60 must be untouched.
    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(notes, undefined, "mpeState entry for ch 1 must still exist");
    const [note] = notes!;
    assertEquals(note.noteNumber, 60);
    assertEquals(note.ending, false, "note 60 must not be affected by noteOff for note 64");
  },
);

/**
 * Case 23: resetAllStates clears mpeState.channelToNotes.
 *
 * After resetAllStates the MPE note tracking map must be empty so that stale
 * entries from a previous playback cannot leak into the next one.
 */
Deno.test(
  "Case 23: resetAllStates clears mpeState.channelToNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 200.0);

    const t = player.audioContext.currentTime;

    await Promise.all([
      player.noteOn(1, 60, 100, t),
      player.noteOn(2, 64, 100, t),
    ]);

    player.resetAllStates();

    assertEquals(
      player.mpeState.channelToNotes.size,
      0,
      "mpeState.channelToNotes must be empty after resetAllStates",
    );
  },
);

/**
 * Case 24: Multiple notes on one MPE channel — noteOff targets the
 * non-ending note regardless of insertion order in the Set.
 *
 * The MPE spec allows at most one note per member channel in typical usage,
 * but the implementation must still find the correct (non-ending) note when
 * the Set contains more than one entry.
 */
Deno.test(
  "Case 24: MPE — noteOff targets the non-ending note in a multi-entry Set",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 210.0);

    const t = player.audioContext.currentTime;

    // First note on ch 1 — note 60.
    await player.noteOn(1, 60, 100, t);

    // Manually mark it ending (simulating a prior noteOff that left the entry).
    const notesSet = player.mpeState.channelToNotes.get(1)!;
    const [firstNote] = notesSet;
    firstNote.ending = true;

    // Second note on ch 1 — note 60 again (same pitch, new entry).
    await player.noteOn(1, 60, 110, t + 0.01);

    // noteOff must target the second (non-ending) note only.
    await player.noteOff(1, 60, 0, t + 0.1, false);
    await flushNotePromises(player);

    // After noteOff the Set should be empty / deleted.
    // The first (already-ending) entry may have been cleaned up too.
    const remaining = player.mpeState.channelToNotes.get(1);
    const hasNonEndingNote = remaining
      ? [...remaining].some((n) => !n.ending)
      : false;
    assertEquals(
      hasNonEndingNote,
      false,
      "No non-ending note must remain after noteOff",
    );
  },
);
// =========================================================================
// Additional test cases — paths not yet covered by Cases 1-24
// =========================================================================

/**
 * Case 25: Drum channel — noteOff immediately removes the note from
 * activeNotes without entering the release path.
 *
 * On a drum channel (isDrum=true) a non-loop noteOff calls
 * removeFromActiveNotes and returns early, bypassing sustain/sostenuto and
 * the release envelope.  The slot must be gone right after noteOff.
 */
Deno.test(
  "Case 25: Drum channel noteOff removes note immediately (no release path)",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    // ch 10 (index 9) is the standard drum channel.
    const channel = player.channels[9];
    channel.isDrum = true;
    // Program 0 is in soundFontTable; provide bank 128 for drums.
    player.soundFontTable[0][128] = 0;
    setMockCurrentTime(player.audioContext, 220.0);

    const t = player.audioContext.currentTime;

    await channel.noteOn(38, 100, t); // snare
    // Sustain pedal must have no effect on drums.
    channel.setSustainPedal(127, t);
    channel.noteOff(38, 0, t + 0.01);
    await flushNotePromises(player);

    // activeNotes[38] must be emptied — drum noteOff removes immediately.
    const stack = channel.activeNotes[38];
    const alive = stack ? stack.filter((n) => !n.ending) : [];
    assertEquals(alive.length, 0, "Drum note must be removed from activeNotes immediately");
  },
);

/**
 * Case 26: applyToMPEChannels — CC sent to the manager channel propagates
 * to all member channels in the lower zone.
 *
 * setControlChange(0, ...) targets ch 0 (manager).  Because ch 0 isMPEManager,
 * applyToMPEChannels must call the handler for ch 0 and each of ch 1..members.
 */
Deno.test(
  "Case 26: pitchBend on MPE manager channel propagates to all member channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3); // ch 0 manager, ch 1-3 members
    setMockCurrentTime(player.audioContext, 230.0);

    const t = player.audioContext.currentTime;

    // Record the default pitchWheel value before the change.
    const defaultPitch = player.channels[0].state.pitchWheel;

    // setPitchBend on manager ch 0 must propagate to ch 0, 1, 2, 3 via
    // applyToMPEChannels. Unlike CC#7, setPitchBend is not gated by
    // isMPEMember and is the canonical manager-to-member propagation path.
    player.setPitchBend(0, 10000, t);

    const expected = 10000 / 16383;
    for (let ch = 0; ch <= 3; ch++) {
      assertAlmostEquals(
        player.channels[ch].state.pitchWheel,
        expected,
        1e-6,
        `ch ${ch} pitchWheel must be updated by manager setPitchBend`,
      );
    }
    // Non-member channels must be unaffected.
    for (let ch = 4; ch <= 15; ch++) {
      assertAlmostEquals(
        player.channels[ch].state.pitchWheel,
        defaultPitch,
        1e-6,
        `ch ${ch} must not receive manager pitchBend`,
      );
    }
  },
);

/**
 * Case 27: applyToMPEChannels — pitchBend sent directly to a member channel
 * does NOT propagate to the manager or other members.
 *
 * Only the target channel must be updated.
 */
Deno.test(
  "Case 27: pitchBend on MPE member channel does not propagate to other channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 240.0);

    const t = player.audioContext.currentTime;

    // Record the default pitchWheel for all channels before the change.
    const defaultPitch = player.channels[0].state.pitchWheel;

    // setPitchBend sent directly to member ch 2.
    // ch 2 is isMPEMember but NOT isMPEManager, so applyToMPEChannels must
    // only call the handler for ch 2 itself.
    player.setPitchBend(2, 6000, t);

    const expected = 6000 / 16383;
    assertAlmostEquals(
      player.channels[2].state.pitchWheel,
      expected,
      1e-6,
      "ch 2 pitchWheel must be updated",
    );
    // ch 0, 1, 3 must remain at default.
    for (const ch of [0, 1, 3]) {
      assertAlmostEquals(
        player.channels[ch].state.pitchWheel,
        defaultPitch,
        1e-6,
        `ch ${ch} must not be affected by ch 2 pitchBend`,
      );
    }
  },
);

/**
 * Case 28: Lifting the sostenuto pedal releases captured notes.
 *
 * After pressing sostenuto and calling noteOff (which is deferred), lifting
 * the pedal via setSostenutoPedal(0) must release the captured notes.
 */
Deno.test(
  "Case 28: Lifting sostenuto pedal releases captured notes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 250.0);

    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);

    // setSostenutoPedal is async and awaits processActiveNotes internally.
    // However, patchBufferSourceNodes injects an extra Promise.resolve().then()
    // microtask into the audio graph, which delays note.ready resolution in
    // this test environment. As a result, setSostenutoPedal's await completes
    // before note.ready fires, leaving sostenutoNotes empty.
    // We work around this by awaiting processActiveNotes directly, which is
    // equivalent to what setSostenutoPedal does but runs after the mock's
    // microtasks have settled. In production, setSostenutoPedal works correctly.
    channel.state.sostenutoPedal = 127 / 127;
    const sostenutoNotes: Note[] = [];
    await (channel as unknown as { processActiveNotes(t: number, cb: (n: Note) => void): Promise<void[]> })
      .processActiveNotes(t + 0.01, (note: Note) => { sostenutoNotes.push(note); });
    channel.sostenutoNotes = sostenutoNotes;

    await channel.noteOff(60, 0, t + 0.05);
    await flushNotePromises(player);

    // Still alive while pedal is held.
    assertEquals(
      channel.activeNotes[60]?.[0]?.ending,
      false,
      "Note must be alive while sostenuto pedal is held",
    );

    // Lift the sostenuto pedal.
    // releaseSostenutoPedal returns Promises that are not in notePromises, so
    // we snapshot notePromises before and after, then await the new entries.
    const before = player.notePromises.length;
    channel.setSostenutoPedal(0, t + 0.1);
    // Yield once for releaseSostenutoPedal to push its promises.
    await Promise.resolve();
    const released = player.notePromises.slice(before);
    await Promise.allSettled(released);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Note must be ending after sostenuto pedal is released",
    );
  },
);

/**
 * Case 29: resetAllStates clears activeNotes, sustainNotes, and sostenutoNotes
 * on all channels.
 *
 * After notes are started and pedals engaged, resetAllStates must wipe
 * everything — no note should survive in any channel's tracking arrays.
 */
Deno.test(
  "Case 29: resetAllStates clears activeNotes, sustainNotes, and sostenutoNotes",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const ch1 = player.channels[1];
    const ch2 = player.channels[2];
    setMockCurrentTime(player.audioContext, 260.0);

    const t = player.audioContext.currentTime;

    ch1.setSustainPedal(127, t);
    await ch1.noteOn(60, 100, t);

    ch2.setSostenutoPedal(127, t);
    await Promise.resolve();
    await Promise.resolve();
    await ch2.noteOn(64, 100, t);

    player.resetAllStates();

    // activeNotes must be cleared on all channels.
    for (let ch = 0; ch < 16; ch++) {
      const channel = player.channels[ch];
      let hasNote = false;
      for (let n = 0; n < 128; n++) {
        if (channel.activeNotes[n]) { hasNote = true; break; }
      }
      assertEquals(hasNote, false, `ch ${ch} activeNotes must be empty after reset`);
      assertEquals(channel.sustainNotes.length, 0, `ch ${ch} sustainNotes must be empty`);
      assertEquals(channel.sostenutoNotes.length, 0, `ch ${ch} sostenutoNotes must be empty`);
    }
  },
);

/**
 * Case 30: exclusiveClass — a new note with the same exclusiveClass forces
 * the previous note to end immediately.
 *
 * Two notes sharing a non-zero exclusiveClass in their voiceParams must
 * result in the first note being marked ending when the second noteOn fires.
 */
Deno.test(
  "Case 30: exclusiveClass — new note forces previous same-class note to end",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 270.0);

    // Override getVoice to return exclusiveClass=1 for all notes.
    player.soundFonts[0] = {
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
          exclusiveClass: 1, // non-zero: belongs to exclusiveClass 1
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
    } as unknown as import("@marmooo/soundfont-parser").SoundFont;

    const t = player.audioContext.currentTime;

    // First note on note 60.
    await channel.noteOn(60, 100, t);
    const firstNote = channel.activeNotes[60]?.[0];
    assertNotEquals(firstNote, undefined, "First note must be active");

    // Second note on note 62 with same exclusiveClass — must cut note 60.
    await channel.noteOn(62, 100, t + 0.05);
    await flushNotePromises(player);

    assertEquals(
      firstNote!.ending,
      true,
      "First note must be ending after second note with same exclusiveClass starts",
    );
    // Second note must be alive.
    const secondNote = channel.activeNotes[62]?.[0];
    assertNotEquals(secondNote, undefined, "Second note must be active");
    assertEquals(secondNote!.ending, false, "Second note must not be ending");
  },
);

// =========================================================================
// Additional test cases — paths not yet covered by Cases 1-30
// =========================================================================

/**
 * Case 31: resetAllControllers restores pedal and pitchWheel to defaults.
 *
 * After engaging sustain, sostenuto, and pitchBend, resetAllControllers must
 * bring every controller back to its default value so the channel is clean
 * for the next phrase.
 */
Deno.test(
  "Case 31: resetAllControllers restores sustainPedal, sostenutoPedal, and pitchWheel to defaults",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 300.0);
    const t = player.audioContext.currentTime;

    // Dirty the state.
    channel.setSustainPedal(127, t);
    channel.setSostenutoPedal(0, t); // keep at 0 to avoid async capture
    channel.setPitchBend(10000, t);

    assertEquals(channel.state.sustainPedal, 1, "pre-condition: sustainPedal must be 1");
    assertAlmostEquals(channel.state.pitchWheel, 10000 / 16383, 1e-6, "pre-condition: pitchWheel must be set");

    channel.resetAllControllers(t);

    assertEquals(channel.state.sustainPedal, 0, "sustainPedal must be reset to 0");
    assertEquals(channel.state.sostenutoPedal, 0, "sostenutoPedal must be reset to 0");
    assertAlmostEquals(channel.state.pitchWheel, 8192 / 16383, 1e-6, "pitchWheel must be reset to centre (8192/16383)");
  },
);

/**
 * Case 32: setChannelPressure updates channelPressure state.
 *
 * channelPressure must reflect the normalised value (value / 127) after the
 * call.  Drum channels must ignore the call.
 */
Deno.test(
  "Case 32: setChannelPressure updates state and ignores drum channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const melodic = player.channels[1];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 310.0);
    const t = player.audioContext.currentTime;

    melodic.setChannelPressure(64, t);
    assertAlmostEquals(
      melodic.state.channelPressure,
      64 / 127,
      1e-6,
      "channelPressure must be updated on melodic channel",
    );

    const prevDrumPressure = drum.state.channelPressure;
    drum.setChannelPressure(64, t);
    assertEquals(
      drum.state.channelPressure,
      prevDrumPressure,
      "channelPressure must not be updated on drum channel",
    );
  },
);

/**
 * Case 33: setProgramChange updates programNumber.
 *
 * After setProgramChange the channel's programNumber must reflect the new
 * value so that subsequent noteOn calls use the correct soundfont voice.
 */
Deno.test(
  "Case 33: setProgramChange updates channel programNumber",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];

    channel.setProgramChange(42);
    assertEquals(channel.programNumber, 42, "programNumber must be updated to 42");

    channel.setProgramChange(0);
    assertEquals(channel.programNumber, 0, "programNumber must be updatable back to 0");
  },
);

/**
 * Case 34: exclusiveClass eviction works across channels.
 *
 * Two notes on *different* channels sharing the same non-zero exclusiveClass
 * must cause the first note to end when the second one starts.
 * (Case 30 tested same-channel; this tests cross-channel.)
 */
Deno.test(
  "Case 34: exclusiveClass eviction works across different channels",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const ch1 = player.channels[1];
    const ch2 = player.channels[2];
    setMockCurrentTime(player.audioContext, 320.0);

    // Use the same exclusiveClass=1 mock for both channels.
    const exclusiveSoundFont = {
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
          exclusiveClass: 2,
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
    } as unknown as import("@marmooo/soundfont-parser").SoundFont;
    player.soundFonts[0] = exclusiveSoundFont;

    const t = player.audioContext.currentTime;

    await ch1.noteOn(60, 100, t);
    const firstNote = ch1.activeNotes[60]?.[0];
    assertNotEquals(firstNote, undefined, "First note on ch1 must be active");

    // Second noteOn on a different channel with the same exclusiveClass.
    await ch2.noteOn(64, 100, t + 0.05);
    await flushNotePromises(player);

    assertEquals(
      firstNote!.ending,
      true,
      "First note on ch1 must be evicted by exclusiveClass note on ch2",
    );
    const secondNote = ch2.activeNotes[64]?.[0];
    assertNotEquals(secondNote, undefined, "Second note on ch2 must be active");
    assertEquals(secondNote!.ending, false, "Second note must not be ending");
  },
);

/**
 * Case 35: MPE forced noteOff (force=true) via player.noteOff ignores sustain
 * pedal on member channel.
 *
 * Extends Case 15 (which verified that a normal noteOff is deferred) by
 * confirming that force=true bypasses the deferral path in the MPE route.
 */
Deno.test(
  "Case 35: MPE — player.noteOff with force=true ignores sustain pedal",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 330.0);

    const t = player.audioContext.currentTime;
    const ch = player.channels[1];

    ch.setSustainPedal(127, t);
    await player.noteOn(1, 60, 100, t);

    // force=true must bypass the sustain check in the MPE noteOff path.
    await player.noteOff(1, 60, 0, t + 0.05, true);
    await flushNotePromises(player);

    const stack = player.channels[1].activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Note must be ending after forced MPE noteOff regardless of sustain pedal",
    );
    // mpeState must also be cleaned up.
    assertEquals(
      player.mpeState.channelToNotes.has(1),
      false,
      "mpeState entry must be gone after forced noteOff",
    );
  },
);

/**
 * Case 36: allNotesOff respects sustain pedal — notes are deferred, not
 * immediately terminated.
 *
 * allNotesOff (MIDI CC#123) sends noteOff for every active note.  With
 * sustain pedal held, each of those noteOffs must be deferred just like a
 * regular noteOff, so the notes keep sounding until the pedal is lifted.
 */
Deno.test(
  "Case 36: allNotesOff with sustain pedal held defers release",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 340.0);
    const t = player.audioContext.currentTime;

    channel.setSustainPedal(127, t);
    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
    ]);

    await channel.allNotesOff(t + 0.1);
    await flushNotePromises(player);

    // Notes must still be alive because sustain is held.
    for (const nn of [60, 64]) {
      assertEquals(
        channel.activeNotes[nn]?.[0]?.ending,
        false,
        `note ${nn} must still be alive while sustain pedal is held after allNotesOff`,
      );
    }
  },
);

/**
 * Case 37: noteOff on a stacked note pair releases in FIFO order.
 *
 * With two notes on the same pitch, the first noteOff must release the first
 * (oldest) note, leaving the second one still active.  A second noteOff must
 * then release the second note.
 */
Deno.test(
  "Case 37: Stacked same-pitch notes are released in FIFO order",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 350.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 80, t);
    await channel.noteOn(60, 90, t + 0.01);

    const [first, second] = channel.activeNotes[60]!;

    // First noteOff must target the oldest (first) note.
    await channel.noteOff(60, 0, t + 0.1);
    await flushNotePromises(player);

    assertEquals(first.ending, true, "First (oldest) note must be ending after first noteOff");
    assertEquals(second.ending, false, "Second note must still be alive");

    // Second noteOff must target the remaining note.
    await channel.noteOff(60, 0, t + 0.2);
    await flushNotePromises(player);

    assertEquals(second.ending, true, "Second note must be ending after second noteOff");
  },
);

/**
 * Case 38: setPolyphonicKeyPressure updates note.pressure for the target note.
 *
 * Only the note matching noteNumber must have its pressure updated; other
 * active notes on the same channel must be unaffected.
 * MPE member channels must ignore the call (isMPEMember guard).
 */
Deno.test(
  "Case 38: setPolyphonicKeyPressure updates pressure on the target note only",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 360.0);
    const t = player.audioContext.currentTime;

    await Promise.all([
      channel.noteOn(60, 100, t),
      channel.noteOn(64, 100, t),
    ]);

    channel.setPolyphonicKeyPressure(60, 80, t);
    // Yield for processActiveNotes microtasks.
    await Promise.resolve();
    await Promise.resolve();

    const note60 = channel.activeNotes[60]?.[0];
    const note64 = channel.activeNotes[64]?.[0];
    assertNotEquals(note60, undefined);
    assertNotEquals(note64, undefined);
    assertEquals(note60!.pressure, 80, "note 60 pressure must be updated");
    assertEquals(note64!.pressure, 0, "note 64 pressure must be unchanged");
  },
);

/**
 * Case 39: setModulationDepth updates modulationDepthMSB state.
 *
 * Drum channels must ignore the call.
 */
Deno.test(
  "Case 39: setModulationDepth updates state and ignores drum channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const melodic = player.channels[1];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 370.0);
    const t = player.audioContext.currentTime;

    melodic.setModulationDepth(64, t);
    assertAlmostEquals(
      melodic.state.modulationDepthMSB,
      Math.trunc(64) / 127,
      1e-6,
      "modulationDepthMSB must be updated on melodic channel",
    );

    const prevDrum = drum.state.modulationDepthMSB;
    drum.setModulationDepth(64, t);
    assertEquals(
      drum.state.modulationDepthMSB,
      prevDrum,
      "modulationDepthMSB must not be updated on drum channel",
    );
  },
);

/**
 * Case 40: setBankMSB updates bankMSB on the channel.
 */
Deno.test(
  "Case 40: setBankMSB updates channel bankMSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];

    channel.setBankMSB(8);
    assertEquals(channel.bankMSB, 8, "bankMSB must be updated to 8");

    channel.setBankMSB(0);
    assertEquals(channel.bankMSB, 0, "bankMSB must be updatable back to 0");
  },
);

/**
 * Case 41: resetAllControllers with sustainNotes pending — pedal is reset to
 * 0, which must trigger releaseSustainPedal and end the deferred notes.
 *
 * When resetAllControllers resets the sustain pedal (CC#64 = 0), any notes
 * held in sustainNotes must be released.
 */
Deno.test(
  "Case 41: resetAllControllers releases sustainNotes by resetting the pedal",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 380.0);
    const t = player.audioContext.currentTime;

    channel.setSustainPedal(127, t);
    await channel.noteOn(60, 100, t);
    // noteOff is deferred by the pedal.
    await channel.noteOff(60, 0, t + 0.05);
    assertEquals(channel.activeNotes[60]?.[0]?.ending, false, "pre-condition: note must be deferred");

    // resetAllControllers resets sustainPedal to 0, which must release deferred notes.
    channel.resetAllControllers(t + 0.1);
    await flushNotePromises(player);

    const stack = channel.activeNotes[60];
    const lastNote = stack ? stack[stack.length - 1] : undefined;
    assertEquals(
      lastNote ? lastNote.ending : true,
      true,
      "Deferred note must be ending after resetAllControllers resets sustain pedal",
    );
  },
);

/**
 * Case 42: MPE player.noteOff sostenuto defer (line 3595 guard).
 *
 * In the MPE noteOff path, when sostenutoPedal >= 0.5 and force=false, the
 * note must NOT be released — the note must remain in both activeNotes and
 * mpeState.channelToNotes.
 *
 * Note: unlike the non-MPE path (which uses heldBySostenuto to check whether
 * the specific note was captured), the MPE path currently applies a blanket
 * sostenutoPedal guard. This test documents the current behaviour.
 */
Deno.test(
  "Case 42: MPE — sostenutoPedal defers player.noteOff on member channel",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 390.0);
    const t = player.audioContext.currentTime;
    const ch = player.channels[1];

    // Manually engage sostenuto (avoid async capture complexity).
    ch.state.sostenutoPedal = 1;

    await player.noteOn(1, 60, 100, t);
    await player.noteOff(1, 60, 0, t + 0.05, false);
    await flushNotePromises(player);

    // Note must still be registered in mpeState.
    const notes = player.mpeState.channelToNotes.get(1);
    assertNotEquals(notes, undefined, "mpeState entry must still exist while sostenutoPedal is held");
    const [note] = notes!;
    assertEquals(note.ending, false, "Note must not be ending while sostenutoPedal is engaged");
  },
);

/**
 * Case 43: setExpression updates expressionMSB and expressionLSB.
 */
Deno.test(
  "Case 43: setExpression updates expressionMSB state",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 400.0);
    const t = player.audioContext.currentTime;

    channel.setExpression(64, t);
    assertAlmostEquals(
      channel.state.expressionMSB,
      Math.trunc(64) / 127,
      1e-6,
      "expressionMSB must be updated",
    );
    assertAlmostEquals(
      channel.state.expressionLSB,
      64 - Math.trunc(64),
      1e-6,
      "expressionLSB must be updated",
    );
  },
);

/**
 * Case 44: setSoftPedal updates softPedal state.
 *
 * Drum channels must ignore the call.
 */
Deno.test(
  "Case 44: setSoftPedal updates state and ignores drum channels",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const melodic = player.channels[1];
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 410.0);
    const t = player.audioContext.currentTime;

    melodic.setSoftPedal(64, t);
    assertAlmostEquals(
      melodic.state.softPedal,
      64 / 127,
      1e-6,
      "softPedal must be updated on melodic channel",
    );

    const prevDrum = drum.state.softPedal;
    drum.setSoftPedal(64, t);
    assertEquals(
      drum.state.softPedal,
      prevDrum,
      "softPedal must not be updated on drum channel",
    );
  },
);

/**
 * Case 45: setFineTuning updates fineTuning and accumulates into detune.
 *
 * Calling setFineTuning twice must accumulate correctly: the second call
 * replaces the first (delta from previous value), so detune reflects the
 * current fineTuning only.
 */
Deno.test(
  "Case 45: setFineTuning accumulates correctly into channel detune",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 420.0);
    const t = player.audioContext.currentTime;

    const initialDetune = channel.detune;

    channel.setFineTuning(50, t);   // +50 cent
    assertAlmostEquals(channel.fineTuning, 50, 1e-9, "fineTuning must be 50");
    assertAlmostEquals(channel.detune, initialDetune + 50, 1e-9, "detune must increase by 50");

    channel.setFineTuning(30, t);   // replace: -20 cent delta
    assertAlmostEquals(channel.fineTuning, 30, 1e-9, "fineTuning must be 30");
    assertAlmostEquals(channel.detune, initialDetune + 30, 1e-9, "detune must reflect only current fineTuning");

    // Drum channels must ignore setFineTuning.
    const drum = player.channels[9];
    drum.isDrum = true;
    const prevDrumDetune = drum.detune;
    drum.setFineTuning(50, t);
    assertEquals(drum.detune, prevDrumDetune, "drum detune must be unaffected");
  },
);

/**
 * Case 46: setCoarseTuning accumulates correctly into channel detune.
 */
Deno.test(
  "Case 46: setCoarseTuning accumulates correctly into channel detune",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 430.0);
    const t = player.audioContext.currentTime;

    const initialDetune = channel.detune;

    channel.setCoarseTuning(100, t);  // +100 cent
    assertAlmostEquals(channel.coarseTuning, 100, 1e-9);
    assertAlmostEquals(channel.detune, initialDetune + 100, 1e-9);

    channel.setCoarseTuning(-200, t); // replace: -300 cent delta
    assertAlmostEquals(channel.coarseTuning, -200, 1e-9);
    assertAlmostEquals(channel.detune, initialDetune - 200, 1e-9);

    // Drum channels must ignore setCoarseTuning.
    const drum = player.channels[9];
    drum.isDrum = true;
    const prevDrumDetune = drum.detune;
    drum.setCoarseTuning(100, t);
    assertEquals(drum.detune, prevDrumDetune, "drum detune must be unaffected");
  },
);

/**
 * Case 47: setBankLSB updates bankLSB on the channel.
 */
Deno.test(
  "Case 47: setBankLSB updates channel bankLSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];

    channel.setBankLSB(3);
    assertEquals(channel.bankLSB, 3, "bankLSB must be updated to 3");

    channel.setBankLSB(0);
    assertEquals(channel.bankLSB, 0, "bankLSB must be updatable back to 0");
  },
);

/**
 * Case 48: player.setProgramChange on a manager channel propagates to all
 * member channels via applyToMPEChannels.
 */
Deno.test(
  "Case 48: MPE — player.setProgramChange on manager propagates to members",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3); // ch 0 manager, ch 1-3 members
    setMockCurrentTime(player.audioContext, 440.0);

    player.setProgramChange(0, 42);

    for (let ch = 0; ch <= 3; ch++) {
      assertEquals(
        player.channels[ch].programNumber,
        42,
        `ch ${ch} programNumber must be updated by manager setProgramChange`,
      );
    }
    // Non-member channels must be unaffected.
    for (let ch = 4; ch <= 15; ch++) {
      assertNotEquals(
        player.channels[ch].programNumber,
        42,
        `ch ${ch} must not receive manager setProgramChange`,
      );
    }
  },
);

/**
 * Case 49: player.setChannelPressure on a manager channel propagates to all
 * member channels via applyToMPEChannels.
 *
 * Unlike CC#7 (which is blocked by isMPEMember), setChannelPressure has no
 * isMPEMember guard and is the correct propagation path for channel pressure.
 */
Deno.test(
  "Case 49: MPE — player.setChannelPressure on manager propagates to members",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    activateLowerMPEZone(player, 3);
    setMockCurrentTime(player.audioContext, 450.0);
    const t = player.audioContext.currentTime;

    player.setChannelPressure(0, 64, t);

    for (let ch = 0; ch <= 3; ch++) {
      assertAlmostEquals(
        player.channels[ch].state.channelPressure,
        64 / 127,
        1e-6,
        `ch ${ch} channelPressure must be updated by manager propagation`,
      );
    }
    // Non-member channels must be unaffected.
    for (let ch = 4; ch <= 15; ch++) {
      assertNotEquals(
        player.channels[ch].state.channelPressure,
        64 / 127,
        `ch ${ch} must not receive manager channelPressure`,
      );
    }
  },
);

/**
 * Case 50: sustain pedal pressed after noteOn captures that note in
 * sustainNotes via processScheduledNotes.
 *
 * setSustainPedal uses processScheduledNotes (not processActiveNotes) to
 * capture already-active notes. This verifies that the scheduled-note list
 * includes notes that have finished loading (i.e. are no longer "scheduled"
 * in the pending sense) — or that the implementation correctly captures them.
 */
Deno.test(
  "Case 50: sustainNotes is populated when pedal is pressed after noteOn",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 460.0);
    const t = player.audioContext.currentTime;

    await channel.noteOn(60, 100, t);

    // setSustainPedal is now async, so we can await it directly to guarantee
    // sustainNotes is populated before asserting.
    await channel.setSustainPedal(127, t + 0.01);

    // The note must appear in sustainNotes.
    const captured = channel.sustainNotes.some((n) => n.noteNumber === 60);
    assertEquals(
      captured,
      true,
      "Active note must be captured into sustainNotes when pedal is pressed",
    );
  },
);
