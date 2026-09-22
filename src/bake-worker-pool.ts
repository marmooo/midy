// Worker pool for pure TypedArray bake work:
//
//   1) Tile-level multi-buffer mix (segment / chunk):
//        simpleHits + complexBufs → dest
//      One (or a few parallel) postMessage(s) per tile — the intended path
//      for high-throughput segment/chunk modes.
//
//   2) Note-level simple-note sample render (note / ads / adsr):
//        resample + loop + optional lowpass + gains
//      Useful to keep the main thread free during realtime onsets even when
//      postMessage cost is non-trivial. Segment/chunk should NOT use this
//      path (per-note overhead dominates); they bake notes on the main
//      thread and only offload the tile mix.
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
  gain: number;
};

export type MixResult = {
  left: Float32Array;
  right?: Float32Array;
  /** Wall time spent inside the worker mix loop (ms). Sum when parallel. */
  workerMs?: number;
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
};

export type RenderSampleResult = {
  /** Destination channels (length = destChCount). */
  channels: Float32Array[];
};

type AnyResult = MixResult | RenderSampleResult;

type Pending = {
  resolve: (r: AnyResult) => void;
  reject: (e: Error) => void;
};

type QueuedJob = {
  worker?: Worker;
  // deno-lint-ignore no-explicit-any
  request: any;
  transfer: Transferable[];
  pending: Pending;
};

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
  static readonly MIN_ENTRIES_FOR_WORKER = 4;

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

function handleMix(msg) {
  var t0 = performance.now();
  var destLen = msg.destLen;
  var destLeft = new Float32Array(destLen);
  var destRight = msg.destChCount > 1 ? new Float32Array(destLen) : null;
  var entries = msg.entries;
  for (var ei = 0; ei < entries.length; ei++) {
    var e = entries[ei];
    var start = e.startSample | 0;
    if (start >= destLen) continue;
    var g = e.gain;
    var srcLeft = e.left;
    var srcLen = srcLeft.length;
    var copyLen = Math.min(srcLen, destLen - start);
    if (copyLen <= 0) continue;
    if (destRight === null) {
      for (var i = 0; i < copyLen; i++) {
        destLeft[start + i] += srcLeft[i] * g;
      }
    } else {
      var srcRight = e.right || srcLeft;
      for (var i = 0; i < copyLen; i++) {
        destLeft[start + i] += srcLeft[i] * g;
        destRight[start + i] += srcRight[i] * g;
      }
    }
  }
  var workerMs = performance.now() - t0;
  var transfer = [destLeft.buffer];
  if (destRight) transfer.push(destRight.buffer);
  self.postMessage(
    { type: "mix-result", id: msg.id, left: destLeft, right: destRight || undefined, workerMs: workerMs },
    transfer
  );
}

function handleRenderSample(msg) {
  var srcChannels = msg.srcChannels;
  var srcRate = msg.srcRate;
  var destRate = msg.destRate;
  var destLen = msg.destLen | 0;
  var destChCount = msg.destChCount | 0;
  var playbackRate = msg.playbackRate;
  var isLoop = !!msg.isLoop;
  var loopStartSrc = msg.loopStartSrc;
  var loopEndSrc = msg.loopEndSrc;
  var startOffsetSrc = msg.startOffsetSrc;
  var gains = msg.gains;
  var filterFreqs = msg.filterFreqs;
  var filterQ = msg.filterQ;
  var srcChCount = srcChannels.length;
  var srcLen = srcChannels[0].length;
  var loopStartSample = loopStartSrc * srcRate;
  var loopEndSample = loopEndSrc * srcRate;
  var loopLenSample = loopEndSample - loopStartSample;
  var startSample = startOffsetSrc * srcRate;
  var step = playbackRate * (srcRate / destRate);
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
      srcPos += step;
    }
    out.push(dst);
    transfer.push(dst.buffer);
  }
  self.postMessage({ type: "render-result", id: msg.id, channels: out }, transfer);
}

self.onmessage = function(ev) {
  var msg = ev.data;
  if (!msg || !msg.type) return;
  try {
    if (msg.type === "mix") {
      handleMix(msg);
    } else if (msg.type === "renderSample") {
      handleRenderSample(msg);
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
      });
    } else if (data.type === "render-result") {
      pending.resolve({ channels: data.channels! });
    } else {
      pending.reject(new Error(`unknown worker response: ${data.type}`));
    }
    this.releaseWorker(worker);
  }

  private releaseWorker(worker: Worker): void {
    const next = this.queue.shift();
    if (next) {
      next.worker = worker;
      worker.postMessage(next.request, next.transfer);
    } else {
      this.free.push(worker);
    }
  }

  // deno-lint-ignore no-explicit-any
  private enqueue(request: any, transfer: Transferable[]): Promise<AnyResult> {
    this.ensureStarted();
    const id = request.id as number;
    return new Promise<AnyResult>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      this.pendingById.set(id, pending);
      const free = this.free.pop();
      if (free) {
        free.postMessage(request, transfer);
      } else {
        this.queue.push({ request, transfer, pending });
      }
    });
  }

  /**
   * Mix source PCM entries into a new destination of length destLen.
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
    const transfer: Transferable[] = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      msgEntries[i] = {
        left: e.left,
        right: e.right,
        startSample: e.startSample,
        gain: e.gain,
      };
      if (useTransferable) {
        if (e.left.buffer.byteLength > 0) transfer.push(e.left.buffer);
        if (
          e.right && e.right.buffer !== e.left.buffer &&
          e.right.buffer.byteLength > 0
        ) {
          transfer.push(e.right.buffer);
        }
      }
    }

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
      },
      transfer,
    );
    return result as RenderSampleResult;
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
