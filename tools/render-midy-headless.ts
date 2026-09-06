// Drives tools/midy-harness.js inside a real headless browser (Puppeteer /
// Chromium) and saves the rendered WAV. midy depends on the real Web Audio
// API (AudioContext / OfflineAudioContext / GainNode / BiquadFilterNode),
// which Deno doesn't provide — a headless browser is the realistic way to
// get a spec-accurate render outside an actual browser tab.
//
// Requires: `deno run -A` (spawns Chromium as a subprocess, listens on a
// local port for the static server, and talks to Chromium over a
// websocket — hence -A rather than a narrower set of flags).
//
// Usage as a library:
//   import { renderMidyMode } from "./render-midy-headless.ts";
//   const wavBytes = await renderMidyMode({
//     harnessDir: "tools",
//     rootDir: ".", // must be a common ancestor of harnessDir and anything
//                   // it imports with a relative path (e.g. "../dist/midy.js")
//     midiPath: "/tmp/single-note.mid",
//     soundFontPath: "/path/to.sf2",
//     cacheMode: "segment",
//   });
//
// Usage as a CLI (run from your repo root, so relative imports resolve):
//   deno run -A tools/render-midy-headless.ts --harness-dir tools \
//     --midi /tmp/single-note.mid --sf2 /path/to.sf2 --mode segment \
//     --out /tmp/midy-segment.wav
import puppeteer from "npm:puppeteer";

export type CacheMode =
  | "none"
  | "ads"
  | "adsr"
  | "note"
  | "segment"
  | "chunk"
  | "audio";

export interface RenderMidyModeOptions {
  /** Directory containing harness.html + midy-harness.js, given as a path
   * relative to `rootDir` (e.g. "tools"). */
  harnessDir: string;
  /** Static-file server root. Needs to be a common ancestor of harnessDir
   * AND anything it imports with a relative path (e.g. "../dist/midy.js"),
   * so this is usually your repo root. Default: ".". */
  rootDir?: string;
  /** Path to the input .mid file. */
  midiPath: string;
  /** Path to the .sf2/.sf3 soundfont to load into midy. */
  soundFontPath: string;
  /** Which cacheMode to render — see render() in player.ts. */
  cacheMode: CacheMode;
  /** Must match the sample rate used for the reference (fluidsynth) render,
   * or the comparison won't be apples-to-apples. Default: 48000. */
  sampleRate?: number;
  /** Show the browser window instead of headless — handy for debugging a
   * harness that silently produces nothing. Default: false. */
  headed?: boolean;
  /** Use an existing Chrome/Chromium install instead of puppeteer's own
   * managed download (e.g. "/usr/bin/chromium", "/usr/bin/google-chrome").
   * Useful when `npx puppeteer browsers install chrome` isn't an option. */
  executablePath?: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Serve `dir` on an ephemeral local port; returns the base URL + a closer. */
function serveDir(dir: string): { url: string; close: () => void } {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      // Every page load makes browsers auto-request this; without a route
      // it's a harmless-but-noisy 404 forwarded through page.on("console").
      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }
      const path = url.pathname === "/" ? "/harness.html" : url.pathname;
      try {
        const data = await Deno.readFile(`${dir}${path}`);
        const contentType = path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".html")
          ? "text/html"
          : "application/octet-stream";
        return new Response(data, {
          headers: { "content-type": contentType },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://localhost:${addr.port}`,
    close: () => {
      server.shutdown();
    },
  };
}

/**
 * Render a single MIDI file through midy in a given cacheMode, inside a
 * real headless browser, and return the WAV bytes.
 */
export async function renderMidyMode(
  options: RenderMidyModeOptions,
): Promise<Uint8Array> {
  const rootDir = options.rootDir ?? ".";
  const { url, close } = serveDir(rootDir);
  const browser = await puppeteer.launch({
    headless: !options.headed,
    executablePath: options.executablePath,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => console.log(`[browser] ${msg.text()}`));
    page.on("pageerror", (err) => console.error(`[browser error] ${err}`));
    await page.goto(`${url}/${options.harnessDir}/harness.html`, {
      waitUntil: "load",
    });

    const midiBytes = await Deno.readFile(options.midiPath);
    const sf2Bytes = await Deno.readFile(options.soundFontPath);

    const wavBase64 = await page.evaluate(
      (params) => {
        // deno-lint-ignore no-explicit-any
        return (globalThis as any).__renderMidyMode(params);
      },
      {
        midiBytesBase64: toBase64(midiBytes),
        soundFontBytesBase64: toBase64(sf2Bytes),
        cacheMode: options.cacheMode,
        sampleRate: options.sampleRate ?? 48000,
      },
    );

    return fromBase64(wavBase64 as string);
  } finally {
    await browser.close();
    close();
  }
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
  if (!args["harness-dir"] || !args.midi || !args.sf2 || !args.out) {
    console.error(
      "usage: deno run -A tools/render-midy-headless.ts --harness-dir <dir> --midi <path> --sf2 <path> --mode <cacheMode> --out <path> [--root-dir .] [--rate 48000] [--headed]",
    );
    Deno.exit(1);
  }
  const wavBytes = await renderMidyMode({
    harnessDir: args["harness-dir"],
    rootDir: args["root-dir"],
    midiPath: args.midi,
    soundFontPath: args.sf2,
    cacheMode: (args.mode as CacheMode) ?? "segment",
    sampleRate: args.rate ? Number(args.rate) : undefined,
    headed: args.headed === "true",
    executablePath: args["executable-path"],
  });
  await Deno.writeFile(args.out, wavBytes);
  console.log(`wrote ${args.out}`);
}
