import { minify, transform } from "@swc/core";

async function buildScript(inPath, outPath) {
  const code = Deno.readTextFileSync(inPath);
  const transformed = await transform(code, {
    isModule: true,
    sourceMaps: false,
  });
  const minified = await minify(transformed.code, {
    compress: true,
    mangle: true,
    module: true,
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
