/**
 * WASM-SIMD worklet backend — build.ts --target=wasm-simd
 * aliases worklet-backend.ts → this file.
 *
 * Same processor shell as scalar WASM; different embedded binary (-msimd128).
 */
export {
  createWorkletModuleURL,
  MIDY_WORKLET_NAME,
  WORKLET_MAX_VOICES,
} from "./worklet-processor-wasm.ts";

import { SYNTH_CORE_WASM_BASE64 } from "./synth_core_wasm_simd_b64.ts";

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
      "[midy-wasm-simd] synth_core_wasm_simd_b64.ts missing — run deno task build:wasm-core",
    );
    return;
  }
  const wasmBytes = b64ToBytes(SYNTH_CORE_WASM_BASE64);
  node.port.postMessage({ type: "initWasm", wasmBytes });
  console.info(
    "[midy-wasm-simd] posted initWasm (" + wasmBytes.byteLength + " bytes)",
  );
}
