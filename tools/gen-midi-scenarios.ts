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
 * Rapid same-note drum hits on channel 9 (GM drum kit).
 * Default: 4 hits at 80ms spacing — dense enough to stress exclusive-class
 * cut / voice steal on long-decay cymbals (crash, open HH, ride).
 *
 * GM note numbers (defaults):
 *   49 Crash Cymbal 1
 *   51 Ride Cymbal 1
 *   46 Open Hi-Hat
 *   42 Closed Hi-Hat
 */
export function buildDrumRapidHitsMidi(options?: {
  /** GM drum note number. Default 49 (Crash Cymbal 1). */
  noteNumber?: number;
  /** Number of hits. Default 4. */
  hitCount?: number;
  /** Interval between hit onsets in seconds. Default 0.08. */
  interval?: number;
  /** Each note-on duration in seconds. Default 0.4 (long enough to overlap). */
  eachDuration?: number;
  velocity?: number;
  tailSilence?: number;
}): Uint8Array {
  const noteNumber = options?.noteNumber ?? 49;
  const hitCount = options?.hitCount ?? 4;
  const interval = options?.interval ?? 0.08;
  const eachDuration = options?.eachDuration ?? 0.4;
  const velocity = options?.velocity ?? 100;
  const notes: TimedNote[] = [];
  for (let i = 0; i < hitCount; i++) {
    notes.push({
      time: i * interval,
      channel: 9,
      noteNumber,
      velocity,
      duration: eachDuration,
    });
  }
  return buildScenarioMidi({
    notes,
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * Alternating crash (49) + ride (51) hits — two long-decay cymbals that may
 * or may not share exclusive class depending on the soundfont.
 */
export function buildCymbalAlternateMidi(options?: {
  noteA?: number;
  noteB?: number;
  hitCount?: number;
  interval?: number;
  eachDuration?: number;
  velocity?: number;
  tailSilence?: number;
}): Uint8Array {
  const noteA = options?.noteA ?? 49;
  const noteB = options?.noteB ?? 51;
  const hitCount = options?.hitCount ?? 4;
  const interval = options?.interval ?? 0.1;
  const eachDuration = options?.eachDuration ?? 0.5;
  const velocity = options?.velocity ?? 100;
  const notes: TimedNote[] = [];
  for (let i = 0; i < hitCount; i++) {
    notes.push({
      time: i * interval,
      channel: 9,
      noteNumber: i % 2 === 0 ? noteA : noteB,
      velocity,
      duration: eachDuration,
    });
  }
  return buildScenarioMidi({
    notes,
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

/**
 * CC1 modulation wheel: sustained note with modulation depth rising mid-note.
 * Exercises SF2 default mod-wheel → vibLFO/modLFO modulators vs fluidsynth.
 *
 * Timeline:
 *   0.0  note on, CC1=0
 *   0.5  CC1 → 127 (full depth)
 *   1.4  note off
 */
export function buildModulationCcMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  modOnTime?: number;
  noteOffTime?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const noteNumber = options?.noteNumber ?? 60;
  const velocity = options?.velocity ?? 100;
  const modOnTime = options?.modOnTime ?? 0.5;
  const noteOffTime = options?.noteOffTime ?? 1.4;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel,
        noteNumber,
        velocity,
        duration: noteOffTime,
      },
    ],
    controllers: [
      { time: 0, channel, controllerType: 1, value: 0 },
      { time: modOnTime, channel, controllerType: 1, value: 127 },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

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
 * CC11 expression scenario: note starts at high expression, then CC11 drops.
 * Volume (CC7) stays fixed so only expression drives the level change.
 *
 * Timeline:
 *   0.0  CC7=100, CC11=100, note on
 *   0.5  CC11=20
 *   1.2  note off
 */
export function buildExpressionCcMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  volume?: number;
  highExpression?: number;
  lowExpression?: number;
  dropAt?: number;
  noteDuration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const dropAt = options?.dropAt ?? 0.5;
  const noteDuration = options?.noteDuration ?? 1.2;
  const volume = options?.volume ?? 100;
  const high = options?.highExpression ?? 100;
  const low = options?.lowExpression ?? 20;
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
      { time: 0, channel, controllerType: 7, value: volume },
      { time: 0, channel, controllerType: 11, value: high },
      { time: dropAt, channel, controllerType: 11, value: low },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * CC10 pan scenario: note starts hard-left, then pans hard-right.
 *
 * Timeline:
 *   0.0  CC10=0 (left), note on
 *   0.5  CC10=127 (right)
 *   1.2  note off
 */
export function buildPanCcMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  leftPan?: number;
  rightPan?: number;
  panAt?: number;
  noteDuration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const panAt = options?.panAt ?? 0.5;
  const noteDuration = options?.noteDuration ?? 1.2;
  const left = options?.leftPan ?? 0;
  const right = options?.rightPan ?? 127;
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
      { time: 0, channel, controllerType: 10, value: left },
      { time: panAt, channel, controllerType: 10, value: right },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * RPN pitch-bend range scenario: set sensitivity to N semitones, then bend max.
 *
 * Timeline:
 *   0.0  RPN (CC101=0, CC100=0), Data Entry MSB=rangeSemitones, null RPN
 *   0.0  note on
 *   bendAt  pitch bend max (+8191)
 *   noteDuration  note off
 *
 * Default rangeSemitones=12 → max bend ≈ +1 octave.
 */
export function buildPitchBendRangeMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  /** Pitch-bend sensitivity in semitones (Data Entry MSB). Default 12. */
  rangeSemitones?: number;
  bendAt?: number;
  noteDuration?: number;
  bendValue?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const bendAt = options?.bendAt ?? 0.4;
  const noteDuration = options?.noteDuration ?? 1.2;
  const rangeSemitones = options?.rangeSemitones ?? 12;
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
      // Select RPN 0,0 (pitch bend sensitivity)
      { time: 0, channel, controllerType: 101, value: 0 },
      { time: 0, channel, controllerType: 100, value: 0 },
      // Data Entry MSB = semitones
      { time: 0, channel, controllerType: 6, value: rangeSemitones },
      { time: 0, channel, controllerType: 38, value: 0 },
      // Null RPN
      { time: 0, channel, controllerType: 101, value: 127 },
      { time: 0, channel, controllerType: 100, value: 127 },
    ],
    pitchBends: [
      { time: bendAt, channel, value: options?.bendValue ?? 8191 },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * All Sound Off (CC120) or All Notes Off (CC123) during a sustained note.
 *
 * Timeline:
 *   0.0  note on (long)
 *   cutAt  CC120 or CC123
 *   (note-off never sent — the CC should end the voice)
 */
export function buildAllOffMidi(options?: {
  noteNumber?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  /** 120 = All Sound Off, 123 = All Notes Off. */
  controllerType?: 120 | 123;
  cutAt?: number;
  noteDuration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const cutAt = options?.cutAt ?? 0.4;
  const noteDuration = options?.noteDuration ?? 2.0;
  const controllerType = options?.controllerType ?? 120;
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
      { time: cutAt, channel, controllerType, value: 0 },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 1,
  });
}

/**
 * Velocity dynamics: soft note then loud note (same pitch, fixed CC7/CC11).
 *
 * Timeline:
 *   0.0  note on vel=soft, duration softDur
 *   gap   silence
 *   loudAt  note on vel=loud, duration loudDur
 */
export function buildVelocityDynamicsMidi(options?: {
  noteNumber?: number;
  channel?: number;
  program?: number;
  softVelocity?: number;
  loudVelocity?: number;
  softDuration?: number;
  loudDuration?: number;
  loudAt?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const softDuration = options?.softDuration ?? 0.6;
  const loudDuration = options?.loudDuration ?? 0.6;
  const loudAt = options?.loudAt ?? 0.9;
  const noteNumber = options?.noteNumber ?? 60;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel,
        noteNumber,
        velocity: options?.softVelocity ?? 40,
        duration: softDuration,
      },
      {
        time: loudAt,
        channel,
        noteNumber,
        velocity: options?.loudVelocity ?? 100,
        duration: loudDuration,
      },
    ],
    controllers: [
      { time: 0, channel, controllerType: 7, value: 100 },
      { time: 0, channel, controllerType: 11, value: 100 },
    ],
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 1.5,
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
 * Catches voice allocation / mix gain issues and ADS pitch double-apply.
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

/**
 * Three-note chord (C major triad): more concurrent voices on one channel.
 *
 * Timeline:
 *   0.0  notes 60 + 64 + 67 on
 *   1.0  all off
 */
export function buildChordPolyphonyMidi(options?: {
  notes?: number[];
  velocity?: number;
  channel?: number;
  program?: number;
  duration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const duration = options?.duration ?? 1;
  const velocity = options?.velocity ?? 100;
  const noteNumbers = options?.notes ?? [60, 64, 67];
  return buildScenarioMidi({
    notes: noteNumbers.map((noteNumber) => ({
      time: 0,
      channel,
      noteNumber,
      velocity,
      duration,
    })),
    programs: { [channel]: options?.program ?? 0 },
    tailSilence: options?.tailSilence ?? 2,
  });
}

/**
 * Wide-interval dyad (C3 + C5). Different sample zones / root keys stress
 * the ADS/ADSR playbackRate bake path (double-apply regression).
 *
 * Timeline:
 *   0.0  note 48 + note 72 on
 *   1.0  both off
 */
export function buildWideIntervalPolyphonyMidi(options?: {
  noteLow?: number;
  noteHigh?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  duration?: number;
  tailSilence?: number;
}): Uint8Array {
  return buildPolyphonyMidi({
    noteA: options?.noteLow ?? 48,
    noteB: options?.noteHigh ?? 72,
    velocity: options?.velocity,
    channel: options?.channel,
    program: options?.program,
    duration: options?.duration,
    tailSilence: options?.tailSilence,
  });
}

/**
 * Staggered overlap: second note starts while the first is still held.
 * Exercises concurrent sustain mixing without a shared onset.
 *
 * Timeline (defaults):
 *   0.0  note A on
 *   0.35 note B on
 *   1.0  note A off
 *   1.35 note B off
 */
export function buildStaggeredPolyphonyMidi(options?: {
  noteA?: number;
  noteB?: number;
  velocity?: number;
  channel?: number;
  program?: number;
  /** When note A starts. Default 0. */
  startA?: number;
  /** When note B starts. Default 0.35. */
  startB?: number;
  /** Duration of each note. Default 1. */
  duration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channel = options?.channel ?? 0;
  const duration = options?.duration ?? 1;
  const velocity = options?.velocity ?? 100;
  const startA = options?.startA ?? 0;
  const startB = options?.startB ?? 0.35;
  return buildScenarioMidi({
    notes: [
      {
        time: startA,
        channel,
        noteNumber: options?.noteA ?? 60,
        velocity,
        duration,
      },
      {
        time: startB,
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

/**
 * Cross-channel polyphony: same pitches on two channels (independent buses).
 * Catches channel-gain / pan mix mistakes that same-channel tests miss.
 *
 * Timeline:
 *   0.0  ch0 note 60 + ch1 note 64 on
 *   1.0  both off
 */
export function buildCrossChannelPolyphonyMidi(options?: {
  noteA?: number;
  noteB?: number;
  velocity?: number;
  channelA?: number;
  channelB?: number;
  programA?: number;
  programB?: number;
  duration?: number;
  tailSilence?: number;
}): Uint8Array {
  const channelA = options?.channelA ?? 0;
  const channelB = options?.channelB ?? 1;
  const duration = options?.duration ?? 1;
  const velocity = options?.velocity ?? 100;
  return buildScenarioMidi({
    notes: [
      {
        time: 0,
        channel: channelA,
        noteNumber: options?.noteA ?? 60,
        velocity,
        duration,
      },
      {
        time: 0,
        channel: channelB,
        noteNumber: options?.noteB ?? 64,
        velocity,
        duration,
      },
    ],
    programs: {
      [channelA]: options?.programA ?? 0,
      [channelB]: options?.programB ?? 0,
    },
    tailSilence: options?.tailSilence ?? 2,
  });
}
