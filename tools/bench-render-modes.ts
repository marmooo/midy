// Benchmark player.render() wall time for every cacheMode.
//
// Unlike bench-main-load (realtime playback ≈ song length), this measures how
// long OfflineAudioContext / worklet offline synthesis takes to produce a
// full AudioBuffer — the metric that differs by cacheMode.
//
// Requires Chromium (Puppeteer) and dist/midy.js.
//
// Usage:
//   deno run -A tools/bench-render-modes.ts \
//     --midi ./tools/field4a.mid \
//     --sf3 ./tools/GeneralUser_GS_v1.472.sf3
//
// Options:
//   --modes none,note,segment,chunk,worklet,audio   (default: all)
//   --runs 3                                        (default: 1)
//   --rate 48000
//   --out ./bench-logs/render-modes.json
//   --root-dir .
//   --harness-dir tools

// deno-lint-ignore-file no-import-prefix
import puppeteer from "npm:puppeteer@25.10.0";
import type { Browser, Page } from "npm:puppeteer@25.10.0";

const ALL_MODES = [
  "none",
  "note",
  "segment",
  "chunk",
  "worklet",
  "audio",
] as const;

type CacheMode = (typeof ALL_MODES)[number];

type RenderTiming = {
  cacheMode: string;
  loadSfMs: number;
  loadMidiMs: number;
  renderMs: number;
  totalMs: number;
  bufferDurationSec: number;
  sampleRate: number;
  frames: number;
  wallMs: number;
  error?: string;
};

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (key === "midi") {
        (multi.midi ??= []).push(next);
      } else {
        flags[key] = next;
      }
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, multi };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function serveDir(
  rootDir: string,
): Promise<{ url: string; close: () => void }> {
  const abs = await Deno.realPath(rootDir);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const u = new URL(req.url);
    let path = decodeURIComponent(u.pathname);
    if (path.endsWith("/")) path += "index.html";
    const filePath = `${abs}${path}`;
    try {
      const data = await Deno.readFile(filePath);
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const types: Record<string, string> = {
        html: "text/html",
        js: "text/javascript",
        mjs: "text/javascript",
        json: "application/json",
        wasm: "application/wasm",
      };
      return new Response(data, {
        headers: {
          "content-type": types[ext] ?? "application/octet-stream",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.shutdown(),
  };
}

function fmt(n: number | undefined, digits = 0): string {
  if (n === undefined || Number.isNaN(n)) return "-";
  return n.toFixed(digits);
}

function printTable(rows: RenderTiming[]) {
  const cols = [
    "cacheMode",
    "renderMs",
    "loadMidiMs",
    "totalMs",
    "bufferSec",
    "xRealtime",
    "wallMs",
    "error",
  ] as const;
  const cells = rows.map((r) => {
    const xrt = r.bufferDurationSec > 0
      ? r.renderMs / 1000 / r.bufferDurationSec
      : NaN;
    return {
      cacheMode: r.cacheMode,
      renderMs: fmt(r.renderMs, 0),
      loadMidiMs: fmt(r.loadMidiMs, 0),
      totalMs: fmt(r.totalMs, 0),
      bufferSec: fmt(r.bufferDurationSec, 1),
      xRealtime: fmt(xrt, 3),
      wallMs: fmt(r.wallMs, 0),
      error: r.error ?? "",
    };
  });
  const widths = cols.map((c) =>
    Math.max(c.length, ...cells.map((row) => String(row[c]).length))
  );
  const line = (vals: string[]) =>
    vals.map((v, i) => v.padStart(widths[i])).join("  ");
  console.log(line([...cols]));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of cells) {
    console.log(line(cols.map((c) => String(row[c]))));
  }
  console.log(
    "\nrenderMs = time to produce AudioBuffer (primary).",
  );
  console.log(
    "xRealtime = renderMs/bufferDuration (<1 faster than realtime).",
  );
  console.log(
    "audio mode: render runs inside loadMIDI — renderMs ≈ loadMidiMs.",
  );
}

async function runMode(
  page: Page,
  params: {
    midiBytesBase64: string;
    soundFontBytesBase64: string;
    cacheMode: CacheMode;
    sampleRate: number;
  },
): Promise<RenderTiming> {
  const t0 = performance.now();
  try {
    const result = await page.evaluate(
      async (p) => {
        // deno-lint-ignore no-explicit-any
        const fn = (globalThis as any).__renderMidyMode;
        if (typeof fn !== "function") {
          throw new Error("__renderMidyMode missing — check harness.html");
        }
        return await fn({ ...p, timingOnly: true });
      },
      params,
    ) as {
      cacheMode: string;
      loadSfMs: number;
      loadMidiMs: number;
      renderMs: number;
      totalMs: number;
      bufferDurationSec: number;
      sampleRate: number;
      frames: number;
    };
    return {
      ...result,
      wallMs: performance.now() - t0,
    };
  } catch (e) {
    return {
      cacheMode: params.cacheMode,
      loadSfMs: 0,
      loadMidiMs: 0,
      renderMs: 0,
      totalMs: 0,
      bufferDurationSec: 0,
      sampleRate: params.sampleRate,
      frames: 0,
      wallMs: performance.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main() {
  const { flags, multi } = parseArgs(Deno.args);
  if (flags.help || flags.h) {
    console.log(`Usage: deno run -A tools/bench-render-modes.ts \\
  --midi <path> [--midi <path> ...] \\
  --sf3 <path> | --sf2 <path> \\
  [--modes none,note,segment,chunk,worklet,audio] \\
  [--runs 1] [--rate 48000] \\
  [--out ./bench-logs/render-modes.json]`);
    Deno.exit(0);
  }

  const midiPaths = multi.midi ?? [];
  if (midiPaths.length === 0 && typeof flags.midi === "string") {
    midiPaths.push(flags.midi);
  }
  const sf = (flags.sf3 ?? flags.sf2) as string | undefined;
  if (midiPaths.length === 0 || !sf) {
    console.error("error: --midi and --sf3/--sf2 are required");
    Deno.exit(1);
  }

  const modes = (
    typeof flags.modes === "string"
      ? flags.modes.split(",").map((s) => s.trim())
      : [...ALL_MODES]
  ) as CacheMode[];
  const runs = Math.max(1, Number(flags.runs ?? 1) || 1);
  const sampleRate = Number(flags.rate ?? 48000) || 48000;
  const rootDir = String(flags["root-dir"] ?? ".");
  const harnessDir = String(flags["harness-dir"] ?? "tools");
  const outPath = typeof flags.out === "string" ? flags.out : null;

  const sfBytes = await Deno.readFile(sf);
  const sfBase64 = toBase64(sfBytes);

  const { url, close } = await serveDir(rootDir);
  let browser: Browser | null = null;
  const allResults: {
    midi: string;
    run: number;
    timings: RenderTiming[];
  }[] = [];

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-features=SharedArrayBuffer",
      ],
    });
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (t.includes("[midy-harness]") || t.includes("[midy]")) {
        console.log(`[browser] ${t}`);
      }
    });
    page.on("pageerror", (err) => console.error(`[browser error] ${err}`));
    await page.goto(`${url}/${harnessDir}/harness.html`, {
      waitUntil: "load",
    });

    for (const midiPath of midiPaths) {
      const midiBytes = await Deno.readFile(midiPath);
      const midiBase64 = toBase64(midiBytes);
      console.log(`\n=== MIDI ${midiPath} ===`);

      for (let run = 1; run <= runs; run++) {
        if (runs > 1) console.log(`--- run ${run}/${runs} ---`);
        const timings: RenderTiming[] = [];
        for (const cacheMode of modes) {
          console.log(`render ${cacheMode}...`);
          const row = await runMode(page, {
            midiBytesBase64: midiBase64,
            soundFontBytesBase64: sfBase64,
            cacheMode,
            sampleRate,
          });
          timings.push(row);
          if (row.error) {
            console.error(`  ERROR ${cacheMode}: ${row.error}`);
          } else {
            console.log(
              `  ${cacheMode}: renderMs=${row.renderMs.toFixed(0)} ` +
                `buffer=${row.bufferDurationSec.toFixed(1)}s`,
            );
          }
        }
        printTable(timings);
        allResults.push({ midi: midiPath, run, timings });
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    close();
  }

  if (outPath) {
    await Deno.mkdir(outPath.replace(/\/[^/]+$/, "") || ".", {
      recursive: true,
    }).catch(() => {});
    await Deno.writeTextFile(
      outPath,
      JSON.stringify(
        { when: new Date().toISOString(), results: allResults },
        null,
        2,
      ) +
        "\n",
    );
    console.log(`\nwrote ${outPath}`);
  }
}

if (import.meta.main) {
  await main();
}
