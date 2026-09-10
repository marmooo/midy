// fluidsynth ↔ midy conformance pipeline (entry / docs).
//
// The original monolithic file has been split for maintainability:
//
//   compare-common.ts            shared constants, asserts, render helpers
//   compare-basic.test.ts        single note, exclusive hi-hat, closed-hat retrigger
//   compare-pitch.test.ts        pitch bend, RPN pitch-bend range
//   compare-controllers.test.ts  CC7/10/11, sustain, all-off, CC1 modulation
//   compare-dynamics.test.ts     velocity soft/loud
//   compare-polyphony.test.ts    two-note polyphony (WIP — run explicitly)
//
// Scenario MIDI builders live in gen-midi-scenarios.ts (incl. modulation).
//
// Usage (main suite; excludes WIP polyphony):
//   deno test -A tools/compare-basic.test.ts \
//               tools/compare-pitch.test.ts \
//               tools/compare-controllers.test.ts \
//               tools/compare-dynamics.test.ts
//
// Polyphony (known-fail / deeper work):
//   deno test -A tools/compare-polyphony.test.ts
//
// WAV outputs land in /tmp/midy-gm2-check for manual inspection.
//
// This file intentionally contains no Deno.test cases so it can stay as a
// pointer without double-running suites when you `deno test tools/`.

export {};
