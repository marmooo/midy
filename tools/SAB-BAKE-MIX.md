# SharedArrayBuffer bake mix path

## What changed

`BakeWorkerPool.mixTimeSplit` now has two backends:

1. **SAB (preferred)** when `SharedArrayBuffer` is usable
   - One `SharedArrayBuffer` dest (L/R) allocated on the main thread.
   - Each worker receives a `Float32Array` view of its non-overlapping time
     slice.
   - Message type: `mixIntoShared`. Worker runs `wasmMix` (or JS
     `mixEntriesInto`) and writes **in place**.
   - Worker replies with `{ type: "mix-shared-result", id, workerMs }` only —
     **no large PCM transfer**.
   - `combineMs = 0`, `shared: true` on the result. Residual “large result
     transfer” disappears.
   - Main must copy results with `AudioBuffer.getChannelData().set` (not
     `copyToChannel`). Chromium rejects SAB-backed views in `copyToChannel` and
     used to fall back to main-thread mix.

2. **Copy path (fallback)** when SAB is unavailable
   - Same as before: private partial buffers + `left.set(partial, offset)`.

Entry-split is unchanged (private partials + additive combine). Concurrent `f32`
add on the same samples is not atomic, so SAB is only used for time-split.

`Player.useSharedDestMix` (default `true`) maps to
`BakeWorkerPool.preferSharedDest` for A/B benches.

## Release status

Chunk mode / op1a, `wasm-threaded-simd`, SAB copyBack fixed (`fallbackTiles=0`):

| `mixParallelMaxParts` | Result                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| **1 (default)**       | Best bakeAvg / workerMixMs / preroll. Production choice.                                         |
| 2                     | SAB path healthy (`sharedTiles≈tiles`, `partsAvg=2`, `combineSum=0`) but **slower** than parts=1 |
| 4                     | Same: correct parallel SAB, still **regresses** vs parts=1                                       |

**Why parallel loses:** each time slice still structured-clones overlapping
source PCM into every worker. Dest SAB removes combine/result transfer only;
source fan-out dominates on current tiles (dest often ~150k samples).

**Do not raise the default above 1** until source PCM is shared (SAB or a single
clone) or a different workload shows a clear win. Keep `useSharedDestMix=true`
so any future opt-in parallel keeps the dest path.

Debug summary line:
`[midy] chunk-mix-parallel | … sharedTiles=… fallbackTiles=… partsAvg=…`.

## Why the previous SAB attempt did not help

Typical failure modes:

- Still returning / transferring full partial `Float32Array`s, then combining on
  main → transfer + combine dominated.
- Entry-split into a shared buffer without partitioning → races / wrong audio,
  or locks that killed throughput.
- SAB constructor / sharing blocked because the page was not cross-origin
  isolated.
- `mixParallelMaxParts` left at `1` → no parallel work regardless of SAB.
- `copyToChannel(SAB view)` threw → main fallback (`sharedTiles ≫ workerTiles`).

This path only shares the **dest**, keeps sources as structured-clone (or
transferable when unique), and only partitions on the **time axis**.

## Enabling SAB in the browser

Serve the app with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

(or `credentialless` for COEP where supported). Then:

```js
console.log(crossOriginIsolated); // must be true
console.log(typeof SharedArrayBuffer); // "function"
```

Subresources need CORP/CORS as required by COEP. Static demos can use a tiny
middleware or `npx serve` with custom headers.

Deno exposes `SharedArrayBuffer` without COOP/COEP; the same code path is used
automatically.

## How to experiment with parallel (opt-in)

```js
player.mixParallelMaxParts = 2; // or 4 — must be > 1
player.workerPoolSize = 4; // before first mix
player.useSharedDestMix = true;
// After a run (debug=true):
// [midy] chunk-mix-parallel | sharedTiles=… partsAvg=… combineSum=0 fallbackTiles=0
```

Expect wall time to improve with worker count **only** when per-slice mix work
exceeds postMessage/source-clone cost. On current chunk/op1a that is not the
case.

## Files

- `src/bake-worker-pool.ts` — SAB mix path + `preferSharedDest`
- `src/player.ts` — `useSharedDestMix`, `mixParallelMaxParts`, copyBack, debug
  aggregates
