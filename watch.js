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

async function watchAndBundle(inPath, outPath) {
  while (true) {
    const watcher = Deno.watchFs(inPath);
    for await (const event of watcher) {
      switch (event.kind) {
        case "remove":
          watcher.close();
          break;
        case "modify":
          await buildScript(inPath, outPath, false);
          for (let i = 0; i < event.paths.length; i++) {
            console.log(`reloaded: ${event.paths[i]}`);
          }
      }
    }
  }
}

if (Deno.args.length !== 2) {
  console.log(
    "Usage: deno run -RWE --allow-run watch.js ./src/midy.js ./dist/midy.js",
  );
} else {
  watchAndBundle(Deno.args[0], Deno.args[1]);
}
