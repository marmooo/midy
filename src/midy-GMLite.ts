// GM Lite implementation. See player.ts for the shared engine (playback
// scheduling, caching, ADSR/segment/chunk rendering, etc.) and the base
// Note / Channel / ControllerState / RenderedBuffer classes. This file only
// exists so that `MidyGMLite` remains its own concrete class (distinct from
// `Midy` in midy.ts), even though today it adds nothing on top of `Player`.
import { Channel, Note, Player } from "./player.ts";

export {
  Channel,
  ControllerState,
  Note,
  Player,
  RenderedBuffer,
} from "./player.ts";

export class MidyGMLite extends Player<Note, Channel> {
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
