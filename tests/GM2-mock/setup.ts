// GM2 test setup. Re-exports shared utilities and defines the PlayerFactory type.
import { Channel, MidyGM2, Note } from "../../src/midy-GM2.ts";
import {
  AnyPlayer,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  flushNotePromises,
  installSoundFontStub,
  makeDefaultVoiceParams,
  patchBufferSourceNodes,
  sanOptions,
  setMockCurrentTime,
} from "../mock-shared.ts";

export { Channel, MidyGM2, Note };
export type { AnyPlayer };
export {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  flushNotePromises,
  makeDefaultVoiceParams,
  sanOptions,
  setMockCurrentTime,
};

// -------------------------------------------------------------------------
// PlayerFactory type
// Used by every register*Tests() function so the same test bodies can be
// re-run against a different class by supplying a different factory.
// -------------------------------------------------------------------------

/** Minimal channel shape the shared basic tests rely on. */
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

/** Factory function type passed to every register*Tests() function. */
export type PlayerFactory = (exclusiveClass?: number) => BasicPlayer;

// -------------------------------------------------------------------------
// GM2 player factory
// -------------------------------------------------------------------------

/**
 * Build a MidyGM2 instance wired up for unit testing.
 * `getAudioBuffer` is stubbed so tests never touch the real decoder.
 */
export function setupGM2Player(exclusiveClass = 0): MidyGM2 {
  const ctx = new AudioContext();
  setMockCurrentTime(ctx, 0);

  const player = new MidyGM2(ctx);
  installSoundFontStub(player, exclusiveClass);

  // Stub getAudioBuffer so tests never hit the real decoder.
  player.getAudioBuffer = (
    _channel: Channel,
    _note: Note,
    _realtime: boolean,
  ): Promise<AudioBuffer> =>
    Promise.resolve(new AudioBuffer({ length: 100, sampleRate: 44100 }));

  patchBufferSourceNodes(player);
  return player;
}

/** Convenience alias so test files can use a uniform name. */
export const gmliteFactory: PlayerFactory = (exclusiveClass = 0) =>
  setupGM2Player(exclusiveClass) as unknown as BasicPlayer;
