// Worker pool for pure TypedArray bake work:
//
//   1) Tile-level multi-buffer mix (segment / chunk):
//        simpleHits + complexBufs → dest
//      One (or a few parallel) postMessage(s) per tile — the intended path
//      for high-throughput segment/chunk modes.
//
//   2) Note-level simple-note sample render (note / ads / adsr):
//        resample + loop + optional lowpass + gains
//      Useful to keep the main thread free during realtime onsets.
//
//   3) Batch simple-note render (segment / chunk tile misses):
//        type:"renderSamplesBatch" — many notes in one postMessage.
//      Preferred for chunk/segment: amortizes queue + postMessage cost
//      vs per-note jobs while still offloading the sample loop from main
//      (keeps residual low so mix onmessage can complete promptly).
//
// Uses structured clone by default; Transferable ArrayBuffers when requested
// to minimise copy cost for large PCM payloads.
//
// Curve computation (ADSR / filter / pan) stays on the main thread.

export type MixSourceEntry = {
  /** Left (or mono) channel data. */
  left: Float32Array;
  /** Right channel data (optional). */
  right?: Float32Array;
  /** Start offset in destination samples. */
  startSample: number;
  /** Left (or mono) scale. */
  gain: number;
  /**
   * Right scale. When omitted, `gain` is used for both channels.
   * Used by chunk dry-simple path: note buffers are unity-gain; pan/vol
   * are applied here so the same dry buffer can be reused across onsets.
   */
  gainRight?: number;
  /**
   * Optional per-sample gain curve (length >= copyLen). Multiplied with
   * `gain` / `gainRight` at each sample. Used by chunk dry-simple path for
   * mid-note volume/expression (CC7/CC11) so the dry buffer stays shared
   * across different expression trajectories.
   */
  gainCurve?: Float32Array;
};

export type MixResult = {
  left: Float32Array;
  right?: Float32Array;
  /** Wall time spent inside the worker mix loop (ms). Sum when parallel. */
  workerMs?: number;
  /** Time from enqueue until postMessage is called (pool queue wait, ms). */
  queueMs?: number;
  /** Duration of the main-thread postMessage call itself (clone/transfer, ms). */
  postMs?: number;
};

/** One tile mix job for {@link BakeWorkerPool.mixBatch}. */
export type MixBatchJob = {
  entries: MixSourceEntry[];
  destLen: number;
  destChCount: 1 | 2;
};

export type MixBatchResult = {
  /** One result per input job, same order. */
  results: MixResult[];
  /** Time from enqueue until postMessage is called (pool queue wait, ms). */
  queueMs?: number;
  /** Duration of the main-thread postMessage call itself (clone/transfer, ms). */
  postMs?: number;
};

export type RenderSampleParams = {
  /** Source PCM channels (mono or stereo). */
  srcChannels: Float32Array[];
  srcRate: number;
  destRate: number;
  destLen: number;
  destChCount: 1 | 2;
  playbackRate: number;
  isLoop: boolean;
  loopStartSrc: number;
  loopEndSrc: number;
  startOffsetSrc: number;
  gains: Float32Array;
  filterFreqs: Float32Array | null;
  filterQ: number;
  /**
   * Optional per-destination-sample rate multipliers (almost-simple pitch
   * bend). When set, srcPos advances by baseStep * rateMultipliers[i].
   * Same length as destLen; omitted / null → constant playbackRate.
   */
  rateMultipliers?: Float32Array | null;
};

export type RenderSampleResult = {
  /** Destination channels (length = destChCount). */
  channels: Float32Array[];
};

export type RenderSamplesBatchResult = {
  /** One result per input params entry, same order. */
  results: RenderSampleResult[];
};

type AnyResult =
  | MixResult
  | MixBatchResult
  | RenderSampleResult
  | RenderSamplesBatchResult;

type Pending = {
  resolve: (r: AnyResult) => void;
  reject: (e: Error) => void;
  /** performance.now() when the job entered enqueue. */
  enqueuedAt: number;
  /** Set when postMessage is about to run: queue wait so far. */
  queueMs?: number;
  /** Set after postMessage returns: duration of that call. */
  postMs?: number;
};

type QueuedJob = {
  worker?: Worker;
  // deno-lint-ignore no-explicit-any
  request: any;
  transfer: Transferable[];
  pending: Pending;
  /**
   * Lower runs first. Mix/mixBatch are 0 (playback-critical); sample bake
   * (renderSample / renderSamplesBatch) is 1. Prevents long note-bakes from
   * starving tile mix and inflating awaitAvg / residual.
   */
  priority: number;
};

function jobPriority(request: { type?: string }): number {
  const t = request?.type;
  if (t === "mix" || t === "mixBatch") return 0;
  return 1;
}

/**
 * Pool of dedicated workers for TypedArray mix + simple-note sample render.
 *
 * - size 0 → auto (min(4, hardwareConcurrency || 2))
 * - Workers are created lazily on first use.
 * - Transferable path detaches source buffers; callers must not reuse them
 *   after enqueue when useTransferable is true.
 */
export class BakeWorkerPool {
  private workers: Worker[] = [];
  private free: Worker[] = [];
  private queue: QueuedJob[] = [];
  private pendingById = new Map<number, Pending>();
  private nextId = 1;
  private readonly size: number;
  private started = false;
  private workerUrl: string | null = null;

  /** Minimum number of mix entries before offloading to a worker is worth it. */
  /** Aligned with Player.workerMixMinEntries default (1). */
  static readonly MIN_ENTRIES_FOR_WORKER = 1;

  /** Minimum dest length (samples) before simple-note render is offloaded. */
  static readonly MIN_SAMPLES_FOR_RENDER = 2048;

  constructor(size = 0) {
    const hw = typeof navigator !== "undefined"
      ? (navigator.hardwareConcurrency || 2)
      : 2;
    this.size = size > 0 ? size : Math.max(1, Math.min(4, hw));
  }

  /** Number of worker threads in the pool. */
  get poolSize(): number {
    return this.size;
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;

    // Inline worker via Blob (no separate network fetch). Handles:
    //   - type:"mix"          → multi-buffer additive mix
    //   - type:"renderSample" → resample + loop + optional biquad + gains
    const workerSource = `
function biquadLowpassCoeffs(freq, q, sampleRate) {
  var nyquist = sampleRate * 0.5;
  var f = freq;
  if (f < 10) f = 10;
  if (f > nyquist - 1) f = nyquist - 1;
  var w0 = 2 * Math.PI * f / sampleRate;
  var cosw0 = Math.cos(w0);
  var sinw0 = Math.sin(w0);
  var alpha = sinw0 / (2 * Math.max(q, 0.001));
  var b0n = (1 - cosw0) * 0.5;
  var b1n = 1 - cosw0;
  var b2n = (1 - cosw0) * 0.5;
  var a0 = 1 + alpha;
  var a1n = -2 * cosw0;
  var a2n = 1 - alpha;
  var invA0 = 1 / a0;
  return {
    b0: b0n * invA0,
    b1: b1n * invA0,
    b2: b2n * invA0,
    a1: a1n * invA0,
    a2: a2n * invA0
  };
}

function mixEntriesInto(destLeft, destRight, destLen, entries) {
  for (var ei = 0; ei < entries.length; ei++) {
    var e = entries[ei];
    var start = e.startSample | 0;
    if (start >= destLen) continue;
    var srcLeft = e.left;
    var srcLen = srcLeft.length;
    var copyLen = Math.min(srcLen, destLen - start);
    if (copyLen <= 0) continue;
    var curve = e.gainCurve;
    var gL = e.gain;
    var gR = e.gainRight != null ? e.gainRight : e.gain;
    var i = 0;
    var di = start;
    if (destRight === null) {
      // Equal-power mono: center pan (0.707,0.707) → gain 1, not -3 dB.
      var gMono = (e.gainRight != null) ? Math.sqrt(gL * gL + gR * gR) : gL;
      if (curve) {
        if (gMono === 1) {
          while (i < copyLen) {
            destLeft[di] += srcLeft[i] * curve[i];
            i++; di++;
          }
        } else {
          while (i < copyLen) {
            destLeft[di] += srcLeft[i] * gMono * curve[i];
            i++; di++;
          }
        }
      } else if (gMono === 1) {
        // Hot: mono unity gain — no mul, running dest index
        var n = copyLen - 3;
        while (i < n) {
          destLeft[di] += srcLeft[i];
          destLeft[di + 1] += srcLeft[i + 1];
          destLeft[di + 2] += srcLeft[i + 2];
          destLeft[di + 3] += srcLeft[i + 3];
          i += 4; di += 4;
        }
        while (i < copyLen) {
          destLeft[di] += srcLeft[i];
          i++; di++;
        }
      } else {
        var n2 = copyLen - 3;
        while (i < n2) {
          destLeft[di] += srcLeft[i] * gMono;
          destLeft[di + 1] += srcLeft[i + 1] * gMono;
          destLeft[di + 2] += srcLeft[i + 2] * gMono;
          destLeft[di + 3] += srcLeft[i + 3] * gMono;
          i += 4; di += 4;
        }
        while (i < copyLen) {
          destLeft[di] += srcLeft[i] * gMono;
          i++; di++;
        }
      }
    } else {
      var srcRight = e.right || srcLeft;
      if (curve) {
        if (gL === 1 && gR === 1) {
          while (i < copyLen) {
            var cg0 = curve[i];
            destLeft[di] += srcLeft[i] * cg0;
            destRight[di] += srcRight[i] * cg0;
            i++; di++;
          }
        } else {
          while (i < copyLen) {
            var cg = curve[i];
            destLeft[di] += srcLeft[i] * gL * cg;
            destRight[di] += srcRight[i] * gR * cg;
            i++; di++;
          }
        }
      } else if (gL === 1 && gR === 1) {
        // Hottest path: stereo, no curve, unity gain
        var n3 = copyLen - 3;
        while (i < n3) {
          destLeft[di] += srcLeft[i];
          destRight[di] += srcRight[i];
          destLeft[di + 1] += srcLeft[i + 1];
          destRight[di + 1] += srcRight[i + 1];
          destLeft[di + 2] += srcLeft[i + 2];
          destRight[di + 2] += srcRight[i + 2];
          destLeft[di + 3] += srcLeft[i + 3];
          destRight[di + 3] += srcRight[i + 3];
          i += 4; di += 4;
        }
        while (i < copyLen) {
          destLeft[di] += srcLeft[i];
          destRight[di] += srcRight[i];
          i++; di++;
        }
      } else if (gL === gR) {
        // Common: same gain both channels (no pan split)
        var g = gL;
        var n4 = copyLen - 3;
        while (i < n4) {
          destLeft[di] += srcLeft[i] * g;
          destRight[di] += srcRight[i] * g;
          destLeft[di + 1] += srcLeft[i + 1] * g;
          destRight[di + 1] += srcRight[i + 1] * g;
          destLeft[di + 2] += srcLeft[i + 2] * g;
          destRight[di + 2] += srcRight[i + 2] * g;
          destLeft[di + 3] += srcLeft[i + 3] * g;
          destRight[di + 3] += srcRight[i + 3] * g;
          i += 4; di += 4;
        }
        while (i < copyLen) {
          destLeft[di] += srcLeft[i] * g;
          destRight[di] += srcRight[i] * g;
          i++; di++;
        }
      } else {
        // Stereo pan: different L/R gains
        var n5 = copyLen - 3;
        while (i < n5) {
          destLeft[di] += srcLeft[i] * gL;
          destRight[di] += srcRight[i] * gR;
          destLeft[di + 1] += srcLeft[i + 1] * gL;
          destRight[di + 1] += srcRight[i + 1] * gR;
          destLeft[di + 2] += srcLeft[i + 2] * gL;
          destRight[di + 2] += srcRight[i + 2] * gR;
          destLeft[di + 3] += srcLeft[i + 3] * gL;
          destRight[di + 3] += srcRight[i + 3] * gR;
          i += 4; di += 4;
        }
        while (i < copyLen) {
          destLeft[di] += srcLeft[i] * gL;
          destRight[di] += srcRight[i] * gR;
          i++; di++;
        }
      }
    }
  }
}

function handleMix(msg) {
  var t0 = performance.now();
  var destLen = msg.destLen;
  var destLeft = new Float32Array(destLen);
  var destRight = msg.destChCount > 1 ? new Float32Array(destLen) : null;
  mixEntriesInto(destLeft, destRight, destLen, msg.entries);
  var workerMs = performance.now() - t0;
  var transfer = [destLeft.buffer];
  if (destRight) transfer.push(destRight.buffer);
  self.postMessage(
    { type: "mix-result", id: msg.id, left: destLeft, right: destRight || undefined, workerMs: workerMs },
    transfer
  );
}

function handleMixBatch(msg) {
  var t0 = performance.now();
  var jobs = msg.jobs;
  var results = [];
  var transfer = [];
  for (var j = 0; j < jobs.length; j++) {
    var job = jobs[j];
    var destLen = job.destLen;
    var destLeft = new Float32Array(destLen);
    var destRight = job.destChCount > 1 ? new Float32Array(destLen) : null;
    mixEntriesInto(destLeft, destRight, destLen, job.entries);
    transfer.push(destLeft.buffer);
    if (destRight) transfer.push(destRight.buffer);
    results.push({ left: destLeft, right: destRight || undefined });
  }
  var workerMs = performance.now() - t0;
  // Attribute total worker time evenly so per-tile residual math stays sane.
  var per = jobs.length > 0 ? workerMs / jobs.length : 0;
  for (var r = 0; r < results.length; r++) {
    results[r].workerMs = per;
  }
  self.postMessage(
    { type: "mix-batch-result", id: msg.id, results: results, workerMs: workerMs },
    transfer
  );
}

function renderOneSample(p) {
  var srcChannels = p.srcChannels;
  var srcRate = p.srcRate;
  var destRate = p.destRate;
  var destLen = p.destLen | 0;
  var destChCount = p.destChCount | 0;
  var playbackRate = p.playbackRate;
  var isLoop = !!p.isLoop;
  var loopStartSrc = p.loopStartSrc;
  var loopEndSrc = p.loopEndSrc;
  var startOffsetSrc = p.startOffsetSrc;
  var gains = p.gains;
  var filterFreqs = p.filterFreqs;
  var filterQ = p.filterQ;
  var rateMultipliers = p.rateMultipliers || null;
  var srcChCount = srcChannels.length;
  var srcLen = srcChannels[0].length;
  var loopStartSample = loopStartSrc * srcRate;
  var loopEndSample = loopEndSrc * srcRate;
  var loopLenSample = loopEndSample - loopStartSample;
  var startSample = startOffsetSrc * srcRate;
  var baseStep = playbackRate * (srcRate / destRate);
  var useRateCurve = rateMultipliers != null && rateMultipliers.length >= destLen;
  var useFilter = filterFreqs != null;
  var out = [];
  var transfer = [];
  for (var c = 0; c < destChCount; c++) {
    var dst = new Float32Array(destLen);
    var srcData = srcChannels[Math.min(c, srcChCount - 1)];
    var srcPos = startSample;
    var z1 = 0, z2 = 0;
    var b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    var lastFreq = -1;
    for (var i = 0; i < destLen; i++) {
      var pos = srcPos;
      if (isLoop && loopLenSample > 0 && pos >= loopEndSample) {
        var over = pos - loopStartSample;
        pos = loopStartSample + (over % loopLenSample);
        if (pos < loopStartSample) pos += loopLenSample;
      }
      var x = 0;
      if (pos >= 0 && pos < srcLen - 1) {
        var i0 = Math.floor(pos);
        var frac = pos - i0;
        x = srcData[i0] + (srcData[i0 + 1] - srcData[i0]) * frac;
      } else if (pos >= 0 && pos < srcLen) {
        x = srcData[Math.floor(pos)];
      }
      if (useFilter) {
        var freq = filterFreqs[i];
        if (lastFreq < 0 || Math.abs(freq - lastFreq) > lastFreq * 0.01) {
          var coef = biquadLowpassCoeffs(freq, filterQ, destRate);
          b0 = coef.b0; b1 = coef.b1; b2 = coef.b2;
          a1 = coef.a1; a2 = coef.a2;
          lastFreq = freq;
        }
        var y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        dst[i] = y * gains[i];
      } else {
        dst[i] = x * gains[i];
      }
      var step = useRateCurve ? baseStep * rateMultipliers[i] : baseStep;
      srcPos += step;
    }
    out.push(dst);
    transfer.push(dst.buffer);
  }
  return { channels: out, transfer: transfer };
}

function handleRenderSample(msg) {
  var r = renderOneSample(msg);
  self.postMessage({ type: "render-result", id: msg.id, channels: r.channels }, r.transfer);
}

function handleRenderSamplesBatch(msg) {
  var items = msg.items;
  var results = [];
  var transfer = [];
  for (var n = 0; n < items.length; n++) {
    var r = renderOneSample(items[n]);
    results.push({ channels: r.channels });
    for (var t = 0; t < r.transfer.length; t++) {
      transfer.push(r.transfer[t]);
    }
  }
  self.postMessage({ type: "render-batch-result", id: msg.id, results: results }, transfer);
}

self.onmessage = function(ev) {
  var msg = ev.data;
  if (!msg || !msg.type) return;
  try {
    if (msg.type === "mix") {
      handleMix(msg);
    } else if (msg.type === "mixBatch") {
      handleMixBatch(msg);
    } else if (msg.type === "renderSample") {
      handleRenderSample(msg);
    } else if (msg.type === "renderSamplesBatch") {
      handleRenderSamplesBatch(msg);
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      message: err && err.message ? err.message : String(err),
    });
  }
};
`;
    const blob = new Blob([workerSource], { type: "application/javascript" });
    this.workerUrl = URL.createObjectURL(blob);

    for (let i = 0; i < this.size; i++) {
      const w = new Worker(this.workerUrl);
      w.onmessage = (ev: MessageEvent) => this.onWorkerMessage(w, ev);
      w.onerror = (err) => {
        console.error("[midy bake-worker]", err.message);
      };
      this.workers.push(w);
      this.free.push(w);
    }
  }

  private onWorkerMessage(worker: Worker, ev: MessageEvent): void {
    const data = ev.data as {
      type: string;
      id: number;
      left?: Float32Array;
      right?: Float32Array;
      channels?: Float32Array[];
      results?: {
        channels?: Float32Array[];
        left?: Float32Array;
        right?: Float32Array;
        workerMs?: number;
      }[];
      workerMs?: number;
      message?: string;
    };
    const pending = this.pendingById.get(data.id);
    if (!pending) {
      this.releaseWorker(worker);
      return;
    }
    this.pendingById.delete(data.id);

    if (data.type === "error") {
      pending.reject(new Error(data.message ?? "worker error"));
    } else if (data.type === "mix-result") {
      pending.resolve({
        left: data.left!,
        right: data.right,
        workerMs: data.workerMs,
        queueMs: pending.queueMs,
        postMs: pending.postMs,
      });
    } else if (data.type === "mix-batch-result") {
      const batchResults = (data.results ?? []).map((r) => ({
        left: r.left!,
        right: r.right,
        workerMs: r.workerMs,
        queueMs: pending.queueMs,
        postMs: pending.postMs,
      }));
      pending.resolve({
        results: batchResults,
        queueMs: pending.queueMs,
        postMs: pending.postMs,
      });
    } else if (data.type === "render-result") {
      pending.resolve({ channels: data.channels! });
    } else if (data.type === "render-batch-result") {
      const renderResults: RenderSampleResult[] = (data.results ?? []).map(
        (r) => ({ channels: r.channels! }),
      );
      pending.resolve({ results: renderResults });
    } else {
      pending.reject(new Error(`unknown worker response: ${data.type}`));
    }
    this.releaseWorker(worker);
  }

  /** Post a job to a free worker and record queue/post timings on pending. */
  private postToWorker(
    worker: Worker,
    // deno-lint-ignore no-explicit-any
    request: any,
    transfer: Transferable[],
    pending: Pending,
  ): void {
    const t0 = performance.now();
    pending.queueMs = t0 - pending.enqueuedAt;
    worker.postMessage(request, transfer);
    pending.postMs = performance.now() - t0;
  }

  /**
   * Dequeue the oldest highest-priority job (mix before bake).
   * Linear scan is fine: queue depth is typically single-digit.
   */
  private dequeueNext(): QueuedJob | undefined {
    const q = this.queue;
    if (q.length === 0) return undefined;
    let best = 0;
    let bestPri = q[0].priority;
    for (let i = 1; i < q.length; i++) {
      if (q[i].priority < bestPri) {
        best = i;
        bestPri = q[i].priority;
        if (bestPri === 0) break; // cannot beat mix priority
      }
    }
    return q.splice(best, 1)[0];
  }

  private releaseWorker(worker: Worker): void {
    const next = this.dequeueNext();
    if (next) {
      next.worker = worker;
      this.postToWorker(worker, next.request, next.transfer, next.pending);
    } else {
      this.free.push(worker);
    }
  }

  // deno-lint-ignore no-explicit-any
  private enqueue(request: any, transfer: Transferable[]): Promise<AnyResult> {
    this.ensureStarted();
    const id = request.id as number;
    return new Promise<AnyResult>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        enqueuedAt: performance.now(),
      };
      this.pendingById.set(id, pending);
      const free = this.free.pop();
      if (free) {
        this.postToWorker(free, request, transfer, pending);
      } else {
        this.queue.push({
          request,
          transfer,
          pending,
          priority: jobPriority(request),
        });
      }
    });
  }

  /**
   * Collect ArrayBuffers that appear exactly once among mix entries so they
   * can be transferred. Buffers referenced 2+ times (in-tile shared slices)
   * must stay on the structured-clone path — transferring the first ref would
   * detach the rest in the same postMessage payload.
   */
  private static collectUniqueTransferables(
    entries: MixSourceEntry[],
  ): Transferable[] {
    // Float32Array.buffer is ArrayBufferLike (ArrayBuffer | SharedArrayBuffer).
    // Only plain ArrayBuffers are transferable; skip SharedArrayBuffer.
    const counts = new Map<ArrayBuffer, number>();
    const bump = (buf: ArrayBufferLike | undefined) => {
      if (!buf || buf.byteLength === 0) return;
      if (!(buf instanceof ArrayBuffer)) return;
      counts.set(buf, (counts.get(buf) ?? 0) + 1);
    };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      bump(e.left.buffer);
      if (e.right) bump(e.right.buffer);
      if (e.gainCurve) bump(e.gainCurve.buffer);
    }
    const transfer: Transferable[] = [];
    for (const [buf, n] of counts) {
      if (n === 1) transfer.push(buf);
    }
    return transfer;
  }

  /**
   * Mix source PCM entries into a new destination of length destLen.
   *
   * When useTransferable is true, only ArrayBuffers that appear once in the
   * entry list are transferred (zero-copy). Shared in-tile slices (same
   * buffer on multiple entries) are structured-cloned so multi-ref payloads
   * stay valid.
   */
  async mix(
    entries: MixSourceEntry[],
    destLen: number,
    destChCount: 1 | 2,
    useTransferable = false,
  ): Promise<MixResult> {
    const id = this.nextId++;
    // deno-lint-ignore no-explicit-any
    const msgEntries: any[] = new Array(entries.length);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      msgEntries[i] = {
        left: e.left,
        right: e.right,
        startSample: e.startSample,
        gain: e.gain,
        gainRight: e.gainRight,
        gainCurve: e.gainCurve,
      };
    }

    const transfer = useTransferable
      ? BakeWorkerPool.collectUniqueTransferables(entries)
      : [];

    const result = await this.enqueue(
      {
        type: "mix",
        id,
        destLen,
        destChCount,
        entries: msgEntries,
      },
      transfer,
    );
    return result as MixResult;
  }

  /**
   * Soft cap on tiles per single mixBatch postMessage. Matches
   * MAX_NOTES_PER_BATCH spirit: amortize postMessage without monopolising
   * one worker for too long.
   * 6 is a compromise: 4 under-amortizes postMessage; 8 can hold a worker
   * long enough to inflate awaitAvg when bake jobs also queue (priority
   * helps, but shorter batches still reduce tail latency).
   */
  static readonly MAX_TILES_PER_MIX_BATCH = 4;

  /**
   * Mix several tiles in one postMessage. Prefer this when 2+ closed tiles
   * are ready so structured-clone / queue overhead is paid once.
   * Single-tile callers should keep using {@link mix} (no coalesce delay).
   * Returns results in the same order as jobs.
   *
   * Transferable selection is across the whole batch: only ArrayBuffers that
   * appear once among all jobs' entries are transferred.
   */
  async mixBatch(
    jobs: MixBatchJob[],
    useTransferable = false,
  ): Promise<MixBatchResult> {
    if (jobs.length === 0) {
      return { results: [] };
    }
    if (jobs.length === 1) {
      const one = await this.mix(
        jobs[0].entries,
        jobs[0].destLen,
        jobs[0].destChCount,
        useTransferable,
      );
      return { results: [one], queueMs: one.queueMs, postMs: one.postMs };
    }

    const id = this.nextId++;
    // deno-lint-ignore no-explicit-any
    const msgJobs: any[] = new Array(jobs.length);
    // Flatten for unique-transferable scan across the whole batch.
    const allEntries: MixSourceEntry[] = [];

    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      const entries = job.entries;
      // deno-lint-ignore no-explicit-any
      const msgEntries: any[] = new Array(entries.length);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        msgEntries[i] = {
          left: e.left,
          right: e.right,
          startSample: e.startSample,
          gain: e.gain,
          gainRight: e.gainRight,
          gainCurve: e.gainCurve,
        };
        allEntries.push(e);
      }
      msgJobs[j] = {
        destLen: job.destLen,
        destChCount: job.destChCount,
        entries: msgEntries,
      };
    }

    const transfer = useTransferable
      ? BakeWorkerPool.collectUniqueTransferables(allEntries)
      : [];

    const result = await this.enqueue(
      {
        type: "mixBatch",
        id,
        jobs: msgJobs,
      },
      transfer,
    );
    return result as MixBatchResult;
  }

  /**
   * Split entries across pool workers, mix partial results, then sum on main.
   */
  async mixParallel(
    entries: MixSourceEntry[],
    destLen: number,
    destChCount: 1 | 2,
    useTransferable = false,
  ): Promise<MixResult> {
    if (entries.length === 0) {
      return {
        left: new Float32Array(destLen),
        right: destChCount > 1 ? new Float32Array(destLen) : undefined,
      };
    }

    const workers = Math.min(
      this.size,
      Math.max(1, Math.ceil(entries.length / 4)),
    );
    if (
      workers <= 1 || entries.length < BakeWorkerPool.MIN_ENTRIES_FOR_WORKER
    ) {
      return this.mix(entries, destLen, destChCount, useTransferable);
    }

    const chunkSize = Math.ceil(entries.length / workers);
    const tasks: Promise<MixResult>[] = [];
    for (let w = 0; w < workers; w++) {
      const start = w * chunkSize;
      if (start >= entries.length) break;
      const slice = entries.slice(start, start + chunkSize);
      tasks.push(this.mix(slice, destLen, destChCount, false));
    }

    const partials = await Promise.all(tasks);
    const left = new Float32Array(destLen);
    const right = destChCount > 1 ? new Float32Array(destLen) : null;
    let workerMs = 0;

    for (let p = 0; p < partials.length; p++) {
      const pl = partials[p].left;
      const pr = partials[p].right;
      if (typeof partials[p].workerMs === "number") {
        workerMs += partials[p].workerMs!;
      }
      for (let i = 0; i < destLen; i++) {
        left[i] += pl[i];
      }
      if (right && pr) {
        for (let i = 0; i < destLen; i++) {
          right[i] += pr[i];
        }
      }
    }

    return { left, right: right ?? undefined, workerMs };
  }

  /**
   * Render one simple note body (resample + loop + optional filter + gains)
   * on a worker thread. Returns destChCount Float32Arrays of length destLen.
   */
  async renderSample(
    params: RenderSampleParams,
    useTransferable = false,
  ): Promise<RenderSampleResult> {
    const id = this.nextId++;
    const transfer: Transferable[] = [];

    // Always clone source/curves when not transferring so the main thread
    // keeps usable AudioBuffer channel views.
    const srcChannels = params.srcChannels.map((ch) => {
      if (useTransferable) {
        if (ch.buffer.byteLength > 0) transfer.push(ch.buffer);
        return ch;
      }
      return ch.slice();
    });
    const gains = useTransferable ? params.gains : params.gains.slice();
    if (useTransferable && params.gains.buffer.byteLength > 0) {
      transfer.push(params.gains.buffer);
    }
    let filterFreqs: Float32Array | null = params.filterFreqs;
    if (filterFreqs) {
      if (useTransferable) {
        if (filterFreqs.buffer.byteLength > 0) {
          transfer.push(filterFreqs.buffer);
        }
      } else {
        filterFreqs = filterFreqs.slice();
      }
    }
    let rateMultipliers: Float32Array | null = params.rateMultipliers ?? null;
    if (rateMultipliers) {
      if (useTransferable) {
        if (rateMultipliers.buffer.byteLength > 0) {
          transfer.push(rateMultipliers.buffer);
        }
      } else {
        rateMultipliers = rateMultipliers.slice();
      }
    }

    const result = await this.enqueue(
      {
        type: "renderSample",
        id,
        srcChannels,
        srcRate: params.srcRate,
        destRate: params.destRate,
        destLen: params.destLen,
        destChCount: params.destChCount,
        playbackRate: params.playbackRate,
        isLoop: params.isLoop,
        loopStartSrc: params.loopStartSrc,
        loopEndSrc: params.loopEndSrc,
        startOffsetSrc: params.startOffsetSrc,
        gains,
        filterFreqs,
        filterQ: params.filterQ,
        rateMultipliers,
      },
      transfer,
    );
    return result as RenderSampleResult;
  }

  /**
   * Soft cap on notes per single batch postMessage. Same spirit as mix's
   * ~4 entries/worker split: large batches serialize on one worker and miss
   * the realtime deadline. Parallel split uses this as the target chunk size.
   */
  static readonly MAX_NOTES_PER_BATCH = 8;

  /**
   * Batch-render many simple-note bodies in a single postMessage.
   * Prefer {@link renderSamplesBatchParallel} for tile-sized miss lists so
   * work fans out across the pool (same pattern as mixParallel).
   * Returns results in the same order as paramsList.
   */
  async renderSamplesBatch(
    paramsList: RenderSampleParams[],
    useTransferable = false,
  ): Promise<RenderSamplesBatchResult> {
    if (paramsList.length === 0) {
      return { results: [] };
    }
    if (paramsList.length === 1) {
      const one = await this.renderSample(paramsList[0], useTransferable);
      return { results: [one] };
    }

    const id = this.nextId++;
    const transfer: Transferable[] = [];
    // deno-lint-ignore no-explicit-any
    const items: any[] = new Array(paramsList.length);

    for (let n = 0; n < paramsList.length; n++) {
      const params = paramsList[n];
      const srcChannels = params.srcChannels.map((ch) => {
        if (useTransferable) {
          if (ch.buffer.byteLength > 0) transfer.push(ch.buffer);
          return ch;
        }
        return ch.slice();
      });
      const gains = useTransferable ? params.gains : params.gains.slice();
      if (useTransferable && params.gains.buffer.byteLength > 0) {
        transfer.push(params.gains.buffer);
      }
      let filterFreqs: Float32Array | null = params.filterFreqs;
      if (filterFreqs) {
        if (useTransferable) {
          if (filterFreqs.buffer.byteLength > 0) {
            transfer.push(filterFreqs.buffer);
          }
        } else {
          filterFreqs = filterFreqs.slice();
        }
      }
      let rateMultipliers: Float32Array | null = params.rateMultipliers ?? null;
      if (rateMultipliers) {
        if (useTransferable) {
          if (rateMultipliers.buffer.byteLength > 0) {
            transfer.push(rateMultipliers.buffer);
          }
        } else {
          rateMultipliers = rateMultipliers.slice();
        }
      }
      items[n] = {
        srcChannels,
        srcRate: params.srcRate,
        destRate: params.destRate,
        destLen: params.destLen,
        destChCount: params.destChCount,
        playbackRate: params.playbackRate,
        isLoop: params.isLoop,
        loopStartSrc: params.loopStartSrc,
        loopEndSrc: params.loopEndSrc,
        startOffsetSrc: params.startOffsetSrc,
        gains,
        filterFreqs,
        filterQ: params.filterQ,
        rateMultipliers,
      };
    }

    const result = await this.enqueue(
      {
        type: "renderSamplesBatch",
        id,
        items,
      },
      transfer,
    );
    return result as RenderSamplesBatchResult;
  }

  /**
   * Split a large note list across pool workers (like mixParallel).
   * Target chunk size = MAX_NOTES_PER_BATCH so no single worker holds a
   * huge serial job that misses the chunk bake deadline.
   */
  async renderSamplesBatchParallel(
    paramsList: RenderSampleParams[],
    useTransferable = false,
  ): Promise<RenderSamplesBatchResult> {
    if (paramsList.length === 0) {
      return { results: [] };
    }
    const maxPer = BakeWorkerPool.MAX_NOTES_PER_BATCH;
    const workers = Math.min(
      this.size,
      Math.max(1, Math.ceil(paramsList.length / maxPer)),
    );
    if (workers <= 1 || paramsList.length <= maxPer) {
      return this.renderSamplesBatch(paramsList, useTransferable);
    }

    const chunkSize = Math.ceil(paramsList.length / workers);
    const tasks: Promise<RenderSamplesBatchResult>[] = [];
    for (let w = 0; w < workers; w++) {
      const start = w * chunkSize;
      if (start >= paramsList.length) break;
      const slice = paramsList.slice(start, start + chunkSize);
      // Each note already holds its own sliced PCM/curves, so transferable
      // is safe on every parallel sub-batch.
      tasks.push(this.renderSamplesBatch(slice, useTransferable));
    }

    const parts = await Promise.all(tasks);
    const results: RenderSampleResult[] = [];
    for (let p = 0; p < parts.length; p++) {
      const pr = parts[p].results;
      for (let i = 0; i < pr.length; i++) {
        results.push(pr[i]);
      }
    }
    return { results };
  }

  /** Terminate all workers and revoke the blob URL. */
  dispose(): void {
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.free = [];
    this.queue = [];
    this.pendingById.clear();
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    this.started = false;
  }
}

/** Shared lazy singleton used by Player instances. */
let sharedPool: BakeWorkerPool | null = null;

export function getSharedBakeWorkerPool(size = 0): BakeWorkerPool {
  if (!sharedPool) {
    sharedPool = new BakeWorkerPool(size);
  }
  return sharedPool;
}

export function disposeSharedBakeWorkerPool(): void {
  if (sharedPool) {
    sharedPool.dispose();
    sharedPool = null;
  }
}
