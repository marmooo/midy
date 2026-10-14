# lookAhead / maxTiled / maxNoteBake sweep

Investigate `lookAhead`, `maxTiledNoteDuration`, and `maxNoteBakeDuration` using
the existing realtime harness (`bench-main-load.ts`).

## Why these three

| Knob                   | Role                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lookAhead`            | How far ahead notes are scheduled (default **1s**). JIT budget for noteBake is roughly this window (tile discovery uses `lookAhead + maxTiled`). |
| `maxTiledNoteDuration` | Notes with duration+release ≤ this go into **tiles**. Upper bound is mostly **memory** (tile buffer sized to longest note in the window).        |
| `maxNoteBakeDuration`  | Notes with `maxTiled < sum ≤ maxNoteBake` use **single-note bake**. Longer notes fall back to **ADS**. `0` = uncapped (legacy).                  |

There is no single analytic optimum: it depends on the song (long pads vs short
drums). Sweep both a **pad-heavy** and a **drum-heavy** MIDI if you can.

## Config file

`tools/bench-configs.lookAhead-long.json`

| Prefix          | Axis                                  |
| --------------- | ------------------------------------- |
| `00-baseline-*` | Current defaults (L=1, T=8, B=16)     |
| `L-*`           | lookAhead 2 / 4 / 6                   |
| `T-*`           | maxTiled 4 / 12                       |
| `B-*`           | maxNoteBake 8 / 12 / 24 / 0(uncapped) |
| `C-*`           | a few coupled candidates              |

## Run

```bash
# Full song (slow: ~13 configs × song length)
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/song.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.lookAhead-long.json \
  --max-play-sec 200 \
  --out-dir ./bench-logs-lookahead

# Quick pass (first ~60s)
deno run -A tools/bench-main-load.ts \
  --midi ./path/to/song.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.lookAhead-long.json \
  --max-play-sec 60 \
  --out-dir ./bench-logs-lookahead60

deno run -A tools/bench-summarize.ts ./bench-logs-lookahead --sort bakeMax
deno run -A tools/bench-summarize.ts ./bench-logs-lookahead --csv > lookahead.csv
```

Use **two songs** when possible:

1. Pad-heavy (many 20–45s notes) — checks ADS fallback / ready≠0
2. Drum / previous hitch song (timidy-like) — checks noteBake vs ADS
   quality/cost

## How to read results

Hard constraints (discard row if violated):

- `late=0` and `dropped=0`
- `timedOut=false`
- Prefer runs where tile pipeline does not stick at `ready=0` for long (see raw
  log `backlog`)

Soft metrics (lower is usually better):

| Metric                               | Meaning                                           |
| ------------------------------------ | ------------------------------------------------- |
| `bakeMax` / `bakeP95`                | Hitch size                                        |
| `simpleSum`                          | Note-body bake cost (noteBake path shows up here) |
| `gateWaitAvg`                        | Bake gate congestion                              |
| `residualSum`                        | Worker await tax                                  |
| `tiled` / `noteBake` / `adsFallback` | Classification split (`segment-classify`)         |

Selection heuristic:

1. Filter `late=0 dropped=0 timedOut=false`
2. Prefer low `bakeMax` and low `simpleSum` on the pad song **without** starving
   tiles
3. On the drum song, ensure quality path is still acceptable (not forced to ADS
   for moderate lengths)
4. Prefer smaller `lookAhead` if metrics are equal (less schedule lag / memory)

## Notes

- With `lookAhead=1`, noteBake of 8–16s is **not** JIT-justified; it relies on
  prewarm/cache. The B-axis still matters as a **starve/OOM cap**.
- `maxNoteBakeDuration=0` is the old “everything long is noteBake” behaviour —
  expect pad songs to degrade.
- Requires built `dist/midy.js` visible from the repo root (see
  `BENCH-MAIN-LOAD.md`).
