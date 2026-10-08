/**
 * Fast unit checks for parameters that change the *sound* (envelope times,
 * filter, playback rate, volume curves). These catch regressions before the
 * slow tools/ waveform suite.
 *
 * Not a substitute for tools/ (no real Offline render / fluidsynth compare),
 * but a cheap gate: if getVoiceParams or the SF2→WebAudio conversion math
 * drifts, these fail in seconds.
 */
import type { Voice } from "@marmooo/soundfont";
import { assertAlmostEquals, assertEquals, assertNotEquals } from "@std/assert";
import {
  cbToRatio,
  FULLY_OPEN_FILTER_CENTS,
  getVoiceParams,
  isFilterAudible,
  sf2FilterQ,
  sf2ModulatorVolumeExprGain,
  sf2VolumeAttenCb,
  sf2VolumeExprGain,
} from "../src/base-player.ts";
import { MidyGMLite } from "../src/midy-GMLite.ts";
import {
  flushNotePromises,
  installSoundFontStub,
  patchBufferSourceNodes,
  sanOptions,
  setMockCurrentTime,
} from "./mock-shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const secondsToTimecent = (seconds: number) =>
  seconds === 0 ? -Infinity : 1200 * Math.log2(seconds);

function makeGenerators(
  overrides: Record<string, number> = {},
): {
  get(key: string): number;
  clone(): ReturnType<typeof makeGenerators>;
  set(key: string, value: number): void;
} {
  const values: Record<string, number> = {
    initialAttenuation: 0,
    initialFilterFc: 13500, // fully open
    initialFilterQ: 0,
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
    sustainVolEnv: 0,
    sustainModEnv: 0,
    delayVolEnv: secondsToTimecent(0),
    attackVolEnv: secondsToTimecent(0.01),
    holdVolEnv: secondsToTimecent(0),
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
    scaleTuning: 100, // 100 = normal semitone scaling
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
    sampleID: 1,
    sampleModes: 1, // loop
    exclusiveClass: 0,
    ...overrides,
  };
  return {
    get: (key: string) => values[key] ?? 0,
    clone: () => makeGenerators({ ...values }),
    set(key: string, value: number) {
      values[key] = value;
    },
  };
}

function makeVoice(
  opts: {
    key?: number;
    originalPitch?: number;
    pitchCorrection?: number;
    generators?: ReturnType<typeof makeGenerators>;
  } = {},
): Voice {
  const generators = opts.generators ?? makeGenerators();
  const sampleHeader = {
    sampleName: "test",
    start: 0,
    end: 44100,
    loopStart: 0,
    loopEnd: 44100,
    sampleRate: 44100,
    originalPitch: opts.originalPitch ?? 60,
    pitchCorrection: opts.pitchCorrection ?? 0,
  };
  return {
    key: opts.key ?? 60,
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
  } as unknown as Voice;
}

function centerControllerState(): Float32Array {
  // Length matches channel state array usage; only index 14 (pitch wheel)
  // is forced to center inside getVoiceParams — rest can be zeros.
  const state = new Float32Array(32);
  state[14] = 8192 / 16383;
  return state;
}

// ---------------------------------------------------------------------------
// Pure conversion math (no player)
// ---------------------------------------------------------------------------

Deno.test(
  "[sound-params] cbToRatio: 0 cB → 1, -200 cB → 0.1",
  sanOptions,
  () => {
    assertAlmostEquals(cbToRatio(0), 1, 1e-12);
    assertAlmostEquals(cbToRatio(-200), 0.1, 1e-12); // 20 dB
    assertEquals(
      cbToRatio(-1000) < cbToRatio(-200),
      true,
      "more atten = quieter",
    );
  },
);

Deno.test(
  "[sound-params] sf2FilterQ: cB → resonanceDb / q / dcGain",
  sanOptions,
  () => {
    const z = sf2FilterQ(0);
    assertAlmostEquals(z.resonanceDb, 0, 1e-12);
    assertAlmostEquals(z.q, 1, 1e-9);
    assertAlmostEquals(z.dcGain, 1, 1e-9);

    const q = sf2FilterQ(60); // 6 dB resonance
    assertAlmostEquals(q.resonanceDb, 6, 1e-12);
    assertAlmostEquals(q.q, Math.pow(10, 6 / 20), 1e-9);
    assertAlmostEquals(q.dcGain, 1 / Math.sqrt(q.q), 1e-9);

    // Negative cB clamps to 0 dB resonance.
    const neg = sf2FilterQ(-10);
    assertAlmostEquals(neg.resonanceDb, 0, 1e-12);
  },
);

Deno.test(
  "[sound-params] isFilterAudible: fully open + Q0 + no mod = silent path",
  sanOptions,
  () => {
    assertEquals(
      isFilterAudible(FULLY_OPEN_FILTER_CENTS, 0, 0),
      false,
      "default open filter must be treated as inaudible",
    );
    assertEquals(
      isFilterAudible(FULLY_OPEN_FILTER_CENTS - 1, 0, 0),
      true,
      "Fc below open must be audible",
    );
    assertEquals(
      isFilterAudible(FULLY_OPEN_FILTER_CENTS, 1, 0),
      true,
      "Q > 0 must be audible even at open Fc",
    );
    assertEquals(
      isFilterAudible(FULLY_OPEN_FILTER_CENTS, 0, 100),
      true,
      "modEnvToFilterFc must force audible",
    );
  },
);

Deno.test(
  "[sound-params] volume curves are monotonic in CC7/CC11",
  sanOptions,
  () => {
    const gLow = sf2VolumeExprGain(0.3, 1);
    const gMid = sf2VolumeExprGain(0.6, 1);
    const gHigh = sf2VolumeExprGain(1, 1);
    assertEquals(gLow < gMid && gMid < gHigh, true, "CC7 must raise gain");

    const eLow = sf2VolumeExprGain(1, 0.3);
    const eHigh = sf2VolumeExprGain(1, 1);
    assertEquals(eLow < eHigh, true, "CC11 must raise gain");

    // Modulator path (SF2 default) also monotonic.
    assertEquals(
      sf2ModulatorVolumeExprGain(0.4, 1) < sf2ModulatorVolumeExprGain(0.9, 1),
      true,
    );

    // Silence at zero volume.
    assertAlmostEquals(sf2VolumeExprGain(0, 1), cbToRatio(-960), 1e-9);
    assertAlmostEquals(sf2VolumeAttenCb(0), 960, 1e-12);
    assertAlmostEquals(sf2VolumeAttenCb(1), 0, 1e-12);
  },
);

// ---------------------------------------------------------------------------
// getVoiceParams: envelope times (note length / release character)
// ---------------------------------------------------------------------------

Deno.test(
  "[sound-params] getVoiceParams maps attack/release timecents → seconds",
  sanOptions,
  () => {
    const attackS = 0.05;
    const releaseS = 0.8;
    const voice = makeVoice({
      generators: makeGenerators({
        attackVolEnv: secondsToTimecent(attackS),
        releaseVolEnv: secondsToTimecent(releaseS),
        decayVolEnv: secondsToTimecent(0.25),
        holdVolEnv: secondsToTimecent(0.02),
      }),
    });
    const p = getVoiceParams(voice, centerControllerState());
    assertAlmostEquals(p.attackVolEnv, attackS, 1e-9);
    assertAlmostEquals(p.releaseVolEnv, releaseS, 1e-9);
    assertAlmostEquals(p.decayVolEnv, 0.25, 1e-9);
    assertAlmostEquals(p.holdVolEnv, 0.02, 1e-9);
  },
);

Deno.test(
  "[sound-params] longer release generator → larger releaseVolEnv",
  sanOptions,
  () => {
    const short = getVoiceParams(
      makeVoice({
        generators: makeGenerators({
          releaseVolEnv: secondsToTimecent(0.05),
        }),
      }),
      centerControllerState(),
    );
    const long = getVoiceParams(
      makeVoice({
        generators: makeGenerators({
          releaseVolEnv: secondsToTimecent(1.5),
        }),
      }),
      centerControllerState(),
    );
    assertEquals(long.releaseVolEnv > short.releaseVolEnv * 10, true);
    assertAlmostEquals(short.releaseVolEnv, 0.05, 1e-9);
    assertAlmostEquals(long.releaseVolEnv, 1.5, 1e-9);
  },
);

Deno.test(
  "[sound-params] keynumToVolEnvDecay scales decay with note key",
  sanOptions,
  () => {
    // Positive keynum scale: higher keys → shorter decay (SF2 §8.1.3).
    const gens = makeGenerators({
      decayVolEnv: secondsToTimecent(1.0),
      keynumToVolEnvDecay: -60, // -60 tc per key above C4
    });
    const atC4 = getVoiceParams(
      makeVoice({ key: 60, generators: gens }),
      centerControllerState(),
    );
    const atC5 = getVoiceParams(
      makeVoice({ key: 72, generators: gens.clone() }),
      centerControllerState(),
    );
    assertAlmostEquals(atC4.decayVolEnv, 1.0, 1e-9);
    // (72-60)*(-60) = -720 tc → 2^(-720/1200) ≈ 0.66 of base
    assertEquals(
      atC5.decayVolEnv < atC4.decayVolEnv,
      true,
      "higher key with negative keynum scale must shorten decay",
    );
  },
);

Deno.test(
  "[sound-params] sustainVolEnv is permille → 0..1 fraction",
  sanOptions,
  () => {
    const p = getVoiceParams(
      makeVoice({
        generators: makeGenerators({ sustainVolEnv: 500 }), // 50%
      }),
      centerControllerState(),
    );
    assertAlmostEquals(p.sustainVolEnv, 0.5, 1e-9);
  },
);

// ---------------------------------------------------------------------------
// getVoiceParams: filter
// ---------------------------------------------------------------------------

Deno.test(
  "[sound-params] getVoiceParams passes initialFilterFc / Q through",
  sanOptions,
  () => {
    const closed = getVoiceParams(
      makeVoice({
        generators: makeGenerators({
          initialFilterFc: 6000,
          initialFilterQ: 30,
        }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(closed.initialFilterFc, 6000, 1e-9);
    assertAlmostEquals(closed.initialFilterQ, 30, 1e-9);
    assertEquals(
      isFilterAudible(closed.initialFilterFc, closed.initialFilterQ, 0),
      true,
    );

    const open = getVoiceParams(
      makeVoice({
        generators: makeGenerators({
          initialFilterFc: FULLY_OPEN_FILTER_CENTS,
          initialFilterQ: 0,
        }),
      }),
      centerControllerState(),
    );
    assertEquals(
      isFilterAudible(open.initialFilterFc, open.initialFilterQ, 0),
      false,
    );
  },
);

Deno.test(
  "[sound-params] modEnvToFilterFc is preserved for envelope path",
  sanOptions,
  () => {
    const p = getVoiceParams(
      makeVoice({
        generators: makeGenerators({
          initialFilterFc: FULLY_OPEN_FILTER_CENTS,
          initialFilterQ: 0,
          modEnvToFilterFc: 2400,
          attackModEnv: secondsToTimecent(0.1),
        }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(p.modEnvToFilterFc, 2400, 1e-9);
    assertEquals(
      isFilterAudible(p.initialFilterFc, p.initialFilterQ, p.modEnvToFilterFc),
      true,
      "mod-to-filter must keep filter path active even when Fc is open",
    );
  },
);

// ---------------------------------------------------------------------------
// getVoiceParams: pitch / length-related playbackRate
// ---------------------------------------------------------------------------

Deno.test(
  "[sound-params] playbackRate follows key vs root (scaleTuning=100)",
  sanOptions,
  () => {
    // Root C4, play C5 → +12 semitones → rate = 2
    const up = getVoiceParams(
      makeVoice({
        key: 72,
        originalPitch: 60,
        generators: makeGenerators({ scaleTuning: 100 }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(up.playbackRate, 2, 1e-9);

    // Root C4, play C3 → -12 → rate = 0.5
    const down = getVoiceParams(
      makeVoice({
        key: 48,
        originalPitch: 60,
        generators: makeGenerators({ scaleTuning: 100 }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(down.playbackRate, 0.5, 1e-9);

    // Same key as root → 1
    const unison = getVoiceParams(
      makeVoice({
        key: 60,
        originalPitch: 60,
        generators: makeGenerators({ scaleTuning: 100 }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(unison.playbackRate, 1, 1e-9);
  },
);

Deno.test(
  "[sound-params] overridingRootKey changes playbackRate",
  sanOptions,
  () => {
    // Sample originalPitch 60, but overridingRootKey 72, play key 72 → rate 1
    const p = getVoiceParams(
      makeVoice({
        key: 72,
        originalPitch: 60,
        generators: makeGenerators({
          scaleTuning: 100,
          overridingRootKey: 72,
        }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(p.playbackRate, 1, 1e-9);
  },
);

Deno.test(
  "[sound-params] fineTune / coarseTune feed detune cents",
  sanOptions,
  () => {
    const p = getVoiceParams(
      makeVoice({
        generators: makeGenerators({
          coarseTune: 1, // +100 cents
          fineTune: 25, // +25 cents
        }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(p.detune, 125, 1e-9);
  },
);

Deno.test(
  "[sound-params] EMU 0.4× scale on static initialAttenuation",
  sanOptions,
  () => {
    // Static atten 100 cB → effective 40 after EMU factor (no modulators).
    const p = getVoiceParams(
      makeVoice({
        generators: makeGenerators({ initialAttenuation: 100 }),
      }),
      centerControllerState(),
    );
    assertAlmostEquals(p.initialAttenuation, 40, 1e-9);
  },
);

// ---------------------------------------------------------------------------
// Integration: noteOn stamps voiceParams used for length / filter
// ---------------------------------------------------------------------------

Deno.test(
  "[sound-params] noteOn attaches voiceParams with expected release/filter",
  sanOptions,
  async () => {
    const ctx = new AudioContext();
    setMockCurrentTime(ctx, 0);
    const player = new MidyGMLite(ctx);
    // Custom voice via stub: long release + closed filter.
    player.soundFontTable[0] = [0];
    const gens = makeGenerators({
      releaseVolEnv: secondsToTimecent(1.25),
      attackVolEnv: secondsToTimecent(0.03),
      initialFilterFc: 5000,
      initialFilterQ: 20,
    });
    player.soundFonts = [
      {
        getVoice: () =>
          ({
            key: 60,
            generators: gens,
            sampleHeader: {
              sampleName: "",
              start: 0,
              end: 0,
              loopStart: 0,
              loopEnd: 0,
              sampleRate: 44100,
              originalPitch: 60,
              pitchCorrection: 0,
            },
            sample: {
              type: "raw",
              data: new Int16Array(0),
              sampleHeader: { sampleRate: 44100 },
              decodePCM: () => new Float32Array(0),
            },
            transformAllParams: () => gens,
            transformParams: () => ({}),
          }) as unknown as Voice,
      } as unknown as import("@marmooo/soundfont").SoundFont,
    ];
    player.getAudioBuffer = () =>
      Promise.resolve(new AudioBuffer({ length: 100, sampleRate: 44100 }));
    patchBufferSourceNodes(player);

    const note = await player.channels[0].noteOn(60, 100, 0) as {
      voiceParams?: {
        releaseVolEnv: number;
        attackVolEnv: number;
        initialFilterFc: number;
        initialFilterQ: number;
      };
    };
    assertNotEquals(note, undefined);
    assertNotEquals(note.voiceParams, undefined);
    assertAlmostEquals(note.voiceParams!.releaseVolEnv, 1.25, 1e-6);
    assertAlmostEquals(note.voiceParams!.attackVolEnv, 0.03, 1e-6);
    assertAlmostEquals(note.voiceParams!.initialFilterFc, 5000, 1e-6);
    assertAlmostEquals(note.voiceParams!.initialFilterQ, 20, 1e-6);
    await flushNotePromises(player);
  },
);

Deno.test(
  "[sound-params] different notes can get different playbackRate from root",
  sanOptions,
  async () => {
    const ctx = new AudioContext();
    setMockCurrentTime(ctx, 0);
    const player = new MidyGMLite(ctx);
    installSoundFontStub(player, 0);
    // Default mock uses scaleTuning 0 in makeDefaultGeneratorValues — override.
    const baseGens = makeGenerators({ scaleTuning: 100 });
    // Real signature: getVoice(bank, program, noteNumber, velocity)
    player.soundFonts = [
      {
        getVoice: (
          _bank: number,
          _program: number,
          noteNumber: number,
          _velocity: number,
        ) =>
          ({
            key: noteNumber,
            generators: baseGens.clone(),
            sampleHeader: {
              sampleName: "",
              start: 0,
              end: 0,
              loopStart: 0,
              loopEnd: 0,
              sampleRate: 44100,
              originalPitch: 60,
              pitchCorrection: 0,
            },
            sample: {
              type: "raw",
              data: new Int16Array(0),
              sampleHeader: { sampleRate: 44100 },
              decodePCM: () => new Float32Array(0),
            },
            transformAllParams: () => baseGens.clone(),
            transformParams: () => ({}),
          }) as unknown as Voice,
      } as unknown as import("@marmooo/soundfont").SoundFont,
    ];
    player.getAudioBuffer = () =>
      Promise.resolve(new AudioBuffer({ length: 100, sampleRate: 44100 }));
    patchBufferSourceNodes(player);

    const n60 = await player.channels[0].noteOn(60, 100, 0) as {
      voiceParams?: { playbackRate: number };
    };
    const n72 = await player.channels[0].noteOn(72, 100, 0) as {
      voiceParams?: { playbackRate: number };
    };
    assertAlmostEquals(n60.voiceParams!.playbackRate, 1, 1e-6);
    assertAlmostEquals(n72.voiceParams!.playbackRate, 2, 1e-6);
    await flushNotePromises(player);
  },
);

Deno.test(
  "[sound-params] filter open vs closed changes isFilterAudible on live note",
  sanOptions,
  async () => {
    const ctx = new AudioContext();
    setMockCurrentTime(ctx, 1);
    const player = new MidyGMLite(ctx);

    function install(fc: number, q: number) {
      const gens = makeGenerators({
        initialFilterFc: fc,
        initialFilterQ: q,
      });
      player.soundFontTable[0] = [0];
      player.soundFonts = [
        {
          getVoice: () =>
            ({
              key: 60,
              generators: gens,
              sampleHeader: {
                sampleName: "",
                start: 0,
                end: 0,
                loopStart: 0,
                loopEnd: 0,
                sampleRate: 44100,
                originalPitch: 60,
                pitchCorrection: 0,
              },
              sample: {
                type: "raw",
                data: new Int16Array(0),
                sampleHeader: { sampleRate: 44100 },
                decodePCM: () => new Float32Array(0),
              },
              transformAllParams: () => gens,
              transformParams: () => ({}),
            }) as unknown as Voice,
        } as unknown as import("@marmooo/soundfont").SoundFont,
      ];
      player.getAudioBuffer = () =>
        Promise.resolve(new AudioBuffer({ length: 100, sampleRate: 44100 }));
      patchBufferSourceNodes(player);
    }

    install(FULLY_OPEN_FILTER_CENTS, 0);
    const openNote = await player.channels[0].noteOn(60, 100, 1) as {
      voiceParams?: { initialFilterFc: number; initialFilterQ: number };
    };
    assertEquals(
      isFilterAudible(
        openNote.voiceParams!.initialFilterFc,
        openNote.voiceParams!.initialFilterQ,
        0,
      ),
      false,
    );
    await player.channels[0].noteOff(60, 0, 1, true);
    await flushNotePromises(player);

    install(4500, 40);
    const closedNote = await player.channels[0].noteOn(60, 100, 1.1) as {
      voiceParams?: { initialFilterFc: number; initialFilterQ: number };
    };
    assertEquals(
      isFilterAudible(
        closedNote.voiceParams!.initialFilterFc,
        closedNote.voiceParams!.initialFilterQ,
        0,
      ),
      true,
    );
    await flushNotePromises(player);
  },
);
