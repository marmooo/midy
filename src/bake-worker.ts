// Dedicated worker for pure TypedArray audio mix (chunk / segment bake).
// Receives transferable Float32Array channel data, mixes in parallel, returns
// transferable result buffers. No Web Audio API dependency.

export type MixEntryMsg = {
  /** Source left (or mono) channel PCM. */
  left: Float32Array;
  /** Source right channel PCM (optional; mono sources omit). */
  right?: Float32Array;
  /** Destination start sample index. */
  startSample: number;
  /** Linear gain applied while mixing. */
  gain: number;
};

export type MixRequest = {
  type: "mix";
  id: number;
  destLen: number;
  /** Number of destination channels (1 or 2). */
  destChCount: number;
  entries: MixEntryMsg[];
};

export type MixResponse = {
  type: "mix-result";
  id: number;
  left: Float32Array;
  right?: Float32Array;
};

export type WorkerErrorResponse = {
  type: "error";
  id: number;
  message: string;
};

type InMessage = MixRequest;
type OutMessage = MixResponse | WorkerErrorResponse;

function mixInto(
  destLeft: Float32Array,
  destRight: Float32Array | null,
  destLen: number,
  entries: MixEntryMsg[],
): void {
  for (let ei = 0; ei < entries.length; ei++) {
    const e = entries[ei];
    const start = e.startSample | 0;
    if (start >= destLen) continue;
    const g = e.gain;
    const srcLeft = e.left;
    const srcLen = srcLeft.length;
    const copyLen = Math.min(srcLen, destLen - start);
    if (copyLen <= 0) continue;

    if (destRight === null) {
      // mono dest
      for (let i = 0; i < copyLen; i++) {
        destLeft[start + i] += srcLeft[i] * g;
      }
    } else {
      const srcRight = e.right ?? srcLeft;
      for (let i = 0; i < copyLen; i++) {
        destLeft[start + i] += srcLeft[i] * g;
        destRight[start + i] += srcRight[i] * g;
      }
    }
  }
}

self.onmessage = (ev: MessageEvent<InMessage>) => {
  const msg = ev.data;
  if (!msg || msg.type !== "mix") return;

  try {
    const destLeft = new Float32Array(msg.destLen);
    const destRight = msg.destChCount > 1
      ? new Float32Array(msg.destLen)
      : null;
    mixInto(destLeft, destRight, msg.destLen, msg.entries);

    const transfer: Transferable[] = [destLeft.buffer];
    if (destRight) transfer.push(destRight.buffer);

    // Also transfer source buffers back ownership if they were transferred to us
    // (they are already detached on the main side). We do not re-transfer sources
    // to keep the reply small; main keeps its own copies for AudioBuffer lifetime.

    const response: MixResponse = {
      type: "mix-result",
      id: msg.id,
      left: destLeft,
      right: destRight ?? undefined,
    };
    (self as DedicatedWorkerGlobalScope).postMessage(response, transfer);
  } catch (err) {
    const response: WorkerErrorResponse = {
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    };
    (self as DedicatedWorkerGlobalScope).postMessage(response);
  }
};
