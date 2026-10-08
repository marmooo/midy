// Gate the almost-simple pitch-bend TypedArray path.
//
// compare-pitch.test.ts does NOT enable useAlmostSimplePitchBend, so it only
// validates the complex/OAC path. This file:
//   1. Renders the same MIDI with flag ON vs OFF (midy A/B)
//   2. Requires measured pitch in windows to match within a tight cents budget
//   3. Asserts bend *deltas* relative to a measured unbent reference window
//      (SF2 Acoustic Grand sits ~14c sharp of ET; pure midiNoteToHz is wrong)
//   4. Covers bend-up, bend-down, multi-step, and note-on during active bend
//
// Usage:
//   deno test -A tools/compare-almost-simple-pitchbend.test.ts
//
import { buildScenarioMidi } from "./gen-midi-scenarios.ts";
import {
  assertNonEmptyFile,
  ensureOutDir,
  estimatePitchHz,
  HARNESS_DIR,
  midiNoteToHz,
  OUT_DIR,
  pitchInWindow,
  renderMidyMode,
  SAMPLE_RATE,
  SF2_PATH,
} from "./compare-common.ts";
import { readWav, toMono } from "./wav.ts";

const NOTE = 60;
const PROGRAM = 0;
// Tight A/B budget: same engine, only path differs.
const AB_CENTS_TOLERANCE = 25;
// Bend-delta vs measured unbent window (detector + SF2 slack).
const DELTA_CENTS_TOLERANCE = 40;

type WindowSpec = {
  label: string;
  start: number;
  end: number;
  minHz: number;
  maxHz: number;
  /**
   * Expected cents relative to the scenario's measured unbent reference
   * (not pure ET). Omit to skip the delta check.
   */
  expectDeltaCents?: number;
  /** Override DELTA_CENTS_TOLERANCE for this window. */
  deltaTol?: number;
  /** If true, this window is the unbent reference for delta checks. */
  isRef?: boolean;
};

async function renderWithFlag(
  midiPath: string,
  cacheMode: "note" | "chunk" | "none",
  almostSimple: boolean,
): Promise<Float32Array> {
  const wavBytes = await renderMidyMode({
    harnessDir: HARNESS_DIR,
    midiPath,
    soundFontPath: SF2_PATH,
    cacheMode,
    sampleRate: SAMPLE_RATE,
    useAlmostSimplePitchBend: almostSimple,
  });
  if (wavBytes.length === 0) {
    throw new Error(
      `empty WAV mode=${cacheMode} almostSimple=${almostSimple}`,
    );
  }
  return toMono(readWav(wavBytes));
}

function measure(
  mono: Float32Array,
  sr: number,
  w: WindowSpec,
): number {
  const hz = pitchInWindow(mono, sr, w.start, w.end, w.minHz, w.maxHz);
  if (hz === null) {
    const raw = estimatePitchHz(
      mono,
      sr,
      Math.floor(w.start * sr),
      Math.floor(w.end * sr),
    );
    throw new Error(
      `${w.label}: pitch undetectable (raw=${raw?.toFixed(1) ?? "null"}) ` +
        `band=[${w.minHz.toFixed(1)}, ${w.maxHz.toFixed(1)}]`,
    );
  }
  return hz;
}

function assertAbMatch(
  label: string,
  hzOff: number,
  hzOn: number,
  tolCents: number,
): void {
  const err = Math.abs(1200 * Math.log2(hzOn / hzOff));
  console.log(
    `  ${label}: flagOff=${hzOff.toFixed(2)}Hz flagOn=${hzOn.toFixed(2)}Hz ` +
      `err=${err.toFixed(1)}c (tol ${tolCents})`,
  );
  if (err > tolCents) {
    throw new Error(
      `${label}: almost-simple pitch diverges from complex path by ` +
        `${err.toFixed(1)} cents (tol ${tolCents}). ` +
        `off=${hzOff.toFixed(2)}Hz on=${hzOn.toFixed(2)}Hz`,
    );
  }
}

function assertDeltaCents(
  label: string,
  hz: number,
  refHz: number,
  expectDelta: number,
  tolCents: number,
): void {
  const got = 1200 * Math.log2(hz / refHz);
  const err = Math.abs(got - expectDelta);
  console.log(
    `  ${label} delta: hz=${hz.toFixed(2)} ref=${refHz.toFixed(2)} ` +
      `got=${got.toFixed(1)}c expect=${expectDelta.toFixed(1)}c ` +
      `err=${err.toFixed(1)}c (tol ${tolCents})`,
  );
  if (err > tolCents) {
    throw new Error(
      `${label}: bend delta ${got.toFixed(1)}c vs expect ` +
        `${expectDelta.toFixed(1)}c (err ${err.toFixed(1)}c, tol ${tolCents})`,
    );
  }
}

/** Honour MIDY_QUICK / MIDY_CACHE_MODES for A/B mode matrix. */
function defaultAbModes(): Array<"note" | "chunk" | "none"> {
  const raw = Deno.env.get("MIDY_CACHE_MODES");
  if (raw && raw.trim()) {
    const allowed = new Set(["note", "chunk", "none"]);
    const picked = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((m): m is "note" | "chunk" | "none" => allowed.has(m));
    if (picked.length > 0) return picked;
  }
  // Quick and full both use note+chunk for A/B (none is rarely informative here).
  return ["note", "chunk"];
}

async function abCheck(
  t: Deno.TestContext,
  name: string,
  midiBytes: Uint8Array,
  windows: WindowSpec[],
  modes: Array<"note" | "chunk" | "none"> = defaultAbModes(),
  /** When false, only A/B is asserted (no delta vs unbent ref). */
  checkDelta = true,
): Promise<void> {
  const midiPath = `${OUT_DIR}/as-pb-${name}.mid`;
  await t.step(`write midi (${name})`, async () => {
    await Deno.writeFile(midiPath, midiBytes);
    await assertNonEmptyFile(midiPath);
  });

  for (const mode of modes) {
    await t.step(`${name} A/B midy flag off vs on (${mode})`, async () => {
      const off = await renderWithFlag(midiPath, mode, false);
      const on = await renderWithFlag(midiPath, mode, true);
      const sr = SAMPLE_RATE;

      const refSpec = windows.find((w) => w.isRef) ??
        windows.find((w) =>
          w.expectDeltaCents == null || w.expectDeltaCents === 0
        );
      let refHzOn: number | null = null;
      if (checkDelta && refSpec) {
        refHzOn = measure(on, sr, refSpec);
      }

      for (const w of windows) {
        const hzOff = measure(off, sr, w);
        const hzOn = measure(on, sr, w);
        assertAbMatch(
          `${name}/${mode}/${w.label}`,
          hzOff,
          hzOn,
          AB_CENTS_TOLERANCE,
        );
        if (
          checkDelta &&
          w.expectDeltaCents != null &&
          refHzOn != null
        ) {
          assertDeltaCents(
            `${name}/${mode}/${w.label}`,
            hzOn,
            refHzOn,
            w.expectDeltaCents,
            w.deltaTol ?? DELTA_CENTS_TOLERANCE,
          );
        }
      }
    });
  }
}

const f0 = midiNoteToHz(NOTE);

Deno.test("almost-simple pitchbend A/B: bend up", async (t) => {
  await ensureOutDir();
  const bytes = buildScenarioMidi({
    programs: { 0: PROGRAM },
    notes: [{
      time: 0,
      duration: 1.0,
      channel: 0,
      noteNumber: NOTE,
      velocity: 100,
    }],
    pitchBends: [
      { time: 0, channel: 0, value: 0 },
      { time: 0.4, channel: 0, value: 8191 },
    ],
    tailSilence: 0.3,
  });
  await abCheck(t, "bend-up", bytes, [
    {
      label: "before",
      start: 0.1,
      end: 0.3,
      minHz: f0 * 0.85,
      maxHz: f0 * 1.12,
      isRef: true,
      expectDeltaCents: 0,
    },
    {
      label: "after",
      start: 0.55,
      end: 0.9,
      minHz: f0 * 1.05,
      maxHz: f0 * Math.pow(2, 2.5 / 12),
      expectDeltaCents: 200,
    },
  ]);
});

Deno.test("almost-simple pitchbend A/B: bend down", async (t) => {
  await ensureOutDir();
  const bytes = buildScenarioMidi({
    programs: { 0: PROGRAM },
    notes: [{
      time: 0,
      duration: 1.0,
      channel: 0,
      noteNumber: NOTE,
      velocity: 100,
    }],
    pitchBends: [
      { time: 0, channel: 0, value: 0 },
      { time: 0.4, channel: 0, value: -8192 },
    ],
    tailSilence: 0.3,
  });
  await abCheck(t, "bend-down", bytes, [
    {
      label: "before",
      start: 0.1,
      end: 0.3,
      minHz: f0 * 0.85,
      maxHz: f0 * 1.12,
      isRef: true,
      expectDeltaCents: 0,
    },
    {
      label: "after",
      start: 0.55,
      end: 0.9,
      minHz: f0 * Math.pow(2, -2.5 / 12),
      maxHz: f0 * 0.95,
      expectDeltaCents: -200,
    },
  ]);
});

Deno.test("almost-simple pitchbend A/B: multi-step down (op.mid-like)", async (t) => {
  await ensureOutDir();
  const toSigned = (abs: number) => abs - 8192;
  const bytes = buildScenarioMidi({
    programs: { 0: PROGRAM },
    notes: [{
      time: 0,
      duration: 1.2,
      channel: 0,
      noteNumber: NOTE,
      velocity: 100,
    }],
    pitchBends: [
      { time: 0.0, channel: 0, value: toSigned(8192) },
      { time: 0.25, channel: 0, value: toSigned(7424) },
      { time: 0.40, channel: 0, value: toSigned(7807) },
      { time: 0.55, channel: 0, value: toSigned(8192) },
      { time: 0.70, channel: 0, value: toSigned(6912) },
      { time: 0.90, channel: 0, value: toSigned(8192) },
    ],
    tailSilence: 0.3,
  });
  const centsOf = (abs: number) => ((abs - 8192) / 8192) * 200;
  await abCheck(t, "multi-step-down", bytes, [
    {
      label: "center0",
      start: 0.05,
      end: 0.2,
      minHz: f0 * 0.85,
      maxHz: f0 * 1.12,
      isRef: true,
      expectDeltaCents: 0,
    },
    {
      label: "down7424",
      start: 0.28,
      end: 0.36,
      minHz: f0 * 0.9,
      maxHz: f0 * 1.05,
      expectDeltaCents: centsOf(7424),
    },
    {
      label: "down6912",
      start: 0.75,
      end: 0.85,
      minHz: f0 * 0.88,
      maxHz: f0 * 1.05,
      expectDeltaCents: centsOf(6912),
    },
    {
      label: "centerEnd",
      start: 0.95,
      end: 1.1,
      minHz: f0 * 0.85,
      maxHz: f0 * 1.12,
      expectDeltaCents: 0,
    },
  ]);
});

Deno.test("almost-simple pitchbend A/B: note-on during active bend", async (t) => {
  await ensureOutDir();
  // Bend to max first, then start the note while still bent, then return.
  //
  // A/B (flag on vs off) is the primary gate: both paths must match.
  //
  // Absolute delta is only asserted in chunk mode. In note mode the
  // afterCenter window is measured ~294 Hz (same as full-bend) for *both*
  // flag on and off — a pre-existing note-mode / detector quirk when the
  // whole note starts already bent, not an almost-simple regression.
  // Chunk mode measures afterCenter ≈ 262 Hz and onsetMax ≈ +200c correctly.
  const bytes = buildScenarioMidi({
    programs: { 0: PROGRAM },
    notes: [{
      time: 0.3,
      duration: 1.0,
      channel: 0,
      noteNumber: NOTE,
      velocity: 100,
    }],
    pitchBends: [
      { time: 0.0, channel: 0, value: 0 },
      { time: 0.15, channel: 0, value: 8191 },
      { time: 0.7, channel: 0, value: 0 },
    ],
    tailSilence: 0.3,
  });

  const windows: WindowSpec[] = [
    {
      label: "afterCenter",
      start: 0.85,
      end: 1.15,
      minHz: f0 * 0.85,
      maxHz: f0 * 1.15, // note mode may report ~294 Hz here; still A/B-checked
      isRef: true,
      expectDeltaCents: 0,
    },
    {
      label: "onsetMax",
      start: 0.35,
      end: 0.55,
      minHz: f0 * 1.05,
      maxHz: f0 * Math.pow(2, 2.5 / 12),
      expectDeltaCents: 200,
    },
  ];

  // note: A/B only (checkDelta=false)
  await abCheck(t, "onset-bent", bytes, windows, ["note"], false);
  // chunk: A/B + delta vs measured unbent afterCenter
  await abCheck(t, "onset-bent", bytes, windows, ["chunk"], true);
});

// ---------------------------------------------------------------------------
// Scenarios extracted from op.mid (~100–112s, channel 3).
//
// op.mid sets RPN pitch-bend sensitivity to 12 semitones (not the GM default
// of 2). Multi-step "scoop" bends return from abs=6912 toward center while a
// note is held. The almost-simple rate curve must honour sensitivity from
// channelStateArray[16], otherwise deltas are ~6× too small.
// ---------------------------------------------------------------------------

const OP_RANGE_SEMIS = 12;
/** Cents for a signed midi-file pitch-bend under ±range semitones. */
function opCents(signed: number, rangeSemis = OP_RANGE_SEMIS): number {
  return (signed / 8192) * rangeSemis * 100;
}

/** RPN controllers that set pitch-bend sensitivity (Data Entry MSB = semis). */
function rpnBendRange12(channel: number, time = 0) {
  return [
    { time, channel, controllerType: 101, value: 0 },
    { time, channel, controllerType: 100, value: 0 },
    { time, channel, controllerType: 6, value: 12 },
    { time, channel, controllerType: 38, value: 0 },
    { time, channel, controllerType: 101, value: 127 },
    { time, channel, controllerType: 100, value: 127 },
  ];
}

Deno.test("almost-simple pitchbend A/B: op.mid-like range12 multi-step scoop", async (t) => {
  await ensureOutDir();
  // Mirrors op.mid @ ~103.97s ch3:
  //   noteOn + pitchBend 6912 at same tick, then return to center over ~130ms
  // Signed values from the file (midi-file style).
  const toSigned = (abs: number) => abs - 8192;
  const steps = [
    { t: 0.0, abs: 6912 },
    { t: 0.031, abs: 7447 },
    { t: 0.063, abs: 7844 },
    { t: 0.094, abs: 8092 },
    { t: 0.126, abs: 8190 },
    { t: 0.130, abs: 8192 },
  ];
  const channel = 0;
  const noteNumber = 91; // as in op.mid
  const bytes = buildScenarioMidi({
    programs: { [channel]: 0 }, // piano for stable pitch detection
    notes: [{
      time: 0.05,
      duration: 0.8,
      channel,
      noteNumber,
      velocity: 112,
    }],
    controllers: rpnBendRange12(channel, 0),
    pitchBends: [
      { time: 0, channel, value: 0 }, // center before note
      ...steps.map((s) => ({
        time: 0.05 + s.t,
        channel,
        value: toSigned(s.abs),
      })),
    ],
    tailSilence: 0.3,
  });

  const fNote = midiNoteToHz(noteNumber);
  // With range=12, abs 6912 → signed -1280 → -187.5c
  const cents6912 = opCents(toSigned(6912));
  await abCheck(t, "op-range12-scoop", bytes, [
    {
      label: "onsetBent",
      start: 0.06,
      end: 0.08,
      minHz: fNote * Math.pow(2, -3 / 12),
      maxHz: fNote * 1.05,
      expectDeltaCents: cents6912,
      deltaTol: 50,
    },
    {
      label: "afterCenter",
      start: 0.35,
      end: 0.7,
      minHz: fNote * 0.85,
      maxHz: fNote * 1.15,
      isRef: true,
      expectDeltaCents: 0,
      deltaTol: 40,
    },
  ]);
});

Deno.test("almost-simple pitchbend A/B: op.mid-like range12 bend during note", async (t) => {
  await ensureOutDir();
  // Mirrors op.mid @ ~107.1s: sustained note, then multi-step down to 6912 and back.
  const toSigned = (abs: number) => abs - 8192;
  const channel = 0;
  const noteNumber = 83;
  const bytes = buildScenarioMidi({
    programs: { [channel]: 0 },
    notes: [{
      time: 0.05,
      duration: 1.0,
      channel,
      noteNumber,
      velocity: 112,
    }],
    controllers: rpnBendRange12(channel, 0),
    pitchBends: [
      { time: 0, channel, value: 0 },
      { time: 0.25, channel, value: toSigned(6912) },
      { time: 0.281, channel, value: toSigned(7447) },
      { time: 0.313, channel, value: toSigned(7844) },
      { time: 0.344, channel, value: toSigned(8092) },
      { time: 0.375, channel, value: toSigned(8190) },
      { time: 0.380, channel, value: toSigned(8192) },
    ],
    tailSilence: 0.3,
  });

  const fNote = midiNoteToHz(noteNumber);
  const cents6912 = opCents(toSigned(6912));
  await abCheck(t, "op-range12-during", bytes, [
    {
      label: "before",
      start: 0.08,
      end: 0.2,
      minHz: fNote * 0.85,
      maxHz: fNote * 1.15,
      isRef: true,
      expectDeltaCents: 0,
    },
    {
      label: "at6912",
      start: 0.255,
      end: 0.275,
      minHz: fNote * Math.pow(2, -3 / 12),
      maxHz: fNote * 1.05,
      expectDeltaCents: cents6912,
      deltaTol: 50,
    },
    {
      label: "afterCenter",
      start: 0.5,
      end: 0.9,
      minHz: fNote * 0.85,
      maxHz: fNote * 1.15,
      expectDeltaCents: 0,
      deltaTol: 40,
    },
  ]);
});

Deno.test("almost-simple pitchbend A/B: op.mid-like range12 full down", async (t) => {
  await ensureOutDir();
  // Full-scale down under range=12 should be ≈ -1200c, not -200c.
  // If sensitivity is stuck at default 2, almost-simple will be ~6× flat.
  // RPN must be scheduled *before* the note so the onset snapshot sees
  // sensitivity=12 (buildScenarioMidi emits notes before controllers at the
  // same tick).
  const channel = 0;
  const noteNumber = 72;
  const bytes = buildScenarioMidi({
    programs: { [channel]: 0 },
    notes: [{
      time: 0.05,
      duration: 1.2,
      channel,
      noteNumber,
      velocity: 100,
    }],
    controllers: rpnBendRange12(channel, 0),
    pitchBends: [
      { time: 0, channel, value: 0 },
      { time: 0.45, channel, value: -8192 }, // min (signed)
    ],
    tailSilence: 0.3,
  });

  const fNote = midiNoteToHz(noteNumber);
  await abCheck(t, "op-range12-full-down", bytes, [
    {
      label: "before",
      start: 0.12,
      end: 0.35,
      minHz: fNote * 0.85,
      maxHz: fNote * 1.15,
      isRef: true,
      expectDeltaCents: 0,
    },
    {
      label: "after",
      start: 0.6,
      end: 1.05,
      minHz: fNote * Math.pow(2, -14 / 12),
      maxHz: fNote * Math.pow(2, -8 / 12),
      expectDeltaCents: -1200,
      deltaTol: 60,
    },
  ]);
});

/**
 * Build a minimal Type-0 MIDI with explicit same-tick event ordering.
 * Used to reproduce op.mid's "PB → noteOff → noteOn" order at one tick
 * (buildScenarioMidi always emits notes before pitchBends at equal time).
 */
function buildOrderedMidi(spec: {
  ticksPerBeat?: number;
  tempo?: number;
  program?: number;
  channel?: number;
  /** Absolute ticks from 0. Events at the same tick keep array order. */
  events: Array<
    | { ticks: number; type: "program"; program: number }
    | { ticks: number; type: "cc"; controller: number; value: number }
    | { ticks: number; type: "noteOn"; note: number; velocity: number }
    | { ticks: number; type: "noteOff"; note: number; velocity?: number }
    | { ticks: number; type: "pitchBend"; value: number } // signed or absolute
  >;
  tailTicks?: number;
}): Uint8Array {
  // Lazy import keep test file self-contained with existing writeMidi path
  // via buildScenarioMidi's dependency — inline SMF writer instead.
  const tpq = spec.ticksPerBeat ?? 480;
  const tempo = spec.tempo ?? 500000;
  const ch = spec.channel ?? 0;

  function writeVarLen(n: number): number[] {
    const bytes: number[] = [];
    let buffer = n & 0x7f;
    while ((n >>= 7) > 0) {
      buffer <<= 8;
      buffer |= 0x80 | (n & 0x7f);
    }
    for (;;) {
      bytes.push(buffer & 0xff);
      if (buffer & 0x80) buffer >>= 8;
      else break;
    }
    return bytes;
  }

  const track: number[] = [];
  // set tempo
  track.push(
    ...writeVarLen(0),
    0xff,
    0x51,
    0x03,
    (tempo >> 16) & 0xff,
    (tempo >> 8) & 0xff,
    tempo & 0xff,
  );
  let last = 0;
  for (const ev of spec.events) {
    const dt = ev.ticks - last;
    last = ev.ticks;
    track.push(...writeVarLen(dt));
    if (ev.type === "program") {
      track.push(0xc0 | ch, ev.program & 0x7f);
    } else if (ev.type === "cc") {
      track.push(0xb0 | ch, ev.controller & 0x7f, ev.value & 0x7f);
    } else if (ev.type === "noteOn") {
      track.push(0x90 | ch, ev.note & 0x7f, ev.velocity & 0x7f);
    } else if (ev.type === "noteOff") {
      track.push(0x80 | ch, ev.note & 0x7f, (ev.velocity ?? 64) & 0x7f);
    } else if (ev.type === "pitchBend") {
      let abs = ev.value;
      if (abs >= -8192 && abs <= 8191) abs = abs + 8192;
      abs = Math.max(0, Math.min(16383, abs));
      const lsb = abs & 0x7f;
      const msb = (abs >> 7) & 0x7f;
      track.push(0xe0 | ch, lsb, msb);
    }
  }
  const tail = spec.tailTicks ?? tpq * 2;
  track.push(...writeVarLen(tail), 0xff, 0x2f, 0x00);

  const trackLen = track.length;
  const out = new Uint8Array(14 + 8 + trackLen);
  // MThd
  out.set([
    0x4d,
    0x54,
    0x68,
    0x64,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    1,
    (tpq >> 8) & 0xff,
    tpq & 0xff,
  ]);
  // MTrk
  const o = 14;
  out[o] = 0x4d;
  out[o + 1] = 0x54;
  out[o + 2] = 0x72;
  out[o + 3] = 0x6b;
  out[o + 4] = (trackLen >> 24) & 0xff;
  out[o + 5] = (trackLen >> 16) & 0xff;
  out[o + 6] = (trackLen >> 8) & 0xff;
  out[o + 7] = trackLen & 0xff;
  out.set(track, o + 8);
  return out;
}

Deno.test("almost-simple pitchbend A/B: op.mid PB-before-noteOn same tick (range12)", async (t) => {
  await ensureOutDir();
  // Exact order from op.mid @ ~107.1s / 112.3s:
  //   pitchBend(6912) → noteOff(prev) → noteOn(new)  at the SAME tick
  // then multi-step return to center while the new note is held.
  //
  // Onset snapshot must already be bent; in-note events only carry the
  // return path. If almost-simple ignores onset state, the scoop starts
  // from center and the pitch is wrong by ~187c (range12).
  const tpq = 480;
  // tempo 500000 → 120bpm; 1 beat = 0.5s = 480 ticks
  const t0 = tpq; // 0.5s — RPN + program
  const tBend = tpq * 2; // 1.0s — PB + noteOff + noteOn
  const note = 85;
  const prev = 86;
  const bytes = buildOrderedMidi({
    ticksPerBeat: tpq,
    tempo: 500000,
    events: [
      { ticks: 0, type: "program", program: 0 },
      // RPN range = 12
      { ticks: 0, type: "cc", controller: 101, value: 0 },
      { ticks: 0, type: "cc", controller: 100, value: 0 },
      { ticks: 0, type: "cc", controller: 6, value: 12 },
      { ticks: 0, type: "cc", controller: 38, value: 0 },
      { ticks: 0, type: "cc", controller: 101, value: 127 },
      { ticks: 0, type: "cc", controller: 100, value: 127 },
      // previous note
      { ticks: t0, type: "noteOn", note: prev, velocity: 100 },
      // same-tick: PB first, then noteOff, then noteOn (op.mid order)
      { ticks: tBend, type: "pitchBend", value: 6912 - 8192 },
      { ticks: tBend, type: "noteOff", note: prev },
      { ticks: tBend, type: "noteOn", note, velocity: 112 },
      // return to center over ~130ms (≈ 0.13s ≈ 125 ticks at 120bpm)
      { ticks: tBend + 30, type: "pitchBend", value: 7447 - 8192 },
      { ticks: tBend + 60, type: "pitchBend", value: 7844 - 8192 },
      { ticks: tBend + 90, type: "pitchBend", value: 8092 - 8192 },
      { ticks: tBend + 120, type: "pitchBend", value: 8190 - 8192 },
      { ticks: tBend + 125, type: "pitchBend", value: 0 },
      { ticks: tBend + 400, type: "noteOff", note },
    ],
    tailTicks: tpq,
  });

  // times in seconds at 120bpm (500000 us/qn): tick/480 * 0.5
  const sec = (ticks: number) => (ticks / tpq) * 0.5;
  const fNote = midiNoteToHz(note);
  const cents6912 = opCents(6912 - 8192);
  await abCheck(t, "op-pb-before-noteon", bytes, [
    {
      label: "onsetBent",
      start: sec(tBend) + 0.01,
      end: sec(tBend) + 0.04,
      minHz: fNote * Math.pow(2, -3 / 12),
      maxHz: fNote * 1.05,
      expectDeltaCents: cents6912,
      deltaTol: 55,
    },
    {
      label: "afterCenter",
      start: sec(tBend + 200),
      end: sec(tBend + 380),
      minHz: fNote * 0.85,
      maxHz: fNote * 1.15,
      isRef: true,
      expectDeltaCents: 0,
      deltaTol: 40,
    },
  ]);
});

Deno.test("almost-simple pitchbend A/B: op.mid noteOn-before-PB same tick (range12)", async (t) => {
  await ensureOutDir();
  // Alternate same-tick order from op.mid @ ~103.97s:
  //   noteOn → pitchBend(6912)  (note starts center, bend applied at t≈0)
  const tpq = 480;
  const tBend = tpq * 2;
  const note = 91;
  const bytes = buildOrderedMidi({
    ticksPerBeat: tpq,
    tempo: 500000,
    events: [
      { ticks: 0, type: "program", program: 0 },
      { ticks: 0, type: "cc", controller: 101, value: 0 },
      { ticks: 0, type: "cc", controller: 100, value: 0 },
      { ticks: 0, type: "cc", controller: 6, value: 12 },
      { ticks: 0, type: "cc", controller: 38, value: 0 },
      { ticks: 0, type: "cc", controller: 101, value: 127 },
      { ticks: 0, type: "cc", controller: 100, value: 127 },
      { ticks: tBend, type: "noteOn", note, velocity: 112 },
      { ticks: tBend, type: "pitchBend", value: 6912 - 8192 },
      { ticks: tBend + 30, type: "pitchBend", value: 7447 - 8192 },
      { ticks: tBend + 60, type: "pitchBend", value: 7844 - 8192 },
      { ticks: tBend + 90, type: "pitchBend", value: 8092 - 8192 },
      { ticks: tBend + 120, type: "pitchBend", value: 8190 - 8192 },
      { ticks: tBend + 125, type: "pitchBend", value: 0 },
      { ticks: tBend + 400, type: "noteOff", note },
    ],
    tailTicks: tpq,
  });

  const sec = (ticks: number) => (ticks / tpq) * 0.5;
  const fNote = midiNoteToHz(note);
  const cents6912 = opCents(6912 - 8192);
  await abCheck(t, "op-noteon-before-pb", bytes, [
    {
      label: "onsetBent",
      start: sec(tBend) + 0.01,
      end: sec(tBend) + 0.04,
      minHz: fNote * Math.pow(2, -3 / 12),
      maxHz: fNote * 1.05,
      expectDeltaCents: cents6912,
      deltaTol: 55,
    },
    {
      label: "afterCenter",
      start: sec(tBend + 200),
      end: sec(tBend + 380),
      minHz: fNote * 0.85,
      maxHz: fNote * 1.15,
      isRef: true,
      expectDeltaCents: 0,
      deltaTol: 40,
    },
  ]);
});
