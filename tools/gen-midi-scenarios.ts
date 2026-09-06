// Scenario MIDI builders for fluidsynth-vs-midy conformance.
// Complements gen-single-note-midi.ts with multi-note / exclusive-class
// patterns that exercise voice stealing and SF2 exclusiveClass behaviour.
import { type MidiData, writeMidi } from "midi-file";

// deno-lint-ignore no-explicit-any
type MidiTrackEvent = any;

export interface TimedNote {
  /** Absolute time in seconds from track start. */
  time: number;
  channel: number;
  noteNumber: number;
  velocity: number;
  /** Note length in seconds. */
  duration: number;
  releaseVelocity?: number;
}

export interface TimedController {
  time: number;
  channel: number;
  /** CC number 0-127 (e.g. 7=volume, 11=expression, 64=sustain). */
  controllerType: number;
  value: number;
}

export interface TimedPitchBend {
  time: number;
  channel: number;
  /**
   * Pitch bend as used by the `midi-file` package (signed):
   * -8192 = min, 0 = center, +8191 = max.
   * (Parser stores `raw14 - 0x2000`; writer does `0x2000 + value`.)
   */
  value: number;
}

export interface ScenarioMidiOptions {
  notes: TimedNote[];
  controllers?: TimedController[];
  pitchBends?: TimedPitchBend[];
  /** Program changes applied at t=0 per channel (channel -> program). */
  programs?: Record<number, number>;
  /** Trailing silence after the last note-off. Default: 2. */
  tailSilence?: number;
  ticksPerBeat?: number;
  microsecondsPerBeat?: number;
}

const DEFAULT_TICKS = 480;
const DEFAULT_TEMPO = 500_000; // 120 BPM

function secondsToTicks(
  seconds: number,
  ticksPerBeat: number,
  microsecondsPerBeat: number,
): number {
  const beats = (seconds * 1_000_000) / microsecondsPerBeat;
  return Math.round(beats * ticksPerBeat);
}

/**
 * Build a format-0 SMF from absolute-timed notes.
 * Events are sorted by time; simultaneous events keep stable insertion order.
 */
export function buildScenarioMidi(options: ScenarioMidiOptions): Uint8Array {
  const ticksPerBeat = options.ticksPerBeat ?? DEFAULT_TICKS;
  const microsecondsPerBeat = options.microsecondsPerBeat ?? DEFAULT_TEMPO;
  const tailSilence = options.tailSilence ?? 2;
  const toTicks = (s: number) =>
    secondsToTicks(s, ticksPerBeat, microsecondsPerBeat);

  type AbsEvent = { ticks: number; order: number; event: MidiTrackEvent };
  const abs: AbsEvent[] = [];
  let order = 0;

  abs.push({
    ticks: 0,
    order: order++,
    event: {
      deltaTime: 0,
      meta: true,
      type: "setTempo",
      microsecondsPerBeat,
    },
  });

  const programs = options.programs ?? {};
  for (const [chStr, program] of Object.entries(programs)) {
    const channel = Number(chStr);
    abs.push({
      ticks: 0,
      order: order++,
      event: {
        deltaTime: 0,
        type: "programChange",
        channel,
        programNumber: program,
      },
    });
  }

  for (const n of options.notes) {
    abs.push({
      ticks: toTicks(n.time),
      order: order++,
      event: {
        deltaTime: 0,
        type: "noteOn",
        channel: n.channel,
        noteNumber: n.noteNumber,
        velocity: n.velocity,
      },
    });
    abs.push({
      ticks: toTicks(n.time + n.duration),
      order: order++,
      event: {
        deltaTime: 0,
        type: "noteOff",
        channel: n.channel,
        noteNumber: n.noteNumber,
        velocity: n.releaseVelocity ?? 0,
      },
    });
  }

  for (const c of options.controllers ?? []) {
    abs.push({
      ticks: toTicks(c.time),
      order: order++,
      event: {
        deltaTime: 0,
        type: "controller",
        channel: c.channel,
        controllerType: c.controllerType,
        value: c.value,
      },
    });
  }

  for (const pb of options.pitchBends ?? []) {
    abs.push({
      ticks: toTicks(pb.time),
      order: order++,
      event: {
        deltaTime: 0,
        type: "pitchBend",
        channel: pb.channel,
        value: pb.value,
      },
    });
  }

  abs.sort((a, b) => a.ticks - b.ticks || a.order - b.order);

  let lastTicks = 0;
  let maxTicks = 0;
  const events: MidiTrackEvent[] = [];
  for (const item of abs) {
    const delta = item.ticks - lastTicks;
    events.push({ ...item.event, deltaTime: delta });
    lastTicks = item.ticks;
    if (item.ticks > maxTicks) maxTicks = item.ticks;
  }
  events.push({
    deltaTime: toTicks(tailSilence),
    meta: true,
    type: "endOfTrack",
  });

  const midiData: MidiData = {
    header: { format: 0, numTracks: 1, ticksPerBeat },
    tracks: [events],
  };
  return new Uint8Array(writeMidi(midiData));
}

/**
 * Drum exclusive-class scenario: open hi-hat (46) starts, then closed
 * hi-hat (42) interrupts it. Both share GM exclusive group 1 on ch.9.
 * After the closed hat starts, residual energy of the open hat should be
 * near zero (cut by exclusive class), matching fluidsynth behaviour.
 *
 * Timeline (seconds):
 *   0.0  open HH  (46) on
 *   0.4  closed HH (42) on  → should cut open HH
 *   0.7  closed HH off
 *   (+ tail)
 */
export function buildHiHatExclusiveMidi(options?: {
  openVelocity?: number;
  closedVelocity?: number;
  openStart?: number;
  closedStart?: number;
  closedDuration?: number;
  tailSilence?: number;
}): Uint8Array {
  const openStart = options?.openStart ?? 0;
  const closedStart = options?.closedStart ?? 0.4;
  const closedDuration = options?.closedDuration ?? 0.3;
  // Open hat held long enough that, without exclusive cut, it would still
  // be sounding when we measure after closed onset.
  const openDuration = closedStart + closedDuration + 0.5;
  return buildScenarioMidi({
    notes: [
      {
        time: openStart,
        channel: 9,
        noteNumber: 46, // Open Hi-Hat
        velocity: options?.openVelocity ?? 100,
        duration: openDuration,
      },
      {
        time: closedStart,
        channel: 9,
        noteNumber: 42, // Closed Hi-Hat
        velocity: options?.closedVelocity ?? 100,
        duration: closedDuration,
      },
    ],
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * Two successive closed hi-hats: second should cut the first (same exclusive
 * group). Useful as a same-note exclusive / voice-steal check.
 */
export function buildClosedHatRetriggerMidi(options?: {
  firstStart?: number;
  secondStart?: number;
  eachDuration?: number;
  velocity?: number;
  tailSilence?: number;
}): Uint8Array {
  const firstStart = options?.firstStart ?? 0;
  const secondStart = options?.secondStart ?? 0.25;
  const eachDuration = options?.eachDuration ?? 0.5;
  const velocity = options?.velocity ?? 100;
  return buildScenarioMidi({
    notes: [
      {
        time: firstStart,
        channel: 9,
        noteNumber: 42,
        velocity,
        duration: eachDuration,
      },
      {
        time: secondStart,
        channel: 9,
        noteNumber: 42,
        velocity,
        duration: eachDuration,
      },
    ],
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * Melodic single note (non-drum) for baseline single-note compare.
 * Same defaults as buildSingleNoteMidi but expressed as a scenario.
 */
export function buildMelodicNoteMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  duration?: number;
  channel?: number;
  program?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const program = options?.program ?? 0;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel,
        noteNumber: options?.noteNumber ?? 60,
        velocity: options?.velocity ?? 100,
        duration: options?.duration ?? 1,
      },
    ],
    programs: { [channel]: program },
    tailSilence: options?.tailSilence ?? 3,
  });
}

/**
 * Pitch-bend scenario: sustained note, then bend up by the default GM range
 * (±2 semitones). `midi-file` uses signed bend: 0=center, +8191≈+2 semitones.
 *
 * Timeline:
 *   0.0  note on (C4), bend center
 *   0.4  pitch bend → max up
 *   1.2  note off
 */
export function buildPitchBendMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  bendAt?: number;
  noteDuration?: number;
  /** Signed bend after bendAt (-8192..8191). Default +8191 (max up). */
  bendValue?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const bendAt = options?.bendAt ?? 0.4;
  const noteDuration = options?.noteDuration ?? 1.2;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel,
        noteNumber: options?.noteNumber ?? 60,
        velocity: options?.velocity ?? 100,
        duration: noteDuration,
      },
    ],
    // Default wheel is already center; only emit the bend that should be heard.
    pitchBends: [
      { time: bendAt, channel, value: options?.bendValue ?? 8191 },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * CC7 volume scenario: note starts at full volume, then CC7 drops.
 *
 * Timeline:
 *   0.0  CC7=100, note on
 *   0.5  CC7=20
 *   1.2  note off
 */
export function buildVolumeCcMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  highVolume?: number;
  lowVolume?: number;
  dropAt?: number;
  noteDuration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const dropAt = options?.dropAt ?? 0.5;
  const noteDuration = options?.noteDuration ?? 1.2;
  const high = options?.highVolume ?? 100;
  const low = options?.lowVolume ?? 20;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel,
        noteNumber: options?.noteNumber ?? 60,
        velocity: options?.velocity ?? 100,
        duration: noteDuration,
      },
    ],
    controllers: [
      { time: 0, channel, controllerType: 7, value: high },
      { time: dropAt, channel, controllerType: 7, value: low },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * Sustain pedal scenario: note-off while sustain is held, then pedal release.
 * Without sustain the note would be silent after note-off; with sustain it
 * must keep sounding until pedal up.
 *
 * Timeline:
 *   0.0  sustain on (CC64=127), note on
 *   0.4  note off  (should still sound)
 *   1.0  sustain off (CC64=0) → release
 */
export function buildSustainPedalMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  noteOffAt?: number;
  pedalUpAt?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const noteOffAt = options?.noteOffAt ?? 0.4;
  const pedalUpAt = options?.pedalUpAt ?? 1.0;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel,
        noteNumber: options?.noteNumber ?? 60,
        velocity: options?.velocity ?? 100,
        duration: noteOffAt,
      },
    ],
    controllers: [
      { time: 0, channel, controllerType: 64, value: 127 },
      { time: pedalUpAt, channel, controllerType: 64, value: 0 },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * Two-note polyphony (C major third): simultaneous notes on one channel.
 * Catches voice allocation / mix gain issues.
 *
 * Timeline:
 *   0.0  note 60 + note 64 on
 *   1.0  both off
 */
export function buildPolyphonyMidi(options?: {
  noteA?: number;
  noteB?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  duration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const duration = options?.duration ?? 1;
  const velocity = options?.velocity ?? 100;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel,
        noteNumber: options?.noteA ?? 60,
        velocity,
        duration,
      },
      {
        time: 0,
        channel,
        noteNumber: options?.noteB ?? 64,
        velocity,
        duration,
      },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}
