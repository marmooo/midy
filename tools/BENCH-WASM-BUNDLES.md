# Compare the four WASM dist builds

Single-thread parity check for step 1 (threads ≈ non-threads when SAB/parallel
is off).

## Prerequisites

```bash
deno task build:wasm-core   # if WASM binaries need rebuild
deno task build             # or at least the four wasm* targets
ls dist/midy.wasm.js dist/midy.wasm-simd.js \
   dist/midy.wasm-threads.js dist/midy.wasm-threaded-simd.js
```

## Run all four

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/heavy.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.wasm-bundles.json \
  --max-play-sec 120 \
  --out-dir ./bench-logs/wasm4
```

## One bundle

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/heavy.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --bundle wasm-simd \
  --set cacheMode=segment \
  --set debug=true \
  --max-play-sec 120 \
  --out-dir ./bench-logs/simd
```

## Summarize

```bash
deno run -A tools/bench-summarize.ts ./bench-logs/wasm4
```

Look for near-parity:

| pair                               | expect                                                   |
| ---------------------------------- | -------------------------------------------------------- |
| `wasm` ≈ `wasm-threads`            | atomics alone should not change single-thread speed much |
| `wasm-simd` ≈ `wasm-threaded-simd` | same for SIMD + atomics                                  |

Useful log lines: `play-load`, `worklet-hybrid`, `preroll done`,
`[bench] bundle=`.
