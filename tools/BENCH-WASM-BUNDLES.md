# Compare the four WASM dist builds

Single-thread parity check for step 1 (threads ≈ non-threads when SAB/parallel
is off), plus parallel SAB bake path for `wasm-threads` / `wasm-threaded-simd`
when the page is cross-origin isolated.

## Prerequisites

```bash
deno task build:wasm-core   # if WASM binaries need rebuild
deno task build             # or at least the four wasm* targets
ls dist/midy.wasm.js dist/midy.wasm-simd.js \
   dist/midy.wasm-threads.js dist/midy.wasm-threaded-simd.js
```

`tools/bench-main-load.ts` serves the repo with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

so `crossOriginIsolated === true` and `SharedArrayBuffer` is available in
headless Chromium. No extra flags required.

## One-shot: all bundles (serial + parallel threads)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/heavy.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.wasm-bundles.json \
  --max-play-sec 120 \
  --out-dir ./bench-logs/wasm4
```

Configs in `bench-configs.wasm-bundles.json`:

| name                        | bundle             | mixParallelMaxParts | purpose                                |
| --------------------------- | ------------------ | ------------------- | -------------------------------------- |
| `wasm`                      | wasm               | 1                   | scalar baseline                        |
| `wasm-simd`                 | wasm-simd          | 1                   | SIMD baseline                          |
| `wasm-threads-serial`       | wasm-threads       | 1                   | atomics binary, single worker (parity) |
| `wasm-threaded-simd-serial` | wasm-threaded-simd | 1                   | SIMD+atomics, single worker (parity)   |
| `wasm-threads`              | wasm-threads       | 4                   | SAB time-split parallel bake           |
| `wasm-threaded-simd`        | wasm-threaded-simd | 4                   | SAB + SIMD parallel bake               |

## One bundle

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/heavy.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --bundle wasm-threaded-simd \
  --set cacheMode=segment \
  --set mixParallelMaxParts=4 \
  --set workerPoolSize=4 \
  --set debug=true \
  --max-play-sec 120 \
  --out-dir ./bench-logs/threaded-simd
```

## Summarize

```bash
deno run -A tools/bench-summarize.ts ./bench-logs/wasm4
```

## What to look for

**Isolation (every run):**

```
[bench-host] isolation crossOriginIsolated=true SharedArrayBuffer=true
[browser:log] [bench] isolation crossOriginIsolated=true SharedArrayBuffer=true
```

If either is `false`, the SAB bake path will not activate.

**Single-thread parity (serial configs):**

| pair                                      | expect                                                   |
| ----------------------------------------- | -------------------------------------------------------- |
| `wasm` ≈ `wasm-threads-serial`            | atomics alone should not change single-thread speed much |
| `wasm-simd` ≈ `wasm-threaded-simd-serial` | same for SIMD + atomics                                  |

**Parallel SAB path (parts=4):**

| pair                                                    | expect                                           |
| ------------------------------------------------------- | ------------------------------------------------ |
| `wasm-threads` wall < `wasm-threads-serial`             | more workers → lower wall on heavy segment tiles |
| `wasm-threaded-simd` wall < `wasm-threaded-simd-serial` | same, with SIMD mix                              |

Useful log lines: `play-load`, `worklet-hybrid`, `preroll done`,
`[bench] bundle=`, `shared=true` / `combineMs` on mix diagnostics when
`debug=true`.

## Notes

- Parallel speed-up needs long segment/chunk tiles (enough mix work). Short MIDI
  or tiny tiles stay postMessage-bound.
- `mixParallelMaxParts` defaults to `1` on the player; the threads configs set
  it to `4` explicitly.
- Apply the SAB bake patch (`src/bake-worker-pool.ts`) so workers write the
  shared dest in place; without it, isolation alone does not remove residual
  result transfer.
