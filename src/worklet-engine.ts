// Main-thread bridge for midy "worklet" cacheMode.
// Owns AudioWorkletNode lifecycle, sample uploads, and voice id allocation.

import {
  MIDY_WORKLET_NAME,
  type WorkletMainToProcessorMsg,
  type WorkletProcessorToMainMsg,
  WORKLET_MAX_VOICES,
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

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
  }

  /** Ensure the worklet module is loaded and the node is connected. */
  async ensureStarted(destination: AudioNode): Promise<void> {
    if (this.node) return;
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
      }
    };
    node.connect(destination);
    this.node = node;
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
    // Always send a copy we can transfer; callers may keep their own buffers.
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
    this.post({ type: "stop", voiceId });
  }

  allSoundOff(): void {
    this.activeVoices.clear();
    this.post({ type: "allSoundOff" });
  }

  setMasterGain(value: number): void {
    this.post({ type: "setMasterGain", value });
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
    if (this.moduleURL) {
      try {
        URL.revokeObjectURL(this.moduleURL);
      } catch { /* ignore */ }
      this.moduleURL = null;
    }
    this.loadedSamples.clear();
    this.activeVoices.clear();
    this.ready = null;
  }
}
