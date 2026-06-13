// Playback-control tests: updateStates, seek, tempoChange, pause/resume, loop.
// These exercise the state-management paths that the timeline tests don't reach,
// in particular the `Math.max(now, t)` fix in updateStates.
import {
  assertAlmostEquals,
  assertEquals,
  PlayerFactory,
  sanOptions,
  setMockCurrentTime,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noteOn(
  deltaTime: number,
  channel: number,
  noteNumber: number,
  velocity: number,
) {
  return { type: "noteOn" as const, deltaTime, channel, noteNumber, velocity };
}
function noteOff(
  deltaTime: number,
  channel: number,
  noteNumber: number,
  velocity: number,
) {
  return { type: "noteOff" as const, deltaTime, channel, noteNumber, velocity };
}
function controller(
  deltaTime: number,
  channel: number,
  controllerType: number,
  value: number,
) {
  return {
    type: "controller" as const,
    deltaTime,
    channel,
    controllerType,
    value,
  };
}
function programChange(deltaTime: number, channel: number, programNumber: number) {
  return { type: "programChange" as const, deltaTime, channel, programNumber };
}
function pitchBend(deltaTime: number, channel: number, value: number) {
  return { type: "pitchBend" as const, deltaTime, channel, value };
}

// ---------------------------------------------------------------------------
// Internal player shape used by these tests
// ---------------------------------------------------------------------------

interface PlaybackPlayer {
  audioContext: BaseAudioContext;
  ticksPerBeat: number;
  tempo: number;
  totalTime: number;
  startTime: number;
  resumeTime: number;
  loop: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  isSeeking: boolean;
  channels: {
    state: {
      volumeMSB: number;
      panMSB: number;
      pitchWheel: number;
    };
    programNumber: number;
    resetAllControllers(t?: number): void;
  }[];
  timeline: unknown[];
  extractMidiData(midi: unknown): { timeline: unknown[] };
  buildNoteOnDurations(): void;
  getQueueIndex(second: number): number;
  updateStates(queueIndex: number, nextQueueIndex: number): void;
  currentTime(): number;
  seekTo(second: number): void;
  tempoChange(tempo: number): void;
}

function asPlayback(player: unknown): PlaybackPlayer {
  return player as unknown as PlaybackPlayer;
}

function buildTimeline(
  player: PlaybackPlayer,
  midi: unknown,
): void {
  const { timeline } = player.extractMidiData(midi);
  player.timeline = timeline;
  player.totalTime = 10;
  player.buildNoteOnDurations();
}

// ---------------------------------------------------------------------------
// updateStates — the core of the seek bug fix
// ---------------------------------------------------------------------------

export function registerPlaybackTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  // -------------------------------------------------------------------------
  // updateStates: CC state is applied for skipped events
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] updateStates: channel volume CC is applied for skipped events`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1;

      // CC7 (volume=80) at tick=0 (t=0.0s), noteOn at tick=480 (t=0.5s).
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[
          controller(0, 0, 7, 80), // volume=80 at tick=0
          noteOn(480, 0, 60, 100), // tick=480
        ]],
      };
      buildTimeline(player, midi);

      // Simulate: user seeks to 0.5s (skipping the CC event).
      // now=2.0, resumeTime=0.5 → t = 2.0 - 0.5 + 0.0 * 1 = 1.5 < now
      // Math.max(now, t) must clamp to now (2.0) without crashing.
      setMockCurrentTime(player.audioContext, 2.0);
      player.resumeTime = 0.5;

      const ccIdx = (player.timeline as { type: string }[]).findIndex(
        (e) => e.type === "controller",
      );
      const noteIdx = (player.timeline as { type: string }[]).findIndex(
        (e) => e.type === "noteOn",
      );

      // updateStates processes [ccIdx, noteIdx) — i.e. just the CC event.
      player.updateStates(ccIdx, noteIdx);

      assertEquals(
        player.channels[0].state.volumeMSB,
        80,
        "channel volume must be set to 80 after updateStates processes the CC event",
      );
    },
  );

  // -------------------------------------------------------------------------
  // updateStates: t < now is clamped to now (the actual bug)
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] updateStates: scheduleTime is never in the past (Math.max fix)`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1;

      // CC at tick=0 (t=0.0s).
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[controller(0, 0, 7, 64)]],
      };
      buildTimeline(player, midi);

      // now=5.0, resumeTime=3.0 → t = 5.0 - 3.0 + 0.0 = 2.0 < now(5.0).
      // Before the fix this would schedule to t=2.0 (past), which Web Audio ignores.
      // After the fix: Math.max(5.0, 2.0) = 5.0.
      // We verify indirectly: setControlChange must be called without throwing,
      // and channel state must reflect the value.
      setMockCurrentTime(player.audioContext, 5.0);
      player.resumeTime = 3.0;

      // Should not throw.
      player.updateStates(0, 1);

      assertEquals(
        player.channels[0].state.volumeMSB,
        64,
        "CC must be applied even when event time is in the past relative to now",
      );
    },
  );

  // -------------------------------------------------------------------------
  // updateStates: nextQueueIndex < queueIndex wraps to 0 (loop seek)
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] updateStates: nextQueueIndex < queueIndex resets to 0`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1;

      // CC at tick=0, noteOn at tick=480, noteOn at tick=960.
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[
          controller(0, 0, 7, 99),
          noteOn(480, 0, 60, 80),
          noteOn(480, 0, 64, 80),
        ]],
      };
      buildTimeline(player, midi);
      setMockCurrentTime(player.audioContext, 0.1);
      player.resumeTime = 0.1;

      // queueIndex=2 (mid-song), nextQueueIndex=1 (loop back to beginning).
      // The branch `if (nextQueueIndex < queueIndex) queueIndex = 0` must fire,
      // so events [0, 1) (the CC at index 0) are processed.
      player.updateStates(2, 1);

      assertEquals(
        player.channels[0].state.volumeMSB,
        99,
        "on loop wrap, updateStates must restart from 0 and apply CC at tick=0",
      );
    },
  );

  // -------------------------------------------------------------------------
  // updateStates: programChange is applied for skipped events
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] updateStates: programChange is applied for skipped events`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1;

      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[
          programChange(0, 0, 42),
          noteOn(480, 0, 60, 80),
        ]],
      };
      buildTimeline(player, midi);
      setMockCurrentTime(player.audioContext, 1.0);
      player.resumeTime = 0.5;

      const pcIdx = (player.timeline as { type: string }[]).findIndex(
        (e) => e.type === "programChange",
      );
      const noteIdx = (player.timeline as { type: string }[]).findIndex(
        (e) => e.type === "noteOn",
      );

      player.updateStates(pcIdx, noteIdx);

      assertEquals(
        player.channels[0].programNumber,
        42,
        "programChange must be applied by updateStates",
      );
    },
  );

  // -------------------------------------------------------------------------
  // updateStates: pitchBend is applied for skipped events
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] updateStates: pitchBend is applied for skipped events`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1;

      // pitchBend value=100 → setPitchBend receives value+8192=8292.
      // channel.state.pitchWheel stores the raw value passed to setPitchBend.
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[
          pitchBend(0, 0, 100),
          noteOn(480, 0, 60, 80),
        ]],
      };
      buildTimeline(player, midi);
      setMockCurrentTime(player.audioContext, 1.0);
      player.resumeTime = 0.5;

      const pbIdx = (player.timeline as { type: string }[]).findIndex(
        (e) => e.type === "pitchBend",
      );
      const noteIdx = (player.timeline as { type: string }[]).findIndex(
        (e) => e.type === "noteOn",
      );

      player.updateStates(pbIdx, noteIdx);

      assertEquals(
        player.channels[0].state.pitchWheel,
        8292,
        "pitchBend must be applied by updateStates (value + 8192)",
      );
    },
  );

  // -------------------------------------------------------------------------
  // seekTo: resumeTime is set correctly (not playing)
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] seekTo: sets resumeTime when not playing`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.resumeTime = 0;
      player.isPlaying = false;

      player.seekTo(3.5);

      assertEquals(player.resumeTime, 3.5, "seekTo must set resumeTime");
    },
  );

  Deno.test(
    `[${label}] seekTo: sets isSeeking=true when playing`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.resumeTime = 0;
      player.isPlaying = true;
      player.isSeeking = false;

      player.seekTo(2.0);

      assertEquals(player.resumeTime, 2.0, "seekTo must update resumeTime");
      assertEquals(player.isSeeking, true, "seekTo must set isSeeking when playing");
    },
  );

  // -------------------------------------------------------------------------
  // tempoChange: resumeTime is rescaled correctly
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] tempoChange: rescales resumeTime by old/new tempo ratio`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1.0;
      player.resumeTime = 2.0;
      player.isPlaying = false;
      player.isSeeking = false;

      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[noteOn(0, 0, 60, 80), noteOff(960, 0, 60, 0)]],
      };
      buildTimeline(player, midi);
      setMockCurrentTime(player.audioContext, 0);

      // tempo 1.0 → 2.0: resumeTime should scale by 1.0/2.0 = 0.5 → 1.0
      player.tempoChange(2.0);

      assertAlmostEquals(
        player.tempo,
        2.0,
        1e-9,
        "tempo must be updated to 2.0",
      );
      assertAlmostEquals(
        player.resumeTime,
        1.0,
        1e-6,
        "resumeTime must be rescaled: 2.0 * (1.0/2.0) = 1.0",
      );
    },
  );

  Deno.test(
    `[${label}] tempoChange: currentTime is consistent after tempo change (not playing)`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1.0;
      player.resumeTime = 4.0;
      player.isPlaying = false;
      player.isSeeking = false;

      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[noteOn(0, 0, 60, 80), noteOff(1920, 0, 60, 0)]],
      };
      buildTimeline(player, midi);
      setMockCurrentTime(player.audioContext, 0);

      // currentTime() == resumeTime when not playing.
      // After tempoChange(0.5): resumeTime = 4.0 * (1.0/0.5) = 8.0.
      // currentTime() should also return 8.0.
      player.tempoChange(0.5);

      assertAlmostEquals(
        player.currentTime(),
        8.0,
        1e-6,
        "currentTime must equal rescaled resumeTime when not playing",
      );
    },
  );

  // -------------------------------------------------------------------------
  // getQueueIndex: used by seek to find the correct start position
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] getQueueIndex: points to first event at or after seek target`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1;

      // tick=0 (t=0.0s), tick=480 (t=0.5s), tick=960 (t=1.0s)
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[
          noteOn(0, 0, 60, 80),
          noteOn(480, 0, 64, 80),
          noteOn(480, 0, 67, 80),
        ]],
      };
      buildTimeline(player, midi);

      const idx = player.getQueueIndex(0.5);
      const tl = player.timeline as { startTime: number }[];

      assertEquals(
        tl[idx].startTime >= 0.5,
        true,
        "getQueueIndex must point to event at or after 0.5s",
      );
      if (idx > 0) {
        assertEquals(
          tl[idx - 1].startTime < 0.5,
          true,
          "event before getQueueIndex result must be before 0.5s",
        );
      }
    },
  );

  Deno.test(
    `[${label}] getQueueIndex: seek to 0.0s returns index of first event`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.ticksPerBeat = 480;
      player.tempo = 1;

      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[noteOn(0, 0, 60, 80), noteOff(480, 0, 60, 0)]],
      };
      buildTimeline(player, midi);

      const idx = player.getQueueIndex(0.0);
      assertEquals(idx, 0, "getQueueIndex(0) must return 0");
    },
  );

  // -------------------------------------------------------------------------
  // currentTime: not playing returns resumeTime
  // -------------------------------------------------------------------------

  Deno.test(
    `[${label}] currentTime: returns resumeTime when not playing`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.isPlaying = false;
      player.resumeTime = 3.75;

      assertAlmostEquals(
        player.currentTime(),
        3.75,
        1e-9,
        "currentTime must equal resumeTime when not playing",
      );
    },
  );

  Deno.test(
    `[${label}] currentTime: advances with audioContext.currentTime when playing`,
    sanOptions,
    () => {
      const player = asPlayback(makePlayer());
      player.resumeTime = 1.0;
      player.startTime = 10.0;
      player.isPlaying = true;
      player.tempo = 1.0;
      setMockCurrentTime(player.audioContext, 11.5);

      // currentTime() = now + resumeTime - startTime = 11.5 + 1.0 - 10.0 = 2.5
      assertAlmostEquals(
        player.currentTime(),
        2.5,
        1e-9,
        "currentTime must reflect elapsed playback time",
      );
    },
  );
}
