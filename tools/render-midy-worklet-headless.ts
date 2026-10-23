// Headless (Puppeteer) driver for worklet-mode quality captures.
//
// Worklet mode cannot use OfflineAudioContext / player.render(), so this
// opens tools/worklet-harness.html and calls globalThis.__renderMidyWorklet
// which plays in realtime and returns float32 WAV base64.
//
// Usage:
//   deno run -A tools/render-midy-worklet-headless.ts \
//     --midi /tmp/note.mid --sf2 tools/GeneralUser_GS_v1.472.sf3 \
//     --out /tmp/worklet.wav

// deno-lint-ignore-file no-import-prefix
import puppeteer from "npm:puppeteer@25.10.0";

export interface RenderMidyWorkletOptions {
  harnessDir?: string;
  rootDir?: string;
  midiPath: string;
  soundFontPath: string;
  sampleRate?: number;
  tailSec?: number;
  headed?: boolean;
  executablePath?: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function startStaticServer(
  rootDir: string,
): Promise<{ url: string; close: () => void }> {
  const abs = await Deno.realPath(rootDir);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const u = new URL(req.url);
    let path = decodeURIComponent(u.pathname);
    if (path.endsWith("/")) path += "index.html";
    const filePath = abs + path;
    try {
      const data = await Deno.readFile(filePath);
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const types: Record<string, string> = {
        html: "text/html; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        mjs: "text/javascript; charset=utf-8",
        css: "text/css; charset=utf-8",
        json: "application/json",
        wasm: "application/wasm",
        sf2: "application/octet-stream",
        sf3: "application/octet-stream",
        mid: "audio/midi",
        midi: "audio/midi",
      };
      return new Response(data, {
        headers: {
          "content-type": types[ext] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  const addr = server.addr;
  if (!("port" in addr)) throw new Error("expected TCP addr");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => {
      try {
        server.shutdown();
      } catch { /* ignore */ }
    },
  };
}

export async function renderMidyWorklet(
  options: RenderMidyWorkletOptions,
): Promise<Uint8Array> {
  const rootDir = options.rootDir ?? ".";
  const harnessDir = options.harnessDir ?? "tools";
  const sampleRate = options.sampleRate ?? 48000;
  const tailSec = options.tailSec ?? 0.5;

  const midiBytes = await Deno.readFile(options.midiPath);
  const sfBytes = await Deno.readFile(options.soundFontPath);

  const { url, close } = await startStaticServer(rootDir);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

  try {
    browser = await puppeteer.launch({
      headless: !options.headed,
      executablePath: options.executablePath,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-web-security",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(msg.text());
    });

    await page.goto(`${url}/${harnessDir}/worklet-harness.html`, {
      waitUntil: "load",
    });

    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as { __renderMidyWorklet?: unknown })
          .__renderMidyWorklet === "function",
      { timeout: 30_000 },
    );

    const result = await page.evaluate(
      async (params) => {
        // deno-lint-ignore no-explicit-any
        return await (globalThis as any).__renderMidyWorklet(params);
      },
      {
        midiBytesBase64: toBase64(midiBytes),
        soundFontBytesBase64: toBase64(sfBytes),
        sampleRate,
        tailSec,
      },
    );

    if (!result || typeof result.wavBase64 !== "string") {
      throw new Error(
        `worklet harness returned unexpected result: ${
          JSON.stringify(result)?.slice(0, 200)
        }; pageErrors=${pageErrors.join(" | ")}`,
      );
    }

    console.log(
      `[render-midy-worklet] frames=${result.frames} ` +
        `captureSec=${result.captureSec?.toFixed?.(3)} ` +
        `sr=${result.sampleRate} peak=${result.peak} selfPeak=${result.selfPeak}`,
    );
    if (Array.isArray(result.logs)) {
      for (const line of result.logs) {
        console.log(`  [harness] ${line}`);
      }
    }

    return fromBase64(result.wavBase64);
  } finally {
    try {
      await browser?.close();
    } catch { /* ignore */ }
    close();
  }
}

if (import.meta.main) {
  const args = Deno.args;
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const midiPath = get("--midi");
  const sf2 = get("--sf2") ?? get("--sf3") ?? "tools/GeneralUser_GS_v1.472.sf3";
  const out = get("--out") ?? "/tmp/midy-worklet.wav";
  const sampleRate = Number(get("--sample-rate") ?? "48000");
  if (!midiPath) {
    console.error(
      "usage: deno run -A tools/render-midy-worklet-headless.ts " +
        "--midi file.mid [--sf2 tools/....sf3] [--out out.wav]",
    );
    Deno.exit(2);
  }
  const wav = await renderMidyWorklet({
    midiPath,
    soundFontPath: sf2,
    sampleRate,
  });
  await Deno.writeFile(out, wav);
  console.log(`wrote ${out} (${wav.byteLength} bytes)`);
}
