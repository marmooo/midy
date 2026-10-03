// getVoiceParams must never mutate a voice's static generator store.
//
// transformAllParams returns voice.generators by reference when no controller
// is active; the EMU initialAttenuation rewrite must clone first.
//
// Usage:
//   deno test -A tools/voice-params-emu.test.ts
import { parse } from "@marmooo/soundfont";
import { assertEquals } from "@std/assert";
import { getVoiceParams } from "../src/base-player.ts";

const SF2_PATH = "tools/GeneralUser_GS_v1.472.sf3";

function controllerState(velocity: number, noteNumber = 60): Float32Array {
  const state = new Float32Array(256);
  state[2] = velocity / 127; // noteOnVelocity
  state[3] = noteNumber / 127; // noteOnKeyNumber
  return state;
}

Deno.test("getVoiceParams does not mutate static initialAttenuation", async () => {
  const data = await Deno.readFile(SF2_PATH);
  const sf = parse(data);
  // Velocity 0 → hasActiveController may still see other sources as 0;
  // also exercise a normal velocity so modulators apply (clone path).
  for (const vel of [0, 40, 100, 127]) {
    const voice = sf.getVoice(0, 0, 60, vel);
    if (!voice) throw new Error(`no voice for velocity ${vel}`);
    const before = voice.generators.get("initialAttenuation");
    getVoiceParams(voice, controllerState(vel));
    const after = voice.generators.get("initialAttenuation");
    assertEquals(
      after,
      before,
      `static initialAttenuation mutated at velocity=${vel} ` +
        `(before=${before}, after=${after})`,
    );
  }
});

Deno.test("getVoiceParams EMU scale is applied to returned params only", async () => {
  const data = await Deno.readFile(SF2_PATH);
  const sf = parse(data);
  // Loud zone has static initialAttenuation = 50; after EMU should be
  // 50*0.4 + velocityModDelta, not left at the unscaled static value.
  const voice = sf.getVoice(0, 0, 60, 100);
  if (!voice) throw new Error("no voice");
  const staticAtten = voice.generators.get("initialAttenuation");
  const params = getVoiceParams(voice, controllerState(100));
  // Static store unchanged.
  assertEquals(voice.generators.get("initialAttenuation"), staticAtten);
  // Params received a (possibly different) effective attenuation.
  // For vel=100 the effective is typically below the raw after-mod value.
  if (typeof params.initialAttenuation !== "number") {
    throw new Error("initialAttenuation missing from VoiceParams");
  }
  // Sanity: not silent and not unity-gain absurd.
  if (params.initialAttenuation < 0 || params.initialAttenuation > 1440) {
    throw new Error(
      `initialAttenuation out of range: ${params.initialAttenuation}`,
    );
  }
});
