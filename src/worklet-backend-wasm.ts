/**
 * WASM worklet backend — selected at build time by build.ts
 * (`--target=wasm` resolves worklet-backend.ts → this file).
 *
 * Do not import this from worklet-engine.ts directly.
 */

export {
  createWorkletModuleURL,
  MIDY_WORKLET_NAME,
  postInitToWorklet,
  WORKLET_MAX_VOICES,
} from "./worklet-processor-wasm.ts";
