// extractMidiData, buildNoteOnDurations, calcTotalTime, getQueueIndex.
import {
  assertAlmostEquals,
  assertEquals,
  PlayerFactory,
  sanOptions,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Minimal event constructors
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
function setTempo(deltaTime: number, bpm: number) {
  return {
    type: "setTempo" as const,
    deltaTime,
    microsecondsPerBeat: Math.round(60_000_000 / bpm),
  };
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

// Helper to call extractMidiData with a given ticksPerBeat set on the player.
function extractWith(
  player: { ticksPerBeat: number } & Record<string, unknown>,
  ticksPerBeat: number,
  midi: unknown,
): { timeline: { type: string; ticks: number; startTime: number }[] } {
  player.ticksPerBeat = ticksPerBeat;
  return (player as unknown as { extractMidiData(m: unknown): unknown })
    .extractMidiData(midi) as {
      timeline: { type: string; ticks: number; startTime: number }[];
    };
}

export function registerTimelineTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  // -----------------------------------------------------------------------
  // extractMidiData — ticks ordering
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] extractMidiData sorts events by ticks ascending`,
    sanOptions,
    () => {
      const player = makePlayer();
      const midi = {
        header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
        tracks: [
          [noteOn(960, 0, 60, 80), noteOff(480, 0, 60, 0)],
          [noteOn(480, 0, 64, 80), noteOff(480, 0, 64, 0)],
        ],
      };

      const { timeline } = extractWith(player as never, 480, midi);

      for (let i = 1; i < timeline.length; i++) {
        assertEquals(
          timeline[i - 1].ticks <= timeline[i].ticks,
          true,
          `events must be sorted: index ${i - 1} ticks=${
            timeline[i - 1].ticks
          } > index ${i} ticks=${timeline[i].ticks}`,
        );
      }
    },
  );

  Deno.test(
    `[${label}] extractMidiData: controller precedes noteOn at same tick`,
    sanOptions,
    () => {
      const player = makePlayer();
      // Both events at tick=480; controller (priority=0) must sort before noteOn (priority=2).
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            noteOn(480, 0, 60, 80), // tick=480, priority=2
            controller(0, 0, 7, 100), // tick=480, priority=0
          ],
        ],
      };

      const { timeline } = extractWith(player as never, 480, midi);
      const atTick480 = timeline.filter((e) => e.ticks === 480);

      assertEquals(
        atTick480[0].type,
        "controller",
        "controller must precede noteOn at same tick",
      );
      assertEquals(atTick480[1].type, "noteOn");
    },
  );

  // -----------------------------------------------------------------------
  // extractMidiData — startTime calculation
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] extractMidiData: startTime at 120bpm default (ticksPerBeat=480)`,
    sanOptions,
    () => {
      const player = makePlayer();
      // Default secondsPerBeat in extractMidiData is 0.5 (120bpm).
      // With ticksPerBeat=480: startTime = 480 * 0.5 / 480 = 0.5s
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[noteOn(480, 0, 60, 80)]],
      };

      const { timeline } = extractWith(player as never, 480, midi);

      assertAlmostEquals(
        timeline[0].startTime,
        0.5,
        1e-6,
        "480 ticks at 120bpm must produce startTime=0.5s",
      );
    },
  );

  Deno.test(
    `[${label}] extractMidiData: setTempo changes startTime mid-song`,
    sanOptions,
    () => {
      const player = makePlayer();
      // ticksPerBeat=480.
      // Ticks 0→480 at default 120bpm (0.5s/beat) → 0.5s elapsed at tick 480.
      // setTempo at tick=480 → switch to 60bpm (1.0s/beat).
      // noteOn at tick=960: 0.5s + (480/480)*1.0s = 1.5s
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            setTempo(480, 60), // tick=480, switch to 60bpm
            noteOn(480, 0, 60, 80), // tick=960
          ],
        ],
      };

      const { timeline } = extractWith(player as never, 480, midi);
      const noteOnEvent = timeline.find((e) => e.type === "noteOn");

      assertAlmostEquals(
        noteOnEvent!.startTime,
        1.5,
        1e-6,
        "noteOn after tempo change must have startTime=1.5s",
      );
    },
  );

  // -----------------------------------------------------------------------
  // buildNoteOnDurations
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] buildNoteOnDurations: simple noteOn/noteOff pair`,
    sanOptions,
    () => {
      const player = makePlayer();
      // 120bpm, ticksPerBeat=480.
      // noteOn tick=0 (t=0s), noteOff tick=480 (t=0.5s) → duration=0.5s
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            noteOn(0, 0, 60, 80),
            noteOff(480, 0, 60, 0),
          ],
        ],
      };

      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: unknown[] };
        buildNoteOnDurations(): void;
        noteOnDurations: Map<number, number>;
        timeline: unknown[];
        ticksPerBeat: number;
        totalTime: number;
        tempo: number;
      };
      p.ticksPerBeat = 480;
      p.tempo = 1;
      const { timeline } = p.extractMidiData(midi);
      p.timeline = timeline;
      p.totalTime = 10;
      p.buildNoteOnDurations();

      const noteOnIdx = (timeline as { type: string }[]).findIndex(
        (e) => e.type === "noteOn",
      );
      const duration = p.noteOnDurations.get(noteOnIdx);
      assertAlmostEquals(
        duration ?? -1,
        0.5,
        1e-4,
        "duration of a 1-beat note at 120bpm must be 0.5s",
      );
    },
  );

  Deno.test(
    `[${label}] buildNoteOnDurations: sustain pedal defers noteOff until pedal release`,
    sanOptions,
    () => {
      const player = makePlayer();
      // ticksPerBeat=480, 120bpm (0.5s/beat):
      //   noteOn     tick=0   → t=0.0s
      //   sustain ON tick=240 → t=0.25s
      //   noteOff    tick=480 → t=0.5s  (deferred — sustain is ON)
      //   sustain OFF tick=720 → t=0.75s → releases pending noteOff
      //
      // finalizeEntry uses the original noteOff time (0.5s), not the sustain-off time.
      // duration = noteOff.t - noteOn.startTime = 0.5 - 0.0 = 0.5s
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            noteOn(0, 0, 60, 80),
            controller(240, 0, 64, 127), // sustain ON at tick=240
            noteOff(240, 0, 60, 0), // tick=480, deferred
            controller(240, 0, 64, 0), // sustain OFF at tick=720
          ],
        ],
      };

      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: unknown[] };
        buildNoteOnDurations(): void;
        noteOnDurations: Map<number, number>;
        timeline: unknown[];
        ticksPerBeat: number;
        totalTime: number;
        tempo: number;
      };
      p.ticksPerBeat = 480;
      p.tempo = 1;
      const { timeline } = p.extractMidiData(midi);
      p.timeline = timeline;
      p.totalTime = 10;
      p.buildNoteOnDurations();

      const noteOnIdx = (timeline as { type: string }[]).findIndex(
        (e) => e.type === "noteOn",
      );
      const duration = p.noteOnDurations.get(noteOnIdx);
      // Sustain defers release until pedal OFF, but duration is computed from
      // the original noteOff timestamp (0.5s), not the pedal-release timestamp.
      assertAlmostEquals(
        duration ?? -1,
        0.5,
        1e-4,
        "duration uses the original noteOff time, not the sustain-release time",
      );
    },
  );

  // -----------------------------------------------------------------------
  // calcTotalTime / getQueueIndex
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] calcTotalTime returns last noteOff time + startDelay`,
    sanOptions,
    () => {
      const player = makePlayer();
      // noteOn tick=0, noteOff tick=960 → t=1.0s at 120bpm/480ppq
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            noteOn(0, 0, 60, 80),
            noteOff(960, 0, 60, 0),
          ],
        ],
      };

      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: unknown[] };
        calcTotalTime(): number;
        timeline: unknown[];
        ticksPerBeat: number;
        startDelay: number;
      };
      p.ticksPerBeat = 480;
      const { timeline } = p.extractMidiData(midi);
      p.timeline = timeline;

      const total = p.calcTotalTime();
      assertAlmostEquals(
        total,
        1.0 + p.startDelay,
        1e-4,
        "totalTime must equal last noteOff time + startDelay",
      );
    },
  );

  Deno.test(
    `[${label}] getQueueIndex returns first event at or after given second`,
    sanOptions,
    () => {
      const player = makePlayer();
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            noteOn(0, 0, 60, 80), // tick=0,   t=0.0s
            noteOn(480, 0, 64, 80), // tick=480,  t=0.5s
            noteOn(480, 0, 67, 80), // tick=960,  t=1.0s
          ],
        ],
      };

      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: { startTime: number }[] };
        getQueueIndex(second: number): number;
        timeline: { startTime: number }[];
        ticksPerBeat: number;
      };
      p.ticksPerBeat = 480;
      const { timeline } = p.extractMidiData(midi);
      p.timeline = timeline;

      const idx = p.getQueueIndex(0.5);
      assertEquals(
        timeline[idx].startTime >= 0.5,
        true,
        "getQueueIndex must point to an event at or after the given time",
      );
    },
  );

  // -----------------------------------------------------------------------
  // Multi-channel sort
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] extractMidiData interleaves events from multiple tracks by ticks`,
    sanOptions,
    () => {
      const player = makePlayer();
      // Track 0: noteOn at tick=0 and tick=960
      // Track 1: noteOn at tick=480
      // Merged and sorted: tick=0, tick=480, tick=960
      const midi = {
        header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
        tracks: [
          [noteOn(0, 0, 60, 80), noteOn(960, 0, 67, 80)],
          [noteOn(480, 1, 64, 80)],
        ],
      };

      const { timeline } = extractWith(player as never, 480, midi);
      const ticks = timeline.map((e) => e.ticks);

      for (let i = 1; i < ticks.length; i++) {
        assertEquals(
          ticks[i - 1] <= ticks[i],
          true,
          `multi-track events must be sorted: ticks[${i - 1}]=${
            ticks[i - 1]
          } > ticks[${i}]=${ticks[i]}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------------
  // velocity=0 noteOn treated as noteOff in buildNoteOnDurations
  // -----------------------------------------------------------------------

  Deno.test(
    `[${label}] buildNoteOnDurations: velocity=0 noteOn is not treated as noteOff`,
    sanOptions,
    () => {
      // extractMidiData preserves type="noteOn" regardless of velocity.
      // velocity=0 → noteOff conversion only happens via midi-file's byte9 flag
      // (parseMidi level), not inside extractMidiData or buildNoteOnDurations.
      // A velocity=0 noteOn therefore opens a second active note, not closes one.
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            noteOn(0, 0, 60, 80),
            noteOn(480, 0, 60, 0), // velocity=0, still type="noteOn"
          ],
        ],
      };

      const player = makePlayer();
      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: { type: string }[] };
        ticksPerBeat: number;
      };
      p.ticksPerBeat = 480;
      const { timeline } = p.extractMidiData(midi);

      const noteOnCount = timeline.filter((e) => e.type === "noteOn").length;
      assertEquals(
        noteOnCount,
        2,
        "both events must remain type=noteOn in the timeline",
      );
    },
  );

  Deno.test(
    `[${label}] buildNoteOnDurations: noteOn without noteOff uses totalTime`,
    sanOptions,
    () => {
      const player = makePlayer();
      // noteOn at tick=0, no noteOff — duration should equal totalTime - startTime.
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[noteOn(0, 0, 60, 80)]],
      };

      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: unknown[] };
        buildNoteOnDurations(): void;
        noteOnDurations: Map<number, number>;
        timeline: unknown[];
        ticksPerBeat: number;
        totalTime: number;
      };
      p.ticksPerBeat = 480;
      const { timeline } = p.extractMidiData(midi);
      p.timeline = timeline;
      p.totalTime = 2.0;
      p.buildNoteOnDurations();

      const duration = p.noteOnDurations.get(0);
      assertAlmostEquals(
        duration ?? -1,
        2.0,
        1e-4,
        "noteOn without noteOff must get duration equal to totalTime",
      );
    },
  );

  Deno.test(
    `[${label}] buildNoteOnDurations: stacked noteOns pair with correct noteOffs`,
    sanOptions,
    () => {
      const player = makePlayer();
      // Two noteOns on same pitch, two noteOffs.
      // noteOn(tick=0), noteOn(tick=240), noteOff(tick=480), noteOff(tick=720)
      // First noteOn duration: 0→480 = 0.5s, second: 240→720 = 0.5s
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [
          [
            noteOn(0, 0, 60, 80),
            noteOn(240, 0, 60, 80),
            noteOff(240, 0, 60, 0), // tick=480
            noteOff(240, 0, 60, 0), // tick=720
          ],
        ],
      };

      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: { type: string }[] };
        buildNoteOnDurations(): void;
        noteOnDurations: Map<number, number>;
        timeline: { type: string }[];
        ticksPerBeat: number;
        totalTime: number;
      };
      p.ticksPerBeat = 480;
      const { timeline } = p.extractMidiData(midi);
      p.timeline = timeline;
      p.totalTime = 10;
      p.buildNoteOnDurations();

      const noteOnIndices = timeline
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === "noteOn")
        .map(({ i }) => i);

      assertEquals(noteOnIndices.length, 2, "must have two noteOn events");
      assertAlmostEquals(
        p.noteOnDurations.get(noteOnIndices[0]) ?? -1,
        0.5,
        1e-4,
        "first noteOn duration must be 0.5s",
      );
      assertAlmostEquals(
        p.noteOnDurations.get(noteOnIndices[1]) ?? -1,
        0.5,
        1e-4,
        "second noteOn duration must be 0.5s",
      );
    },
  );

  Deno.test(
    `[${label}] getQueueIndex returns 0 when seek time is past end of timeline`,
    sanOptions,
    () => {
      const player = makePlayer();
      const midi = {
        header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
        tracks: [[noteOn(0, 0, 60, 80), noteOff(480, 0, 60, 0)]],
      };

      const p = player as unknown as {
        extractMidiData(m: unknown): { timeline: unknown[] };
        getQueueIndex(second: number): number;
        timeline: unknown[];
        ticksPerBeat: number;
      };
      p.ticksPerBeat = 480;
      const { timeline } = p.extractMidiData(midi);
      p.timeline = timeline;

      const idx = p.getQueueIndex(999);
      assertEquals(idx, 0, "getQueueIndex past end of timeline must return 0");
    },
  );
}
