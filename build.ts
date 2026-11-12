/**
 * midy build — pure JS, WASM, and WASM-SIMD worklet variants.
 *
 * Usage:
 *   deno run -RWE --allow-run build.ts --target=js
 *   deno run -RWE --allow-run build.ts --target=wasm
 *   deno run -RWE --allow-run build.ts --target=wasm-simd
 *   deno run -RWE --allow-run build.ts --target=all
 *
 * Outputs:
 *   dist/midy.js / midy.min.js
 *   dist/midy.wasm.js
 *   dist/midy.wasm-simd.js
 *   (+ GM1 / GM2 / GMLite variants)
 */
import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

const root = Deno.cwd();
const backendWasm = `${root}/src/worklet-backend-wasm.ts`;
const backendWasmSimd = `${root}/src/worklet-backend-wasm-simd.ts`;

const customDenoPlugins = denoPlugins({
  configPath: await Deno.realPath("./deno.json"),
}) as esbuild.Plugin[];

type WasmKind = "wasm" | "wasm-simd" | false;

function backendAliasPlugin(kind: WasmKind): esbuild.Plugin {
  return {
    name: "midy-worklet-backend-alias",
    setup(build) {
      if (!kind) return;
      const target = kind === "wasm-simd" ? backendWasmSimd : backendWasm;
      build.onResolve({ filter: /worklet-backend\.ts$/ }, (args) => {
        const normalized = args.path.replace(/\\/g, "/");
        if (
          normalized === "./worklet-backend.ts" ||
          normalized.endsWith("/worklet-backend.ts") ||
          normalized === "worklet-backend.ts"
        ) {
          return { path: target };
        }
        return undefined;
      });
    },
  };
}

type Target = "js" | "wasm" | "wasm-simd" | "all";

function parseTarget(args: string[]): Target {
  for (const a of args) {
    if (a === "--target=js" || a === "--js") return "js";
    if (a === "--target=wasm-simd" || a === "--wasm-simd") return "wasm-simd";
    if (a === "--target=wasm" || a === "--wasm") return "wasm";
    if (a === "--target=all" || a === "--all") return "all";
    if (a.startsWith("--target=")) {
      const v = a.slice("--target=".length);
      if (v === "js" || v === "wasm" || v === "wasm-simd" || v === "all") {
        return v;
      }
      throw new Error(`Unknown --target=${v} (use js|wasm|wasm-simd|all)`);
    }
  }
  return "all";
}

const PACKAGES = [
  { entry: "./src/midy.ts", base: "midy" },
  { entry: "./src/midy-GM2.ts", base: "midy-GM2" },
  { entry: "./src/midy-GM1.ts", base: "midy-GM1" },
  { entry: "./src/midy-GMLite.ts", base: "midy-GMLite" },
] as const;

async function buildOne(
  inPath: string,
  outPath: string,
  opts: { minify: boolean; wasmKind: WasmKind },
): Promise<void> {
  await esbuild.build({
    entryPoints: [inPath],
    outfile: outPath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: opts.minify,
    sourcemap: false,
    plugins: [backendAliasPlugin(opts.wasmKind), ...customDenoPlugins],
    logLevel: "warning",
  });
}

async function buildJs() {
  console.log("== build:js ==");
  for (const p of PACKAGES) {
    await buildOne(p.entry, `./dist/${p.base}.js`, {
      minify: false,
      wasmKind: false,
    });
    console.log(`  dist/${p.base}.js`);
    await buildOne(p.entry, `./dist/${p.base}.min.js`, {
      minify: true,
      wasmKind: false,
    });
    console.log(`  dist/${p.base}.min.js`);
  }
}

async function buildWasmVariant(
  kind: "wasm" | "wasm-simd",
  suffix: string,
  b64File: string,
) {
  try {
    await Deno.stat(`./src/${b64File}`);
  } catch {
    console.error(
      `ERROR: src/${b64File} missing. Run: deno task build:wasm-core`,
    );
    Deno.exit(1);
  }
  console.log(`== build:${kind} (minify only) ==`);
  for (const p of PACKAGES) {
    const out = `./dist/${p.base}.${suffix}.js`;
    await buildOne(p.entry, out, { minify: true, wasmKind: kind });
    console.log(`  ${out}`);
  }
}

async function main() {
  const target = parseTarget(Deno.args);
  await Deno.mkdir("./dist", { recursive: true });
  if (target === "js" || target === "all") await buildJs();
  if (target === "wasm" || target === "all") {
    await buildWasmVariant("wasm", "wasm", "synth_core_wasm_b64.ts");
  }
  if (target === "wasm-simd" || target === "all") {
    await buildWasmVariant(
      "wasm-simd",
      "wasm-simd",
      "synth_core_wasm_simd_b64.ts",
    );
  }
  esbuild.stop();
  console.log("done.");
}

await main();
