// Generate a minimal single-note Standard MIDI File for spec-conformance
// checks (fluidsynth vs. midy, per cacheMode). Uses the same `midi-file`
// library midy itself uses to parse MIDI, so the byte-level shape we
// produce here is guaranteed to be something midy already knows how to read.
//
// Usage as a library:
//   import { buildSingleNoteMidi } from "./gen-single-note-midi.ts";
//   const bytes = buildSingleNoteMidi({ noteNumber: 60, velocity: 100 });
//
// Usage as a CLI:
//   deno run -A tools/gen-single-note-midi.ts --note 60 --velocity 100 \
//     --duration 1 --channel 0 --program 0 --out /tmp/single-note.mid
import { type MidiData, writeMidi } from "midi-file";

export interface SingleNoteMidiOptions {
  /** MIDI note number, 0-127. Default: 60 (C4 / "Middle C"). */
  noteNumber?: number;
  /** Note-on velocity, 1-127. Default: 100. */
  velocity?: number;
  /** Note-off velocity, 0-127. Default: 0. */
  releaseVelocity?: number;
  /** Note length in seconds. Default: 1. */
  duration?: number;
  /** Trailing silence after note-off, in seconds, so release tails are
   * captured by both renderers. Default: 3. */
  tailSilence?: number;
  /** MIDI channel, 0-15. Default: 0. Use 9 for the GM percussion channel. */
  channel?: number;
  /** Program (patch) number, 0-127. Omit to skip the Program Change
   * event entirely and rely on the default (Acoustic Grand Piano / GM
   * channel-9 kit). Default: 0. */
  program?: number;
  /** Bank select (MSB, CC0). Omit to skip bank-select entirely. */
  bankMSB?: number;
  /** Bank select (LSB, CC32). Omit to skip bank-select entirely. */
  bankLSB?: number;
  /** Ticks per quarter note. Default: 480 (common, harmless resolution). */
  ticksPerBeat?: number;
  /** Tempo in microseconds per quarter note. Default: 500000 (120 BPM). */
  microsecondsPerBeat?: number;
}

const DEFAULTS: Required<SingleNoteMidiOptions> = {
  noteNumber: 60,
  velocity: 100,
  releaseVelocity: 0,
  duration: 1,
  tailSilence: 3,
  channel: 0,
  program: 0,
  bankMSB: -1, // -1 => "omit"; see buildSingleNoteMidi()
  bankLSB: -1,
  ticksPerBeat: 480,
  microsecondsPerBeat: 500000,
};

// deno-lint-ignore no-explicit-any
type MidiTrackEvent = any;

/**
 * Build a single-note Standard MIDI File (format 0, one track) as raw bytes.
 *
 * Track layout: [optional Bank Select MSB/LSB] -> [optional Program Change]
 * -> Note On -> (duration) -> Note Off -> (tailSilence) -> End of Track.
 */
export function buildSingleNoteMidi(
  options: SingleNoteMidiOptions = {},
): Uint8Array {
  // Strip explicit `undefined` values (e.g. from a CLI wrapper that always
  // passes every field) so they don't shadow DEFAULTS below — a bare
  // `{ ...DEFAULTS, ...options }` merge does NOT skip keys whose value is
  // `undefined`, it overwrites the default with `undefined`.
  const cleanOptions = Object.fromEntries(
    Object.entries(options).filter(([, v]) => v !== undefined),
  ) as SingleNoteMidiOptions;
  const opts = { ...DEFAULTS, ...cleanOptions };
  const ticksPerBeat = opts.ticksPerBeat;
  const secondsToTicks = (seconds: number): number => {
    const beats = (seconds * 1_000_000) / opts.microsecondsPerBeat;
    return Math.round(beats * ticksPerBeat);
  };

  const events: MidiTrackEvent[] = [];
  events.push({
    deltaTime: 0,
    meta: true,
    type: "setTempo",
    microsecondsPerBeat: opts.microsecondsPerBeat,
  });

  let pendingDelta = 0;
  if (opts.bankMSB >= 0) {
    events.push({
      deltaTime: pendingDelta,
      type: "controller",
      channel: opts.channel,
      controllerType: 0,
      value: opts.bankMSB,
    });
    pendingDelta = 0;
  }
  if (opts.bankLSB >= 0) {
    events.push({
      deltaTime: pendingDelta,
      type: "controller",
      channel: opts.channel,
      controllerType: 32,
      value: opts.bankLSB,
    });
    pendingDelta = 0;
  }
  if (opts.program >= 0) {
    events.push({
      deltaTime: pendingDelta,
      type: "programChange",
      channel: opts.channel,
      programNumber: opts.program,
    });
    pendingDelta = 0;
  }

  events.push({
    deltaTime: pendingDelta,
    type: "noteOn",
    channel: opts.channel,
    noteNumber: opts.noteNumber,
    velocity: opts.velocity,
  });
  events.push({
    deltaTime: secondsToTicks(opts.duration),
    type: "noteOff",
    channel: opts.channel,
    noteNumber: opts.noteNumber,
    velocity: opts.releaseVelocity,
  });
  events.push({
    deltaTime: secondsToTicks(opts.tailSilence),
    meta: true,
    type: "endOfTrack",
  });

  const midiData: MidiData = {
    header: { format: 0, numTracks: 1, ticksPerBeat },
    tracks: [events],
  };

  return new Uint8Array(writeMidi(midiData));
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const bytes = buildSingleNoteMidi({
    noteNumber: args.note ? Number(args.note) : undefined,
    velocity: args.velocity ? Number(args.velocity) : undefined,
    releaseVelocity: args["release-velocity"]
      ? Number(args["release-velocity"])
      : undefined,
    duration: args.duration ? Number(args.duration) : undefined,
    tailSilence: args["tail-silence"]
      ? Number(args["tail-silence"])
      : undefined,
    channel: args.channel ? Number(args.channel) : undefined,
    program: args.program !== undefined ? Number(args.program) : undefined,
    bankMSB: args["bank-msb"] !== undefined
      ? Number(args["bank-msb"])
      : undefined,
    bankLSB: args["bank-lsb"] !== undefined
      ? Number(args["bank-lsb"])
      : undefined,
    ticksPerBeat: args["ticks-per-beat"]
      ? Number(args["ticks-per-beat"])
      : undefined,
  });
  const outPath = args.out ?? "single-note.mid";
  await Deno.writeFile(outPath, bytes);
  console.log(`wrote ${outPath} (${bytes.length} bytes)`);
}
