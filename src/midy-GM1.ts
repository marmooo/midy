// GM1 implementation. See player.ts for the shared engine (playback
// scheduling, caching, ADSR/segment/chunk rendering, etc.) and the base
// Note / Channel / ControllerState / RenderedBuffer classes.
//
// Behaviour relative to the generic Player defaults, matching the historical
// monolithic MidyGM1:
// - No RPN Fine Tuning / Coarse Tuning (not defined in GM1). Player already
//   omits these; channel.detune is driven only by pitch bend + range.
// - No hardcoded GM drum-map exclusive groups. Note choking uses only the
//   soundfont's SF2 exclusiveClass generator.
// - Drum Note Off runs the normal release path (ignoreDrumNoteOff = false),
//   instead of Player's one-shot "drop from activeNotes only" default.
import { Channel, Note, Player } from "./player.ts";

export {
  Channel,
  ControllerState,
  Note,
  Player,
  RenderedBuffer,
} from "./player.ts";

export class MidyGM1 extends Player<Note, Channel> {
  // Clear Player's default GM drum-map exclusive table.
  // All zeros → handleDrumExclusiveClass is a no-op and segment
  // classification does not treat any drum note as excluded-exclusive.
  override drumExclusiveClasses: Uint8Array = new Uint8Array(128);

  // Historical MidyGM1: drum Note Off triggers release, same as melodic notes.
  override ignoreDrumNoteOff: boolean = false;

  constructor(
    audioContext: AudioContext | OfflineAudioContext,
    options?: { activeChannelNumbers?: Iterable<number> },
  ) {
    super(audioContext, options);
    this.finishConstruction(
      audioContext,
      audioContext instanceof OfflineAudioContext,
    );
  }
}
