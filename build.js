import { minify, transform } from "@swc/core";

async function buildScript(inPath, outPath, optimize) {
  const code = Deno.readTextFileSync(inPath);
  const transformed = await transform(code, {
    isModule: true,
    sourceMaps: false,
  });
  if (optimize) {
    const minified = await minify(transformed.code, {
      compress: optimize,
      mangle: optimize,
      module: true,
      sourceMap: false,
    });
    Deno.writeTextFileSync(outPath, minified.code);
  } else {
    Deno.writeTextFileSync(outPath, transformed.code);
  }
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
