# useSharedDestMix flag

Force the bake mix dest path for A/B:

| `Player.useSharedDestMix` | Effect                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `true` (default)          | Use SAB dest when `SharedArrayBuffer` is available (COOP/COEP or Deno) |
| `false`                   | Always private partials + combine/placement, even if SAB exists        |

Wired as `BakeWorkerPool.preferSharedDest` inside `getBakeWorkerPool()`.

See `tools/bench-configs.sab-compare.json` for sab-off / sab-on-1 / sab-on-4.
