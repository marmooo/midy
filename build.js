import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

const customDenoPlugins = denoPlugins({
  configPath: await Deno.realPath("./deno.json"),
});

async function buildScript(inPath, outPath, optimize) {
  await esbuild.build({
    plugins: [...customDenoPlugins],
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
  await buildScript("./src/midy.js", "./dist/midy.js", false);
  await buildScript("./src/midy-GM2.js", "./dist/midy-GM2.js", false);
  await buildScript("./src/midy-GM1.js", "./dist/midy-GM1.js", false);
  await buildScript("./src/midy-GMLite.js", "./dist/midy-GMLite.js", false);
  await buildScript("./src/midy.js", "./dist/midy.min.js", true);
  await buildScript("./src/midy-GM2.js", "./dist/midy-GM2.min.js", true);
  await buildScript("./src/midy-GM1.js", "./dist/midy-GM1.min.js", true);
  await buildScript("./src/midy-GMLite.js", "./dist/midy-GMLite.min.js", true);
}

await build();
