# bench-main-load — realtime main-thread load batch runner

Runs midy in **realtime playback** under headless Chromium and saves the full
browser console output to files.

Uses `player.start()` instead of offline `render()`, so the same code paths as a
local browser run are exercised (`preferWorkerMixDuringLive`,
`updateChunkPipeline`, etc.).

## Requirements

- Deno
- Chromium (downloaded by Puppeteer, or specify with `--executable-path`)
- Built `dist/midy.js` (must be visible from the repo root)

```bash
# Example: use a build that includes preferWorker* flags
cp /path/to/midy.js dist/midy.js
```

## Usage

### Single song × inline settings

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./songs/foo.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --set cacheMode=chunk \
  --set debug=true \
  --set useWorkerTypedArrayMix=true \
  --set workerMixMinEntries=1 \
  --set preferWorkerMixDuringLive=false \
  --set preferWorkerBakeDuringLive=false \
  --out-dir ./bench-logs
```

### Main-thread minimisation (games / shared main)

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./tools/op1a.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --set cacheMode=chunk \
  --set prerollSec=20 \
  --set debug=true \
  --set useWorkerTypedArrayMix=true \
  --set workerMixMinEntries=1 \
  --set preferWorkerMixDuringLive=true \
  --set preferWorkerBakeDuringLive=true \
  --max-play-sec 200 \
  --out-dir ./bench-logs
```

### Multiple configs × multiple songs

```bash
deno run -A tools/bench-main-load.ts \
  --midi-dir ./songs \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --configs ./tools/bench-configs.example.json \
  --out-dir ./bench-logs
```

### Arbitrary Midy properties

`--set key=value` assigns values directly to the Midy / Player instance.

- Supports `true` / `false` / numbers / strings
- JSON is also allowed: `--set 'foo={"a":1}'`

Unknown keys emit a warning but the assignment is still attempted.

## Output

```
bench-logs/
  songA__baseline.log      # full browser console
  songA__worker-mix.log
  ...
  manifest.json            # run metadata
```

Log contents match the format of the local browser DevTools console.

### Metrics to compare (main-thread load)

After a run finishes (`debug=true`), grep:

```bash
grep -h 'main-thread \|offload \|chunk-mix-parts\|chunk-pipeline\|chunk-bake-parts' bench-logs/*.log
```

Key lines:

| Line                                                                | What it means                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `[midy] main-thread \| mixMainMs=… mixWorkerMs=… mixMainRatio=…%`   | **Primary target.** Lower `mixMainMs` / `mixMainRatio` = less main-thread mix work |
| `[midy] offload \| mixMainTiles=… mixWorkerTiles=… mixMainRatio=…%` | Same split, easy to grep                                                           |
| `[midy] chunk-mix-parts \| … mainSum=… workerSum=…`                 | Detailed mix-phase timing                                                          |
| `[midy] chunk-pipeline \| … late=… dropped=…`                       | Playback health (should stay `late=0 dropped=0`)                                   |
| `[midy] chunk-bake-parts \| simpleSum=… mixSum=…`                   | Bake vs mix wall inside tiles                                                      |

Example A/B:

```text
# baseline (live mix on main)
main-thread | mixMainMs=5093 mixWorkerMs=1298 mixMainRatio=88.3% liveMix=main

# preferWorkerMixDuringLive=true
main-thread | mixMainMs=…   mixWorkerMs=…   mixMainRatio=…%  liveMix=worker
```

Trade-off: lower main occupancy may raise per-tile latency / residual. Watch
`late` and `dropped` on `chunk-pipeline`.

## Notes

- Times out after song length + a few seconds (override with `--max-play-sec`)
- Launches Chrome with `--mute-audio` (no sound)
- `debug=true` is recommended (forced on by the harness if not set)
- Puppeteer `protocolTimeout` defaults to 10 minutes so long songs can finish
  inside one `page.evaluate`
