# Parameter tune sweep (headless)

One-song batch of midy knobs that affect hitching / main load. Uses existing
`tools/bench-main-load.ts`.

## Full song (~3 min × 15 configs)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.tune-sweep.json \
  --max-play-sec 200 \
  --out-dir ./bench-logs-tune

deno run -A tools/bench-summarize.ts ./bench-logs-tune
deno run -A tools/bench-summarize.ts ./bench-logs-tune --sort gateWaitAvg
deno run -A tools/bench-summarize.ts ./bench-logs-tune --csv > tune.csv
```

## Quick pass (first ~60s only)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.tune-sweep.json \
  --max-play-sec 60 \
  --out-dir ./bench-logs-tune60

deno run -A tools/bench-summarize.ts ./bench-logs-tune60 --sort bakeMax
```

## What each config changes

| name              | focus                                                  |
| ----------------- | ------------------------------------------------------ |
| 00-baseline       | current defaults                                       |
| 01/02-bakes3/4    | `maxConcurrentChunkBakes`                              |
| 03/04-budget12/24 | `chunkCostBudget` (tile split)                         |
| 05/06-notes32/64  | `maxChunkNotes`                                        |
| 07-cache4k        | `simpleNoteCacheMaxSize`                               |
| 08-horizon9       | `chunkBakeHorizonSec`                                  |
| 09-starts5        | `maxChunkBakeStartsPerPass`                            |
| 10-preroll30      | `prerollSec`                                           |
| 11/12-liveWorker* | preferWorker mix/bake                                  |
| 13-combo-smooth   | bakes4 + split + cache + horizon (playback smoothness) |
| 14-combo-offload  | same + live worker (main empty)                        |

## How to read the table

- **bakeMax / bakeP95** — hitch size (lower better)
- **gateWaitAvg** — bake gate congestion (lower better)
- **simpleSum** — note-body bake cost
- **mixMainRatio** — main-thread mix share (0% = offloaded)
- **late / dropped** — must stay 0
- **residualSum** — worker await tax (relevant when live worker on)

Pick the best row with `late=0 dropped=false`, then re-test that config alone in
the browser/game.
