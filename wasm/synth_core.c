#include "synth_core.h"

/* freestanding: clang may emit memset/memcpy for large statics / inits */
void *memset(void *s, int c, unsigned long n) {
  unsigned char *p = (unsigned char *)s;
  while (n--) *p++ = (unsigned char)c;
  return s;
}
void *memcpy(void *d, const void *s, unsigned long n) {
  unsigned char *dd = (unsigned char *)d;
  const unsigned char *ss = (const unsigned char *)s;
  while (n--) *dd++ = *ss++;
  return d;
}

/* ---- math (no libm) ---- */
#define SC_PI 3.14159265358979323846f
#define SC_TWO_PI 6.28318530717958647692f
#define SC_FULLY_OPEN_CENTS 13500.0f

/* sin via range-reduced polynomial (accurate enough for LFO) */
static float sc_sinf(float x) {
  x = x - (float)((int)(x / SC_TWO_PI)) * SC_TWO_PI;
  if (x > SC_PI) x -= SC_TWO_PI;
  if (x < -SC_PI) x += SC_TWO_PI;
  {
    float x2 = x * x;
    return x * (1.0f - x2 * (0.166666567f - x2 * (0.0083330256f - x2 * 0.000198074f)));
  }
}

/* 2^x */
static float sc_exp2f(float x) {
  if (x < -20.0f) return 0.0f;
  if (x > 20.0f) return 1048576.0f;
  {
    int i = (int)x;
    float f = x - (float)i;
    if (f < 0) { f += 1.0f; i -= 1; }
    float p = 1.0f + f * (0.693147f + f * (0.240226f + f * (0.0555041f + f * 0.009618f)));
    if (i > 0) { while (i--) p *= 2.0f; }
    else if (i < 0) { while (i++) p *= 0.5f; }
    return p;
  }
}

static float sc_cent_to_hz(float cents) {
  if (cents <= 0.0f) return 8.176f;
  if (cents >= 14000.0f) cents = 14000.0f;
  return 8.176f * sc_exp2f(cents * (1.0f / 1200.0f));
}

static float sc_pitch_ratio(float cents) {
  if (cents > -0.5f && cents < 0.5f) return 1.0f;
  if (cents < -4800.0f) cents = -4800.0f;
  if (cents > 4800.0f) cents = 4800.0f;
  return sc_exp2f(cents * (1.0f / 1200.0f));
}

static float sc_cb_to_lin(float cb) {
  if (cb > -0.5f && cb < 0.5f) return 1.0f;
  if (cb < -200.0f) cb = -200.0f;
  if (cb > 200.0f) cb = 200.0f;
  return sc_exp2f(cb * 0.0166294f);
}

static float sc_clampf(float x, float lo, float hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/* Newton sqrt — enough for equal-power mono gain */
static float sc_sqrtf(float x) {
  float y;
  int i;
  if (x <= 0.0f) return 0.0f;
  y = x;
  if (x >= 1.0f) y = 1.0f + 0.5f * (x - 1.0f);
  else y = 0.5f + 0.5f * x;
  for (i = 0; i < 4; i++) y = 0.5f * (y + x / y);
  return y;
}

static int sc_isfinite(float x) {
  return (x == x) && (x - x == 0.0f);
}

enum {
  ENV_DELAY = 0,
  ENV_ATTACK,
  ENV_HOLD,
  ENV_DECAY,
  ENV_SUSTAIN,
  ENV_RELEASE,
  ENV_DONE
};

typedef struct {
  const float *pcm_l;
  const float *pcm_r;
  int32_t length;
  int32_t sample_rate;
  int32_t loop;
  int32_t loop_start;
  int32_t loop_end;
  int32_t in_use;
} Sample;

typedef struct {
  int32_t active;
  int32_t voice_id;
  int32_t sample_id;
  float phase;
  float rate;
  float gain;
  float pan_l;
  float pan_r;

  int32_t env_stage;
  float env_level;
  float env_time;
  float delay_sec, attack_sec, hold_sec, decay_sec, sustain, release_sec;
  float rel_start;
  float start_frame;
  int32_t releasing;
  float release_frame;

  int32_t mod_stage;
  float mod_level;
  float mod_time;
  float delay_mod, attack_mod, hold_mod, decay_mod, sustain_mod, release_mod;
  float mod_env_to_pitch;
  float mod_env_to_filter_fc;
  float mod_rel_start;

  float filter_fc_cents;
  float filter_q;
  float filter_dc_gain;
  int32_t filter_enabled;
  float z1l, z2l, z1r, z2r;
  float b0, b1, b2, a1, a2;
  float last_fc;

  float mod_lfo_delay, mod_lfo_freq;
  float mod_lfo_to_pitch, mod_lfo_to_filter_fc, mod_lfo_to_volume;
  float mod_lfo_phase, mod_lfo_age;

  float vib_lfo_delay, vib_lfo_freq, vib_lfo_to_pitch;
  float vib_lfo_phase, vib_lfo_age;

  int32_t needs_pitch_mod;
  int32_t needs_vol_lfo;
  int32_t needs_mod_env;
  int32_t simple_path;
  float vol_lfo;
  float rate_scale;
} Voice;

static Sample g_samples[SC_MAX_SAMPLES];
static Voice g_voices[SC_MAX_VOICES];
static float g_out_l[SC_QUANTUM];
static float g_out_r[SC_QUANTUM];
static int32_t g_active;
static float g_master = 1.0f;
static float g_frame0 = 0.0f;
static float g_sr = 48000.0f;
static float g_inv_sr = 1.0f / 48000.0f;

/* voice ids that ended this quantum (for JS to post voiceEnded) */
#define SC_MAX_ENDED 64
static int32_t g_ended_ids[SC_MAX_ENDED];
static int32_t g_ended_count;
static uint32_t g_simple_vq;
static uint32_t g_complex_vq;
static int32_t g_peak_active;

#ifndef PCM_HEAP_FLOATS
#define PCM_HEAP_FLOATS (32 * 1024 * 1024)
#endif
static float g_pcm_heap[PCM_HEAP_FLOATS];
static int32_t g_pcm_heap_used;

void sc_init(void) {
  int32_t i;
  for (i = 0; i < SC_MAX_SAMPLES; i++) {
    g_samples[i].in_use = 0;
    g_samples[i].pcm_l = 0;
    g_samples[i].pcm_r = 0;
  }
  for (i = 0; i < SC_MAX_VOICES; i++) {
    g_voices[i].active = 0;
    g_voices[i].voice_id = -1;
  }
  g_active = 0;
  g_pcm_heap_used = 0;
  g_master = 1.0f;
  g_frame0 = 0.0f;
  g_ended_count = 0;
  g_simple_vq = 0;
  g_complex_vq = 0;
  g_peak_active = 0;
}

void sc_set_master_gain(float g) { g_master = g; }
void sc_set_frame0(float frame0) { g_frame0 = frame0; }
void sc_set_sample_rate(float sr) {
  if (sr > 0) {
    g_sr = sr;
    g_inv_sr = 1.0f / sr;
  }
}

float *sc_sample_alloc(int32_t length) {
  float *p;
  if (length <= 0) return 0;
  if (g_pcm_heap_used > PCM_HEAP_FLOATS - length) return 0;
  p = g_pcm_heap + g_pcm_heap_used;
  g_pcm_heap_used += length;
  return p;
}

int32_t sc_sample_register(
    int32_t sample_id,
    const float *pcm_l,
    const float *pcm_r,
    int32_t length,
    int32_t sample_rate,
    int32_t loop,
    int32_t loop_start,
    int32_t loop_end
) {
  int32_t id = sample_id;
  if (!pcm_l || length <= 1 || sample_rate <= 0) return -1;
  if (id < 0) {
    for (id = 0; id < SC_MAX_SAMPLES; id++) {
      if (!g_samples[id].in_use) break;
    }
  }
  if (id < 0 || id >= SC_MAX_SAMPLES) return -1;
  g_samples[id].pcm_l = pcm_l;
  g_samples[id].pcm_r = pcm_r;
  g_samples[id].length = length;
  g_samples[id].sample_rate = sample_rate;
  g_samples[id].loop = loop ? 1 : 0;
  g_samples[id].loop_start = loop_start;
  g_samples[id].loop_end = loop_end > 0 ? loop_end : length;
  g_samples[id].in_use = 1;
  return id;
}

static int32_t find_voice_slot(int32_t voice_id) {
  int32_t i, free_i = -1;
  int32_t oldest_i = -1;
  float oldest_start = 1e30f;
  for (i = 0; i < SC_MAX_VOICES; i++) {
    if (g_voices[i].active && g_voices[i].voice_id == voice_id) return i;
    if (!g_voices[i].active && free_i < 0) free_i = i;
    if (g_voices[i].active && g_voices[i].start_frame < oldest_start) {
      oldest_start = g_voices[i].start_frame;
      oldest_i = i;
    }
  }
  if (free_i >= 0) return free_i;
  /* steal oldest */
  return oldest_i;
}

/*
 * RBJ lowpass. For high Fc (near Nyquist) the filter is nearly transparent;
 * we snap to bypass coeffs to avoid unstable coefficients from approx trig.
 */
static void lowpass_coeffs(Voice *v, float freq, float q, float sr) {
  float w0, cosw, sinw, alpha, b0, b1, a0, inv_a0;
  float nyq = sr * 0.5f;
  if (freq < 20.0f) freq = 20.0f;
  if (freq > nyq * 0.49f) freq = nyq * 0.49f;
  if (q < 0.001f) q = 0.001f;

  /* Near-Nyquist: treat as bypass (unity) — avoids unstable coeffs */
  if (freq > nyq * 0.45f) {
    v->b0 = 1.0f; v->b1 = 0.0f; v->b2 = 0.0f;
    v->a1 = 0.0f; v->a2 = 0.0f;
    return;
  }

  w0 = SC_TWO_PI * freq / sr;
  /* Cody/Waite style: use better polynomial on [0, pi/2] */
  {
    float x = w0;
    float x2 = x * x;
    /* cos and sin via Taylor — safe because freq <= 0.45*nyquist → w0 <= 0.45*pi ≈ 1.41 */
    cosw = 1.0f + x2 * (-0.5f + x2 * (0.041666666f + x2 * (-0.0013888889f + x2 * 0.000024801587f)));
    sinw = x * (1.0f + x2 * (-0.16666667f + x2 * (0.008333333f + x2 * (-0.0001984127f + x2 * 0.0000027557319f))));
  }
  alpha = sinw / (2.0f * q);
  b0 = (1.0f - cosw) * 0.5f;
  b1 = 1.0f - cosw;
  a0 = 1.0f + alpha;
  if (a0 < 1e-12f) a0 = 1e-12f;
  inv_a0 = 1.0f / a0;
  v->b0 = b0 * inv_a0;
  v->b1 = b1 * inv_a0;
  v->b2 = b0 * inv_a0;
  v->a1 = (-2.0f * cosw) * inv_a0;
  v->a2 = (1.0f - alpha) * inv_a0;

  /* sanitize */
  if (!sc_isfinite(v->b0) || !sc_isfinite(v->a1) || !sc_isfinite(v->a2)) {
    v->b0 = 1.0f; v->b1 = 0.0f; v->b2 = 0.0f;
    v->a1 = 0.0f; v->a2 = 0.0f;
  }
}

static void push_ended(int32_t voice_id) {
  if (g_ended_count < SC_MAX_ENDED) {
    g_ended_ids[g_ended_count++] = voice_id;
  }
}

int32_t sc_ended_count(void) { return g_ended_count; }
int32_t sc_ended_id(int32_t i) {
  if (i < 0 || i >= g_ended_count) return -1;
  return g_ended_ids[i];
}

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
) {
  int32_t vi;
  Voice *v;
  float lowest_cents, lowest_hz, nyq;
  int32_t mod_lfo_live, vib_lfo_live;

  if (sample_id < 0 || sample_id >= SC_MAX_SAMPLES) return -1;
  if (!g_samples[sample_id].in_use) return -1;
  if (!(playback_rate > 1e-6f && playback_rate < 64.0f)) return -1;
  if (!sc_isfinite(playback_rate) || !sc_isfinite(gain)) return -1;
  vi = find_voice_slot(voice_id);
  if (vi < 0) return -1;
  v = &g_voices[vi];
  if (v->active && v->voice_id != voice_id) {
    /* stolen */
    push_ended(v->voice_id);
  } else if (!v->active) {
    g_active++;
  }
  v->active = 1;
  v->voice_id = voice_id;
  v->sample_id = sample_id;
  v->phase = 0.0f;
  v->rate = playback_rate;
  v->gain = gain;
  v->pan_l = pan_l;
  v->pan_r = pan_r;

  v->delay_sec = delay_sec > 0 ? delay_sec : 0;
  v->attack_sec = attack_sec > 1e-5f ? attack_sec : 1e-5f;
  v->hold_sec = hold_sec > 0 ? hold_sec : 0;
  v->decay_sec = decay_sec > 1e-5f ? decay_sec : 1e-5f;
  v->sustain = sustain < 0 ? 0 : (sustain > 1 ? 1 : sustain);
  v->release_sec = release_sec > 1e-5f ? release_sec : 1e-5f;
  v->env_stage = ENV_DELAY;
  v->env_level = 0;
  v->env_time = 0;
  v->rel_start = 0;
  v->start_frame = start_frame;
  v->releasing = 0;
  v->release_frame = -1.0f;

  v->filter_fc_cents = filter_fc_cents;
  v->filter_q = filter_q > 0.001f ? filter_q : 0.7071f;
  v->filter_dc_gain = (filter_dc_gain > 0 && sc_isfinite(filter_dc_gain)) ? filter_dc_gain : 1.0f;
  v->mod_env_to_filter_fc = mod_env_to_filter_fc;
  v->mod_lfo_to_filter_fc = mod_lfo_to_filter_fc;
  lowest_cents = filter_fc_cents
      + (mod_env_to_filter_fc < 0 ? mod_env_to_filter_fc : 0)
      - (mod_lfo_to_filter_fc < 0 ? -mod_lfo_to_filter_fc : mod_lfo_to_filter_fc);
  lowest_hz = sc_cent_to_hz(lowest_cents);
  nyq = g_sr * 0.5f;
  v->filter_enabled =
      (lowest_cents < SC_FULLY_OPEN_CENTS - 1.0f) &&
      (lowest_hz < nyq * 0.95f);
  v->z1l = v->z2l = v->z1r = v->z2r = 0;
  v->last_fc = -1.0f;
  v->b0 = 1; v->b1 = 0; v->b2 = 0; v->a1 = 0; v->a2 = 0;

  v->delay_mod = delay_mod_env > 0 ? delay_mod_env : 0;
  v->attack_mod = attack_mod_env > 1e-5f ? attack_mod_env : 1e-5f;
  v->hold_mod = hold_mod_env > 0 ? hold_mod_env : 0;
  v->decay_mod = decay_mod_env > 1e-5f ? decay_mod_env : 1e-5f;
  v->sustain_mod = sustain_mod_env < 0 ? 0 : (sustain_mod_env > 1 ? 1 : sustain_mod_env);
  v->release_mod = release_mod_env > 1e-5f ? release_mod_env : 1e-5f;
  v->mod_env_to_pitch = mod_env_to_pitch;
  v->mod_stage = ENV_DELAY;
  v->mod_level = 0;
  v->mod_time = 0;
  v->mod_rel_start = 0;

  v->mod_lfo_delay = delay_mod_lfo > 0 ? delay_mod_lfo : 0;
  v->mod_lfo_freq = freq_mod_lfo > 0 ? freq_mod_lfo : 0;
  v->mod_lfo_to_pitch = mod_lfo_to_pitch;
  v->mod_lfo_to_volume = mod_lfo_to_volume;
  v->mod_lfo_phase = 0;
  v->mod_lfo_age = 0;

  v->vib_lfo_delay = delay_vib_lfo > 0 ? delay_vib_lfo : 0;
  v->vib_lfo_freq = freq_vib_lfo > 0 ? freq_vib_lfo : 0;
  v->vib_lfo_to_pitch = vib_lfo_to_pitch;
  v->vib_lfo_phase = 0;
  v->vib_lfo_age = 0;

  mod_lfo_live = v->mod_lfo_freq > 0;
  vib_lfo_live = v->vib_lfo_freq > 0;
  v->needs_pitch_mod =
      (mod_env_to_pitch > 2.0f || mod_env_to_pitch < -2.0f) ||
      (mod_lfo_live && (mod_lfo_to_pitch > 2.0f || mod_lfo_to_pitch < -2.0f)) ||
      (vib_lfo_live && (vib_lfo_to_pitch > 2.0f || vib_lfo_to_pitch < -2.0f));
  v->needs_vol_lfo = mod_lfo_live &&
      (mod_lfo_to_volume > 1.0f || mod_lfo_to_volume < -1.0f);
  v->needs_mod_env = v->needs_pitch_mod || v->filter_enabled;
  v->simple_path =
      !v->filter_enabled && !v->needs_pitch_mod &&
      !v->needs_vol_lfo && !v->needs_mod_env;
  v->vol_lfo = 1.0f;
  v->rate_scale = playback_rate;

  if (v->filter_enabled) {
    float fc = sc_cent_to_hz(filter_fc_cents);
    lowpass_coeffs(v, fc, v->filter_q, g_sr);
    v->last_fc = fc;
  }
  return vi;
}

void sc_voice_off(int32_t voice_id, float release_sec, float at_frame) {
  int32_t i;
  for (i = 0; i < SC_MAX_VOICES; i++) {
    Voice *v = &g_voices[i];
    if (!v->active || v->voice_id != voice_id) continue;
    if (v->releasing) return;
    if (at_frame > 0 && at_frame > g_frame0) {
      v->release_frame = at_frame;
      if (release_sec > 1e-5f) v->release_sec = release_sec;
      return;
    }
    v->releasing = 1;
    v->env_stage = ENV_RELEASE;
    v->env_time = 0;
    v->rel_start = v->env_level > 1e-6f ? v->env_level : 1e-6f;
    if (release_sec > 1e-5f) v->release_sec = release_sec;
    if (v->mod_stage != ENV_DONE) {
      v->mod_stage = ENV_RELEASE;
      v->mod_time = 0;
      v->mod_rel_start = v->mod_level;
    }
    return;
  }
}

void sc_voice_stop(int32_t voice_id) {
  int32_t i;
  for (i = 0; i < SC_MAX_VOICES; i++) {
    if (g_voices[i].active && g_voices[i].voice_id == voice_id) {
      g_voices[i].active = 0;
      g_active--;
      if (g_active < 0) g_active = 0;
      push_ended(voice_id);
      return;
    }
  }
}

void sc_all_sound_off(void) {
  int32_t i;
  for (i = 0; i < SC_MAX_VOICES; i++) {
    if (g_voices[i].active) push_ended(g_voices[i].voice_id);
    g_voices[i].active = 0;
  }
  g_active = 0;
}

int32_t sc_active_voices(void) { return g_active; }
float *sc_output_l(void) { return g_out_l; }
float *sc_output_r(void) { return g_out_r; }

int32_t sc_bench_start_n(int32_t sample_id, int32_t n, float rate, float gain) {
  int32_t i, started = 0;
  if (n > SC_MAX_VOICES) n = SC_MAX_VOICES;
  for (i = 0; i < n; i++) {
    float r = rate * (1.0f + (float)(i % 16) * 0.0001f);
    if (sc_voice_on(i, sample_id, r, gain, 0.7071f, 0.7071f,
                    0, 0.005f, 0, 0.1f, 0.8f, 0.2f, 0,
                    13500.0f, 0.7071f, 1.0f,
                    0, 0.001f, 0, 0.01f, 0, 0.05f, 0, 0,
                    0, 0, 0, 0, 0,
                    0, 0, 0) >= 0) {
      started++;
    }
  }
  return started;
}

static float process_env(Voice *v, float dt) {
  switch (v->env_stage) {
    case ENV_DELAY:
      v->env_time += dt;
      v->env_level = 0;
      if (v->env_time >= v->delay_sec) {
        v->env_stage = ENV_ATTACK;
        v->env_time = 0;
      }
      break;
    case ENV_ATTACK: {
      float t;
      v->env_time += dt;
      t = v->env_time / v->attack_sec;
      if (t > 1) t = 1;
      v->env_level = t;
      if (v->env_time >= v->attack_sec) {
        v->env_stage = ENV_HOLD;
        v->env_time = 0;
        v->env_level = 1;
      }
      break;
    }
    case ENV_HOLD:
      v->env_time += dt;
      v->env_level = 1;
      if (v->env_time >= v->hold_sec) {
        v->env_stage = ENV_DECAY;
        v->env_time = 0;
      }
      break;
    case ENV_DECAY: {
      float t;
      v->env_time += dt;
      t = v->env_time / v->decay_sec;
      if (t > 1) t = 1;
      v->env_level = 1.0f + (v->sustain - 1.0f) * t;
      if (v->env_time >= v->decay_sec) {
        v->env_stage = ENV_SUSTAIN;
        v->env_level = v->sustain;
      }
      break;
    }
    case ENV_SUSTAIN:
      v->env_level = v->sustain;
      break;
    case ENV_RELEASE: {
      float t;
      v->env_time += dt;
      t = v->env_time / v->release_sec;
      if (t > 1) t = 1;
      v->env_level = v->rel_start * (1.0f - t);
      if (v->env_time >= v->release_sec || v->env_level < 1e-5f) {
        v->env_stage = ENV_DONE;
        v->env_level = 0;
      }
      break;
    }
    case ENV_DONE:
      v->env_level = 0;
      break;
  }
  return v->env_level;
}

static float process_mod_env(Voice *v, float dt) {
  switch (v->mod_stage) {
    case ENV_DELAY:
      v->mod_time += dt;
      v->mod_level = 0;
      if (v->mod_time >= v->delay_mod) {
        v->mod_stage = ENV_ATTACK;
        v->mod_time = 0;
      }
      break;
    case ENV_ATTACK: {
      float t;
      v->mod_time += dt;
      t = v->mod_time / v->attack_mod;
      if (t > 1) t = 1;
      v->mod_level = t;
      if (v->mod_time >= v->attack_mod) {
        v->mod_stage = ENV_HOLD;
        v->mod_time = 0;
        v->mod_level = 1;
      }
      break;
    }
    case ENV_HOLD:
      v->mod_time += dt;
      v->mod_level = 1;
      if (v->mod_time >= v->hold_mod) {
        v->mod_stage = ENV_DECAY;
        v->mod_time = 0;
      }
      break;
    case ENV_DECAY: {
      float t;
      v->mod_time += dt;
      t = v->mod_time / v->decay_mod;
      if (t > 1) t = 1;
      v->mod_level = 1.0f + (v->sustain_mod - 1.0f) * t;
      if (v->mod_time >= v->decay_mod) {
        v->mod_stage = ENV_SUSTAIN;
        v->mod_level = v->sustain_mod;
      }
      break;
    }
    case ENV_SUSTAIN:
      v->mod_level = v->sustain_mod;
      break;
    case ENV_RELEASE: {
      float t;
      v->mod_time += dt;
      t = v->mod_time / v->release_mod;
      if (t > 1) t = 1;
      v->mod_level = v->mod_rel_start * (1.0f - t);
      if (v->mod_time >= v->release_mod) {
        v->mod_stage = ENV_DONE;
        v->mod_level = 0;
      }
      break;
    }
    case ENV_DONE:
      v->mod_level = 0;
      break;
  }
  return v->mod_level;
}

int32_t sc_process(int32_t frames) {
  int32_t i, vi;
  float inv_sr = g_inv_sr;
  float mg = g_master;
  float sr = g_sr;
  float nyq = sr * 0.5f;
  float block_dt = inv_sr * (float)SC_MOD_BLOCK;
  float frame0 = g_frame0;

  g_ended_count = 0;
  if (g_active > g_peak_active) g_peak_active = g_active;

  if (frames <= 0) return 0;
  if (frames > SC_QUANTUM) frames = SC_QUANTUM;

  for (i = 0; i < frames; i++) {
    g_out_l[i] = 0.0f;
    g_out_r[i] = 0.0f;
  }

  for (vi = 0; vi < SC_MAX_VOICES; vi++) {
    Voice *v = &g_voices[vi];
    Sample *s;
    const float *pcm_l;
    const float *pcm_r;
    int32_t len, loop, ls, le, loop_len, stereo;
    float phase, rate, gl, gr;
    int32_t ended;
    int32_t i_start;
    float mod_env, mod_lfo, vib_lfo, vol_lfo;
    float env;
    int32_t blk;

    if (!v->active) continue;
    s = &g_samples[v->sample_id];
    if (!s->in_use || !s->pcm_l) {
      push_ended(v->voice_id);
      v->active = 0;
      g_active--;
      if (g_active < 0) g_active = 0;
      continue;
    }

    if (v->simple_path) g_simple_vq++;
    else g_complex_vq++;

    pcm_l = s->pcm_l;
    pcm_r = s->pcm_r;
    stereo = pcm_r != 0;
    len = s->length;
    loop = s->loop;
    ls = s->loop_start;
    le = s->loop_end;
    loop_len = le - ls;
    phase = v->phase;
    rate = v->rate_scale > 0 ? v->rate_scale : v->rate;
    gl = v->gain * v->pan_l * mg;
    gr = v->gain * v->pan_r * mg;
    ended = 0;
    mod_env = v->mod_level;
    mod_lfo = 0;
    vib_lfo = 0;
    vol_lfo = v->vol_lfo;
    env = v->env_level;

    i_start = 0;
    if (frame0 < v->start_frame) {
      i_start = (int32_t)(v->start_frame - frame0);
      if (i_start >= frames) continue;
    }

    for (i = i_start; i < frames; i++) {
      float abs_frame = frame0 + (float)i;
      float sL, sR, ampL, ampR;
      int32_t i0, i1;
      float frac, p;

      if (!v->releasing && v->release_frame >= 0 && abs_frame >= v->release_frame) {
        v->releasing = 1;
        v->env_stage = ENV_RELEASE;
        v->env_time = 0;
        v->rel_start = v->env_level > 1e-6f ? v->env_level : 1e-6f;
        if (v->mod_stage != ENV_DONE) {
          v->mod_stage = ENV_RELEASE;
          v->mod_time = 0;
          v->mod_rel_start = v->mod_level;
        }
      }

      blk = (i & (SC_MOD_BLOCK - 1));
      if (blk == 0 || i == i_start) {
        float dt = (i == i_start) ? inv_sr : block_dt;
        if (v->simple_path) {
          if (v->env_stage == ENV_SUSTAIN) {
            env = v->sustain;
          } else {
            env = process_env(v, dt);
          }
          rate = v->rate;
          vol_lfo = 1.0f;
        } else {
          if (v->env_stage == ENV_SUSTAIN && !v->releasing) {
            env = v->sustain;
          } else {
            env = process_env(v, dt);
          }
          if (v->needs_mod_env) {
            mod_env = process_mod_env(v, dt);
          } else {
            mod_env = 0;
          }
          v->mod_lfo_age += dt;
          v->vib_lfo_age += dt;
          mod_lfo = 0;
          if (v->mod_lfo_age >= v->mod_lfo_delay && v->mod_lfo_freq > 0) {
            mod_lfo = sc_sinf(v->mod_lfo_phase);
            v->mod_lfo_phase += SC_TWO_PI * v->mod_lfo_freq * dt;
            if (v->mod_lfo_phase > SC_TWO_PI) v->mod_lfo_phase -= SC_TWO_PI;
            if (v->mod_lfo_phase < 0) v->mod_lfo_phase += SC_TWO_PI;
          }
          vib_lfo = 0;
          if (v->vib_lfo_age >= v->vib_lfo_delay && v->vib_lfo_freq > 0 &&
              v->vib_lfo_to_pitch != 0) {
            vib_lfo = sc_sinf(v->vib_lfo_phase);
            v->vib_lfo_phase += SC_TWO_PI * v->vib_lfo_freq * dt;
            if (v->vib_lfo_phase > SC_TWO_PI) v->vib_lfo_phase -= SC_TWO_PI;
            if (v->vib_lfo_phase < 0) v->vib_lfo_phase += SC_TWO_PI;
          }
          if (v->needs_pitch_mod) {
            float pitch_cents =
                mod_env * v->mod_env_to_pitch +
                mod_lfo * v->mod_lfo_to_pitch +
                vib_lfo * v->vib_lfo_to_pitch;
            float rs = (pitch_cents != 0)
                ? v->rate * sc_pitch_ratio(pitch_cents)
                : v->rate;
            if (!(rs > 1e-6f && rs < 64.0f) || !sc_isfinite(rs)) rs = v->rate;
            rate = rs;
            v->rate_scale = rs;
          } else {
            rate = v->rate;
            v->rate_scale = rate;
          }
          if (v->needs_vol_lfo && mod_lfo != 0) {
            float cb = mod_lfo * v->mod_lfo_to_volume;
            float vl = sc_cb_to_lin(cb);
            vol_lfo = (vl > 0 && sc_isfinite(vl)) ? vl : 1.0f;
            v->vol_lfo = vol_lfo;
          } else {
            vol_lfo = 1.0f;
            v->vol_lfo = 1.0f;
          }
          if (v->filter_enabled) {
            float fc_cents =
                v->filter_fc_cents +
                mod_env * v->mod_env_to_filter_fc +
                mod_lfo * v->mod_lfo_to_filter_fc;
            float fc_hz = sc_cent_to_hz(fc_cents);
            if (fc_hz < 20.0f) fc_hz = 20.0f;
            if (fc_hz > nyq * 0.99f) fc_hz = nyq * 0.99f;
            if (v->last_fc < 0 || (fc_hz - v->last_fc > 0.5f) ||
                (v->last_fc - fc_hz > 0.5f)) {
              lowpass_coeffs(v, fc_hz, v->filter_q, sr);
              v->last_fc = fc_hz;
            }
          }
        }
      } else {
        if (v->env_stage == ENV_SUSTAIN && !v->releasing) {
          env = v->sustain;
        } else if (v->env_stage == ENV_HOLD) {
          env = 1.0f;
        } else {
          env = process_env(v, inv_sr);
        }
      }

      if (v->env_stage == ENV_DONE) {
        ended = 1;
        break;
      }

      p = phase;
      if (loop) {
        if (p >= (float)le) {
          if (loop_len <= 0) { ended = 1; break; }
          p = (float)ls + (p - (float)ls);
          while (p >= (float)le) p -= (float)loop_len;
        }
      } else if (p >= (float)(len - 1)) {
        ended = 1;
        break;
      }
      i0 = (int32_t)p;
      if (i0 < 0) i0 = 0;
      if (i0 >= len) i0 = len - 1;
      i1 = (i0 + 1 < len) ? i0 + 1 : len - 1;
      frac = p - (float)i0;
      sL = pcm_l[i0] + (pcm_l[i1] - pcm_l[i0]) * frac;
      if (stereo) {
        sR = pcm_r[i0] + (pcm_r[i1] - pcm_r[i0]) * frac;
      } else {
        sR = sL;
      }
      phase = p + rate;

      if (v->filter_enabled) {
        float yL, yR, xL = sL, xR = sR;
        yL = v->b0 * xL + v->z1l;
        v->z1l = v->b1 * xL - v->a1 * yL + v->z2l;
        v->z2l = v->b2 * xL - v->a2 * yL;
        yR = v->b0 * xR + v->z1r;
        v->z1r = v->b1 * xR - v->a1 * yR + v->z2r;
        v->z2r = v->b2 * xR - v->a2 * yR;
        /* kill denormals / NaN */
        if (!sc_isfinite(yL) || !sc_isfinite(v->z1l) || !sc_isfinite(v->z2l)) {
          yL = 0; v->z1l = 0; v->z2l = 0;
        }
        if (!sc_isfinite(yR) || !sc_isfinite(v->z1r) || !sc_isfinite(v->z2r)) {
          yR = 0; v->z1r = 0; v->z2r = 0;
        }
        sL = yL * v->filter_dc_gain;
        sR = yR * v->filter_dc_gain;
      }

      ampL = env * vol_lfo * gl;
      ampR = env * vol_lfo * gr;
      if (!sc_isfinite(ampL)) ampL = 0;
      if (!sc_isfinite(ampR)) ampR = 0;
      g_out_l[i] += sL * ampL;
      g_out_r[i] += sR * ampR;
    }

    /* keep phase bounded for looped voices */
    if (loop && loop_len > 0 && phase >= (float)le) {
      phase = (float)ls + (phase - (float)ls);
      while (phase >= (float)le) phase -= (float)loop_len;
    }
    v->phase = phase;

    if (ended || v->env_stage == ENV_DONE) {
      push_ended(v->voice_id);
      v->active = 0;
      g_active--;
      if (g_active < 0) g_active = 0;
    }
  }

  /* final NaN sanitize on mix bus */
  for (i = 0; i < frames; i++) {
    if (!sc_isfinite(g_out_l[i])) g_out_l[i] = 0;
    if (!sc_isfinite(g_out_r[i])) g_out_r[i] = 0;
  }
  return frames;
}

uint32_t sc_simple_vq(void) { return g_simple_vq; }
uint32_t sc_complex_vq(void) { return g_complex_vq; }
int32_t sc_peak_active(void) { return g_peak_active; }

/* -------------------------------------------------------------------------
 * Offline bake mix — mirrors JS mixEntriesInto (bake-worker-pool.ts)
 * ------------------------------------------------------------------------- */

void sc_mix_clear(float *dest_l, float *dest_r, int32_t dest_len) {
  int32_t i;
  if (!dest_l || dest_len <= 0) return;
  for (i = 0; i < dest_len; i++) dest_l[i] = 0.0f;
  if (dest_r) {
    for (i = 0; i < dest_len; i++) dest_r[i] = 0.0f;
  }
}

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
) {
  int32_t copy_len, i, di, n;
  float g_mono;
  const float *sr;

  if (!dest_l || !src_l || dest_len <= 0 || src_len <= 0) return;
  if (start >= dest_len) return;
  if (start < 0) start = 0;
  copy_len = src_len;
  if (copy_len > dest_len - start) copy_len = dest_len - start;
  if (copy_len <= 0) return;

  if (!dest_r) {
    /* mono dest: equal-power when L/R gains differ (center pan → 1.0) */
    if (gain_l != gain_r) {
      g_mono = sc_sqrtf(gain_l * gain_l + gain_r * gain_r);
    } else {
      g_mono = gain_l;
    }
    i = 0;
    di = start;
    if (curve) {
      if (g_mono == 1.0f) {
        while (i < copy_len) {
          dest_l[di] += src_l[i] * curve[i];
          i++; di++;
        }
      } else {
        while (i < copy_len) {
          dest_l[di] += src_l[i] * g_mono * curve[i];
          i++; di++;
        }
      }
    } else if (g_mono == 1.0f) {
      n = copy_len - 3;
      while (i < n) {
        dest_l[di]     += src_l[i];
        dest_l[di + 1] += src_l[i + 1];
        dest_l[di + 2] += src_l[i + 2];
        dest_l[di + 3] += src_l[i + 3];
        i += 4; di += 4;
      }
      while (i < copy_len) {
        dest_l[di] += src_l[i];
        i++; di++;
      }
    } else {
      n = copy_len - 3;
      while (i < n) {
        dest_l[di]     += src_l[i] * g_mono;
        dest_l[di + 1] += src_l[i + 1] * g_mono;
        dest_l[di + 2] += src_l[i + 2] * g_mono;
        dest_l[di + 3] += src_l[i + 3] * g_mono;
        i += 4; di += 4;
      }
      while (i < copy_len) {
        dest_l[di] += src_l[i] * g_mono;
        i++; di++;
      }
    }
    return;
  }

  /* stereo dest */
  sr = src_r ? src_r : src_l;
  i = 0;
  di = start;
  if (curve) {
    if (gain_l == 1.0f && gain_r == 1.0f) {
      while (i < copy_len) {
        float cg = curve[i];
        dest_l[di] += src_l[i] * cg;
        dest_r[di] += sr[i] * cg;
        i++; di++;
      }
    } else {
      while (i < copy_len) {
        float cg = curve[i];
        dest_l[di] += src_l[i] * gain_l * cg;
        dest_r[di] += sr[i] * gain_r * cg;
        i++; di++;
      }
    }
  } else if (gain_l == 1.0f && gain_r == 1.0f) {
    n = copy_len - 3;
    while (i < n) {
      dest_l[di]     += src_l[i];
      dest_r[di]     += sr[i];
      dest_l[di + 1] += src_l[i + 1];
      dest_r[di + 1] += sr[i + 1];
      dest_l[di + 2] += src_l[i + 2];
      dest_r[di + 2] += sr[i + 2];
      dest_l[di + 3] += src_l[i + 3];
      dest_r[di + 3] += sr[i + 3];
      i += 4; di += 4;
    }
    while (i < copy_len) {
      dest_l[di] += src_l[i];
      dest_r[di] += sr[i];
      i++; di++;
    }
  } else if (gain_l == gain_r) {
    float g = gain_l;
    n = copy_len - 3;
    while (i < n) {
      dest_l[di]     += src_l[i] * g;
      dest_r[di]     += sr[i] * g;
      dest_l[di + 1] += src_l[i + 1] * g;
      dest_r[di + 1] += sr[i + 1] * g;
      dest_l[di + 2] += src_l[i + 2] * g;
      dest_r[di + 2] += sr[i + 2] * g;
      dest_l[di + 3] += src_l[i + 3] * g;
      dest_r[di + 3] += sr[i + 3] * g;
      i += 4; di += 4;
    }
    while (i < copy_len) {
      dest_l[di] += src_l[i] * g;
      dest_r[di] += sr[i] * g;
      i++; di++;
    }
  } else {
    n = copy_len - 3;
    while (i < n) {
      dest_l[di]     += src_l[i] * gain_l;
      dest_r[di]     += sr[i] * gain_r;
      dest_l[di + 1] += src_l[i + 1] * gain_l;
      dest_r[di + 1] += sr[i + 1] * gain_r;
      dest_l[di + 2] += src_l[i + 2] * gain_l;
      dest_r[di + 2] += sr[i + 2] * gain_r;
      dest_l[di + 3] += src_l[i + 3] * gain_l;
      dest_r[di + 3] += sr[i + 3] * gain_r;
      i += 4; di += 4;
    }
    while (i < copy_len) {
      dest_l[di] += src_l[i] * gain_l;
      dest_r[di] += sr[i] * gain_r;
      i++; di++;
    }
  }
}


#ifdef SC_NATIVE_MAIN
#include <stdio.h>
#include <time.h>
int main(void) {
  float *pcm;
  int32_t sid, started, i, quantums = 1000;
  int32_t voices = 64;
  int32_t length = 48000;
  clock_t t0, t1;
  double us_per_q, budget_us;

  sc_init();
  sc_set_sample_rate(48000);
  pcm = sc_sample_alloc(length);
  if (!pcm) { printf("alloc fail\n"); return 1; }
  for (i = 0; i < length; i++) pcm[i] = 0.1f * sc_sinf(SC_TWO_PI * 440.0f * i / 48000.0f);
  sid = sc_sample_register(-1, pcm, 0, length, 48000, 1, 0, length);
  started = sc_bench_start_n(sid, voices, 1.0f, 0.05f);
  for (i = 0; i < 100; i++) sc_process(SC_QUANTUM);
  t0 = clock();
  for (i = 0; i < quantums; i++) sc_process(SC_QUANTUM);
  t1 = clock();
  us_per_q = (double)(t1 - t0) / CLOCKS_PER_SEC * 1e6 / quantums;
  budget_us = 1000000.0 * SC_QUANTUM / 48000.0;
  printf("voices=%d started=%d us/quantum=%.2f budget=%.1f (%.1f%%) active=%d\n",
         voices, started, us_per_q, budget_us, 100.0 * us_per_q / budget_us, sc_active_voices());
  return 0;
}
#endif
