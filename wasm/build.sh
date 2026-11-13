#!/usr/bin/env bash
# Build native bench binaries (scalar + SIMD) + synth_core.wasm variants.
# Variants: scalar, simd, threads (no simd), threaded-simd.
set -euo pipefail
cd "$(dirname "$0")"

for d in /usr/lib/llvm-18/bin /usr/lib/llvm-17/bin /usr/lib/llvm-16/bin /opt/homebrew/opt/llvm/bin /usr/local/bin; do
  if [[ -x "$d/wasm-ld" ]] || [[ -x "$d/wasm-ld-18" ]]; then
    export PATH="$d:$PATH"
    break
  fi
done

CLANG="${CLANG:-clang}"
OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

WASM_EXPORTS=(
  -Wl,--export=sc_init
  -Wl,--export=sc_sample_alloc
  -Wl,--export=sc_sample_register
  -Wl,--export=sc_voice_on
  -Wl,--export=sc_voice_off
  -Wl,--export=sc_voice_stop
  -Wl,--export=sc_all_sound_off
  -Wl,--export=sc_set_master_gain
  -Wl,--export=sc_set_frame0
  -Wl,--export=sc_set_sample_rate
  -Wl,--export=sc_process
  -Wl,--export=sc_process_range
  -Wl,--export=sc_output_l
  -Wl,--export=sc_output_r
  -Wl,--export=sc_active_voices
  -Wl,--export=sc_bench_start_n
  -Wl,--export=sc_ended_count
  -Wl,--export=sc_ended_id
  -Wl,--export=sc_peak_active
  -Wl,--export=sc_complex_vq
  -Wl,--export=sc_simple_vq
  -Wl,--export=sc_mix_clear
  -Wl,--export=sc_mix_add
)

build_native() {
  local name="$1"; shift
  local bin="$OUT_DIR/$name"
  echo "== native $name ($*) =="
  "$CLANG" -O3 -DSC_NATIVE_MAIN "$@" -o "$bin" synth_core.c -lm
  "$bin"
}

echo "======== native scalar (SC_FORCE_SCALAR) ========"
build_native synth_native_scalar \
  -DSC_FORCE_SCALAR=1 -fno-vectorize -fno-slp-vectorize -fno-tree-vectorize

echo "======== native SIMD (SSE) ========"
build_native synth_native_simd -msse2

build_wasm() {
  local out="$1"; shift
  echo "== wasm32 → $out ($*) =="
  "$CLANG" --target=wasm32 -O3 -fno-builtin -nostdlib -Wl,--no-entry \
    -Wl,-z,stack-size=65536 \
    -Wl,--initial-memory=167772160 \
    "${WASM_EXPORTS[@]}" \
    "$@" \
    -o "$OUT_DIR/$out" \
    synth_core.c
  ls -la "$OUT_DIR/$out"
}

if ! command -v wasm-ld >/dev/null 2>&1 && ! command -v wasm-ld-18 >/dev/null 2>&1; then
  echo "WARNING: wasm-ld not found — skipping wasm builds (native benches OK)." >&2
  exit 0
fi

echo "======== wasm scalar ========"
build_wasm synth_core.wasm

echo "======== wasm simd128 ========"
build_wasm synth_core_simd.wasm -msimd128

echo "======== wasm threads (atomics+bulk, no simd) ========"
# Atomics + bulk-memory only. No SIMD. For hosts that need SAB but lack simd128.
build_wasm synth_core_threads.wasm -matomics -mbulk-memory

echo "======== wasm threaded-simd (atomics+bulk+simd) ========"
# Shared-memory pthread modules need special runtime; this binary is
# single-threaded but exports sc_process_range and enables atomics/bulk
# memory for future SAB-backed hosts. Realtime AudioWorklet stays 1-thread.
build_wasm synth_core_threaded_simd.wasm -msimd128 -matomics -mbulk-memory

echo "======== native threads (pthread process_range) ========"
build_native synth_native_threads -DSC_THREADS=1 -msse2 -pthread
# link pthread
if [[ -x "$OUT_DIR/synth_native_threads" ]]; then
  true
fi

echo "OK. Next: deno run -A scripts/embed_wasm.ts"
