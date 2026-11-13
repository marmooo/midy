/**
 * WASM-threads worklet backend — build.ts --target=wasm-threads
 *
 * Embeds the atomics/bulk-memory synth_core binary (NO SIMD).
 * Exports sc_process_range for host-side parallel offline use.
 *
 * Realtime AudioWorklet still runs sc_process on a single audio thread:
 * Atomics.wait is not allowed there, and worker round-trips cannot meet
 * the quantum deadline without an extra buffer of latency.
 */
export {
  createWorkletModuleURL,
  MIDY_WORKLET_NAME,
  WORKLET_MAX_VOICES,
} from "./worklet-processor-wasm.ts";

import { SYNTH_CORE_WASM_BASE64 } from "./synth_core_wasm_threads_b64.ts";

function b64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function postInitToWorklet(node: AudioWorkletNode): void {
  if (
    !SYNTH_CORE_WASM_BASE64 || SYNTH_CORE_WASM_BASE64.startsWith("PLACEHOLDER")
  ) {
    console.warn(
      "[midy-wasm-threads] synth_core_wasm_threads_b64.ts missing — run deno task build:wasm-core",
    );
    return;
  }
  const wasmBytes = b64ToBytes(SYNTH_CORE_WASM_BASE64);
  node.port.postMessage({ type: "initWasm", wasmBytes });
  console.info(
    "[midy-wasm-threads] posted initWasm (" + wasmBytes.byteLength + " bytes)",
  );
}
