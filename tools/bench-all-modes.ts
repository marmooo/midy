// Run playback-load bench for every cacheMode (none/note/segment/chunk/worklet/audio).
//
// Thin wrapper around bench-main-load.ts + bench-configs.all-modes.json.
// Requires a real Chromium (puppeteer) — same as bench-main-load.
//
// Usage:
//   deno run -A tools/bench-all-modes.ts \
//     --midi ./tools/field4a.mid \
//     --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
//     --out-dir ./bench-logs/all-modes
//
// Optional passthrough (same as bench-main-load):
//   --bundle js|wasm|wasm-simd|...
//   --max-play-sec N
//   --midi-dir ./songs
//
// Why not Deno-only / OfflineAudioContext?
//   worklet needs a real AudioWorklet; npm:web-audio-api does not provide one.
//   This harness drives the browser build so all modes are comparable.

const configsPath = new URL("./bench-configs.all-modes.json", import.meta.url)
  .pathname;

const args = Deno.args.slice();
// Inject --configs if the caller did not pass one.
if (!args.some((a) => a === "--configs" || a.startsWith("--configs="))) {
  args.push("--configs", configsPath);
}

const benchMain = new URL("./bench-main-load.ts", import.meta.url).pathname;
const cmd = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", benchMain, ...args],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
