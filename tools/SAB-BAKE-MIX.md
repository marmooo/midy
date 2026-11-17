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

2. **Copy path (fallback)** when SAB is unavailable
   - Same as before: private partial buffers + `left.set(partial, offset)`.

Entry-split is unchanged (private partials + additive combine). Concurrent `f32`
add on the same samples is not atomic, so SAB is only used for time-split.

## Why the previous SAB attempt did not help

Typical failure modes:

- Still returning / transferring full partial `Float32Array`s, then combining on
  main → transfer + combine dominated.
- Entry-split into a shared buffer without partitioning → races / wrong audio,
  or locks that killed throughput.
- SAB constructor / sharing blocked because the page was not cross-origin
  isolated.
- `mixParallelMaxParts` left at `1` → no parallel work regardless of SAB.

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

## How to see the wall-time curve

```js
player.mixParallelMaxParts = 0; // or 2..4 — must be > 1
player.workerPoolSize = 4; // before first mix
// After a tile:
// mixDetail.shared === true, mixDetail.combineMs === 0
```

Increase parts and dest length (long segment/chunk tiles). Wall time should fall
roughly with worker count until mix work is smaller than
postMessage/source-clone cost.

## Files

- `src/bake-worker-pool.ts` — only file required for this change.
