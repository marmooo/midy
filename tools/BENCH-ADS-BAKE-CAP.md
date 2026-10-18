# maxAdsBakeDuration parameter tune

Sweep the ADS bake length cap introduced to stop multi-10s SF2 decays from
producing huge looped PCM bakes (and the pitch-safe capped-bake path).

Uses the existing headless harness:

- `tools/bench-main-load.ts` — play + full console log
- `tools/bench-summarize.ts` — table / CSV from logs
- `tools/bench-configs.ads-bake-cap.json` — this knob + a few interactions

## What the knob does

| `maxAdsBakeDuration` | Effect                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| `0`                  | No cap (legacy full ADS length; can be 20s+ and multi-MB)              |
| `2`–`4`              | Aggressive / default: long decays compressed to sustain inside the cap |
| `6`–`12`             | Looser: more of the natural decay kept in the bake                     |

Pitch stays baked into the `RenderedBuffer` (ADS lean path). Only the volume
envelope length is capped.

## Full song (~3 min × 16 configs)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.ads-bake-cap.json \
  --max-play-sec 200 \
  --out-dir ./bench-logs-ads-cap

deno run -A tools/bench-summarize.ts ./bench-logs-ads-cap
deno run -A tools/bench-summarize.ts ./bench-logs-ads-cap --sort bakeMax
deno run -A tools/bench-summarize.ts ./bench-logs-ads-cap --csv > ads-cap-tune.csv
```

## Quick pass (first ~60s)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.ads-bake-cap.json \
  --max-play-sec 60 \
  --out-dir ./bench-logs-ads-cap60

deno run -A tools/bench-summarize.ts ./bench-logs-ads-cap60 --sort bakeMax
```

## Config map

| name                  | focus                                   |
| --------------------- | --------------------------------------- |
| `00-adsCap-0-legacy`  | no cap (regression baseline for cost)   |
| `01`–`05-adsCap-*`    | pure sweep: 2 / 4 / 6 / 8 / 12          |
| `06`–`09-*-noteBake*` | interaction with `maxNoteBakeDuration`  |
| `10`–`12-*-tile*`     | interaction with `maxTiledNoteDuration` |
| `13-combo-tight-pads` | aggressive for pad-heavy songs          |
| `14-combo-balanced`   | default-ish balance                     |
| `15-combo-loose`      | longer bakes, more headroom             |

## How to read results

Primary (lower is better, with `late=0`):

- **bakeMax / bakeP95** — hitch size from ADS / noteBake spikes
- **bakeAvg** — overall tile bake cost
- **simpleSum / mixSum** — body vs mix cost
- **gateWaitAvg** — bake gate congestion

Secondary:

- Console lines `[midy] ads-bake-cap | …` — how often the cap fires
- Console lines `[midy] ads-bake-size | …` — post-cap buffer size (~MB)

Pick the lowest `bakeMax` row with `late=0` and no audible pitch/envelope
regressions on pad instruments, then lock that `maxAdsBakeDuration` in the
game/browser settings.

## Single-value smoke

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --set cacheMode=chunk \
  --set maxAdsBakeDuration=4 \
  --set debug=true \
  --max-play-sec 60 \
  --out-dir ./bench-logs-ads-cap-smoke
```
