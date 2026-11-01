/**
 * Deno wrapper: runs the native bench binary produced by build.sh.
 *
 *   bash build.sh
 *   deno run --allow-run --allow-read test_native.ts
 */
const candidates = [
  new URL("./dist/synth_native", import.meta.url).pathname,
  "/tmp/synth_native",
];

let bin: string | null = null;
for (const p of candidates) {
  try {
    await Deno.stat(p);
    bin = p;
    break;
  } catch {
    /* try next */
  }
}

if (!bin) {
  console.error("synth_native not found. Run: bash build.sh");
  Deno.exit(1);
}

const cmd = new Deno.Command(bin, { stdout: "inherit", stderr: "inherit" });
const { code } = await cmd.output();
Deno.exit(code);
