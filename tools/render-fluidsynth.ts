// Build a pinned fluidsynth from source (once, cached) and use its CLI to
// render a .mid file to .wav. fluidsynth's own DSP has changed across
// releases, so the version is pinned explicitly rather than relying on
// whatever `fluidsynth` happens to be on $PATH.
//
// Usage as a library:
//   import { ensureFluidsynthBinary, renderWithFluidsynth } from "./render-fluidsynth.ts";
//   const bin = await ensureFluidsynthBinary();
//   await renderWithFluidsynth({ fluidsynthBin: bin, sf2Path, midiPath, wavPath, sampleRate: 48000 });
//
// Usage as a CLI:
//   deno run -A tools/render-fluidsynth.ts --sf2 /path/to.sf2 \
//     --midi /tmp/single-note.mid --out /tmp/fluidsynth.wav --rate 48000

export interface EnsureFluidsynthOptions {
  /** Git tag to build. Default: "v2.6.0". */
  version?: string;
  /** Repo to clone. Default: the official FluidSynth repo. */
  repoUrl?: string;
  /** Where to clone/build/cache fluidsynth. Default: ".cache/fluidsynth". */
  cacheDir?: string;
  /** Force a rebuild even if a cached binary already exists. */
  forceRebuild?: boolean;
}

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  const command = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) {
    throw new Error(`command failed (${code}): ${cmd} ${args.join(" ")}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone + build fluidsynth at a pinned tag if it isn't already built under
 * `cacheDir`, then return the absolute path to the built `fluidsynth`
 * binary. Safe to call repeatedly — subsequent calls just reuse the cache.
 */
export async function ensureFluidsynthBinary(
  options: EnsureFluidsynthOptions = {},
): Promise<string> {
  const version = options.version ?? "v2.6.0";
  const repoUrl = options.repoUrl ??
    "https://github.com/FluidSynth/fluidsynth.git";
  const cacheDir = options.cacheDir ?? ".cache/fluidsynth";
  const repoDir = `${cacheDir}/${version}`;
  const binPath = `${repoDir}/build/src/fluidsynth`;

  if (!options.forceRebuild && await exists(binPath)) {
    return await Deno.realPath(binPath);
  }

  await Deno.mkdir(cacheDir, { recursive: true });
  if (!await exists(repoDir)) {
    await run("git", [
      "clone",
      "--recursive",
      repoUrl,
      repoDir,
    ]);
  }
  await run("git", ["checkout", version], repoDir);
  // `--recursive` at clone time doesn't refresh submodules after a
  // checkout of an already-cloned repo; keep it in sync just in case.
  await run("git", ["submodule", "update", "--init", "--recursive"], repoDir);
  await run("cmake", [
    "-S",
    ".",
    "-B",
    "build",
    "-DCMAKE_BUILD_TYPE=Release",
  ], repoDir);
  const cpuCount = navigator.hardwareConcurrency || 4;
  await run("cmake", [
    "--build",
    "build",
    "-j",
    String(cpuCount),
  ], repoDir);

  if (!await exists(binPath)) {
    throw new Error(
      `build finished but ${binPath} is missing — check the build output above`,
    );
  }
  return await Deno.realPath(binPath);
}

export interface RenderWithFluidsynthOptions {
  /** Path to the fluidsynth binary (e.g. from ensureFluidsynthBinary()). */
  fluidsynthBin: string;
  /** Path to a .sf2/.sf3 soundfont. */
  sf2Path: string;
  /** Path to the input .mid file. */
  midiPath: string;
  /** Path to write the rendered .wav file. */
  wavPath: string;
  /** Output sample rate. Must match whatever rate midy's OfflineAudioContext
   * renders at, or the comparison won't be apples-to-apples. Default: 48000. */
  sampleRate?: number;
  /** Disable the reverb unit (synth.reverb.active=0). Default: true — off,
   * so the comparison is of the dry per-voice signal, not the FX unit. */
  disableReverb?: boolean;
  /** Disable the chorus unit (synth.chorus.active=0). Default: true. */
  disableChorus?: boolean;
  /** Sample format for the rendered WAV. "float" avoids 16-bit quantization
   * noise, which matters when diffing against midy's Float32 AudioBuffer
   * output directly. Default: "float". */
  sampleFormat?: "16bits" | "float";
  /**
   * Master gain passed as `-o synth.gain=...`.
   *
   * FluidSynth's built-in default is 0.2 (about -14 dB). midy's Web Audio
   * masterVolume is unity (1.0). Comparing dry voice levels against that
   * default makes every midy render look ~14 dB hot even when per-voice
   * attenuation already matches. Default here is 1 so conformance tests
   * compare DSP at the same master scale. Pass 0.2 only when you want the
   * stock FluidSynth listening level.
   */
  gain?: number;
  /** Extra raw CLI args appended after the built-in ones. */
  extraArgs?: string[];
}

/** Render a MIDI file to WAV via the fluidsynth CLI (non-interactive, "-ni"). */
export async function renderWithFluidsynth(
  options: RenderWithFluidsynthOptions,
): Promise<void> {
  const sampleRate = options.sampleRate ?? 48000;
  const disableReverb = options.disableReverb ?? true;
  const disableChorus = options.disableChorus ?? true;
  const sampleFormat = options.sampleFormat ?? "float";
  // Unity gain by default — see RenderWithFluidsynthOptions.gain.
  const gain = options.gain ?? 1;

  const args = ["-ni"];
  if (disableReverb) args.push("-o", "synth.reverb.active=0");
  if (disableChorus) args.push("-o", "synth.chorus.active=0");
  args.push("-o", `synth.gain=${gain}`);
  args.push("-o", `audio.file.format=${sampleFormat}`);
  args.push("-F", options.wavPath, "-r", String(sampleRate));
  if (options.extraArgs) args.push(...options.extraArgs);
  args.push(options.sf2Path, options.midiPath);

  await run(options.fluidsynthBin, args);
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
  if (!args.sf2 || !args.midi || !args.out) {
    console.error(
      "usage: deno run -A tools/render-fluidsynth.ts --sf2 <path> --midi <path> --out <path> [--rate 48000] [--version v2.6.0]",
    );
    Deno.exit(1);
  }
  const bin = await ensureFluidsynthBinary({ version: args.version });
  await renderWithFluidsynth({
    fluidsynthBin: bin,
    sf2Path: args.sf2,
    midiPath: args.midi,
    wavPath: args.out,
    sampleRate: args.rate ? Number(args.rate) : undefined,
  });
  console.log(`wrote ${args.out}`);
}
