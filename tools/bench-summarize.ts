#!/usr/bin/env -S deno run -A
/**
 * Summarize bench-main-load logs into a comparison table.
 *
 * Usage:
 *   deno run -A tools/bench-summarize.ts ./bench-logs-tune
 *   deno run -A tools/bench-summarize.ts ./bench-logs-tune --csv
 *   deno run -A tools/bench-summarize.ts ./bench-logs-tune --sort bakeMax
 */

const METRIC_KEYS = [
  "config",
  "bundle",
  "elapsedMs",
  "wallMs",
  "totalTimeSec",
  "rtf",
  "timedOut",
  "prerollWallMs",
  "mainBusyPct",
  "workerMixMs",
  "avgProcUs",
  "tiles",
  "bakeAvg",
  "bakeP50",
  "bakeP95",
  "bakeMax",
  "gateWaitAvg",
  "late",
  "dropped",
  "simpleSum",
  "mixSum",
  "mixMainMs",
  "mixWorkerMs",
  "mixMainRatio",
  "parallelTiles",
  "sharedTiles",
  "fallbackTiles",
  "timeSplitTiles",
  "partsAvg",
  "combineSum",
  "residualSum",
  "cacheHit",
  "clsTiled",
  "clsNoteBake",
  "clsWorkletOffline",
  "clsExclBake",
] as const;

type Row = Record<string, string | number>;

function parseLog(text: string, configHint: string): Row {
  const row: Row = { config: configHint };

  const m = (re: RegExp) => text.match(re);

  const pipe = m(
    /\[midy\] chunk-pipeline \| tiles=(\d+) bakeAvg=([\d.]+)ms bakeP50=([\d.]+)ms bakeP95=([\d.]+)ms bakeMax=([\d.]+)ms[\s\S]*?gateWaitAvg=([\d.]+)ms[\s\S]*?late=(\d+)[\s\S]*?dropped=(\d+)/,
  );
  if (pipe) {
    row.tiles = +pipe[1];
    row.bakeAvg = +pipe[2];
    row.bakeP50 = +pipe[3];
    row.bakeP95 = +pipe[4];
    row.bakeMax = +pipe[5];
    row.gateWaitAvg = +pipe[6];
    row.late = +pipe[7];
    row.dropped = +pipe[8];
  }

  const bakeParts = m(
    /\[midy\] chunk-bake-parts \|[\s\S]*?simpleSum=([\d.]+)ms[\s\S]*?mixSum=([\d.]+)ms/,
  );
  if (bakeParts) {
    row.simpleSum = +bakeParts[1];
    row.mixSum = +bakeParts[2];
  }

  const mainThread = m(
    /\[midy\] main-thread \| mixMainMs=([\d.]+) mixWorkerMs=([\d.]+)[\s\S]*?mixMainRatio=([\d.]+)%/,
  );
  if (mainThread) {
    row.mixMainMs = +mainThread[1];
    row.mixWorkerMs = +mainThread[2];
    row.mixMainRatio = +mainThread[3];
  } else {
    const offload = m(
      /\[midy\] offload \| mixMainTiles=\d+ mixWorkerTiles=\d+ mixMainRatio=([\d.]+)%/,
    );
    if (offload) row.mixMainRatio = +offload[1];
    const mixParts = m(
      /\[midy\] chunk-mix-parts \|[\s\S]*?residualSum=([\d.]+)ms[\s\S]*?mainSum=([\d.]+)ms/,
    );
    if (mixParts) {
      row.residualSum = +mixParts[1];
      row.mixMainMs = +mixParts[2];
    }
  }

  const residual = m(/residualSum=([\d.]+)ms/);
  if (residual && row.residualSum === undefined) {
    row.residualSum = +residual[1];
  }

  const parallel = m(
    /\[midy\] chunk-mix-parallel \|[\s\S]*?parallelTiles=(\d+)[\s\S]*?timeSplitTiles=(\d+)[\s\S]*?sharedTiles=(\d+)[\s\S]*?(?:fallbackTiles=(\d+)[\s\S]*?)?partsAvg=([\d.]+)[\s\S]*?combineSum=([\d.]+)ms/,
  );
  if (parallel) {
    row.parallelTiles = +parallel[1];
    row.timeSplitTiles = +parallel[2];
    row.sharedTiles = +parallel[3];
    if (parallel[4] !== undefined) row.fallbackTiles = +parallel[4];
    row.partsAvg = +parallel[5];
    row.combineSum = +parallel[6];
  }

  const cache = m(
    /\[midy\] note-cache \| simple: hit=\d+ miss=\d+ rate=([\d.]+)%/,
  );
  if (cache) row.cacheHit = +cache[1];

  // segment-classify | tiled=N noteBake=N workletOffline=N|adsFallback=N exclBake=N
  const cls = m(
    /\[midy\] segment-classify \| tiled=(\d+) noteBake=(\d+)(?: (?:workletOffline|adsFallback)=(\d+))?[^\n]*exclBake=(\d+)/,
  );
  if (cls) {
    row.clsTiled = +cls[1];
    row.clsNoteBake = +cls[2];
    if (cls[3] !== undefined) row.clsWorkletOffline = +cls[3];
    row.clsExclBake = +cls[4];
  }

  const finished = m(
    /\[bench\] play finished elapsedMs=([\d.]+) timedOut=(true|false)(?: totalTime=([\d.]+)s)?/,
  );
  if (finished) {
    row.elapsedMs = Math.round(+finished[1]);
    row.timedOut = finished[2];
    if (finished[3] !== undefined) row.totalTimeSec = +finished[3];
  } else {
    const host = m(/"timedOut":\s*(true|false)/);
    if (host) row.timedOut = host[1];
    const el = m(/"elapsedMs":\s*([\d.]+)/);
    if (el) row.elapsedMs = Math.round(+el[1]);
  }

  // Host wall clock (includes Chrome page setup); secondary to elapsedMs.
  const wall = m(/wallMs=([\d.]+)/);
  if (wall) row.wallMs = Math.round(+wall[1]);
  const wallJson = m(/"wallMs":\s*([\d.]+)/);
  if (wallJson && row.wallMs === undefined) {
    row.wallMs = Math.round(+wallJson[1]);
  }

  // totalTime from start-play line if not on finished line.
  if (row.totalTimeSec === undefined) {
    const tt = m(/\[bench\] start play[^\n]*totalTime=([\d.]+)s/);
    if (tt) row.totalTimeSec = +tt[1];
  }
  // Realtime factor: elapsed / song length. 1.0 = realtime, lower = faster.
  if (
    typeof row.elapsedMs === "number" &&
    typeof row.totalTimeSec === "number" &&
    row.totalTimeSec > 0
  ) {
    row.rtf = +(row.elapsedMs / 1000 / row.totalTimeSec).toFixed(3);
  }

  const bundleLine = m(/\[bench\] bundle=([\w-]+) import=/);
  if (bundleLine) row.bundle = bundleLine[1];
  else {
    const b2 = m(/\[bench\] start play bundle=([\w-]+)/);
    if (b2) row.bundle = b2[1];
  }

  const playLoad = m(
    /\[midy\] play-load \|[^\n]*mainBusyPct=([\d.]+)%[^\n]*workerMixMs=([\d.]+)/,
  );
  if (playLoad) {
    row.mainBusyPct = +playLoad[1];
    row.workerMixMs = +playLoad[2];
  }

  const worklet = m(
    /\[midy\] worklet-hybrid \|[^\n]*avgProcUs=([\d.]+)/,
  );
  if (worklet) row.avgProcUs = +worklet[1];

  const preroll = m(
    /\[midy\] preroll done \|[^\n]*wall=([\d.]+)ms/,
  );
  if (preroll) row.prerollWallMs = +preroll[1];

  return row;
}

function configFromFilename(name: string): string {
  // e.g. shk_mid_215__01-bakes3.log → 01-bakes3
  const base = name.replace(/\.log$/, "");
  const parts = base.split("__");
  return parts.length > 1 ? parts.slice(1).join("__") : base;
}

function fmt(v: string | number | undefined, digits = 1): string {
  if (v === undefined || v === "") return "-";
  if (typeof v === "string") return v;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(digits);
}

function printTable(rows: Row[], sortKey: string) {
  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(a.config).localeCompare(String(b.config));
  });

  // Cross-mode comparison first; chunk-only bake metrics still available via --csv.
  const cols = [
    "config",
    "bundle",
    "elapsedMs",
    "rtf",
    "totalTimeSec",
    "timedOut",
    "prerollWallMs",
    "mainBusyPct",
    "workerMixMs",
    "avgProcUs",
    "bakeAvg",
    "bakeMax",
    "late",
    "dropped",
  ];

  const widths = cols.map((c) =>
    Math.max(
      c.length,
      ...sorted.map((r) => fmt(r[c]).length),
    )
  );

  const line = (cells: string[]) =>
    cells.map((c, i) => c.padStart(widths[i])).join("  ");

  console.log(line(cols));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of sorted) {
    console.log(line(cols.map((c) => fmt(r[c]))));
  }

  console.log(
    "\nHints: elapsedMs / rtf are the primary cross-mode speed metrics.",
  );
  console.log(
    "       rtf = elapsed/songLength (<1 faster than realtime). timedOut=true → discard that row.",
  );
  console.log(
    "       prerollWallMs = startup cost; mainBusyPct / avgProcUs = live CPU shape.",
  );
  console.log(
    "       bakeAvg/bakeMax only apply to segment/chunk tiles (others stay - or 0).",
  );
  console.log(
    "       Full columns: --csv. Sort: --sort elapsedMs|rtf|prerollWallMs|bakeMax",
  );
}

function printCsv(rows: Row[]) {
  const cols = [...METRIC_KEYS];
  console.log(cols.join(","));
  for (const r of rows) {
    console.log(cols.map((c) => fmt(r[c])).join(","));
  }
}

async function main() {
  const args = Deno.args;
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(
      `Usage: deno run -A tools/bench-summarize.ts <log-dir> [--csv] [--sort bakeMax]

Parses *.log from bench-main-load and prints a comparison table.
`,
    );
    Deno.exit(args.length === 0 ? 1 : 0);
  }

  const dir = args.find((a) => !a.startsWith("--")) ?? "./bench-logs";
  const csv = args.includes("--csv");
  const sortIdx = args.indexOf("--sort");
  const sortKey = sortIdx >= 0
    ? (args[sortIdx + 1] ?? "elapsedMs")
    : "elapsedMs";

  const rows: Row[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".log")) continue;
    const text = await Deno.readTextFile(`${dir}/${e.name}`);
    rows.push(parseLog(text, configFromFilename(e.name)));
  }

  if (rows.length === 0) {
    console.error(`No .log files in ${dir}`);
    Deno.exit(1);
  }

  if (csv) printCsv(rows);
  else printTable(rows, sortKey);
}

if (import.meta.main) {
  await main();
}
