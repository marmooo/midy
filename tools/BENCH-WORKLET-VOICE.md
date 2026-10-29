# workletVoiceLimit tune

Sweep **worklet polyphony policy** only. This is separate from the chunk
simple/almost-simple bake sweep
([`BENCH-SIMPLE-BAKE.md`](./BENCH-SIMPLE-BAKE.md)).

Uses:

- `tools/bench-main-load.ts`
- `tools/bench-configs.worklet-voice.json`

## What the knob does

| `workletVoiceLimit`   | Effect                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `"unlimited"`         | Default. Only the processor hard ceiling (`WORKLET_MAX_VOICES`, typically 1024). Long sustains keep sounding. |
| `"match"`             | Same `maxVoices` / `maxPedalVoices` rules as non-worklet modes (enforce before noteOn).                       |
| number (e.g. 64, 128) | Explicit main-thread cap for worklet only (still bounded by the processor hard max).                          |

Only consulted when `cacheMode === "worklet"`.

## Important: do not use bench-summarize for ranking

`bench-summarize.ts` keys off **chunk-pipeline** lines (`bakeMax`, `simpleSum`,
…). Worklet mode does **not** emit those, so the table will show all zeros even
when the run succeeded.

Read the raw log instead, especially:

```
[midy] worklet-perf | … peakActive=…/1024 avgActive=… overruns=… stealWorklet=… stealMain=… …
[midy] play-load | mode=worklet glitch=… (overruns) …
[bench] play finished elapsedMs=… timedOut=… totalTime=…
```

### Metrics that matter for worklet

| Metric                       | Where                           | Good direction                                         |
| ---------------------------- | ------------------------------- | ------------------------------------------------------ |
| `overruns`                   | worklet-perf / play-load glitch | lower                                                  |
| `peakActive` / `avgActive`   | worklet-perf                    | context (polyphony pressure)                           |
| `stealWorklet` / `stealMain` | worklet-perf                    | lower (unless you intentionally cap)                   |
| `audioBusyPct` / `processMs` | play-load / worklet-perf        | lower                                                  |
| `timedOut`                   | play finished                   | `true` OK on 60s quick pass; want `false` on full song |

## Quick pass (60s — expect timedOut=true)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.worklet-voice.json \
  --max-play-sec 60 \
  --out-dir ./bench-logs-worklet-voice60
```

Compare with:

```bash
grep -h 'worklet-perf' ./bench-logs-worklet-voice60/*.log
grep -h 'play-load' ./bench-logs-worklet-voice60/*.log
```

## Full song

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/shk_mid_215.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.worklet-voice.json \
  --max-play-sec 200 \
  --out-dir ./bench-logs-worklet-voice

grep -h 'worklet-perf' ./bench-logs-worklet-voice/*.log
```

## Config map

| name           | workletVoiceLimit       |
| -------------- | ----------------------- |
| `00-unlimited` | `"unlimited"` (default) |
| `01-match`     | `"match"`               |
| `02-limit64`   | `64`                    |
| `03-limit128`  | `128`                   |
| `04-limit256`  | `256`                   |

## Healthy run checklist

You should see near the start:

```
[bench] set cacheMode="worklet"
[worklet] ensureWorkletEngine ok …
[worklet] preload done entries=… uploaded=…
```

Near the end:

```
[midy] worklet-perf | wall=… peakActive=… overruns=… …
[bench] play finished elapsedMs=… timedOut=… totalTime=…
```

If `ensureWorkletEngine` fails or there is no `worklet-perf` line, the worklet
path did not run — check headless AudioWorklet support and the built
`dist/midy.js`.

## Related

- Chunk simple bake: [`BENCH-SIMPLE-BAKE.md`](./BENCH-SIMPLE-BAKE.md)
- Main load harness: [`BENCH-MAIN-LOAD.md`](./BENCH-MAIN-LOAD.md)
