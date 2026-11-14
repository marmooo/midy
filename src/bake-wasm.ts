/**
 * Bake-path WASM binary (scalar). build.ts --target=js|wasm leaves this
 * resolution as-is; --target=wasm-simd|… aliases to bake-wasm-*.ts.
 */
export { SYNTH_CORE_WASM_BASE64 } from "./synth_core_wasm_b64.ts";
