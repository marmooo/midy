// Main-thread bridge for midy "worklet" cacheMode.
// Owns AudioWorkletNode lifecycle, sample uploads, voice id allocation,
// and post-stage effect sends (reverb / chorus / delay).

import {
  MIDY_WORKLET_NAME,
  WORKLET_MAX_VOICES,
  type WorkletMainToProcessorMsg,
  type WorkletProcessorToMainMsg,
} from "./worklet-protocol.ts";
import { createWorkletModuleURL } from "./worklet-processor.ts";

export type WorkletNoteOnParams = {
  sampleId: number;
  when: number;
  playbackRate: number;
  gain: number;
  pan: number;
  delay: number;
  attack: number;
  hold: number;
  decay: number;
  sustain: number;
  release: number;
  // Filter
  filterFcCents: number;
  filterQ: number;
  filterDcGain: number;
  // Mod envelope
  delayModEnv: number;
  attackModEnv: number;
  holdModEnv: number;
  decayModEnv: number;
  sustainModEnv: number;
  releaseModEnv: number;
  modEnvToPitch: number;
  modEnvToFilterFc: number;
  // Mod LFO
  delayModLFO: number;
  freqModLFO: number;
  modLfoToPitch: number;
  modLfoToFilterFc: number;
  modLfoToVolume: number;
  // Vib LFO
  delayVibLFO: number;
  freqVibLFO: number;
  vibLfoToPitch: number;
};

/** Optional post-stage effect inputs (GM2 reverb/chorus, Midy delay). */
export type WorkletEffectInputs = {
  reverbInput?: AudioNode | null;
  chorusInput?: AudioNode | null;
  delayInput?: AudioNode | null;
};

export class WorkletEngine {
  readonly audioContext: AudioContext;
  node: AudioWorkletNode | null = null;
  private moduleURL: string | null = null;
  private ready: Promise<void> | null = null;
  private nextVoiceId = 1;
  private loadedSamples = new Set<number>();
  /** voiceId → true while sounding (for local bookkeeping). */
  private activeVoices = new Set<number>();

  /** Dry path into masterVolume (or other destination). */
  private dryGain: GainNode | null = null;
  /** Post-stage effect send gains (worklet mix → effect.input). */
  private reverbSendGain: GainNode | null = null;
  private chorusSendGain: GainNode | null = null;
  private delaySendGain: GainNode | null = null;

  /** Per-voice send levels for bus max aggregation. */
  private voiceReverb = new Map<number, number>();
  private voiceChorus = new Map<number, number>();
  private voiceDelay = new Map<number, number>();

  private effectInputs: WorkletEffectInputs = {};

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
  }

  /**
   * Ensure the worklet module is loaded and the node is connected.
   * `destination` is the dry bus (typically masterVolume).
   * Optional effect inputs receive post-mix sends (後段ノード).
   */
  async ensureStarted(
    destination: AudioNode,
    effects?: WorkletEffectInputs,
  ): Promise<void> {
    if (effects) this.effectInputs = { ...this.effectInputs, ...effects };
    if (this.node) {
      // Effects may appear after first start (e.g. setReverbEffect swap).
      this.reconnectEffectSends();
      return;
    }
    if (!this.ready) {
      this.ready = this.init(destination);
    }
    await this.ready;
  }

  private async init(destination: AudioNode): Promise<void> {
    const ctx = this.audioContext;
    if (!(ctx.audioWorklet)) {
      throw new Error("AudioWorklet is not supported in this environment");
    }
    this.moduleURL = createWorkletModuleURL();
    await ctx.audioWorklet.addModule(this.moduleURL);
    const node = new AudioWorkletNode(ctx, MIDY_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (ev: MessageEvent<WorkletProcessorToMainMsg>) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "voiceEnded") {
        this.activeVoices.delete(msg.voiceId);
        this.clearVoiceSends(msg.voiceId);
      }
    };

    // Dry path
    this.dryGain = new GainNode(ctx, { gain: 1 });
    node.connect(this.dryGain);
    this.dryGain.connect(destination);

    // Effect send gains (start silent; levels rise when voices report sends)
    this.reverbSendGain = new GainNode(ctx, { gain: 0 });
    this.chorusSendGain = new GainNode(ctx, { gain: 0 });
    this.delaySendGain = new GainNode(ctx, { gain: 0 });
    node.connect(this.reverbSendGain);
    node.connect(this.chorusSendGain);
    node.connect(this.delaySendGain);
    this.reconnectEffectSends();

    this.node = node;
  }

  /** Wire send gains to current effect inputs (safe to call on effect swap). */
  reconnectEffectSends(): void {
    const { reverbInput, chorusInput, delayInput } = this.effectInputs;
    this.safeReconnect(this.reverbSendGain, reverbInput ?? null);
    this.safeReconnect(this.chorusSendGain, chorusInput ?? null);
    this.safeReconnect(this.delaySendGain, delayInput ?? null);
  }

  private safeReconnect(
    send: GainNode | null,
    input: AudioNode | null,
  ): void {
    if (!send) return;
    try {
      send.disconnect();
    } catch { /* ignore */ }
    if (input) {
      try {
        send.connect(input);
      } catch { /* ignore */ }
    }
  }

  /** Update effect input targets (e.g. after setReverbEffect). */
  setEffectInputs(effects: WorkletEffectInputs): void {
    this.effectInputs = { ...this.effectInputs, ...effects };
    this.reconnectEffectSends();
  }

  post(msg: WorkletMainToProcessorMsg, transfer?: Transferable[]): void {
    if (!this.node) return;
    if (transfer && transfer.length) {
      this.node.port.postMessage(msg, transfer);
    } else {
      this.node.port.postMessage(msg);
    }
  }

  /**
   * Upload (or re-upload) a sample. Transfers the Float32Array buffers when
   * possible so the main thread can drop the copies.
   */
  loadSample(
    sampleId: number,
    pcmL: Float32Array,
    pcmR: Float32Array | null,
    sampleRate: number,
    loopStart: number,
    loopEnd: number,
    loop: boolean,
  ): void {
    const left = pcmL.slice();
    const transfer: Transferable[] = [left.buffer];
    let right: Float32Array | undefined;
    if (pcmR && pcmR.length === pcmL.length) {
      right = pcmR.slice();
      transfer.push(right.buffer);
    }
    this.post({
      type: "loadSample",
      sampleId,
      pcmL: left,
      pcmR: right,
      sampleRate,
      loopStart,
      loopEnd,
      loop,
    }, transfer);
    this.loadedSamples.add(sampleId);
  }

  hasSample(sampleId: number): boolean {
    return this.loadedSamples.has(sampleId);
  }

  allocVoiceId(): number {
    const id = this.nextVoiceId++;
    if (this.nextVoiceId > 0x7fffffff) this.nextVoiceId = 1;
    return id;
  }

  noteOn(voiceId: number, params: WorkletNoteOnParams): void {
    this.activeVoices.add(voiceId);
    this.post({
      type: "noteOn",
      voiceId,
      sampleId: params.sampleId,
      when: params.when,
      playbackRate: params.playbackRate,
      gain: params.gain,
      pan: params.pan,
      delay: params.delay,
      attack: params.attack,
      hold: params.hold,
      decay: params.decay,
      sustain: params.sustain,
      release: params.release,
      filterFcCents: params.filterFcCents,
      filterQ: params.filterQ,
      filterDcGain: params.filterDcGain,
      delayModEnv: params.delayModEnv,
      attackModEnv: params.attackModEnv,
      holdModEnv: params.holdModEnv,
      decayModEnv: params.decayModEnv,
      sustainModEnv: params.sustainModEnv,
      releaseModEnv: params.releaseModEnv,
      modEnvToPitch: params.modEnvToPitch,
      modEnvToFilterFc: params.modEnvToFilterFc,
      delayModLFO: params.delayModLFO,
      freqModLFO: params.freqModLFO,
      modLfoToPitch: params.modLfoToPitch,
      modLfoToFilterFc: params.modLfoToFilterFc,
      modLfoToVolume: params.modLfoToVolume,
      delayVibLFO: params.delayVibLFO,
      freqVibLFO: params.freqVibLFO,
      vibLfoToPitch: params.vibLfoToPitch,
    });
  }

  noteOff(voiceId: number, when: number, release?: number): void {
    this.post({
      type: "noteOff",
      voiceId,
      when,
      release,
    });
  }

  stop(voiceId: number): void {
    this.activeVoices.delete(voiceId);
    this.clearVoiceSends(voiceId);
    this.post({ type: "stop", voiceId });
  }

  allSoundOff(): void {
    this.activeVoices.clear();
    this.voiceReverb.clear();
    this.voiceChorus.clear();
    this.voiceDelay.clear();
    this.applySendBusLevels();
    this.post({ type: "allSoundOff" });
  }

  setMasterGain(value: number): void {
    this.post({ type: "setMasterGain", value });
  }

  /** Dynamic gain / pan / playbackRate update (channel CC). */
  setVoiceParams(
    voiceId: number,
    params: { gain?: number; pan?: number; playbackRate?: number },
  ): void {
    this.post({
      type: "setVoiceParams",
      voiceId,
      gain: params.gain,
      pan: params.pan,
      playbackRate: params.playbackRate,
    });
  }

  /**
   * Set per-voice effect send levels (0–1). Bus gains use the max across
   * active voices — a practical approximation for a post-mix worklet output.
   */
  setVoiceEffectSends(
    voiceId: number,
    sends: { reverb?: number; chorus?: number; delay?: number },
  ): void {
    if (sends.reverb != null) {
      const v = Math.max(0, Math.min(1, sends.reverb));
      if (v > 0) this.voiceReverb.set(voiceId, v);
      else this.voiceReverb.delete(voiceId);
    }
    if (sends.chorus != null) {
      const v = Math.max(0, Math.min(1, sends.chorus));
      if (v > 0) this.voiceChorus.set(voiceId, v);
      else this.voiceChorus.delete(voiceId);
    }
    if (sends.delay != null) {
      const v = Math.max(0, Math.min(1, sends.delay));
      if (v > 0) this.voiceDelay.set(voiceId, v);
      else this.voiceDelay.delete(voiceId);
    }
    this.applySendBusLevels();
  }

  private clearVoiceSends(voiceId: number): void {
    let changed = false;
    if (this.voiceReverb.delete(voiceId)) changed = true;
    if (this.voiceChorus.delete(voiceId)) changed = true;
    if (this.voiceDelay.delete(voiceId)) changed = true;
    if (changed) this.applySendBusLevels();
  }

  private maxMap(m: Map<number, number>): number {
    let max = 0;
    for (const v of m.values()) if (v > max) max = v;
    return max;
  }

  private applySendBusLevels(): void {
    const t = this.audioContext.currentTime;
    // Short smoothing so send changes are not clicks
    const tc = 0.015;
    if (this.reverbSendGain) {
      this.reverbSendGain.gain.setTargetAtTime(
        this.maxMap(this.voiceReverb),
        t,
        tc,
      );
    }
    if (this.chorusSendGain) {
      this.chorusSendGain.gain.setTargetAtTime(
        this.maxMap(this.voiceChorus),
        t,
        tc,
      );
    }
    if (this.delaySendGain) {
      this.delaySendGain.gain.setTargetAtTime(
        this.maxMap(this.voiceDelay),
        t,
        tc,
      );
    }
  }

  get activeVoiceCount(): number {
    return this.activeVoices.size;
  }

  get maxVoices(): number {
    return WORKLET_MAX_VOICES;
  }

  /** Disconnect and release the blob URL. */
  dispose(): void {
    if (this.node) {
      try {
        this.node.disconnect();
      } catch { /* ignore */ }
      try {
        this.node.port.onmessage = null;
      } catch { /* ignore */ }
      this.node = null;
    }
    for (
      const g of [
        this.dryGain,
        this.reverbSendGain,
        this.chorusSendGain,
        this.delaySendGain,
      ]
    ) {
      if (!g) continue;
      try {
        g.disconnect();
      } catch { /* ignore */ }
    }
    this.dryGain = null;
    this.reverbSendGain = null;
    this.chorusSendGain = null;
    this.delaySendGain = null;
    if (this.moduleURL) {
      try {
        URL.revokeObjectURL(this.moduleURL);
      } catch { /* ignore */ }
      this.moduleURL = null;
    }
    this.loadedSamples.clear();
    this.activeVoices.clear();
    this.voiceReverb.clear();
    this.voiceChorus.clear();
    this.voiceDelay.clear();
    this.ready = null;
  }
}
