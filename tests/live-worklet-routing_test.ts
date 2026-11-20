// segment/chunk live residual → worklet; note/none → bufferSource.
// Pitch bend on worklet requires updateChannelDetune → setVoiceParams.
//
// Usage:
//   deno test -A tests/live-worklet-routing_test.ts

import { assertEquals } from "./mock-shared.ts";
import { Player } from "../src/player.ts";
import { isAudioWorkletUsable } from "../src/worklet-engine.ts";
import { isTiledCacheMode } from "../src/cache-strategy.ts";

function makePlayer(): Player {
  return new Player(new AudioContext());
}

Deno.test("live residual modes: segment/chunk/worklet use worklet path predicate", () => {
  // Policy helper mirrors setNoteAudioNode live branch.
  function liveUsesWorklet(cacheMode: string): boolean {
    return cacheMode === "worklet" || isTiledCacheMode(cacheMode as never);
  }
  assertEquals(liveUsesWorklet("worklet"), true);
  assertEquals(liveUsesWorklet("segment"), true);
  assertEquals(liveUsesWorklet("chunk"), true);
  assertEquals(liveUsesWorklet("none"), false);
  assertEquals(liveUsesWorklet("note"), false);
  assertEquals(liveUsesWorklet("audio"), false);
});

Deno.test("shouldRouteNoteToWorkletHybrid: live notes are not hybrid", () => {
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
  const expectHybrid = isAudioWorkletUsable(player.audioContext);
  assertEquals(routed, expectHybrid);
});

Deno.test("player source: live residual routes tiled modes to worklet", async () => {
  const text = await Deno.readTextFile(
    new URL("../src/player.ts", import.meta.url),
  );
  const start = text.indexOf("Live MIDI (no timeline index) residual path");
  assertEquals(start >= 0, true);
  const body = text.slice(start, start + 800);
  assertEquals(body.includes("isTiledCacheMode(this.cacheMode)"), true);
  assertEquals(body.includes('cacheMode === "worklet"'), true);
  // Must not use the old "any non-none" force.
  assertEquals(body.includes('cacheMode !== "none"'), false);
});

Deno.test("midy-GM2 source: live residual matches Player policy", async () => {
  const text = await Deno.readTextFile(
    new URL("../src/midy-GM2.ts", import.meta.url),
  );
  const start = text.indexOf("Live MIDI residual");
  assertEquals(start >= 0, true);
  const body = text.slice(start, start + 600);
  assertEquals(body.includes("isTiledCacheMode(this.cacheMode)"), true);
  assertEquals(text.includes('this.cacheMode !== "none"'), false);
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

Deno.test("wasm processor source implements setVoiceParams via sc_voice_set_params", async () => {
  const text = await Deno.readTextFile(
    new URL("../src/worklet-processor-wasm.ts", import.meta.url),
  );
  assertEquals(text.includes("sc_voice_set_params"), true);
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
