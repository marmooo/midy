# Parameter tune sweep (headless)

One-song batch of midy knobs that affect hitching / main load. Uses existing
`tools/bench-main-load.ts`.

Configs only override the knobs under test. Everything else uses Player defaults
(`maxConcurrentChunkBakes=2`, `chunkCostBudget=16`, `maxChunkNotes=24`,
`chunkBakeHorizonSec=6`, `maxChunkBakeStartsPerPass=5`, `tileDuration=1`,
`simpleNoteCacheMaxSize=2048`, `maxTiledNoteDuration=4`, …).

## Full song (~3 min × configs)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/song.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.tune.json \
  --max-play-sec 200 \
  --out-dir ./bench-logs-tune

deno run -A tools/bench-summarize.ts ./bench-logs-tune
deno run -A tools/bench-summarize.ts ./bench-logs-tune --sort gateWaitAvg
deno run -A tools/bench-summarize.ts ./bench-logs-tune --csv > tune.csv
```

## Quick pass (first ~60s only)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/song.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.tune.json \
  --max-play-sec 60 \
  --out-dir ./bench-logs-tune60

deno run -A tools/bench-summarize.ts ./bench-logs-tune60 --sort bakeMax
```

## What each config changes

| name                | focus                                                      |
| ------------------- | ---------------------------------------------------------- |
| 00-baseline         | code defaults only (`cacheMode=chunk`, `debug`)            |
| 01-notes40          | `maxChunkNotes`                                            |
| 02/03-budget8/12    | `chunkCostBudget`                                          |
| 04/05-tile0.5/1.5   | `tileDuration`                                             |
| 06/07-horizon4/12   | `chunkBakeHorizonSec`                                      |
| 08/09-starts3/6     | `maxChunkBakeStartsPerPass`                                |
| 10/11-pool2/6       | `workerPoolSize`                                           |
| 12-mixMin4          | `workerMixMinEntries`                                      |
| 13-prewarm8s        | `prewarmSimpleMaxMs`                                       |
| 14-complexWeight2.5 | `chunkComplexCostWeight`                                   |
| 15-cache1024        | `simpleNoteCacheMaxSize`                                   |
| 16-tiled8           | `maxTiledNoteDuration`                                     |
| 17-combo-tight      | tighter + notes + horizon + starts + tile + pool + prewarm |
| 18-combo-wide       | same knobs, wider values                                   |

## How to read the table

- **bakeMax / bakeP95** — hitch size (lower better)
- **gateWaitAvg** — bake gate congestion (lower better)
- **simpleSum** — note-body bake cost
- **mixMainRatio** — main-thread mix share (0% = offloaded)
- **late / dropped** — must stay 0
- **residualSum** — worker await tax (relevant when live worker on)

Pick the best row with `late=0 dropped=false`, then re-test that config alone in
the browser/game.
