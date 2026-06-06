import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

const customDenoPlugins = denoPlugins({
  configPath: await Deno.realPath("./deno.json"),
}) as esbuild.Plugin[];

async function buildScript(inPath: string, outPath: string, optimize: boolean) {
  await esbuild.build({
    plugins: customDenoPlugins,
    entryPoints: [inPath],
    outfile: outPath,
    bundle: true,
    minify: optimize,
    platform: "browser",
    format: "esm",
  });
  esbuild.stop();
}

async function build() {
  await buildScript("./src/midy.ts", "./dist/midy.js", false);
  await buildScript("./src/midy-GM2.ts", "./dist/midy-GM2.js", false);
  await buildScript("./src/midy-GM1.ts", "./dist/midy-GM1.js", false);
  await buildScript("./src/midy-GMLite.ts", "./dist/midy-GMLite.js", false);
  await buildScript("./src/midy.ts", "./dist/midy.min.js", true);
  await buildScript("./src/midy-GM2.ts", "./dist/midy-GM2.min.js", true);
  await buildScript("./src/midy-GM1.ts", "./dist/midy-GM1.min.js", true);
  await buildScript("./src/midy-GMLite.ts", "./dist/midy-GMLite.min.js", true);
}

await build();
