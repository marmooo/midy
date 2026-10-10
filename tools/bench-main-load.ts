// Batch realtime main-load benchmark for midy.
//
// Spawns headless Chromium (Puppeteer), plays each MIDI with configurable
// Midy properties, and writes the FULL browser console log to disk.
// Primary output is raw logs (same style as manual browser debugging),
// not CSV — re-parse later if you want tables.
//
// Requires: deno run -A  (Chromium subprocess + local static server)
//
// Examples:
//   # Single run with inline --set
//   deno run -A tools/bench-main-load.ts \
//     --midi ./songs/foo.mid \
//     --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
//     --set cacheMode=chunk \
//     --set preferWorkerMixDuringLive=true \
//     --set debug=true \
//     --out-dir ./bench-logs
//
//   # Multiple configs from JSON + one or more MIDIs
//   deno run -A tools/bench-main-load.ts \
//     --midi-dir ./songs \
//     --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
//     --configs ./tools/bench-configs.example.json \
//     --out-dir ./bench-logs
//
//   # Multiple MIDIs explicitly
//   deno run -A tools/bench-main-load.ts \
//     --midi a.mid --midi b.mid \
//     --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
//     --configs ./tools/bench-configs.example.json \
//     --out-dir ./bench-logs

// deno-lint-ignore-file no-import-prefix
import puppeteer from "npm:puppeteer@25.10.0";
import type { Browser, Page } from "npm:puppeteer@25.10.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchConfig {
  /** Short name used in log filenames (e.g. "baseline"). */
  name: string;
  /** Arbitrary Midy instance properties applied after construction. */
  set: Record<string, unknown>;
}

export interface BenchRunOptions {
  harnessDir?: string;
  rootDir?: string;
  midiPaths: string[];
  soundFontPath: string;
  configs: BenchConfig[];
  outDir: string;
  sampleRate?: number;
  /** Hard cap on play duration in seconds (default: totalTime + 5). */
  maxPlaySec?: number;
  headed?: boolean;
  executablePath?: string;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
  flags: Record<string, string>;
  sets: string[];
  midis: string[];
} {
  const flags: Record<string, string> = {};
  const sets: string[] = [];
  const midis: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (key === "set" && next !== undefined && !next.startsWith("--")) {
      sets.push(next);
      i++;
      continue;
    }
    if (key === "midi" && next !== undefined && !next.startsWith("--")) {
      midis.push(next);
      i++;
      continue;
    }
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return { flags, sets, midis };
}

/** Parse "key=value" with loose typing (bool / number / string / JSON). */
export function parseSetValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw === "undefined") return undefined;
  // number?
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // JSON object/array/string
  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through
    }
  }
  return raw;
}

export function parseSetPair(pair: string): { key: string; value: unknown } {
  const eq = pair.indexOf("=");
  if (eq <= 0) {
    throw new Error(`invalid --set (expected key=value): ${pair}`);
  }
  return {
    key: pair.slice(0, eq),
    value: parseSetValue(pair.slice(eq + 1)),
  };
}

async function loadConfigs(
  flags: Record<string, string>,
  sets: string[],
): Promise<BenchConfig[]> {
  if (flags.configs) {
    const text = await Deno.readTextFile(flags.configs);
    const parsed = JSON.parse(text) as BenchConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`--configs must be a non-empty JSON array`);
    }
    for (const c of parsed) {
      if (!c.name || typeof c.set !== "object") {
        throw new Error(
          `each config needs { "name": string, "set": object }`,
        );
      }
    }
    return parsed;
  }

  // Inline --set → single config named "run"
  const set: Record<string, unknown> = {};
  for (const pair of sets) {
    const { key, value } = parseSetPair(pair);
    set[key] = value;
  }
  if (!set.cacheMode) set.cacheMode = "chunk";
  if (set.debug === undefined) set.debug = true;
  return [{ name: flags.name ?? "run", set }];
}

async function collectMidiPaths(
  flags: Record<string, string>,
  midis: string[],
): Promise<string[]> {
  const paths = [...midis];
  if (flags.midi) paths.push(flags.midi);
  if (flags["midi-dir"]) {
    for await (const entry of Deno.readDir(flags["midi-dir"])) {
      if (!entry.isFile) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".mid") || lower.endsWith(".midi")) {
        paths.push(`${flags["midi-dir"].replace(/\/$/, "")}/${entry.name}`);
      }
    }
  }
  // de-dupe, stable order
  return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// Browser helpers (simplified from render-midy-headless.ts)
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function serveDir(dir: string): { url: string; close: () => void } {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }
      const path = url.pathname === "/" ? "/bench-harness.html" : url.pathname;
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

const CHROME_LAUNCH_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--mute-audio",
];

async function launchBrowser(opts: {
  headed?: boolean;
  executablePath?: string;
  /** CDP protocolTimeout (ms). Must cover full song wall time inside page.evaluate. */
  protocolTimeoutMs?: number;
}): Promise<Browser> {
  return await puppeteer.launch({
    headless: !opts.headed,
    executablePath: opts.executablePath,
    // Default 10 min: a 175s song + preroll easily exceeds the old 120s limit
    // and aborts page.evaluate with Runtime.callFunctionOn timed out.
    protocolTimeout: opts.protocolTimeoutMs ?? 600_000,
    args: CHROME_LAUNCH_ARGS,
  });
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

export async function runBench(options: BenchRunOptions): Promise<void> {
  const harnessDir = options.harnessDir ?? "tools";
  const rootDir = options.rootDir ?? ".";
  const sampleRate = options.sampleRate ?? 48000;

  await Deno.mkdir(options.outDir, { recursive: true });

  const sf2Bytes = await Deno.readFile(options.soundFontPath);
  const sf2Base64 = toBase64(sf2Bytes);

  const { url, close } = serveDir(rootDir);
  // page.evaluate runs the entire song; protocolTimeout must exceed wall time.
  const protocolTimeoutMs = Math.max(
    600_000,
    ((options.maxPlaySec ?? 300) + 120) * 1000,
  );
  const browser = await launchBrowser({
    headed: options.headed,
    executablePath: options.executablePath,
    protocolTimeoutMs,
  });

  const manifest: Array<Record<string, unknown>> = [];

  try {
    for (const midiPath of options.midiPaths) {
      const midiBytes = await Deno.readFile(midiPath);
      const midiBase64 = toBase64(midiBytes);
      const midiLabel = safeName(
        midiPath.split("/").pop()?.replace(/\.(mid|midi)$/i, "") ?? "song",
      );

      for (const config of options.configs) {
        const runId = `${midiLabel}__${safeName(config.name)}`;
        const logPath = `${options.outDir}/${runId}.log`;
        const lines: string[] = [];
        const push = (line: string) => {
          lines.push(line);
          console.log(line);
        };

        push(`[bench-host] === ${runId} ===`);
        push(`[bench-host] midi=${midiPath}`);
        push(`[bench-host] config=${config.name}`);
        push(`[bench-host] settings=${JSON.stringify(config.set)}`);

        const page: Page = await browser.newPage();
        page.on("console", (msg) => {
          const text = msg.text();
          const entry = `[browser:${msg.type()}] ${text}`;
          lines.push(entry);
          // Also mirror to host stdout for live watching
          console.log(entry);
        });
        page.on("pageerror", (err) => {
          const entry = `[browser:pageerror] ${err}`;
          lines.push(entry);
          console.error(entry);
        });

        let result: Record<string, unknown> | null = null;
        const t0 = performance.now();
        try {
          await page.goto(`${url}/${harnessDir}/bench-harness.html`, {
            waitUntil: "load",
            timeout: 60_000,
          });

          // Wait until the module has exposed the entry point.
          await page.waitForFunction(
            () => typeof (globalThis as any).__benchMainLoad === "function",
            { timeout: 30_000 },
          );

          result = await page.evaluate(
            async (params) => {
              return await (globalThis as any).__benchMainLoad(params);
            },
            {
              midiBytesBase64: midiBase64,
              soundFontBytesBase64: sf2Base64,
              sampleRate,
              settings: config.set,
              maxPlaySec: options.maxPlaySec,
            },
          ) as Record<string, unknown>;

          push(
            `[bench-host] result=${JSON.stringify(result)} ` +
              `wallMs=${(performance.now() - t0).toFixed(0)}`,
          );
        } catch (err) {
          push(`[bench-host] ERROR ${err}`);
        } finally {
          await page.close().catch(() => {});
        }

        await Deno.writeTextFile(logPath, lines.join("\n") + "\n");
        push(`[bench-host] wrote ${logPath}`);

        manifest.push({
          runId,
          midiPath,
          config: config.name,
          settings: config.set,
          logPath,
          result,
          wallMs: performance.now() - t0,
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
    close();
  }

  const manifestPath = `${options.outDir}/manifest.json`;
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`[bench-host] wrote ${manifestPath}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error(`usage:
  deno run -A tools/bench-main-load.ts \\
    --midi <path> [--midi <path> ...] \\
    --sf3 <path> | --sf2 <path> \\
    [--configs <json>] \\
    [--set key=value ...] \\
    [--out-dir ./bench-logs] \\
    [--root-dir .] [--harness-dir tools] \\
    [--rate 48000] [--max-play-sec 300] \\
    [--headed] [--executable-path /usr/bin/chromium]

Primary output: raw browser console logs under --out-dir (one file per song×config).
Also writes manifest.json with run metadata.

--set examples:
  --set cacheMode=chunk
  --set preferWorkerMixDuringLive=true
  --set maxTiledNoteDuration=16
  --set simpleNoteCacheMaxSize=4096

--configs: JSON array of { "name": string, "set": { ... } }
  see tools/bench-configs.example.json
`);
}

if (import.meta.main) {
  const { flags, sets, midis } = parseArgs(Deno.args);
  const sf = flags.sf3 ?? flags.sf2;
  if (!sf) {
    printUsage();
    Deno.exit(1);
  }

  const midiPaths = await collectMidiPaths(flags, midis);
  if (midiPaths.length === 0) {
    console.error("error: provide --midi and/or --midi-dir");
    printUsage();
    Deno.exit(1);
  }

  const configs = await loadConfigs(flags, sets);
  const outDir = flags["out-dir"] ?? "./bench-logs";

  await runBench({
    harnessDir: flags["harness-dir"] ?? "tools",
    rootDir: flags["root-dir"] ?? ".",
    midiPaths,
    soundFontPath: sf,
    configs,
    outDir,
    sampleRate: flags.rate ? Number(flags.rate) : 48000,
    maxPlaySec: flags["max-play-sec"]
      ? Number(flags["max-play-sec"])
      : undefined,
    headed: flags.headed === "true",
    executablePath: flags["executable-path"],
  });
}
