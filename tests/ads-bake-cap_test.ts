// Removed: ADS lean path (maxAdsBakeDuration / createAdsRenderedBuffer) no longer exists.
// Ultra-long notes use worklet hybrid (or main-thread residual when AudioWorklet is unavailable).
// Keep this file so old docs/links do not 404; tests are intentionally empty.

import { assertEquals } from "@std/assert";

Deno.test("ads-bake-cap: API removed (placeholder)", () => {
  assertEquals(true, true);
});
