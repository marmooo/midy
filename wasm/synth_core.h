/* midy-oriented synth core (C → WASM).
 * Sample + vol env + pan + lowpass filter + modEnv + modLFO + vibLFO.
 * Goal: sound close enough to pure-JS worklet for A/B comparison.
 */
#ifndef SYNTH_CORE_H
#define SYNTH_CORE_H

#include <stdint.h>

#define SC_MAX_SAMPLES 512
#define SC_MAX_VOICES  1024
#define SC_QUANTUM     128
#define SC_MOD_BLOCK   16

#ifdef __cplusplus
extern "C" {
#endif

void sc_init(void);
float *sc_sample_alloc(int32_t length);
int32_t sc_sample_register(
    int32_t sample_id,
    const float *pcm_l,
    const float *pcm_r,
    int32_t length,
    int32_t sample_rate,
    int32_t loop,
    int32_t loop_start,
    int32_t loop_end
);

int32_t sc_voice_on(
    int32_t voice_id,
    int32_t sample_id,
    float playback_rate,
    float gain,
    float pan_l,
    float pan_r,
    float delay_sec,
    float attack_sec,
    float hold_sec,
    float decay_sec,
    float sustain,
    float release_sec,
    float start_frame,
    float filter_fc_cents,
    float filter_q,
    float filter_dc_gain,
    float delay_mod_env,
    float attack_mod_env,
    float hold_mod_env,
    float decay_mod_env,
    float sustain_mod_env,
    float release_mod_env,
    float mod_env_to_pitch,
    float mod_env_to_filter_fc,
    float delay_mod_lfo,
    float freq_mod_lfo,
    float mod_lfo_to_pitch,
    float mod_lfo_to_filter_fc,
    float mod_lfo_to_volume,
    float delay_vib_lfo,
    float freq_vib_lfo,
    float vib_lfo_to_pitch
);

void sc_voice_off(int32_t voice_id, float release_sec, float at_frame);
void sc_voice_stop(int32_t voice_id);
void sc_all_sound_off(void);
void sc_set_master_gain(float g);
void sc_set_frame0(float frame0);
void sc_set_sample_rate(float sr);
int32_t sc_process(int32_t frames);
float *sc_output_l(void);
float *sc_output_r(void);
int32_t sc_active_voices(void);
int32_t sc_bench_start_n(int32_t sample_id, int32_t n, float rate, float gain);

/* Ended voice ids from last sc_process (for voiceEnded messages). */
int32_t sc_ended_count(void);
int32_t sc_ended_id(int32_t i);

uint32_t sc_simple_vq(void);
uint32_t sc_complex_vq(void);
int32_t sc_peak_active(void);

/* -------------------------------------------------------------------------
 * Offline bake mix (chunk / segment tile path)
 *
 * Mirrors the JS mixEntriesInto semantics used by BakeWorkerPool:
 *   dest += src * gain  (optional per-sample gainCurve, optional L/R gains)
 *
 * All pointers are into the WASM linear memory (byte offsets from the
 * JS side via memory.buffer). dest_r may be 0 for mono destination.
 * src_r may be 0 → treat as mono source (duplicate left).
 * curve may be 0 → constant gain only.
 * ------------------------------------------------------------------------- */
void sc_mix_clear(float *dest_l, float *dest_r, int32_t dest_len);

/**
 * Add one source into dest.
 * start: destination sample index
 * src_len: length of src buffers (and curve if non-null)
 * gain_l / gain_r: linear scales (mono dest uses equal-power when gain_r != gain_l)
 */
void sc_mix_add(
    float *dest_l,
    float *dest_r,
    int32_t dest_len,
    const float *src_l,
    const float *src_r,
    int32_t start,
    int32_t src_len,
    float gain_l,
    float gain_r,
    const float *curve
);

#ifdef __cplusplus
}
#endif
#endif
