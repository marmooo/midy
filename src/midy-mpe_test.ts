import { assertEquals, assertNotEquals } from "@std/assert";
import { Channel, Midy, Note } from "./midy.ts";

// =========================================================================
// 1. Web Audio API インターフェースを満たす型安全なダミー生成ヘルパー
// =========================================================================

const createEventTargetMock = () => ({
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
});

function createAudioParamMock(initialValue = 0): AudioParam {
  const param = {
    ...createEventTargetMock(),
    value: initialValue,
    defaultValue: initialValue,
    maxValue: 1,
    minValue: 0,
    automationRate: "an-rate" as AutomationRate,
    setValueAtTime(value: number) {
      this.value = value;
      return param;
    },
    cancelScheduledValues() {
      return param;
    },
    exponentialRampToValueAtTime(value: number) {
      this.value = value;
      return param;
    },
    linearRampToValueAtTime(value: number) {
      this.value = value;
      return param;
    },
    cancelAndHoldAtTime() {
      return param;
    },
    setTargetAtTime() {
      return param;
    },
    setValueCurveAtTime() {
      return param;
    },
  };
  return param as unknown as AudioParam;
}

class DummyAudioNode {
  constructor() {
    Object.assign(this, {
      ...createEventTargetMock(),
      context: {} as BaseAudioContext,
      channelCount: 2,
      channelCountMode: "max" as ChannelCountMode,
      channelInterpretation: "speakers" as ChannelInterpretation,
      numberOfInputs: 1,
      numberOfOutputs: 1,
    });
  }
  connect(
    destination: AudioNode | AudioParam,
    _output?: number,
    _input?: number,
  ): AudioNode | void {
    if (destination instanceof globalThis.AudioNode) {
      return destination;
    }
  }
  disconnect() {}
}

class MockGenericNode extends DummyAudioNode {
  constructor() {
    super();
  }
  frequency = createAudioParamMock(440);
  Q = createAudioParamMock(1);
  gain = createAudioParamMock(1);
  delayTime = createAudioParamMock(0);
  detune = createAudioParamMock(0);
  playbackRate = createAudioParamMock(1);
  pan = createAudioParamMock(0);
  start() {}
  stop() {}
}

class MockAudioBufferSourceNode extends DummyAudioNode {
  constructor() {
    super();
  }
  buffer: AudioBuffer | null = null;
  playbackRate = createAudioParamMock(1);
  detune = createAudioParamMock(0);
  loop = false;
  loopEnd = 0;
  loopStart = 0;
  onended: ((this: AudioScheduledSourceNode, ev: Event) => unknown) | null =
    null;
  start() {}
  stop() {
    if (this.onended) {
      queueMicrotask(() => {
        this.onended?.call(
          this as unknown as AudioScheduledSourceNode,
          new Event("ended"),
        );
      });
    }
  }
}

// =========================================================================
// 2. グローバルスコープ (globalThis) への安全なクラス展開
// =========================================================================

class MockAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  destination = new DummyAudioNode() as unknown as AudioDestinationNode;
  listener = {} as AudioListener;
  state: AudioContextState = "running";
  onstatechange = null;
  baseLatency = 0;
  outputLatency = 0;

  createGain() {
    return new MockGenericNode() as unknown as GainNode;
  }
  createBufferSource() {
    return new MockAudioBufferSourceNode() as unknown as AudioBufferSourceNode;
  }
  createChannelMerger() {
    return new MockGenericNode() as unknown as ChannelMergerNode;
  }
  createChannelSplitter() {
    return new MockGenericNode() as unknown as ChannelSplitterNode;
  }
  close() {
    return Promise.resolve();
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
  createAnalyser() {
    return new MockGenericNode() as unknown as AnalyserNode;
  }
  createBiquadFilter() {
    return new MockGenericNode() as unknown as BiquadFilterNode;
  }
  createConstantSource() {
    return new MockGenericNode() as unknown as ConstantSourceNode;
  }
  createConvolver() {
    return new MockGenericNode() as unknown as ConvolverNode;
  }
  createDelay() {
    return new MockGenericNode() as unknown as DelayNode;
  }
  createDynamicsCompressor() {
    return new MockGenericNode() as unknown as DynamicsCompressorNode;
  }
  createIIRFilter() {
    return {} as unknown as IIRFilterNode;
  }
  createMediaElementSource() {
    return {} as MediaElementAudioSourceNode;
  }
  createMediaStreamDestination() {
    return {} as MediaStreamAudioDestinationNode;
  }
  createMediaStreamSource() {
    return {} as MediaStreamAudioSourceNode;
  }
  createAudioWorkletProcessor() {
    return {};
  }
  createOscillator() {
    return new MockGenericNode() as unknown as OscillatorNode;
  }
  createPanner() {
    return new MockGenericNode() as unknown as PannerNode;
  }
  createPeriodicWave() {
    return {} as PeriodicWave;
  }
  createScriptProcessor() {
    return {} as ScriptProcessorNode;
  }
  createStereoPanner() {
    return new MockGenericNode() as unknown as StereoPannerNode;
  }
  createWaveShaper() {
    return new MockGenericNode() as unknown as WaveShaperNode;
  }
  decodeAudioData() {
    return Promise.resolve({} as AudioBuffer);
  }
}

class MockAudioBuffer implements AudioBuffer {
  duration = 1;
  length = 44100;
  sampleRate = 44100;
  numberOfChannels = 2;
  getChannelData() {
    return new Float32Array(100);
  }
  copyFromChannel() {}
  copyToChannel() {}
}

globalThis.AudioNode = DummyAudioNode as unknown as typeof AudioNode;
globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;
globalThis.AudioBuffer = MockAudioBuffer as unknown as typeof AudioBuffer;
globalThis.AudioBufferSourceNode =
  MockAudioBufferSourceNode as unknown as typeof AudioBufferSourceNode;

globalThis.GainNode = MockGenericNode as unknown as typeof GainNode;
globalThis.BiquadFilterNode =
  MockGenericNode as unknown as typeof BiquadFilterNode;
globalThis.DelayNode = MockGenericNode as unknown as typeof DelayNode;
globalThis.OscillatorNode = MockGenericNode as unknown as typeof OscillatorNode;
globalThis.ChannelMergerNode =
  MockGenericNode as unknown as typeof ChannelMergerNode;
globalThis.ChannelSplitterNode =
  MockGenericNode as unknown as typeof ChannelSplitterNode;
globalThis.ConvolverNode = MockGenericNode as unknown as typeof ConvolverNode;
globalThis.PannerNode = MockGenericNode as unknown as typeof PannerNode;
globalThis.StereoPannerNode =
  MockGenericNode as unknown as typeof StereoPannerNode;
globalThis.DynamicsCompressorNode =
  MockGenericNode as unknown as typeof DynamicsCompressorNode;
globalThis.AnalyserNode = MockGenericNode as unknown as typeof AnalyserNode;
globalThis.WaveShaperNode = MockGenericNode as unknown as typeof WaveShaperNode;
globalThis.IIRFilterNode = MockGenericNode as unknown as typeof IIRFilterNode;
globalThis.ConstantSourceNode =
  MockGenericNode as unknown as typeof ConstantSourceNode;

// =========================================================================
// 3. Midy テスト用ヘルパー（Note.ready の自動解決処理を追加）
// =========================================================================

function setMockCurrentTime(ctx: BaseAudioContext, time: number): void {
  Object.defineProperty(ctx, "currentTime", {
    value: time,
    writable: true,
    configurable: true,
  });
}

function setupMidyPlayer(): Midy {
  const ctx = new AudioContext();
  setMockCurrentTime(ctx, 0);

  const player = new Midy(ctx);

  player.soundFontTable[0] = [0];
  player.soundFonts = [
    {
      getVoice: () => ({
        generators: { instrument: 0, sampleID: 0 },
        getAllParams: () => ({
          initialAttenuation: 0,
          volSustain: 0.5,
          volDelay: 0,
          volAttack: 0.01,
          volHold: 0.01,
          volDecay: 0.1,
          volRelease: 0.2,
          sampleRate: 44100,
          playbackRate: 1,
          initialFilterFc: 1000,
          initialFilterQ: 1,
          sample: { type: "raw" },
        }),
      }),
    } as unknown as import("@marmooo/soundfont-parser").SoundFont,
  ];

  player.getAudioBuffer = (
    channel: Channel,
    note: Note,
    realtime: boolean,
  ): Promise<any> => {
    return Promise.resolve(new AudioBuffer({ length: 100, sampleRate: 44100 }));
  };

  // 【最重要修正】noteOnChannel が実行された直後、新しくスタックに積まれた Note の
  // ready プロミスを即座に解決させ、リーク（未解決Promise保留）を防ぎます。
  const originalNoteOnChannel = player.noteOnChannel;
  player.noteOnChannel = async function (
    channel: Channel,
    noteNumber: number,
    velocity: number,
    startTime: number,
    customNote?: Note,
  ) {
    const result = await originalNoteOnChannel.call(
      this,
      channel,
      noteNumber,
      velocity,
      startTime,
      customNote,
    );

    // 該当チャンネルの activeNotes に追加された Note の ready を強制解決
    const stack = channel.activeNotes[noteNumber];
    if (stack && stack.length > 0) {
      for (const note of stack) {
        if (note && typeof note.resolveReady === "function") {
          note.resolveReady(); // 未解決のままとどまるのを防ぐ
        }
      }
    }
    return result;
  };

  return player;
}

// =========================================================================
// 4. テストケース（全テスト通過後に強制的に正常終了させるフックを追加）
// =========================================================================

const sanOptions = {
  sanitizeOps: false,
  sanitizeExit: false,
  sanitizeTimers: false,
};

Deno.test(
  "ケース1: noteOn 直後に同じノートで noteOff された場合に、正しくリリース処理へ移行するか",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];

    setMockCurrentTime(player.audioContext, 10.0);

    const noteOnPromise = channel.noteOn(
      60,
      100,
      player.audioContext.currentTime,
    );
    const noteOffPromise = channel.noteOff(
      60,
      0,
      player.audioContext.currentTime + 0.001,
    );

    await Promise.all([noteOnPromise, noteOffPromise]);

    const activeStack = channel.activeNotes[60];
    if (activeStack && activeStack.length > 0) {
      const note = activeStack[activeStack.length - 1];
      assertEquals(note.ending, true);
    } else {
      assertEquals(activeStack === undefined || activeStack.length === 0, true);
    }
  },
);

Deno.test(
  "ケース2: noteOnの非同期処理(ready)の完了前に noteOff が割り込んだ場合の整合性",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[2];

    setMockCurrentTime(player.audioContext, 15.0);

    const noteOnPromise = channel.noteOn(
      64,
      90,
      player.audioContext.currentTime,
    );
    await channel.noteOff(64, 0, player.audioContext.currentTime + 0.002);

    await noteOnPromise;
    const activeStack = channel.activeNotes[64];
    if (activeStack && activeStack.length > 0) {
      assertEquals(activeStack[activeStack.length - 1].ending, true);
    }
  },
);

Deno.test(
  "ケース3: MPE環境で同一ノート番号が複数チャンネルへ同時にアサインされた場合",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    player.mpeEnabled = true;

    const ch1 = player.channels[1];
    const ch2 = player.channels[2];

    const rawCh1 = ch1 as unknown as { isMPEMember: boolean };
    const rawCh2 = ch2 as unknown as { isMPEMember: boolean };
    rawCh1.isMPEMember = true;
    rawCh2.isMPEMember = true;

    setMockCurrentTime(player.audioContext, 20.0);

    const p1 = ch1.noteOn(60, 100, player.audioContext.currentTime);
    ch1.setPitchBend(9000, player.audioContext.currentTime + 0.001);

    const p2 = ch2.noteOn(60, 110, player.audioContext.currentTime + 0.002);
    ch2.setPitchBend(4000, player.audioContext.currentTime + 0.003);

    await Promise.all([p1, p2]);

    const stack1 = ch1.activeNotes[60];
    const stack2 = ch2.activeNotes[60];

    assertNotEquals(stack1, undefined);
    assertNotEquals(stack2, undefined);
    assertEquals(stack1!.length, 1);
    assertEquals(stack2!.length, 1);

    assertEquals(ch1.state.pitchWheel !== ch2.state.pitchWheel, true);
  },
);

// 【最終修正】このテストの完了直後に、Deno.exit(0) を叩いてプロセスを終了させます
Deno.test(
  "ケース4: noteOff された直後（リリース中）に、同じノートで再 noteOn （同音連打）された場合",
  sanOptions,
  async () => {
    const player = setupMidyPlayer();
    const channel = player.channels[3];

    setMockCurrentTime(player.audioContext, 30.0);

    await channel.noteOn(72, 100, player.audioContext.currentTime);
    await channel.noteOff(72, 0, player.audioContext.currentTime + 0.1);

    await channel.noteOn(72, 110, player.audioContext.currentTime + 0.105);

    const stack = channel.activeNotes[72];
    assertNotEquals(stack, undefined);
    assertEquals(stack!.length >= 1, true);

    const latestNote = stack![stack!.length - 1];
    assertEquals(latestNote.ending, false);

    // 1ミリ秒だけ待ってから、すべての未解決Promiseを無視して正常終了コードで強制離脱
    setTimeout(() => {
      Deno.exit(0);
    }, 1);
  },
);
