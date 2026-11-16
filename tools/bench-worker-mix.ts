/**
 * Diagnostic micro-bench for BakeWorkerPool mix / mixParallel / mixTimeSplit.
 *
 * Run from midy repo root (after unzip):
 *   deno run -A tools/bench-worker-mix.ts
 *
 * Optional:
 *   POOL=4 ENTRIES=48 DEST=32768 SRC=8192 ITERS=10 deno run -A tools/bench-worker-mix.ts
 *
 * Deno uses module Workers (classic Workers are unsupported).
 * Browser: same API via the normal classic Worker path in BakeWorkerPool.
 */

import {
  BakeWorkerPool,
  type MixSourceEntry,
} from "../src/bake-worker-pool.ts";

function makeEntries(
  n: number,
  destLen: number,
  srcLen: number,
): MixSourceEntry[] {
  const out: MixSourceEntry[] = [];
  for (let i = 0; i < n; i++) {
    const left = new Float32Array(srcLen);
    const right = new Float32Array(srcLen);
    for (let s = 0; s < srcLen; s++) {
      left[s] = ((s + i) & 255) * 0.001;
      right[s] = ((s + i * 3) & 127) * 0.001;
    }
    const start = Math.floor((i * (destLen - srcLen)) / Math.max(1, n - 1));
    out.push({
      left,
      right,
      startSample: Math.max(0, start),
      gain: 0.7,
      gainRight: 0.65,
    });
  }
  return out;
}

async function timeOne(
  label: string,
  fn: () => Promise<{
    workerMs?: number;
    combineMs?: number;
    parts?: number;
    timeSplit?: boolean;
  }>,
  iters: number,
) {
  await fn(); // warmup
  let worker = 0;
  let combine = 0;
  let parts = 0;
  let timeSplit = false;
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const r = await fn();
    worker += r.workerMs ?? 0;
    combine += r.combineMs ?? 0;
    parts = r.parts ?? parts;
    timeSplit = !!r.timeSplit;
  }
  const wall = performance.now() - t0;
  console.log(
    `${label.padEnd(28)} wall=${(wall / iters).toFixed(2)}ms ` +
      `worker=${(worker / iters).toFixed(2)}ms ` +
      `combine=${(combine / iters).toFixed(2)}ms ` +
      `parts=${parts} timeSplit=${timeSplit}`,
  );
}

async function main() {
  const poolSize = Number(Deno.env.get("POOL") ?? "4");
  const entriesN = Number(Deno.env.get("ENTRIES") ?? "32");
  const destLen = Number(Deno.env.get("DEST") ?? "16384");
  const srcLen = Number(Deno.env.get("SRC") ?? "4096");
  const iters = Number(Deno.env.get("ITERS") ?? "8");

  const pool = new BakeWorkerPool(poolSize);
  const entries = makeEntries(entriesN, destLen, srcLen);

  console.log(
    `pool=${pool.poolSize} entries=${entriesN} dest=${destLen} src=${srcLen} iters=${iters}`,
  );
  console.log(
    `runtime=${
      typeof Deno !== "undefined"
        ? "deno(module-worker)"
        : "browser/classic-worker"
    }`,
  );

  try {
    await timeOne(
      "mix (single worker job)",
      () => pool.mix(entries, destLen, 2, false),
      iters,
    );
    await timeOne(
      "mixParallel",
      () => pool.mixParallel(entries, destLen, 2, false),
      iters,
    );
    await timeOne(
      "mixTimeSplit(force 4)",
      () => pool.mixTimeSplit(entries, destLen, 2, 4),
      iters,
    );

    const sparse = makeEntries(3, destLen * 2, srcLen * 2);
    await timeOne(
      "mixParallel sparse×2dest",
      () => pool.mixParallel(sparse, destLen * 2, 2, false),
      iters,
    );
  } finally {
    pool.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
