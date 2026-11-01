/**
 * Light wasm bench: same shape as native main (400 voices × many quantums).
 * Run: node test_wasm.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, "dist", "synth_core.wasm");

const QUANTUM = 128;
const VOICES = 400;
const QUANTUMS = 10000;
const LENGTH = 4096;

const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const e = instance.exports;

const sc_init = e.sc_init;
const sc_sample_alloc = e.sc_sample_alloc;
const sc_sample_register = e.sc_sample_register;
const sc_process = e.sc_process;
const sc_bench_start_n = e.sc_bench_start_n;
const sc_active_voices = e.sc_active_voices;
const sc_output_l = e.sc_output_l;
const memory = e.memory;

function ptrF32(bytePtr) {
  return bytePtr >>> 2;
}

sc_init();
const pcmPtr = sc_sample_alloc(LENGTH);
if (!pcmPtr) throw new Error("sc_sample_alloc failed");

const heap = new Float32Array(memory.buffer, pcmPtr, LENGTH);
for (let i = 0; i < LENGTH; i++) {
  heap[i] = (i % 64) / 32 - 1;
}

const sid = sc_sample_register(pcmPtr, LENGTH, 48000, 1, 0, LENGTH);
const started = sc_bench_start_n(sid, VOICES, 1.0, 0.05);
console.log(`voices=${started} sample_id=${sid}`);

for (let i = 0; i < 100; i++) sc_process(QUANTUM);

const t0 = performance.now();
for (let i = 0; i < QUANTUMS; i++) sc_process(QUANTUM);
const t1 = performance.now();

const usPerQ = ((t1 - t0) * 1000) / QUANTUMS;
const budgetUs = (QUANTUM / 48000) * 1e6;
const outL = new Float32Array(memory.buffer, sc_output_l(), QUANTUM);
let peak = 0;
for (let i = 0; i < QUANTUM; i++) {
  const a = Math.abs(outL[i]);
  if (a > peak) peak = a;
}

console.log(
  `avgProcUs=${usPerQ.toFixed(1)} budgetUs=${budgetUs.toFixed(1)} ` +
    `load=${((100 * usPerQ) / budgetUs).toFixed(1)}% active=${sc_active_voices()} peakL=${peak.toFixed(4)}`,
);
console.log(`wasm=${wasmPath}`);
