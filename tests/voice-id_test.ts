// Regression tests for getVoiceId / ADS cache-key uniqueness.
//
// Bug (fixed): getVoiceId packed sampleID and startTag with overlapping bits:
//   ((sampleID & 0xffff) << 8) + (start & 0xffff)
// so e.g. (sampleID=4, start=256) collided with (sampleID=5, start=0).
// That made distinct samples share one rawAudioBufferCache entry and could
// make A4 sound like G4 under cache modes that reuse getVoiceId.
//
// These tests do not need waveform comparison — uniqueness of the integer id
// is enough to catch the packing regression.

import { MidyGMLite } from "../src/midy-GMLite.ts";
import type { Voice } from "@marmooo/soundfont";
import {
  assertEquals,
  assertNotEquals,
  installSoundFontStub,
  sanOptions,
  setMockCurrentTime,
} from "./mock-shared.ts";

// ---------------------------------------------------------------------------
// Helpers: build a mock Voice with controllable sampleID / start / instrument
// ---------------------------------------------------------------------------

function makeGeneratorStore(opts: {
  sampleID: number;
  instrument?: number;
  startAddrsOffset?: number;
  startAddrsCoarseOffset?: number;
  exclusiveClass?: number;
}): {
  get(key: string): number;
  clone(): ReturnType<typeof makeGeneratorStore>;
  set(key: string, value: number): void;
} {
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
    sustainVolEnv: 500,
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
    scaleTuning: 0,
    overridingRootKey: -1,
    startAddrsOffset: opts.startAddrsOffset ?? 0,
    startAddrsCoarseOffset: opts.startAddrsCoarseOffset ?? 0,
    endAddrsOffset: 0,
    endAddrsCoarseOffset: 0,
    startloopAddrsOffset: 0,
    startloopAddrsCoarseOffset: 0,
    endloopAddrsOffset: 0,
    endloopAddrsCoarseOffset: 0,
    instrument: opts.instrument ?? 0,
    sampleID: opts.sampleID,
    sampleModes: 0,
    exclusiveClass: opts.exclusiveClass ?? 0,
  };
  return {
    get(key: string) {
      return values[key] ?? 0;
    },
    clone: () => makeGeneratorStore(opts),
    set(key: string, value: number) {
      values[key] = value;
    },
  };
}

function makeVoice(opts: {
  sampleID: number;
  instrument?: number;
  startAddrsOffset?: number;
  startAddrsCoarseOffset?: number;
  key?: number;
}): Voice {
  const generators = makeGeneratorStore(opts);
  const sampleHeader = {
    sampleName: `sample-${opts.sampleID}`,
    start: 0,
    end: 0,
    loopStart: 0,
    loopEnd: 0,
    sampleRate: 44100,
    originalPitch: opts.key ?? 60,
    pitchCorrection: 0,
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

/** Old (buggy) packing — 16-bit startTag ADDed after sampleID<<8. */
function oldBuggyVoiceId(
  soundFontIndex: number,
  instrument: number,
  sampleID: number,
  start: number,
): number {
  const startTag = (start | 0) & 0xffff;
  return soundFontIndex * (2 ** 31) + instrument * (2 ** 24) +
    ((sampleID & 0xffff) << 8) + startTag;
}

/** Current packing: 16-bit startTag, non-overlapping fields. */
function packVoiceId(
  soundFontIndex: number,
  instrument: number,
  sampleID: number,
  start: number,
): number {
  const startTag = (start | 0) & 0xffff;
  return (soundFontIndex & 0xff) * (2 ** 40) +
    (instrument & 0xff) * (2 ** 32) +
    (sampleID & 0xffff) * (2 ** 16) +
    startTag;
}

function setupPlayer(): MidyGMLite {
  const ctx = new AudioContext();
  setMockCurrentTime(ctx, 0);
  const player = new MidyGMLite(ctx);
  installSoundFontStub(player, 0);
  return player;
}

/**
 * Replace getVoice so each noteNumber maps to a controlled sampleID / start.
 * Returns a Map noteNumber → { sampleID, start } for assertions.
 */
function installVoiceMap(
  player: MidyGMLite,
  map: Map<number, {
    sampleID: number;
    startAddrsOffset?: number;
    startAddrsCoarseOffset?: number;
    instrument?: number;
  }>,
): void {
  player.soundFontTable[0] = [0];
  player.soundFonts = [
    {
      getVoice: (
        _bank: number,
        _program: number,
        noteNumber: number,
        _velocity: number,
      ) => {
        const entry = map.get(noteNumber);
        if (!entry) return null;
        return makeVoice({
          sampleID: entry.sampleID,
          startAddrsOffset: entry.startAddrsOffset,
          startAddrsCoarseOffset: entry.startAddrsCoarseOffset,
          instrument: entry.instrument,
          key: noteNumber,
        });
      },
    } as unknown as import("@marmooo/soundfont").SoundFont,
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "[voice-id] distinct sampleIDs that collided under old packing get unique ids",
  sanOptions,
  () => {
    // Classic collision under the old formula:
    //   sampleID=5, start=0   → low bits 1280
    //   sampleID=4, start=256 → low bits 1280
    const a = oldBuggyVoiceId(0, 0, 5, 0);
    const b = oldBuggyVoiceId(0, 0, 4, 256);
    assertEquals(
      a,
      b,
      "sanity: old packing must still collide for this pair (documents the bug)",
    );

    const player = setupPlayer();
    const channel = player.channels[0];
    installVoiceMap(
      player,
      new Map([
        [67, { sampleID: 5, startAddrsOffset: 0 }], // G4
        [69, { sampleID: 4, startAddrsOffset: 256 }], // A4
      ]),
    );

    const idG4 = player.getVoiceId(channel, 67, 100);
    const idA4 = player.getVoiceId(channel, 69, 100);

    assertNotEquals(idG4, undefined, "G4 must resolve a voice id");
    assertNotEquals(idA4, undefined, "A4 must resolve a voice id");
    assertNotEquals(
      idG4,
      idA4,
      "G4 and A4 must not share audioBufferId (old packing collided here)",
    );
  },
);

Deno.test(
  "[voice-id] same sampleID + same start → same id (cache hit is intentional)",
  sanOptions,
  () => {
    const player = setupPlayer();
    const channel = player.channels[0];
    installVoiceMap(
      player,
      new Map([
        [60, { sampleID: 10, startAddrsOffset: 0 }],
        [62, { sampleID: 10, startAddrsOffset: 0 }],
      ]),
    );

    const idC4 = player.getVoiceId(channel, 60, 100);
    const idD4 = player.getVoiceId(channel, 62, 100);
    assertEquals(
      idC4,
      idD4,
      "shared sample region must reuse the same raw-buffer cache key",
    );
  },
);

Deno.test(
  "[voice-id] same sampleID + different start → different ids",
  sanOptions,
  () => {
    const player = setupPlayer();
    const channel = player.channels[0];
    installVoiceMap(
      player,
      new Map([
        [60, { sampleID: 10, startAddrsOffset: 0 }],
        [61, { sampleID: 10, startAddrsOffset: 512 }],
      ]),
    );

    const idA = player.getVoiceId(channel, 60, 100);
    const idB = player.getVoiceId(channel, 61, 100);
    assertNotEquals(
      idA,
      idB,
      "different start offsets on the same sample must not collide",
    );
  },
);

Deno.test(
  "[voice-id] different instruments do not collide",
  sanOptions,
  () => {
    const player = setupPlayer();
    const channel = player.channels[0];
    installVoiceMap(
      player,
      new Map([
        [60, { sampleID: 1, instrument: 0, startAddrsOffset: 0 }],
        [61, { sampleID: 1, instrument: 1, startAddrsOffset: 0 }],
      ]),
    );

    const id0 = player.getVoiceId(channel, 60, 100);
    const id1 = player.getVoiceId(channel, 61, 100);
    assertNotEquals(id0, id1, "instrument must be part of the cache key");
  },
);

Deno.test(
  "[voice-id] audioBufferId and ADS subKey stay safe integers",
  sanOptions,
  () => {
    const audioBufferId = packVoiceId(1, 127, 0xffff, 0xffff);
    const subKey = 127 * 128 + 127;
    assertEquals(
      Number.isSafeInteger(audioBufferId),
      true,
      `audioBufferId ${audioBufferId} must be safe`,
    );
    assertEquals(
      Number.isSafeInteger(subKey),
      true,
      `ADS subKey ${subKey} must be safe`,
    );
  },
);

Deno.test(
  "[voice-id] ids stay within Number.MAX_SAFE_INTEGER",
  sanOptions,
  () => {
    const player = setupPlayer();
    const channel = player.channels[0];
    installVoiceMap(
      player,
      new Map([
        [
          60,
          {
            sampleID: 0xffff,
            instrument: 0xff,
            startAddrsOffset: 0xffff,
          },
        ],
      ]),
    );

    const id = player.getVoiceId(channel, 60, 100);
    assertNotEquals(id, undefined);
    assertEquals(
      Number.isSafeInteger(id),
      true,
      `voice id ${id} must be a safe integer for Map keys`,
    );
  },
);

Deno.test(
  "[voice-id] ADS composite cache key distinguishes noteNumber for shared sample",
  sanOptions,
  () => {
    // bigint key: (audioBufferId << 14) | (velocity * 128 + noteNumber)
    // Shared sample (same audioBufferId) must still get distinct ADS entries
    // per noteNumber because playbackRate / rootKey differ.
    const audioBufferId = 0x123456789abc;
    const velocity = 100;
    const keyG4 = (BigInt(audioBufferId) << 14n) |
      BigInt(velocity * 128 + 67);
    const keyA4 = (BigInt(audioBufferId) << 14n) |
      BigInt(velocity * 128 + 69);
    assertNotEquals(
      keyG4,
      keyA4,
      "ADS keys must not merge different noteNumbers on a shared sample",
    );
  },
);

Deno.test(
  "[voice-id] sampleID×start (16-bit) pairs never collide",
  sanOptions,
  () => {
    // Every (sampleID, start) in a representative grid must be unique.
    const seen = new Map<number, string>();
    for (let sampleID = 0; sampleID <= 32; sampleID++) {
      for (let start = 0; start <= 2048; start += 256) {
        const id = packVoiceId(0, 0, sampleID, start);
        const label = `sampleID=${sampleID},start=${start}`;
        const prev = seen.get(id);
        assertEquals(
          prev,
          undefined,
          `collision: ${label} shares id ${id} with ${prev}`,
        );
        seen.set(id, label);
        assertEquals(
          Number.isSafeInteger(id),
          true,
          `id ${id} must be a safe integer`,
        );
      }
    }
  },
);
