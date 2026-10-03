// Soft-velocity internal parity: cacheMode=none vs baked modes.
//
// GeneralUser piano soft zone (vel=40) closes the lowpass to ~212 Hz (below
// the C4 fundamental). ADS/ADSR/note/… bake through a TypedArray biquad while
// "none" uses Web Audio BiquadFilterNode. Levels should still match closely;
// a multi-dB gap is a pipeline bug, not FluidSynth tolerance noise.
//
// This test does NOT compare against FluidSynth — only midy-internal
// none↔bake consistency on the soft attack window.
//
// Usage:
//   deno test -A tools/compare-soft-bake.test.ts
import { buildVelocityZoneMidi } from "./gen-midi-scenarios.ts";
import {
  assertNonEmptyFile,
  CACHE_MODES,
  ensureOutDir,
  HARNESS_DIR,
  OUT_DIR,
  readWav,
  renderMidyMode,
  SAMPLE_RATE,
  SF2_PATH,
  toMono,
  windowRmsDb,
} from "./compare-common.ts";

const SOFT_ATTACK_START = 0.02;
const SOFT_ATTACK_END = 0.12;
const LOUD_AT = 1.2;
const LOUD_ATTACK_START = LOUD_AT + 0.02;
const LOUD_ATTACK_END = LOUD_AT + 0.12;

/** Max |softΔ| between none and any baked mode (dB). Tight on purpose. */
const SOFT_NONE_VS_BAKE_MAX_DB = 1.5;
/** Loud is less filter-sensitive; keep a separate, still tight bound. */
const LOUD_NONE_VS_BAKE_MAX_DB = 1.5;

Deno.test("piano soft velocity: none vs baked mode level parity", async (t) => {
  await ensureOutDir();
  const midiPath = `${OUT_DIR}/melody-soft-bake-parity.mid`;

  await t.step("generate velocity-zone MIDI", async () => {
    const bytes = buildVelocityZoneMidi({
      noteNumber: 60,
      softVelocity: 40,
      loudVelocity: 100,
      softDuration: 0.7,
      loudDuration: 0.7,
      loudAt: LOUD_AT,
      program: 0,
    });
    await Deno.writeFile(midiPath, bytes);
    await assertNonEmptyFile(midiPath);
  });

  const levels = new Map<string, { soft: number; loud: number }>();

  for (const cacheMode of CACHE_MODES) {
    await t.step(`render midy (${cacheMode})`, async () => {
      const wavBytes = await renderMidyMode({
        harnessDir: HARNESS_DIR,
        midiPath,
        soundFontPath: SF2_PATH,
        cacheMode,
        sampleRate: SAMPLE_RATE,
      });
      if (wavBytes.length === 0) {
        throw new Error(`midy (${cacheMode}) returned empty WAV`);
      }
      const path = `${OUT_DIR}/midy-soft-bake-parity-${cacheMode}.wav`;
      await Deno.writeFile(path, wavBytes);
      const wav = readWav(wavBytes);
      const mono = toMono(wav);
      const soft = windowRmsDb(
        mono,
        wav.sampleRate,
        SOFT_ATTACK_START,
        SOFT_ATTACK_END,
      );
      const loud = windowRmsDb(
        mono,
        wav.sampleRate,
        LOUD_ATTACK_START,
        LOUD_ATTACK_END,
      );
      levels.set(cacheMode, { soft, loud });
      console.log(
        `  midy(${cacheMode}): soft=${soft.toFixed(1)}dB loud=${
          loud.toFixed(1)
        }dB`,
      );
    });
  }

  await t.step("none vs baked soft/loud parity", () => {
    const none = levels.get("none");
    if (!none) throw new Error("missing none render");
    if (!Number.isFinite(none.soft) || none.soft < -60) {
      throw new Error(`none soft effectively silent (${none.soft}dB)`);
    }

    for (const mode of CACHE_MODES) {
      if (mode === "none") continue;
      const cand = levels.get(mode);
      if (!cand) throw new Error(`missing ${mode} render`);
      const softDelta = cand.soft - none.soft;
      const loudDelta = cand.loud - none.loud;
      console.log(
        `  ${mode} vs none: softΔ=${softDelta.toFixed(2)}dB loudΔ=${
          loudDelta.toFixed(2)
        }dB`,
      );
      if (Math.abs(softDelta) > SOFT_NONE_VS_BAKE_MAX_DB) {
        throw new Error(
          `midy(${mode}): soft level ${softDelta.toFixed(2)}dB vs none ` +
            `(cand=${cand.soft.toFixed(1)} none=${none.soft.toFixed(1)}; ` +
            `max |Δ|=${SOFT_NONE_VS_BAKE_MAX_DB}dB). ` +
            `Soft zone uses a lowpass near the fundamental — bake (TypedArray ` +
            `biquad) and realtime (BiquadFilterNode) should still match within ` +
            `${SOFT_NONE_VS_BAKE_MAX_DB}dB.`,
        );
      }
      if (Math.abs(loudDelta) > LOUD_NONE_VS_BAKE_MAX_DB) {
        throw new Error(
          `midy(${mode}): loud level ${loudDelta.toFixed(2)}dB vs none ` +
            `(cand=${cand.loud.toFixed(1)} none=${none.loud.toFixed(1)}; ` +
            `max |Δ|=${LOUD_NONE_VS_BAKE_MAX_DB}dB)`,
        );
      }
    }
  });
});
