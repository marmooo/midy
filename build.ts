/**
 * midy build — pure JS and WASM worklet variants.
 *
 * Usage:
 *   deno run -RWE --allow-run build.ts              # all (js + wasm)
 *   deno run -RWE --allow-run build.ts --target=js
 *   deno run -RWE --allow-run build.ts --target=wasm
 *
 * Outputs:
 *   dist/midy.js / midy.min.js              pure JS
 *   dist/midy-GM*.js / midy-GM*.min.js      pure JS
 *   dist/midy.wasm.js                       WASM (minify only)
 *   dist/midy-GM*.wasm.js                   WASM (minify only)
 *
 * WASM builds alias src/worklet-backend.ts → src/worklet-backend-wasm.ts
 * so worklet-engine.ts always imports from "./worklet-backend.ts".
 */
import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

const root = Deno.cwd();
const backendWasm = `${root}/src/worklet-backend-wasm.ts`;

const customDenoPlugins = denoPlugins({
  configPath: await Deno.realPath("./deno.json"),
}) as esbuild.Plugin[];

/** Resolve worklet-backend.ts to the WASM backend when target=wasm. */
function backendAliasPlugin(useWasm: boolean): esbuild.Plugin {
  return {
    name: "midy-worklet-backend-alias",
    setup(build) {
      if (!useWasm) return;
      build.onResolve({ filter: /worklet-backend\.ts$/ }, (args) => {
        // Only rewrite the library backend, not accidental matches elsewhere.
        const normalized = args.path.replace(/\\/g, "/");
        if (
          normalized === "./worklet-backend.ts" ||
          normalized.endsWith("/worklet-backend.ts") ||
          normalized === "worklet-backend.ts"
        ) {
          return { path: backendWasm };
        }
        return undefined;
      });
    },
  };
}

type Target = "js" | "wasm" | "all";

function parseTarget(args: string[]): Target {
  for (const a of args) {
    if (a === "--target=js" || a === "--js") return "js";
    if (a === "--target=wasm" || a === "--wasm") return "wasm";
    if (a === "--target=all" || a === "--all") return "all";
    if (a.startsWith("--target=")) {
      const v = a.slice("--target=".length);
      if (v === "js" || v === "wasm" || v === "all") return v;
      throw new Error(`Unknown --target=${v} (use js|wasm|all)`);
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
  opts: { minify: boolean; useWasm: boolean },
) {
  await esbuild.build({
    plugins: [
      backendAliasPlugin(opts.useWasm),
      ...customDenoPlugins,
    ],
    entryPoints: [inPath],
    outfile: outPath,
    bundle: true,
    minify: opts.minify,
    platform: "browser",
    format: "esm",
    // Keep the absolute path stable for the alias plugin.
    absWorkingDir: root,
  });
}

async function buildJs() {
  console.log("== build:js ==");
  for (const p of PACKAGES) {
    await buildOne(p.entry, `./dist/${p.base}.js`, {
      minify: false,
      useWasm: false,
    });
    console.log(`  dist/${p.base}.js`);
    await buildOne(p.entry, `./dist/${p.base}.min.js`, {
      minify: true,
      useWasm: false,
    });
    console.log(`  dist/${p.base}.min.js`);
  }
}

async function buildWasm() {
  // Ensure embedded b64 exists (commit it, or run build:wasm-core first).
  try {
    await Deno.stat("./src/synth_core_wasm_b64.ts");
  } catch {
    console.error(
      "ERROR: src/synth_core_wasm_b64.ts missing. Run: deno task build:wasm-core",
    );
    Deno.exit(1);
  }
  try {
    await Deno.stat("./src/worklet-backend-wasm.ts");
  } catch {
    console.error("ERROR: src/worklet-backend-wasm.ts missing.");
    Deno.exit(1);
  }

  console.log("== build:wasm (minify only) ==");
  for (const p of PACKAGES) {
    const out = `./dist/${p.base}.wasm.js`;
    await buildOne(p.entry, out, { minify: true, useWasm: true });
    console.log(`  ${out}`);
  }
}

async function main() {
  const target = parseTarget(Deno.args);
  await Deno.mkdir("./dist", { recursive: true });

  if (target === "js" || target === "all") {
    await buildJs();
  }
  if (target === "wasm" || target === "all") {
    await buildWasm();
  }

  esbuild.stop();
  console.log("done.");
}

await main();
