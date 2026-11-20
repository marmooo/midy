// Live notes must not be forced onto worklet when cacheMode is segment/chunk.
// WASM worklet historically ignored setVoiceParams, so live MPE pitch bend
// requires bufferSource (setDetune) unless cacheMode === "worklet".
//
// Usage:
//   deno test -A tests/live-worklet-routing_test.ts

import { assertEquals } from "./mock-shared.ts";
import { Player } from "../src/player.ts";
import { isAudioWorkletUsable } from "../src/worklet-engine.ts";

function makePlayer(): Player {
  return new Player(new AudioContext());
}

Deno.test("shouldRouteNoteToWorkletHybrid: live notes stay off worklet", () => {
  const player = makePlayer();
  player.cacheMode = "segment";
  const note = player.createNoteInstance(60, 100, 0);
  assertEquals(note.timelineIndex == null, true);
  // deno-lint-ignore no-explicit-any
  assertEquals((player as any).shouldRouteNoteToWorkletHybrid(note), false);
});

Deno.test("shouldRouteNoteToWorkletHybrid: timeline leftover can hybrid when worklet usable", () => {
  const player = makePlayer();
  player.cacheMode = "segment";
  const note = player.createNoteInstance(60, 100, 0);
  note.timelineIndex = 0;
  // deno-lint-ignore no-explicit-any
  const routed = (player as any).shouldRouteNoteToWorkletHybrid(note);
  // Deno's npm:web-audio-api typically has no AudioWorkletNode — then hybrid
  // is correctly false. In browsers with worklet, timeline leftovers route true.
  const expectHybrid = isAudioWorkletUsable(player.audioContext);
  assertEquals(routed, expectHybrid);
});

Deno.test("wasm processor source implements setVoiceParams via sc_voice_set_params", async () => {
  const text = await Deno.readTextFile(
    new URL("../src/worklet-processor-wasm.ts", import.meta.url),
  );
  assertEquals(text.includes("sc_voice_set_params"), true);
  // Must not be an empty case that only breaks.
  assertEquals(/case "setVoiceParams":\s*break;/.test(text), false);
  assertEquals(text.includes('case "setVoiceParams"'), true);
});

Deno.test("synth_core declares sc_voice_set_params", async () => {
  const header = await Deno.readTextFile(
    new URL("../wasm/synth_core.h", import.meta.url),
  );
  const src = await Deno.readTextFile(
    new URL("../wasm/synth_core.c", import.meta.url),
  );
  assertEquals(header.includes("sc_voice_set_params"), true);
  assertEquals(src.includes("void sc_voice_set_params"), true);
});

Deno.test("midy-GM2 source: live notes require cacheMode worklet", async () => {
  const text = await Deno.readTextFile(
    new URL("../src/midy-GM2.ts", import.meta.url),
  );
  // Must not force live → worklet for every non-none mode (Player override).
  assertEquals(text.includes('this.cacheMode !== "none"'), false);
  assertEquals(
    text.includes("note.timelineIndex == null") &&
      text.includes('this.cacheMode === "worklet"'),
    true,
  );
});

Deno.test("midy-GM2 updateChannelDetune updates worklet voices", async () => {
  const text = await Deno.readTextFile(
    new URL("../src/midy-GM2.ts", import.meta.url),
  );
  const start = text.indexOf("override updateChannelDetune");
  const body = text.slice(start, start + 1500);
  assertEquals(body.includes("workletVoiceId"), true);
  assertEquals(body.includes("setVoiceParams"), true);
});
