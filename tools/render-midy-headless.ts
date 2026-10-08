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

// deno-lint-ignore-file no-import-prefix
import puppeteer from "npm:puppeteer@25.10.0";

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
  /** Enable almost-simple pitch-bend TypedArray path for this render. */
  useAlmostSimplePitchBend?: boolean;
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

/** Launch args that keep Chromium stable under sequential test load. */
const CHROME_LAUNCH_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // Avoid /dev/shm exhaustion when many headless Chromes are launched
  // back-to-back (common flake: "Timed out waiting for the WS endpoint").
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--mute-audio",
];

const LAUNCH_TIMEOUT_MS = 60_000;
const LAUNCH_RETRIES = 3;

/** Set MIDY_NO_BROWSER_REUSE=1 to force a fresh Chrome per render (debug). */
const REUSE_BROWSER = Deno.env.get("MIDY_NO_BROWSER_REUSE") !== "1";

/**
 * Cross-process state so parallel `deno test` workers share ONE Chrome.
 * Without this, each test file launches its own browser and processes pile up.
 */
const STATE_DIR = Deno.env.get("MIDY_CHROME_STATE_DIR") ??
  "/tmp/midy-chrome-state";
const LOCK_PATH = `${STATE_DIR}/render.lock`;
const WS_PATH = `${STATE_DIR}/ws-endpoint`;
const CHROME_PID_PATH = `${STATE_DIR}/chrome.pid`;
const OWNER_PID_PATH = `${STATE_DIR}/owner.pid`;

function isLaunchTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    err.name === "TimeoutError" ||
    msg.includes("Timed out after") ||
    msg.includes("WS endpoint") ||
    msg.includes("Failed to launch")
  );
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    Deno.kill(pid, "SIGCONT"); // no-op signal probe; throws if gone
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(path: string): Promise<number | null> {
  try {
    const text = (await Deno.readTextFile(path)).trim();
    const pid = Number(text);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Kill a process group/tree best-effort (Chrome spawns many children). */
function forceKillPid(pid: number, label: string): void {
  if (!isPidAlive(pid)) return;
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
  // Brief wait then SIGKILL if still up.
  try {
    // Synchronous short spin — avoid async in signal paths.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && isPidAlive(pid)) {
      // spin
    }
    if (isPidAlive(pid)) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  if (isPidAlive(pid)) {
    console.warn(
      `[render-midy-headless] ${label} pid=${pid} still alive after SIGKILL`,
    );
  }
}

async function launchBrowser(
  options: RenderMidyModeOptions,
): Promise<Awaited<ReturnType<typeof puppeteer.launch>>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LAUNCH_RETRIES; attempt++) {
    try {
      return await puppeteer.launch({
        headless: !options.headed,
        executablePath: options.executablePath,
        timeout: LAUNCH_TIMEOUT_MS,
        protocolTimeout: LAUNCH_TIMEOUT_MS,
        // We handle signals ourselves so Chrome is not left orphaned when
        // the Deno test runner is interrupted.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: CHROME_LAUNCH_ARGS,
      });
    } catch (err) {
      lastErr = err;
      if (!isLaunchTimeout(err) || attempt === LAUNCH_RETRIES) throw err;
      const delayMs = 500 * attempt;
      console.warn(
        `[render-midy-headless] Chrome launch timed out ` +
          `(attempt ${attempt}/${LAUNCH_RETRIES}); retrying in ${delayMs}ms…`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Cross-process render lock + single shared Chrome
// ---------------------------------------------------------------------------

type PuppeteerBrowser = Awaited<ReturnType<typeof puppeteer.launch>>;
type PuppeteerPage = Awaited<ReturnType<PuppeteerBrowser["newPage"]>>;

interface SharedSession {
  rootDir: string;
  harnessDir: string;
  url: string;
  closeServer: () => void;
  browser: PuppeteerBrowser;
  page: PuppeteerPage;
  /** True when this process launched Chrome (must close it on exit). */
  ownsBrowser: boolean;
  chromePid: number | null;
}

let sharedSession: SharedSession | null = null;
/** In-process queue so concurrent tests in one worker don't interleave. */
let sharedSessionLock: Promise<void> = Promise.resolve();
let cleanupHandlersInstalled = false;

/** In-process cache of SF2 base64 (same GeneralUser file for every test). */
const sf2Base64Cache = new Map<string, string>();

async function getSf2Base64(path: string): Promise<string> {
  let cached = sf2Base64Cache.get(path);
  if (cached) return cached;
  const bytes = await Deno.readFile(path);
  cached = toBase64(bytes);
  sf2Base64Cache.set(path, cached);
  return cached;
}

/**
 * Exclusive file lock shared by all Deno test workers.
 * Recovers stale locks left by killed processes.
 */
async function acquireGlobalLock(): Promise<() => Promise<void>> {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  const deadline = Date.now() + 600_000; // 10 min max wait
  while (Date.now() < deadline) {
    try {
      const f = await Deno.open(LOCK_PATH, { createNew: true, write: true });
      await f.write(new TextEncoder().encode(`${Deno.pid}\n`));
      f.close();
      return async () => {
        try {
          await Deno.remove(LOCK_PATH);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
      const holder = await readPidFile(LOCK_PATH);
      if (holder !== null && !isPidAlive(holder)) {
        console.warn(
          `[render-midy-headless] removing stale render.lock ` +
            `(dead pid=${holder})`,
        );
        try {
          await Deno.remove(LOCK_PATH);
        } catch {
          // race with another worker
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(
    `[render-midy-headless] timed out waiting for render.lock in ${STATE_DIR}`,
  );
}

async function clearBrowserStateFiles(): Promise<void> {
  for (const p of [WS_PATH, CHROME_PID_PATH, OWNER_PID_PATH]) {
    try {
      await Deno.remove(p);
    } catch {
      // ignore
    }
  }
}

async function connectOrLaunchBrowser(
  options: RenderMidyModeOptions,
): Promise<
  { browser: PuppeteerBrowser; ownsBrowser: boolean; chromePid: number | null }
> {
  // Try existing endpoint first.
  try {
    const ws = (await Deno.readTextFile(WS_PATH)).trim();
    const chromePid = await readPidFile(CHROME_PID_PATH);
    if (ws && (chromePid === null || isPidAlive(chromePid))) {
      const browser = await puppeteer.connect({
        browserWSEndpoint: ws,
        protocolTimeout: LAUNCH_TIMEOUT_MS,
      });
      return { browser, ownsBrowser: false, chromePid };
    }
  } catch {
    // fall through to launch
  }

  // Stale state — drop and launch.
  await clearBrowserStateFiles();
  const browser = await launchBrowser(options);
  const ws = browser.wsEndpoint();
  const proc = browser.process();
  const chromePid = proc?.pid ?? null;
  await Deno.writeTextFile(WS_PATH, ws);
  if (chromePid != null) {
    await Deno.writeTextFile(CHROME_PID_PATH, `${chromePid}\n`);
  }
  await Deno.writeTextFile(OWNER_PID_PATH, `${Deno.pid}\n`);
  return { browser, ownsBrowser: true, chromePid };
}

async function acquireSession(
  options: RenderMidyModeOptions,
): Promise<SharedSession> {
  const rootDir = options.rootDir ?? ".";

  if (
    REUSE_BROWSER &&
    sharedSession &&
    sharedSession.rootDir === rootDir &&
    sharedSession.harnessDir === options.harnessDir
  ) {
    try {
      await sharedSession.page.evaluate(() => true);
      return sharedSession;
    } catch {
      console.warn(
        "[render-midy-headless] shared page died; reconnecting…",
      );
      await disposeSharedSession({ killChrome: false });
    }
  }

  if (sharedSession) {
    await disposeSharedSession({ killChrome: false });
  }

  const { url, close } = serveDir(rootDir);
  const { browser, ownsBrowser, chromePid } = await connectOrLaunchBrowser(
    options,
  );
  const page = await browser.newPage();
  page.on("console", (msg) => console.log(`[browser] ${msg.text()}`));
  page.on("pageerror", (err) => console.error(`[browser error] ${err}`));
  await page.goto(`${url}/${options.harnessDir}/harness.html`, {
    waitUntil: "load",
  });

  sharedSession = {
    rootDir,
    harnessDir: options.harnessDir,
    url,
    closeServer: close,
    browser,
    page,
    ownsBrowser,
    chromePid,
  };
  return sharedSession;
}

async function disposeSharedSession(
  opts: { killChrome: boolean } = { killChrome: true },
): Promise<void> {
  const s = sharedSession;
  sharedSession = null;
  if (!s) {
    if (opts.killChrome) await shutdownGlobalChrome();
    return;
  }

  try {
    await s.page.close().catch(() => {});
  } catch {
    // ignore
  }

  if (s.ownsBrowser && opts.killChrome) {
    try {
      await s.browser.close();
    } catch (closeErr) {
      console.warn(
        `[render-midy-headless] browser.close() failed: ${closeErr}`,
      );
    }
    if (s.chromePid != null) forceKillPid(s.chromePid, "chrome");
    await clearBrowserStateFiles();
  } else {
    // Connected client: disconnect without killing the shared Chrome.
    try {
      s.browser.disconnect();
    } catch {
      // ignore
    }
  }

  try {
    s.closeServer();
  } catch {
    // already shut down
  }
}

/** Kill the process-global Chrome recorded in state files (any worker). */
async function shutdownGlobalChrome(): Promise<void> {
  const chromePid = await readPidFile(CHROME_PID_PATH);
  const ownerPid = await readPidFile(OWNER_PID_PATH);
  if (chromePid != null) forceKillPid(chromePid, "chrome");
  // If we are the owner process still alive, nothing else to do.
  if (ownerPid != null && ownerPid !== Deno.pid && isPidAlive(ownerPid)) {
    // Owner still running — only kill chrome, leave ownership files for it
    // unless chrome is dead.
    if (chromePid != null && !isPidAlive(chromePid)) {
      await clearBrowserStateFiles();
    }
    return;
  }
  await clearBrowserStateFiles();
}

/** Close the shared Chrome session (call from test teardown if desired). */
export async function closeSharedBrowser(): Promise<void> {
  await sharedSessionLock;
  await disposeSharedSession({ killChrome: true });
}

function installCleanupHandlers(): void {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;

  const cleanup = () => {
    // Sync best-effort path for signal handlers.
    try {
      const s = sharedSession;
      sharedSession = null;
      if (s?.ownsBrowser) {
        try {
          s.browser.close();
        } catch {
          // ignore
        }
        if (s.chromePid != null) forceKillPid(s.chromePid, "chrome");
      }
    } catch {
      // ignore
    }
    try {
      const text = Deno.readTextFileSync(CHROME_PID_PATH).trim();
      const pid = Number(text);
      if (Number.isFinite(pid)) forceKillPid(pid, "chrome");
    } catch {
      // no pid file
    }
    for (const p of [LOCK_PATH, WS_PATH, CHROME_PID_PATH, OWNER_PID_PATH]) {
      try {
        Deno.removeSync(p);
      } catch {
        // ignore
      }
    }
  };

  // unload fires on normal process exit.
  globalThis.addEventListener("unload", cleanup);

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        console.warn(
          `[render-midy-headless] ${sig} — shutting down Chrome…`,
        );
        cleanup();
        // Let the runtime abort after cleanup; re-raise by exiting.
        Deno.exit(130);
      });
    } catch {
      // Signal may be unavailable (Windows / restricted env).
    }
  }
}

function parseRenderResult(
  result: string | {
    wavBase64: string;
    useAlmostSimplePitchBend?: boolean;
    cacheMode?: string;
  },
  options: RenderMidyModeOptions,
): Uint8Array {
  let wavBase64: string;
  if (typeof result === "string") {
    wavBase64 = result;
    if (options.useAlmostSimplePitchBend != null) {
      console.warn(
        "[render-midy-headless] harness returned bare base64; " +
          "cannot verify useAlmostSimplePitchBend was applied. " +
          "Update tools/midy-harness.js.",
      );
    }
  } else {
    wavBase64 = result.wavBase64;
    if (options.useAlmostSimplePitchBend != null) {
      const actual = !!result.useAlmostSimplePitchBend;
      const requested = !!options.useAlmostSimplePitchBend;
      console.log(
        `[render-midy-headless] useAlmostSimplePitchBend ` +
          `requested=${requested} actual=${actual} mode=${options.cacheMode}`,
      );
      if (actual !== requested) {
        throw new Error(
          `useAlmostSimplePitchBend mismatch: requested=${requested} ` +
            `actual=${actual}. Rebuild dist/midy.js and ensure harness sets the flag.`,
        );
      }
    }
  }
  return fromBase64(wavBase64);
}

/**
 * Render a single MIDI file through midy in a given cacheMode, inside a
 * real headless browser, and return the WAV bytes.
 *
 * By default reuses one Chrome across renders AND across parallel Deno test
 * workers (file lock + shared WebSocket endpoint). Set MIDY_NO_BROWSER_REUSE=1
 * for a fresh Chrome per render (debug).
 */
export async function renderMidyMode(
  options: RenderMidyModeOptions,
): Promise<Uint8Array> {
  installCleanupHandlers();

  // In-process queue.
  let releaseLocal!: () => void;
  const prev = sharedSessionLock;
  sharedSessionLock = new Promise<void>((r) => {
    releaseLocal = r;
  });
  await prev;

  // Cross-process lock (parallel test files).
  let releaseGlobal: (() => Promise<void>) | null = null;
  if (REUSE_BROWSER) {
    releaseGlobal = await acquireGlobalLock();
  }

  try {
    if (!REUSE_BROWSER) {
      const rootDir = options.rootDir ?? ".";
      const { url, close } = serveDir(rootDir);
      const browser = await launchBrowser(options);
      const chromePid = browser.process()?.pid ?? null;
      try {
        const page = await browser.newPage();
        page.on("console", (msg) => console.log(`[browser] ${msg.text()}`));
        page.on("pageerror", (err) => console.error(`[browser error] ${err}`));
        await page.goto(`${url}/${options.harnessDir}/harness.html`, {
          waitUntil: "load",
        });
        const midiBytes = await Deno.readFile(options.midiPath);
        const result = await page.evaluate(
          (params) => {
            // deno-lint-ignore no-explicit-any
            return (globalThis as any).__renderMidyMode(params);
          },
          {
            midiBytesBase64: toBase64(midiBytes),
            soundFontBytesBase64: await getSf2Base64(options.soundFontPath),
            cacheMode: options.cacheMode,
            sampleRate: options.sampleRate ?? 48000,
            useAlmostSimplePitchBend: options.useAlmostSimplePitchBend,
          },
        ) as string | {
          wavBase64: string;
          useAlmostSimplePitchBend?: boolean;
          cacheMode?: string;
        };
        return parseRenderResult(result, options);
      } finally {
        try {
          await browser.close();
        } catch (closeErr) {
          console.warn(
            `[render-midy-headless] browser.close() failed: ${closeErr}`,
          );
        }
        if (chromePid != null) forceKillPid(chromePid, "chrome");
        close();
      }
    }

    const session = await acquireSession(options);
    const midiBytes = await Deno.readFile(options.midiPath);
    const result = await session.page.evaluate(
      (params) => {
        // deno-lint-ignore no-explicit-any
        return (globalThis as any).__renderMidyMode(params);
      },
      {
        midiBytesBase64: toBase64(midiBytes),
        soundFontBytesBase64: await getSf2Base64(options.soundFontPath),
        cacheMode: options.cacheMode,
        sampleRate: options.sampleRate ?? 48000,
        useAlmostSimplePitchBend: options.useAlmostSimplePitchBend,
      },
    ) as string | {
      wavBase64: string;
      useAlmostSimplePitchBend?: boolean;
      cacheMode?: string;
    };
    return parseRenderResult(result, options);
  } finally {
    if (releaseGlobal) await releaseGlobal();
    releaseLocal();
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
