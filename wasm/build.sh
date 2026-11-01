#!/usr/bin/env bash
# Build native bench binary + synth_core.wasm for midy worklet hot path.
set -euo pipefail
cd "$(dirname "$0")"

for d in /usr/lib/llvm-18/bin /usr/lib/llvm-17/bin /usr/lib/llvm-16/bin /opt/homebrew/opt/llvm/bin; do
  if [[ -x "$d/wasm-ld" ]]; then
    export PATH="$d:$PATH"
    break
  fi
done

CLANG="${CLANG:-clang}"
OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

echo "== native bench =="
NATIVE_BIN="$OUT_DIR/synth_native"
if ! "$CLANG" -O3 -DSC_NATIVE_MAIN -o "$NATIVE_BIN" synth_core.c -lm 2>/dev/null \
  || ! "$NATIVE_BIN" 2>/dev/null; then
  NATIVE_BIN=/tmp/synth_native
  "$CLANG" -O3 -DSC_NATIVE_MAIN -o "$NATIVE_BIN" synth_core.c -lm
  "$NATIVE_BIN"
fi

echo "== wasm32 =="
if ! command -v wasm-ld >/dev/null 2>&1; then
  echo "ERROR: wasm-ld not found." >&2
  echo "  Ubuntu/Debian: sudo apt install lld-18   (or lld)" >&2
  echo "  macOS: brew install llvm" >&2
  exit 1
fi

# 32M float PCM heap ≈ 128MB; reserve 160MB initial (2560 * 64KB pages)
"$CLANG" --target=wasm32 -O3 -fno-builtin -nostdlib -Wl,--no-entry \
  -Wl,-z,stack-size=65536 \
  -Wl,--initial-memory=167772160 \
  -Wl,--export=sc_init \
  -Wl,--export=sc_sample_alloc \
  -Wl,--export=sc_sample_register \
  -Wl,--export=sc_voice_on \
  -Wl,--export=sc_voice_off \
  -Wl,--export=sc_voice_stop \
  -Wl,--export=sc_all_sound_off \
  -Wl,--export=sc_set_master_gain \
  -Wl,--export=sc_set_frame0 \
  -Wl,--export=sc_set_sample_rate \
  -Wl,--export=sc_process \
  -Wl,--export=sc_output_l \
  -Wl,--export=sc_output_r \
  -Wl,--export=sc_active_voices \
  -Wl,--export=sc_bench_start_n \
  -Wl,--export=sc_ended_count \
  -Wl,--export=sc_ended_id \
  -Wl,--export=sc_peak_active \
  -Wl,--export=sc_complex_vq \
  -Wl,--export=sc_simple_vq \
  -o "$OUT_DIR/synth_core.wasm" \
  synth_core.c

ls -la "$OUT_DIR/synth_core.wasm"
echo "OK. Next: deno run -A scripts/embed_wasm.ts"
