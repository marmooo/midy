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
# Example: use the latest offload build
cp /path/to/midy-main-offload.js dist/midy.js
```

## Usage

### Single song × inline settings

```bash
deno run -A tools/bench-main-load.ts \
  --midi ./songs/foo.mid \
  --sf3 ./tools/GeneralUser_GS_v1.472.sf3 \
  --set cacheMode=chunk \
  --set debug=true \
  --set preferWorkerMixDuringLive=true \
  --set preferWorkerBakeDuringLive=true \
  --set maxTiledNoteDuration=16 \
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
  songA__main-offload.log
  ...
  manifest.json            # run metadata
```

Log contents match the format of the local browser DevTools console (e.g.
`[midy] main-summary`).

No CSV is produced. Grep for `main-summary` / `offload` lines afterward if
needed:

```bash
grep -h 'main-summary\|offload \|chunk-pipeline' bench-logs/*.log
```

## Notes

- Times out after song length + a few seconds (override with `--max-play-sec`)
- Launches Chrome with `--mute-audio` (no sound)
- `debug=true` is recommended (forced on by the harness if not set)
