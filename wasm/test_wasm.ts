/**
 * Deno WASM bench
 *   bash build.sh && deno run --allow-read test_wasm.ts
 */
const QUANTUM = 128;
const VOICES = 400;
const QUANTUMS = 5000;
const LENGTH = 4096;

const wasmPath = new URL("./dist/synth_core.wasm", import.meta.url);
const bytes = await Deno.readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const e = instance.exports as Record<
  string,
  CallableFunction | WebAssembly.Memory
>;

const sc_init = e.sc_init as () => void;
const sc_sample_alloc = e.sc_sample_alloc as (n: number) => number;
const sc_sample_register = e.sc_sample_register as (
  id: number,
  ptrL: number,
  ptrR: number,
  len: number,
  sr: number,
  loop: number,
  ls: number,
  le: number,
) => number;
const sc_process = e.sc_process as (frames: number) => number;
const sc_bench_start_n = e.sc_bench_start_n as (
  sid: number,
  n: number,
  rate: number,
  gain: number,
) => number;
const sc_active_voices = e.sc_active_voices as () => number;
const sc_set_sample_rate = e.sc_set_sample_rate as (sr: number) => void;
const memory = e.memory as WebAssembly.Memory;

sc_init();
sc_set_sample_rate(48000);
const pcmPtr = sc_sample_alloc(LENGTH);
const heap = new Float32Array(memory.buffer, pcmPtr, LENGTH);
for (let i = 0; i < LENGTH; i++) heap[i] = (i % 64) / 32 - 1;
const sid = sc_sample_register(-1, pcmPtr, 0, LENGTH, 48000, 1, 0, LENGTH);
const started = sc_bench_start_n(sid, VOICES, 1.0, 0.05);
console.log(`voices=${started} sample_id=${sid}`);
for (let i = 0; i < 50; i++) sc_process(QUANTUM);
const t0 = performance.now();
for (let i = 0; i < QUANTUMS; i++) sc_process(QUANTUM);
const t1 = performance.now();
const usPerQ = ((t1 - t0) * 1000) / QUANTUMS;
const budgetUs = (QUANTUM / 48000) * 1e6;
console.log(
  `avgProcUs=${usPerQ.toFixed(1)} budgetUs=${budgetUs.toFixed(1)} ` +
    `load=${
      ((100 * usPerQ) / budgetUs).toFixed(1)
    }% active=${sc_active_voices()}`,
);
