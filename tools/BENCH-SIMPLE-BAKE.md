# simple / almost-simple bake path tune (chunk)

Investigate the knobs that most affect **simple / almost-simple** (noteBake +
tiled) cost and hitching on the **chunk** path.

Worklet polyphony (`workletVoiceLimit`) is **out of scope** here — use
[`BENCH-WORKLET-VOICE.md`](./BENCH-WORKLET-VOICE.md) instead.

Uses the existing headless harness:

- `tools/bench-main-load.ts` — play + full console log
- `tools/bench-summarize.ts` — table / CSV from logs
- `tools/bench-configs.simple-bake.json` — this sweep (chunk only)

## Why these three

| Knob                   | Role                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookAhead`            | How far ahead notes are scheduled (default **1s**). JIT budget for noteBake is roughly this window (tile discovery uses `lookAhead + maxTiled`). Smaller = less lag/memory; larger = more headroom for long noteBake. |
| `maxTiledNoteDuration` | Notes with duration+release ≤ this go into **tiles**. Upper bound is mostly **memory** (tile buffer sized to longest note in the window).                                                                             |
| `maxNoteBakeDuration`  | Notes with `maxTiled < sum ≤ maxNoteBake` use **single-note bake** (simple / almost-simple). Longer notes fall to worklet fallback. `0` = uncapped (legacy). Must be ≥ `maxTiledNoteDuration`.                        |

There is no single analytic optimum: it depends on the song (long pads vs short
drums). Sweep both a **pad-heavy** and a **drum-heavy / dense** MIDI if you can.

## Quick pass (first ~60s) — expected `timedOut=true`

`--max-play-sec 60` on a ~3 min song **always** ends with `timedOut=true`. That
is normal. It means the harness stopped at the cap, not that the run failed.

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.simple-bake.json \
  --max-play-sec 60 \
  --out-dir ./bench-logs-simple-bake60

deno run -A tools/bench-summarize.ts ./bench-logs-simple-bake60 --sort bakeMax
```

## Full song (expect `timedOut=false`)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.simple-bake.json \
  --max-play-sec 200 \
  --out-dir ./bench-logs-simple-bake

deno run -A tools/bench-summarize.ts ./bench-logs-simple-bake --sort bakeMax
deno run -A tools/bench-summarize.ts ./bench-logs-simple-bake --csv > simple-bake.csv
```

## Config map

| Prefix / name | Focus                                                |
| ------------- | ---------------------------------------------------- |
| `00-baseline` | Current defaults (L=1, T=8, B=12)                    |
| `L-*`         | lookAhead 2 / 4 / 6                                  |
| `T-*`         | maxTiledNoteDuration 4 / 6 / 12                      |
| `B-*`         | maxNoteBakeDuration 8 / 16 / 24 / 0 (uncapped)       |
| `C-*`         | coupled candidates (L×T×B), including tight variants |

All configs use `cacheMode=chunk` and prefer worker mix/bake.

## How to read the summary table

### Hard constraints (discard row if violated)

| Column     | Meaning                  | Good                                                          |
| ---------- | ------------------------ | ------------------------------------------------------------- |
| `late`     | Pipeline late tiles      | **must be 0**                                                 |
| `dropped`  | Dropped tiles            | **must be 0**                                                 |
| `timedOut` | Hit `--max-play-sec` cap | `true` is **OK on 60s quick pass**; want `false` on full song |

### Primary metrics (lower is better, with hard constraints held)

| Column                | Meaning                                      |
| --------------------- | -------------------------------------------- |
| `bakeMax` / `bakeP95` | Hitch size from noteBake / tile spikes       |
| `simpleSum`           | Note-body bake cost (simple / almost-simple) |
| `gateWaitAvg`         | Bake gate congestion                         |
| `mixMainRatio`        | Main-thread mix share (0 = fully offloaded)  |

### Secondary

| Column / log                                  | Meaning                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `residualSum`                                 | Worker await tax (watch when mix is on worker)                                                             |
| `cacheHit`                                    | Simple-note cache hit rate (%)                                                                             |
| `clsTiled` / `clsNoteBake` / `clsAdsFallback` | From `[midy] segment-classify` — may show `-` if that log line is absent or format changed. Check raw log. |

### Common confusion

| Symptom                                       | Cause                                  | Action                                                |
| --------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| All rows `timedOut=true` on 60s run           | Expected with `--max-play-sec 60`      | Use 200 for full song, or ignore timedOut for ranking |
| `clsTiled` etc. all `-`                       | classify log missing or regex mismatch | `grep segment-classify bench-logs-*/\*.log`           |
| worklet-like zeros in this table              | You ran a worklet config here          | Use `BENCH-WORKLET-VOICE.md` instead                  |
| `pathNoteBake=0` in raw log with low maxTiled | Most notes fit in tiles                | Normal when maxTiled is small                         |

### Selection heuristic

1. Filter `late=0` and `dropped=0`
2. Prefer low `bakeMax` and low `simpleSum`
3. Prefer smaller `lookAhead` if metrics are equal
4. Prefer smaller `maxTiled` if bakeMax stays low (less memory)
5. Re-test the winner alone on full song (`timedOut=false`) and in the
   browser/game

## What the raw log should look like (healthy chunk run)

Near the end you should see lines like:

```
[midy] chunk-pipeline | tiles=… bakeAvg=… bakeMax=… late=0 dropped=0 …
[midy] chunk-bake-parts | simpleSum=… mixSum=…
[midy] main-thread | mixMainMs=… mixMainRatio=0.0% …
[midy] noteBake-summary | pathNoteBake=… maxTiled=… maxNoteBake=…
[bench] play finished elapsedMs=… timedOut=true|false totalTime=…
```

If `chunk-pipeline` is missing and everything is zero, you are probably on
`cacheMode=worklet` — wrong file for this sweep.

## Notes

- With `lookAhead=1`, noteBake of 8–16s is **not** JIT-justified; it relies on
  prewarm/cache. The B-axis still matters as a **starve/OOM cap**.
- `maxNoteBakeDuration=0` is the old “everything long is noteBake” behaviour —
  expect pad songs to degrade or OOM.
- Requires built `dist/midy.js` visible from the repo root (see
  `BENCH-MAIN-LOAD.md`).

## Related

- Worklet polyphony: [`BENCH-WORKLET-VOICE.md`](./BENCH-WORKLET-VOICE.md)
- General hitch tune: [`BENCH-TUNE.md`](./BENCH-TUNE.md) +
  `bench-configs.tune.json`
- Older lookAhead sweep: [`BENCH-LOOKAHEAD-LONG.md`](./BENCH-LOOKAHEAD-LONG.md)
  (superseded for simple-path work by this file)
