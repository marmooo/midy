import { minify, transform } from "npm:@swc/core";

async function bundle(inPath, outPath) {
  const code = Deno.readTextFileSync(inPath);
  const transformed = await transform(code, {
    isModule: true,
    sourceMaps: false,
  });
  const minified = await minify(transformed.code, {
    compress: false,
    mangle: false,
    module: true,
    sourceMap: false,
  });
  Deno.writeTextFileSync(outPath, minified.code);
}

async function watchAndBundle(inPath, outPath) {
  const watcher = Deno.watchFs(inPath);
  for await (const event of watcher) {
    if (event.kind !== "modify") continue;
    await bundle(inPath, outPath);
    for (let i = 0; i < event.paths.length; i++) {
      console.log(`reloaded: ${event.paths[i]}`);
    }
  }
}

if (Deno.args.length !== 2) {
  console.log("Usage: deno run -RWE --allow-ffi ./src/midy.js ./dist/midy.js");
} else {
  watchAndBundle(Deno.args[0], Deno.args[1]);
}
