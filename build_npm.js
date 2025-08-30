import { build, emptyDir } from "@deno/dnt";

await emptyDir("./npm");

await build({
  entryPoints: ["./src/mod.js"],
  outDir: "./npm",
  shims: {
    deno: true,
  },
  package: {
    name: "@marmooo/midy",
    version: "0.2.7",
    description:
      "A MIDI player/synthesizer written in JavaScript that supports GM-Lite/GM1 and SF2/SF3.",
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/marmooo/midy.git",
    },
    bugs: {
      url: "https://github.com/marmooo/midy/issues",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
