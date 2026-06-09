import type { AnyPlayer } from "../mock-shared.ts";
export type { AnyPlayer };
export {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  flushNotePromises,
  makeDefaultVoiceParams,
  sanOptions,
  setMockCurrentTime,
} from "../mock-shared.ts";

export interface BasicChannel {
  player: AnyPlayer;
  isDrum: boolean;
  channelNumber: number;
  programNumber: number;
  detune: number;
  dataMSB: number;
  dataLSB: number;
  rpnMSB: number;
  rpnLSB: number;
  activeNotes: (unknown[] | undefined)[];
  sustainNotes: unknown[];
  state: {
    pitchWheel: number;
    pitchWheelSensitivity: number;
    volumeMSB: number;
    panMSB: number;
    expressionMSB: number;
    modulationDepthMSB: number;
    sustainPedal: number;
  };
  noteOn(n: number, v: number, t?: number): Promise<unknown>;
  noteOff(n: number, v: number, t?: number, force?: boolean): Promise<void>;
  setControlChange(cc: number, v: number, t?: number): void;
  setProgramChange(p: number): void;
  setPitchBend(v: number, t?: number): void;
  setRPNMSB(v: number): void;
  setRPNLSB(v: number): void;
  dataEntryMSB(v: number, t?: number): void;
  dataEntryLSB(v: number, t?: number): void;
  setSustainPedal(v: number, t?: number): Promise<void>;
  allSoundOff(t?: number): Promise<unknown>;
  allNotesOff(t?: number): Promise<unknown>;
  resetAllControllers(t?: number): void;
  processScheduledNotes(cb: (n: unknown) => void): Promise<void[]>;
  processActiveNotes(t: number, cb: (n: unknown) => void): Promise<void[]>;
}

export interface BasicPlayer extends AnyPlayer {
  channels: BasicChannel[];
}

export type PlayerFactory = (exclusiveClass?: number) => BasicPlayer;
