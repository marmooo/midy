// fluidsynth ↔ midy conformance pipeline (entry / docs).
//
// The original monolithic file has been split for maintainability:
//
//   compare-common.ts            shared constants, asserts, render helpers
//   compare-basic.test.ts        single note, exclusive hi-hat, closed-hat retrigger
//   compare-pitch.test.ts        pitch bend, RPN pitch-bend range
//   compare-controllers.test.ts  CC7/10/11, sustain, all-off, CC1 modulation
//   compare-dynamics.test.ts     velocity soft/loud
//   compare-polyphony.test.ts    two-note polyphony
//
// Scenario MIDI builders live in gen-midi-scenarios.ts (incl. modulation).
//
// Usage:
//   deno test -A tools/compare-basic.test.ts \
//                tools/compare-pitch.test.ts \
//                tools/compare-controllers.test.ts \
//                tools/compare-dynamics.test.ts \
//                tools/compare-polyphony.test.ts \
//                tools/compare-almost-simple.test.ts
//
// Speed knobs (env):
//   MIDY_QUICK=1                 24 kHz + cacheModes=note,chunk (~3–5× faster)
//   MIDY_CACHE_MODES=note,audio  only listed modes
//   MIDY_SAMPLE_RATE=22050       custom rate (fluidsynth + midy must match)
//   MIDY_NO_BROWSER_REUSE=1      fresh Chrome per render (slower; for debug)
//   MIDY_CHROME_STATE_DIR=/tmp/…  shared Chrome lock/endpoint dir (parallel workers)
//
// Chrome is shared across parallel test workers (one process). Interrupted
// runs (Ctrl+C) tear down Chrome via signal handlers; leftover PIDs can be
// cleaned with: rm -rf /tmp/midy-chrome-state && pkill -f 'chrome.*puppeteer'
//
// WAV outputs land in /tmp/midy-gm2-check for manual inspection.
//
// This file intentionally contains no Deno.test cases so it can stay as a
// pointer without double-running suites when you `deno test tools/`.

export {};
