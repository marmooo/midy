import { bundle } from "@deno/emit";
import { minify } from "@swc/core";

async function buildScript(inPath, outPath) {
  const url = new URL(import.meta.resolve(inPath));
  const { code } = await bundle(url);
  const minified = await minify(code, {
    module: true,
    compress: true,
    mangle: true,
    sourceMap: false,
  });
  Deno.writeTextFileSync(outPath, minified.code);
}

async function build() {
  await buildScript("./src/midy.js", "./dist/midy.min.js");
  await buildScript("./src/midy-GM2.js", "./dist/midy-GM2.min.js");
  await buildScript("./src/midy-GM1.js", "./dist/midy-GM1.min.js");
  await buildScript("./src/midy-GMLite.js", "./dist/midy-GMLite.min.js");
}

await build();
