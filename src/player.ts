/**
 * Full-featured MIDI player with all CacheMode strategies
 * (none / ads / adsr / note / segment / chunk / audio).
 * Inherits real-time core from {@link BasePlayer}.
 */
import { parseMidi } from "midi-file";
import { type Voice, type VoiceParams } from "@marmooo/soundfont-parser";

import {
  BasePlayer,
  cbToRatio,
  Channel,
  ControllerState,
  envelopeCurve,
  f64ToBigInt,
  FULLY_OPEN_FILTER_CENTS,
  Note,
  RenderedBuffer,
  type TimelineEvent,
} from "./base-player.ts";

// Cache mode
// - "none"    for full real-time control (dynamic CC, LFO, pitch)
// - "ads"     for real-time playback with higher cache hit rate
// - "adsr"    for real-time playback with accurate release envelope
// - "note"    for efficient playback when note behavior is fixed
// - "segment" for heavy polyphony with low CPU and live channel mixing
// - "chunk"   for heavy polyphony, merging all channels into one offline render
// - "audio"   for fully pre-rendered playback (lowest CPU)
//
// "none"
//   No caching. Envelope processing is done in real time on every note.
//   Uses Web Audio API nodes directly, so LFO and pitch envelope are
//   fully supported. Higher CPU usage.
// "ads"
//   Pre-renders the ADS (Attack-Decay-Sustain) phase into an
//   OfflineAudioContext and caches the result. The sustain tail is
//   aligned to the loop boundary as a fixed buffer. Release is
//   handled by fading volumeNode gain to 0 at note-off.
//   LFO effects (modLfoToPitch, modLfoToFilterFc, modLfoToVolume,
//   vibLfoToPitch) are applied in real time after playback starts.
// "adsr"
//   Pre-renders the full ADSR envelope (Attack-Decay-Sustain-Release)
//   into an OfflineAudioContext. The cache key includes the note
//   duration in ticks (tempo-independent) and the volRelease parameter,
//   so notes with the same duration and release shape share a buffer.
//   LFO effects are applied in real time after playback starts,
//   same as "ads" mode. Cache keys include note duration and
//   volRelease so identical-length notes share a buffer; LFO
//   variations do not produce separate cache entries.
// "note"
//   Renders the full noteOn-to-noteOff duration per note in an
//   OfflineAudioContext. All events during the note (volume,
//   expression, pitch bend, LFO, CC#1) are baked into the buffer,
//   so no real-time processing is needed during playback. Greatly
//   reduces CPU load for songs with many simultaneous notes.
//   Caching is unified with the shared simpleNote path: notes with no
//   automation during their interval are keyed and reused via
//   simpleNoteBufferCache (same as segment/chunk/audio). Notes with
//   in-note automation are still fully baked, but are not cached
//   (per-timeline-index fullVoiceCache was too low-hit to be useful).
//   MIDI file playback only — does not respond to real-time CC changes.
// "segment"
//   Groups simultaneously-sounding notes per channel into short
//   (segmentDuration-second) buffers instead of one AudioBufferSourceNode
//   per note. All notes belonging to one segment are baked together in a
//   single OfflineAudioContext / startRendering() call (each note still
//   gets its own full envelope/pitch-bend/LFO/CC#1 bake, same as "note"
//   mode), so segment creation pays the offline-render setup cost once
//   per segment rather than once per note. Channel volume/pan/expression
//   are deliberately left out of the bake so they keep responding in real
//   time through channel.gainL/gainR, like "ads"/"adsr" mode does. This
//   bounds the number of simultaneously active AudioBufferSourceNodes to
//   roughly one per channel (occasionally a couple more while a long
//   release tail overlaps the next segment), regardless of how dense the
//   polyphony gets. Notes whose ring time exceeds maxSegmentNoteDuration,
//   or that have a non-zero exclusiveClass (e.g. hi-hat choke groups), are
//   excluded from tiling and fall back to normal per-note real-time
//   ("ads"-style) scheduling so they can still be cut off early.
//   MIDI file playback only, same as "note"/"adsr" mode. Automatically
//   uses lookAhead + maxSegmentNoteDuration as its effective lookahead
//   (see lookAhead doc comment) instead of plain lookAhead, since a
//   segment's worst-case render cost scales with how long a single note
//   in it can ring, not just lookAhead's note-discovery window. Watch the
//   console for "missed its scheduled start" warnings; raise
//   maxSegmentNoteDuration's tier (or lookAhead) if they appear, at the
//   cost of added playback latency.
// "chunk"
//   Like "segment" mode, but merges ALL channels into a single
//   OfflineAudioContext / startRendering() call per time window instead of
//   one call per channel per window. Each note still gets its own full
//   envelope/pitch-bend/LFO/CC#1 bake (same fidelity as "segment" mode).
//   Channel volume/pan/expression ARE baked into the combined buffer
//   (unlike "segment" mode), so the result is a stereo mix ready to
//   connect straight to masterVolume — there is no per-channel gainL/gainR
//   live mixing. This halves the number of startRendering() calls (from
//   one per active channel per window to one per window), reducing
//   OfflineAudioContext setup overhead further. The trade-off is that
//   channel volume/pan/expression changes are not reflected after the
//   chunk is baked; they are snapshotted at chunk-open time.
//   Same MIDI-file-only restriction as "segment" mode.
// "audio"
//   Renders the entire MIDI file into a single AudioBuffer offline.
//   Call render() to complete rendering before calling start().
//   Playback simply streams an AudioBufferSourceNode, so CPU usage
//   is near zero. Seek and tempo changes are handled in real time.
//   A "rendering" event is dispatched when rendering starts, and a
//   "rendered" event is dispatched when rendering completes.
export const DEFAULT_CACHE_MODE = "segment";
export type CacheMode =
  | "none"
  | "ads"
  | "adsr"
  | "note"
  | "segment"
  | "chunk"
  | "audio";

export interface CacheEntry {
  audioBuffer: RenderedBuffer;
  maxCount: number;
  counter: number;
}
export interface NoteOnEventEntry {
  duration: number;
  durationTicks: number;
  startTime: number;
  /** Note-on absolute ticks (for relative automation keying). */
  startTicks: number;
  events: TimelineEvent[];
}
export interface NoteOnEntry {
  idx: number;
  startTime: number;
  startTicks: number;
  events: TimelineEvent[];
}
export interface PendingOffItem {
  t: number;
  ticks: number;
}
// "segment" mode
export interface SegmentNoteEntry {
  offset: number;
  noteNumber: number;
  velocity: number;
  voiceParams: VoiceParams;
  noteDuration: number;
  noteEvent: NoteOnEventEntry | undefined;
  audioBufferId?: number;
  voice?: Voice;
  // Snapshot of channel.detune / channel.state at this note's onset (append
  // time). Required for simple-note bakes: a pitch bend mid-segment must
  // not leave later simple notes using the segment-open detune.
  channelDetune: number;
  channelStateArray: Float32Array;
  programNumber: number;
  // Timeline index for simple-note classification / cache lookup.
  timelineIndex?: number;
}
export interface OpenSegment {
  segmentStart: number;
  notes: SegmentNoteEntry[];
  // Snapshot of channel.detune / channel.state.array taken at segment-open
  // time (the first note's onset), not segment-close time. scheduleTimelineEvents
  // applies every CC/pitchBend event to the realtime channel as the timeline
  // is walked, regardless of segment mode, so by the time closeSegment()
  // runs, the realtime channel.detune already reflects every event that
  // happened inside this segment. renderSegmentBuffer seeds the offline
  // channel from this snapshot and replays timeline events in chronological
  // order (same approach as renderChunkBuffer) so pitch bend is applied
  // once, not double-counted via setPitchBend's cumulative update.
  channelDetune: number;
  channelStateArray: Float32Array;
  programNumber: number;
}
export interface PendingSegment {
  segmentStart: number;
  buffer: AudioBuffer | null;
  bufferReady: boolean;
  bufferPromise: Promise<AudioBuffer | null>;
  source: AudioBufferSourceNode | null;
  done: boolean;
  // Tags which segmentGeneration this render belongs to. Compared against
  // the player's current segmentGeneration when the render resolves: if
  // they no longer match, a seek/stop/loop happened while this segment was
  // still rendering, so the result is stale and gets discarded instead of
  // being scheduled. See closeSegment()/stopSegmentSources() doc comments.
  generation: number;
}
export interface SegmentChannelState {
  openSegment: OpenSegment | null;
  pending: PendingSegment[];
}
// "chunk" mode
// ChunkNoteEntry mirrors SegmentNoteEntry, with a channelNumber added so
// the renderer knows which channel each note belongs to.
export interface ChunkNoteEntry {
  channelNumber: number;
  offset: number;
  noteNumber: number;
  velocity: number;
  voiceParams: VoiceParams;
  noteDuration: number;
  noteEvent: NoteOnEventEntry | undefined;
  audioBufferId?: number;
  voice?: Voice;
  // Snapshot of per-channel state at the time this note was appended.
  // Channel volume/pan/expression are baked into the chunk buffer so
  // they must be captured here (before later events on the same channel
  // change them).
  channelDetune: number;
  channelStateArray: Float32Array;
  programNumber: number;
  isDrum: boolean;
  // Timeline index (for simple-note classification / cache lookup).
  timelineIndex?: number;
}
/** Shared input for single-note offline bakes (simple + complex). */
export interface BakeNoteEntry {
  channelNumber: number;
  noteNumber: number;
  velocity: number;
  voiceParams: VoiceParams;
  noteDuration: number;
  noteEvent?: NoteOnEventEntry;
  channelDetune: number;
  channelStateArray: Float32Array;
  programNumber: number;
  isDrum: boolean;
  audioBufferId?: number;
  voice?: Voice;
}
export interface OpenChunk {
  chunkStart: number;
  notes: ChunkNoteEntry[];
}
export interface PendingChunk {
  chunkStart: number;
  buffer: AudioBuffer | null;
  bufferReady: boolean;
  bufferPromise: Promise<AudioBuffer | null>;
  source: AudioBufferSourceNode | null;
  done: boolean;
  generation: number;
}
export interface ChunkState {
  openChunk: OpenChunk | null;
  pending: PendingChunk[];
}

export class Player<
  TNote extends Note = Note,
  TChannel extends Channel<TNote> = Channel<TNote>,
> extends BasePlayer<TNote, TChannel> {
  cacheMode: CacheMode = DEFAULT_CACHE_MODE;
  voiceCache: Map<number, CacheEntry> = new Map();
  realtimeVoiceCache: Map<number, RenderedBuffer> = new Map();
  adsrVoiceCache: Map<
    number,
    Map<bigint, RenderedBuffer | Promise<RenderedBuffer>>
  > = new Map();
  // Simple-note cache (shared by note / segment / chunk / audio modes).
  // Notes with no pitch-bend / CC automation during their interval can be
  // fully baked once and reused (keyed by voice params + duration + channel
  // mix snapshot) instead of re-running the full noteOn path for every
  // identical onset — including "note" mode playback and offline segment/
  // chunk/audio mixes.
  simpleNoteCache: boolean = true;
  simpleNoteSet: Set<number> = new Set();
  simpleNoteBufferCache: Map<string, AudioBuffer | Promise<AudioBuffer>> =
    new Map();
  // Pre-playback occurrence counts for simple-note cache keys (same key as
  // makeSimpleNoteKey). Keys that appear more than once are worth a separate
  // OfflineAudioContext bake + cache fill on first miss; unique keys stay on
  // the shared mix OAC path (scheduleSimpleNotesDirect) to avoid an extra
  // startRendering that would never be reused.
  simpleNoteCounts: Map<string, number> = new Map();
  // Complex-note cache (shared by note / segment / chunk / audio modes).
  // Notes with identical in-interval automation (pitch bend / CC / sysEx
  // relative timeline) + voice / duration / onset channel state share one
  // OfflineAudioContext bake. Only keys that appear more than once are
  // cached (see complexNoteCounts / buildComplexNoteCounts) so one-shot
  // patterns never pay an extra Map + Promise indirection.
  complexNoteCache: boolean = true;
  complexNoteBufferCache: Map<string, AudioBuffer | Promise<AudioBuffer>> =
    new Map();
  complexNoteCounts: Map<string, number> = new Map();
  // True for offline mix bakers (segment/chunk/audio simple path).
  // setNoteAudioNode uses a leaner node graph (shared envelope gain,
  // no smoothing ramps, skip silent LFO/filter/pitch-env).
  offlineRenderOnly: boolean = false;
  noteOnDurations: number[] = [];
  noteOnEvents: (NoteOnEventEntry | undefined)[] = [];
  renderedAudioBuffer: AudioBuffer | null = null;
  isRendering: boolean = false;
  // audio mode
  audioModeBufferSource: AudioBufferSourceNode | null = null;
  audioWindowDuration: number = 4;
  // segment mode
  segmentDuration: number = 1;
  maxSegmentNoteDuration: number = 8;
  segmentBakedSet: Set<number> = new Set();
  segmentChannelStates: (SegmentChannelState | null)[] = [];
  segmentVoiceParams: (VoiceParams | null)[] = [];
  segmentVoices: (Voice | null)[] = [];
  segmentGeneration: number = 0;
  // chunk mode
  chunkState: ChunkState = { openChunk: null, pending: [] };
  chunkGeneration: number = 0;

  constructor(
    audioContext: AudioContext | OfflineAudioContext,
    options?: {
      activeChannelNumbers?: Iterable<number>;
      offlineRenderOnly?: boolean;
    },
  ) {
    super(audioContext, options);
    this.cacheMode = DEFAULT_CACHE_MODE;
    this.offlineRenderOnly = options?.offlineRenderOnly ?? false;
  }

  createOfflineRenderPlayer(
    offlineContext: OfflineAudioContext,
    activeChannelNumbers: number[],
    lightweight = false,
  ): Player<TNote, TChannel> {
    const offlinePlayer = new (this.constructor as new (
      audioContext: AudioContext | OfflineAudioContext,
      options?: {
        activeChannelNumbers?: Iterable<number>;
        offlineRenderOnly?: boolean;
      },
    ) => Player<TNote, TChannel>)(
      offlineContext as unknown as AudioContext,
      {
        activeChannelNumbers,
        offlineRenderOnly: lightweight,
      },
    );
    offlinePlayer.cacheMode = "none";
    offlinePlayer.offlineRenderOnly = lightweight;
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    offlinePlayer.rawAudioBufferCache = this.rawAudioBufferCache;
    return offlinePlayer;
  }

  override async loadMIDI(input: string | Uint8Array): Promise<void> {
    if (this.isPlaying || this.isPaused) {
      await this.stop();
    }
    this.voiceCounter.clear();
    this.clearPlaybackCaches();
    this.renderedAudioBuffer = null;
    this.noteAudioBufferIds = [];
    this.preloadEntries = [];
    this.segmentBakedSet.clear();
    this.simpleNoteSet.clear();
    this.simpleNoteBufferCache.clear();
    this.simpleNoteCounts.clear();
    this.complexNoteBufferCache.clear();
    this.complexNoteCounts.clear();
    this.segmentVoiceParams = [];
    this.segmentVoices = [];
    this.noteOnDurations = [];
    this.noteOnEvents = [];
    this.resumeTime = 0;
    this.isPaused = false;

    const uint8Array = await this.toUint8Array(input);
    const midi = parseMidi(uint8Array);
    this.ticksPerBeat = midi.header.ticksPerBeat ?? 480;
    const midiData = this.extractMidiData(midi);
    this.instruments = midiData.instruments;
    this.timeline = midiData.timeline;
    this.totalTime = this.calcTotalTime();
    if (this.cacheMode === "audio") {
      await this.render();
    }
  }

  buildNoteOnDurations(): void {
    const { timeline, totalTime, noteOnDurations, noteOnEvents, numChannels } =
      this;
    noteOnDurations.length = 0;
    noteOnEvents.length = 0;
    noteOnDurations.length = timeline.length;
    noteOnEvents.length = timeline.length;
    const inverseTempo = 1 / this.tempo;
    const sustainPedal = new Uint8Array(numChannels);
    const activeNotes = new Map<number, NoteOnEntry[]>();
    const pendingOff = new Map<number, PendingOffItem[]>();
    const finalizeEntry = (
      entry: NoteOnEntry,
      endTime: number,
      endTicks: number | null,
    ): void => {
      const duration = Math.max(0, endTime - entry.startTime);
      const durationTicks = (endTicks == null || endTicks === Infinity)
        ? Infinity
        : Math.max(0, endTicks - entry.startTicks);
      noteOnDurations[entry.idx] = duration;
      noteOnEvents[entry.idx] = {
        duration,
        durationTicks,
        startTime: entry.startTime,
        startTicks: entry.startTicks,
        events: entry.events,
      };
    };
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const t = event.startTime * inverseTempo;
      switch (event.type) {
        case "noteOn": {
          const ch = event.channel ?? 0;
          const key = event.noteNumber! * numChannels + ch;
          if (!activeNotes.has(key)) activeNotes.set(key, []);
          activeNotes.get(key)!.push({
            idx: i,
            startTime: t,
            startTicks: event.ticks,
            events: [],
          });
          const pendingStack = pendingOff.get(key);
          if (pendingStack && pendingStack.length > 0) pendingStack.shift();
          break;
        }
        case "noteOff": {
          const ch = event.channel ?? 0;
          const key = event.noteNumber! * numChannels + ch;
          if (sustainPedal[ch]) {
            if (!pendingOff.has(key)) pendingOff.set(key, []);
            pendingOff.get(key)!.push({ t, ticks: event.ticks });
          } else {
            const stack = activeNotes.get(key);
            if (stack && stack.length > 0) {
              finalizeEntry(stack.shift()!, t, event.ticks);
              if (stack.length === 0) activeNotes.delete(key);
            }
          }
          break;
        }
        case "controller": {
          const ch = event.channel ?? 0;
          {
            const pairs = Array.from(activeNotes);
            for (let pi = 0; pi < pairs.length; pi++) {
              const key = pairs[pi][0];
              if (key % numChannels !== ch) continue;
              const entries = pairs[pi][1];
              for (let ei = 0; ei < entries.length; ei++) {
                entries[ei].events.push(event);
              }
            }
          }
          switch (event.controllerType) {
            case 64: { // Sustain Pedal
              const on = event.value! >= 64;
              sustainPedal[ch] = on ? 1 : 0;
              if (!on) {
                const pairs = Array.from(pendingOff);
                for (let pi = 0; pi < pairs.length; pi++) {
                  const key = pairs[pi][0];
                  if (key % numChannels !== ch) continue;
                  const offItems = pairs[pi][1];
                  const activeStack = activeNotes.get(key);
                  for (let oi = 0; oi < offItems.length; oi++) {
                    const item = offItems[oi];
                    if (activeStack && activeStack.length > 0) {
                      finalizeEntry(activeStack.shift()!, item.t, item.ticks);
                      if (activeStack.length === 0) activeNotes.delete(key);
                    }
                  }
                  pendingOff.delete(key);
                }
              }
              break;
            }
            case 121: // Reset All Controllers
              sustainPedal[ch] = 0;
              break;
            case 120: // All Sound Off
            case 123: { // All Notes Off
              const pairs = Array.from(activeNotes);
              for (let pi = 0; pi < pairs.length; pi++) {
                const key = pairs[pi][0];
                if (key % numChannels !== ch) continue;
                const stack = pairs[pi][1];
                for (let ei = 0; ei < stack.length; ei++) {
                  finalizeEntry(stack[ei], t, event.ticks);
                }
                activeNotes.delete(key);
              }
              const pendingPairs = Array.from(pendingOff);
              for (let pi = 0; pi < pendingPairs.length; pi++) {
                const key = pendingPairs[pi][0];
                if (key % numChannels === ch) pendingOff.delete(key);
              }
              break;
            }
          }
          break;
        }
        case "sysEx": {
          const data = event.data!;
          if (data[0] === 126 && data[1] === 9 && data[2] === 3) {
            // GM1 System On
            if (data[3] === 1) {
              sustainPedal.fill(0);
              pendingOff.clear();
              const pairs = Array.from(activeNotes);
              for (let pi = 0; pi < pairs.length; pi++) {
                const stack = pairs[pi][1];
                for (let ei = 0; ei < stack.length; ei++) {
                  finalizeEntry(stack[ei], t, event.ticks);
                }
              }
              activeNotes.clear();
            }
          } else {
            const pairs = Array.from(activeNotes);
            for (let pi = 0; pi < pairs.length; pi++) {
              const entries = pairs[pi][1];
              for (let ei = 0; ei < entries.length; ei++) {
                entries[ei].events.push(event);
              }
            }
          }
          break;
        }
        case "pitchBend":
        case "programChange": {
          // Pitch bend is intentionally recorded on active notes so that
          // isSimpleNote / simpleNoteSet treat in-note pitch bends as
          // non-simple (same as CC). programChange is also recorded for
          // completeness; offline bakers may ignore it.
          const ch = event.channel ?? 0;
          const pairs = Array.from(activeNotes);
          for (let pi = 0; pi < pairs.length; pi++) {
            const key = pairs[pi][0];
            if (key % numChannels !== ch) continue;
            const entries = pairs[pi][1];
            for (let ei = 0; ei < entries.length; ei++) {
              entries[ei].events.push(event);
            }
          }
          break;
        }
      }
    }
    {
      const pairs = Array.from(activeNotes);
      for (let pi = 0; pi < pairs.length; pi++) {
        const stack = pairs[pi][1];
        for (let ei = 0; ei < stack.length; ei++) {
          finalizeEntry(stack[ei], totalTime, Infinity);
        }
      }
    }
  }

  cacheVoiceIds(): void {
    const { channels, timeline, voiceCounter, cacheMode } = this;
    // Start from GM defaults so programNumber/isDrum don't depend on
    // whatever live MIDI / previous song left on this.channels. Otherwise
    // noteAudioBufferIds resolved here can disagree with a clean walk
    // (e.g. audio mode's renderChannels), binding the wrong sample id.
    const settings = (this.constructor as typeof Player).channelSettings;
    for (let ch = 0; ch < channels.length; ch++) {
      const channel = channels[ch];
      channel.resetSettings(settings);
      // Subclasses (MidyGM2 / Midy) must supply their own ControllerState
      // so LSB / softPedal / delaySend etc. getters keep working.
      channel.state = this.createControllerState();
      channel.isDrum = false;
      channel.detune = 0;
      channel.programNumber = 0;
    }
    if (channels[9]) channels[9].isDrum = true;
    const isSegmentMode = cacheMode === "segment";
    const isChunkMode = cacheMode === "chunk";
    const needsSegmentData = isSegmentMode || isChunkMode;
    const segmentVoiceParams: (VoiceParams | null)[] = needsSegmentData
      ? new Array(timeline.length).fill(null)
      : [];
    const segmentVoices: (Voice | null)[] = needsSegmentData
      ? new Array(timeline.length).fill(null)
      : [];
    const noteAudioBufferIds: (number | undefined)[] = new Array(
      timeline.length,
    );
    const preloadEntries: {
      audioBufferId: number;
      voiceParams: VoiceParams;
    }[] = [];
    const seenPreloadIds = new Set<number>();
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "noteOn": {
          const channel = channels[event.channel!];
          const audioBufferId = this.getVoiceId(
            channel,
            event.noteNumber!,
            event.velocity!,
          );
          voiceCounter.set(
            audioBufferId!,
            (voiceCounter.get(audioBufferId!) ?? 0) + 1,
          );
          // finalizeSegmentClassification() runs after this loop, at which point
          // channel.programNumber reflects the last programChange in the song, not
          // the one in effect at each individual note. So voiceParams must be
          // resolved and snapshotted here, while programNumber is still correct.
          //
          // Exclusive-class drum notes are excluded from segmentVoiceParams
          // (and therefore from segment/chunk notes) because segmenting them
          // would bring no benefit — exclusive class guarantees at most one
          // note of the same class sounds at a time, so they're scheduled via
          // the normal noteOnChannel path instead. However they still need
          // their raw sample decoded and cached so that noteOnChannel path
          // doesn't pay a decode penalty on first encounter. Preload them
          // unconditionally. Subclasses (e.g. GM2 kit tables) override
          // isSegmentExcludedDrum.
          const isExcludedDrum = this.isSegmentExcludedDrum(
            channel,
            event.noteNumber!,
          );
          if (audioBufferId !== undefined) {
            noteAudioBufferIds[i] = audioBufferId;
            const voice = this.resolveVoice(
              channel,
              event.noteNumber!,
              event.velocity!,
            );
            if (voice) {
              const controllerState = this.getControllerState(
                channel,
                event.noteNumber!,
                event.velocity!,
                0,
              );
              const voiceParams = voice.getAllParams(controllerState);
              if (needsSegmentData && !isExcludedDrum) {
                segmentVoiceParams[i] = voiceParams;
                segmentVoices[i] = voice;
              }
              if (!seenPreloadIds.has(audioBufferId)) {
                seenPreloadIds.add(audioBufferId);
                preloadEntries.push({ audioBufferId, voiceParams });
              }
            }
          }
          break;
        }
        case "programChange":
          channels[event.channel!].setProgramChange(event.programNumber!);
          break;
        default:
          // Bank select and other mode-specific walk side effects (GM2, etc.).
          this.onCacheTimelineEvent(event);
      }
    }
    this.noteAudioBufferIds = noteAudioBufferIds;
    this.preloadEntries = preloadEntries;
    {
      const pairs = Array.from(voiceCounter);
      for (let i = 0; i < pairs.length; i++) {
        if (pairs[i][1] === 1) voiceCounter.delete(pairs[i][0]);
      }
    }
    this.applySystemDefaultsAfterCache(this.audioContext.currentTime);
    if (
      cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio" ||
      cacheMode === "segment" || cacheMode === "chunk"
    ) {
      this.buildNoteOnDurations();
    }
    if (needsSegmentData) {
      this.segmentVoiceParams = segmentVoiceParams;
      this.segmentVoices = segmentVoices;
      this.finalizeSegmentClassification();
      // Simple/complex-note classification is shared by note / segment / chunk / audio.
      this.finalizeSimpleNoteClassification();
      this.buildSimpleNoteCounts();
      this.buildComplexNoteCounts();
    } else if (cacheMode === "audio" || cacheMode === "note") {
      // audio mode uses renderChunkBuffer's simple-note path;
      // note mode reuses simpleNoteBufferCache for identical onsets.
      this.finalizeSimpleNoteClassification();
      this.buildSimpleNoteCounts();
      this.buildComplexNoteCounts();
    }
  }

  /**
   * Whether a drum note should be excluded from segment/chunk baking.
   * Exclusive-class drums are scheduled via the normal noteOn path so they
   * can still choke each other; segmenting them adds no polyphony win.
   * GM1 uses a fixed table; GM2 overrides with per-kit tables.
   */
  protected isSegmentExcludedDrum(
    channel: TChannel,
    noteNumber: number,
  ): boolean {
    return channel.isDrum && this.drumExclusiveClasses[noteNumber] !== 0;
  }

  /**
   * Side effects while walking the timeline inside cacheVoiceIds (bank
   * select, etc.). Base does nothing; GM2 applies CC#0 / CC#32 so program
   * changes resolve against the correct bank during the walk.
   */
  protected onCacheTimelineEvent(_event: TimelineEvent): void {}

  /**
   * Restore mode defaults after cacheVoiceIds has resolved voice ids.
   * Base = GM1 System On; GM2 overrides with GM2 System On.
   */
  protected applySystemDefaultsAfterCache(scheduleTime: number): void {
    this.GM1SystemOn(scheduleTime);
  }

  /**
   * Factory for a fresh ControllerState used when resetting channels inside
   * cacheVoiceIds / prepareVoices. Base returns the shared GM-Lite state;
   * MidyGM2 / Midy override so channel.state keeps the right prototype
   * (softPedal, portamento, LSB controllers, delaySendLevel, ...).
   * Using `new ControllerState()` from this module would install the base
   * class and silence notes once subclass code reads missing getters.
   */
  protected createControllerState(): ControllerState {
    return new ControllerState();
  }

  override scheduleTimelineEvents(
    scheduleTime: number,
    queueIndex: number,
  ): number {
    const timeOffset = this.resumeTime - this.startTime;
    const cacheMode = this.cacheMode;
    const isSegmentMode = cacheMode === "segment";
    const isChunkMode = cacheMode === "chunk";
    // Segment/chunk mode needs notes discovered far enough ahead that
    // closeSegment/closeChunk + render have time to finish before each
    // segment/chunk's scheduled start time. The worst case render length scales
    // with how long a single note in the segment can ring
    // (maxSegmentNoteDuration), on top of the segment's own discovery
    // window (lookAhead), so segment/chunk mode adds the two rather than reusing
    // the plain lookAhead other cache modes use for note-on scheduling.
    const effectiveLookAhead = (isSegmentMode || isChunkMode)
      ? this.lookAhead + this.maxSegmentNoteDuration
      : this.lookAhead;
    const lookAheadCheckTime = scheduleTime + timeOffset + effectiveLookAhead;
    const schedulingOffset = this.startDelay - timeOffset;
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const noteAudioBufferIds = this.noteAudioBufferIds;
    const segmentBakedSet = this.segmentBakedSet;
    const noteOnDurations = this.noteOnDurations;
    while (queueIndex < timeline.length) {
      const event = timeline[queueIndex];
      const t = event.startTime * inverseTempo;
      if (lookAheadCheckTime < t) break;
      const startTime = t + schedulingOffset;
      this.processTimelineEvent(event, startTime, {
        onNoteOn: (channel, event, startTime) => {
          const note = this.createNoteInstance(
            event.noteNumber!,
            event.velocity!,
            startTime,
          );
          note.timelineIndex = queueIndex;
          note.audioBufferId = noteAudioBufferIds[queueIndex];
          const isSegmentNote = isSegmentMode &&
            segmentBakedSet.has(queueIndex);
          const isChunkNote = isChunkMode &&
            segmentBakedSet.has(queueIndex);
          if (isSegmentNote || isChunkNote) {
            note.isSegmentGhost = true;
            note.segmentNoteDuration = noteOnDurations[queueIndex] ?? 0;
          }
          channel.noteOn(
            event.noteNumber!,
            event.velocity!,
            startTime,
            note,
          );
          if (isSegmentNote) {
            this.appendToSegmentQueue(
              channel.channelNumber,
              t,
              queueIndex,
              event.noteNumber!,
              event.velocity!,
            );
          }
          if (isChunkNote) {
            this.appendToChunkQueue(
              channel,
              t,
              queueIndex,
              event.noteNumber!,
              event.velocity!,
            );
          }
        },
        onNoteOff: (channel, event, startTime) => {
          channel.noteOff(event.noteNumber!, event.velocity!, startTime, false);
        },
      });
      queueIndex++;
    }
    return queueIndex;
  }

  override clearPlaybackCaches(): void {
    this.voiceCache.clear();
    this.realtimeVoiceCache.clear();
    this.adsrVoiceCache.clear();
    this.simpleNoteBufferCache.clear();
    this.simpleNoteCounts.clear();
    this.complexNoteBufferCache.clear();
    this.complexNoteCounts.clear();
  }

  async playAudioBuffer(): Promise<void> {
    const audioContext = this.audioContext;
    const paused = this.isPaused;
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = audioContext.currentTime;
    if (paused) {
      this.dispatchEvent(new Event("resumed"));
    } else {
      this.dispatchEvent(new Event("started"));
    }
    let exitReason: string | undefined;
    outer: while (true) {
      const buffer = this.renderedAudioBuffer;
      const bufferSource = new AudioBufferSourceNode(audioContext, { buffer });
      bufferSource.playbackRate.value = this.tempo;
      bufferSource.connect(this.masterVolume);
      const offset = Math.min(Math.max(this.resumeTime, 0), buffer!.duration);
      bufferSource.start(audioContext.currentTime, offset);
      this.audioModeBufferSource = bufferSource;
      let naturalEnded = false;
      bufferSource.onended = () => {
        naturalEnded = true;
      };
      while (true) {
        const now = audioContext.currentTime;
        await this.scheduleTask(() => {}, now + this.noteCheckInterval);
        if (naturalEnded || this.currentTime() >= this.totalTime) {
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          if (this.loop) {
            this.resumeTime = 0;
            this.startTime = audioContext.currentTime;
            this.dispatchEvent(new Event("looped"));
            continue outer;
          }
          await this.suspendAudioContext();
          exitReason = "ended";
          break outer;
        }
        if (this.isPausing) {
          this.cancelScheduledTasks();
          this.resumeTime = this.currentTime();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          // await this.suspendAudioContext();
          this.isPausing = false;
          exitReason = "paused";
          break outer;
        } else if (this.isStopping) {
          this.cancelScheduledTasks();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          await this.suspendAudioContext();
          this.isStopping = false;
          exitReason = "stopped";
          break outer;
        } else if (this.isSeeking) {
          this.cancelScheduledTasks();
          bufferSource.stop();
          bufferSource.disconnect();
          this.audioModeBufferSource = null;
          this.startTime = audioContext.currentTime;
          this.isSeeking = false;
          this.dispatchEvent(new Event("seeked"));
          continue outer;
        }
      }
    }
    this.isPlaying = false;
    if (exitReason === "paused") {
      this.isPaused = true;
      this.dispatchEvent(new Event("paused"));
    } else if (exitReason !== undefined) {
      this.isPaused = false;
      this.dispatchEvent(new Event(exitReason));
    }
  }

  override async playNotes(): Promise<void> {
    const audioContext = this.audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (this.cacheMode === "audio" && this.renderedAudioBuffer) {
      return await this.playAudioBuffer();
    }
    const paused = this.isPaused;
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = audioContext.currentTime;
    if (paused) {
      this.dispatchEvent(new Event("resumed"));
    } else {
      this.dispatchEvent(new Event("started"));
    }
    let queueIndex = this.getQueueIndex(this.resumeTime);
    if (this.cacheMode === "segment") this.initSegmentPipeline();
    if (this.cacheMode === "chunk") this.initChunkPipeline();
    let exitReason: string | undefined;
    this.notePromises = [];
    while (true) {
      const now = audioContext.currentTime;
      if (
        this.totalTime < this.currentTime() &&
        this.timeline.length <= queueIndex
      ) {
        const pendingPromises = this.notePromises.slice();
        this.notePromises = [];
        // Interruptible + grace-bounded wait (see BasePlayer.waitNotePromisesInterruptible).
        // Dense songs can leave a large release backlog here; a blocking
        // allSettled would make seek/pause unresponsive until every tail ends.
        const result = await this.waitNotePromisesInterruptible(
          pendingPromises,
        );
        if (result === "completed") {
          if (this.loop) {
            this.resetAllStates();
            this.startTime = audioContext.currentTime;
            this.resumeTime = 0;
            queueIndex = 0;
            if (this.cacheMode === "segment") {
              this.segmentGeneration++;
              this.initSegmentPipeline();
            }
            if (this.cacheMode === "chunk") {
              this.chunkGeneration++;
              this.initChunkPipeline();
            }
            this.dispatchEvent(new Event("looped"));
            continue;
          } else {
            if (this.cacheMode === "segment") await this.drainSegmentPipeline();
            if (this.cacheMode === "chunk") await this.drainChunkPipeline();
            await this.stopNotes(now);
            await this.suspendAudioContext();
            exitReason = "ended";
            break;
          }
        }
        // aborted → fall through to isPausing / isStopping / isSeeking
      }
      if (this.isPausing) {
        this.cancelScheduledTasks();
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
        await this.stopNotes(now);
        // await this.suspendAudioContext();
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        this.cancelScheduledTasks();
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
        await this.stopNotes(now);
        await this.suspendAudioContext();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
        if (this.cacheMode === "segment") this.stopSegmentSources();
        if (this.cacheMode === "chunk") this.stopChunkSources();
        this.startTime = audioContext.currentTime;
        const nextQueueIndex = this.getQueueIndex(this.resumeTime);
        this.updateStates(queueIndex, nextQueueIndex);
        queueIndex = nextQueueIndex;
        if (this.cacheMode === "segment") this.initSegmentPipeline();
        if (this.cacheMode === "chunk") this.initChunkPipeline();
        this.isSeeking = false;
        this.dispatchEvent(new Event("seeked"));
        continue;
      }
      queueIndex = this.scheduleTimelineEvents(now, queueIndex);
      if (this.cacheMode === "segment") {
        const timeOffset = this.resumeTime - this.startTime;
        this.updateSegmentPipeline(
          now + timeOffset + this.lookAhead + this.maxSegmentNoteDuration,
        );
      }
      if (this.cacheMode === "chunk") {
        const timeOffset = this.resumeTime - this.startTime;
        this.updateChunkPipeline(
          now + timeOffset + this.lookAhead + this.maxSegmentNoteDuration,
        );
      }
      const waitTime = now + this.noteCheckInterval;
      await this.scheduleTask(() => {}, waitTime);
    }
    if (exitReason !== "paused") {
      this.resetAllStates();
    }
    this.isPlaying = false;
    if (exitReason === "paused") {
      this.isPaused = true;
      this.dispatchEvent(new Event("paused"));
    } else {
      this.isPaused = false;
      this.dispatchEvent(new Event(exitReason!));
    }
  }

  override async start(
    { preload = true }: { preload?: boolean } = {},
  ): Promise<void> {
    if (this.isPlaying) return;
    if (this.isPaused) {
      await this.resume();
      return;
    }
    this.resumeTime = 0;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    if (preload) await this.preloadSamples();
    // Fresh playthrough: reset so console stats reflect this run only.
    this.playPromise = this.playNotes();
    await this.playPromise;
  }

  override async stop(): Promise<void> {
    if (this.isPlaying) {
      this.isStopping = true;
      this.cancelScheduledTasks();
      await this.playPromise;
      return;
    }
    if (this.isPaused) {
      const now = this.audioContext.currentTime;
      await this.stopNotes(now);
      if (this.cacheMode === "segment") this.stopSegmentSources();
      if (this.cacheMode === "chunk") this.stopChunkSources();
      if (this.audioModeBufferSource) {
        try {
          this.audioModeBufferSource.stop();
        } catch { /* already stopped */ }
        this.audioModeBufferSource.disconnect();
        this.audioModeBufferSource = null;
      }
      this.resetAllStates();
      this.resumeTime = 0;
      this.isPaused = false;
      this.dispatchEvent(new Event("stopped"));
    }
  }

  override tempoChange(tempo: number): void {
    const cacheMode = this.cacheMode;
    const timeScale = this.tempo / tempo;
    this.resumeTime = this.resumeTime * timeScale;
    this.tempo = tempo;
    this.totalTime = this.calcTotalTime();
    this.seekTo(this.currentTime() * timeScale);
    if (
      cacheMode === "adsr" || cacheMode === "note" || cacheMode === "audio" ||
      cacheMode === "segment" || cacheMode === "chunk"
    ) {
      this.buildNoteOnDurations();
      this.adsrVoiceCache.clear();
    }
    if (cacheMode === "segment" || cacheMode === "chunk") {
      this.finalizeSegmentClassification();
    }
    if (
      cacheMode === "note" || cacheMode === "segment" ||
      cacheMode === "chunk" || cacheMode === "audio"
    ) {
      this.finalizeSimpleNoteClassification();
      this.simpleNoteBufferCache.clear();
      this.complexNoteBufferCache.clear();
      this.buildSimpleNoteCounts();
      this.buildComplexNoteCounts();
    }
    if (cacheMode === "audio") {
      if (this.audioModeBufferSource) {
        this.audioModeBufferSource.playbackRate.setValueAtTime(
          this.tempo,
          this.audioContext.currentTime,
        );
      }
    }
    this.dispatchEvent(new Event("tempoChanged"));
  }

  override currentTime(): number {
    if (!this.isPlaying) return this.resumeTime;
    const now = this.audioContext.currentTime;
    if (this.cacheMode === "audio") {
      return this.resumeTime + (now - this.startTime) * this.tempo;
    }
    return now + this.resumeTime - this.startTime;
  }

  initSegmentPipeline(): void {
    this.segmentChannelStates = Array.from(
      { length: this.numChannels },
      () => ({ openSegment: null, pending: [] }),
    );
  }

  async drainSegmentPipeline(): Promise<void> {
    const channels = this.channels;
    const states = this.segmentChannelStates;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      if (state.openSegment) {
        this.closeSegment(state, channels[ch]);
      }
    }
    let promiseCount = 0;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (state) promiseCount += state.pending.length;
    }
    const allBufferPromises = new Array<Promise<AudioBuffer | null>>(
      promiseCount,
    );
    let pi = 0;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        allBufferPromises[pi++] = pending[i].bufferPromise;
      }
    }
    await Promise.allSettled(allBufferPromises);
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        if (!pending[i].source && pending[i].bufferReady) {
          this.startPendingSegment(channels[ch], pending[i]);
        }
      }
    }
    await this.waitForPendingSources("drainSegmentPipeline", () => {
      let total = 0;
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (state) total += state.pending.length;
      }
      const result = new Array<PendingSegment>(total);
      let ri = 0;
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (!state) continue;
        const pending = state.pending;
        for (let i = 0; i < pending.length; i++) result[ri++] = pending[i];
      }
      return result;
    });
  }

  stopSegmentSources(): void {
    // Invalidate any renderSegmentBuffer() calls still in flight. They keep
    // running in the background (OfflineAudioContext has no cancel API),
    // but closeSegment()'s completion handler checks this generation and
    // discards stale results instead of scheduling them or re-adding them
    // to state.pending. Without this, a backlog of now-irrelevant renders
    // from before a seek/stop/loop can play at the wrong moment once they
    // finally finish, and — since startRendering() is serialized by the
    // browser — can delay the fresh segments that should render next,
    // pushing them past lookAhead too.
    this.segmentGeneration++;
    const states = this.segmentChannelStates;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        if (p.source) {
          try {
            p.source.stop();
          } catch {
            // already stopped/ended
          }
          // disconnect is handled by the source's onended handler
          p.source = null;
        }
      }
      state.pending = [];
      state.openSegment = null;
    }
  }

  appendToSegmentQueue(
    channelNumber: number,
    t: number,
    timelineIndex: number,
    noteNumber: number,
    velocity: number,
  ): void {
    const state = this.segmentChannelStates[channelNumber];
    if (!state) return;
    const voiceParams = this.segmentVoiceParams[timelineIndex];
    if (!voiceParams) return;
    const channel = this.channels[channelNumber];
    if (
      state.openSegment &&
      this.segmentDuration <= t - state.openSegment.segmentStart
    ) {
      this.closeSegment(state, channel);
    }
    if (!state.openSegment) {
      state.openSegment = {
        segmentStart: t,
        notes: [],
        channelDetune: channel.detune,
        channelStateArray: channel.state.array.slice(),
        programNumber: channel.programNumber,
      };
    }
    state.openSegment.notes.push({
      offset: t - state.openSegment.segmentStart,
      noteNumber,
      velocity,
      voiceParams,
      noteDuration: this.noteOnDurations[timelineIndex] ?? 0,
      noteEvent: this.noteOnEvents[timelineIndex],
      audioBufferId: this.noteAudioBufferIds[timelineIndex],
      voice: this.segmentVoices[timelineIndex] ?? undefined,
      // Per-note onset snapshot — simple-note bakes need the detune/state
      // at this note's start, not the segment-open values (pitch bend may
      // have moved them in the meantime).
      channelDetune: channel.detune,
      channelStateArray: channel.state.array.slice(),
      programNumber: channel.programNumber,
      timelineIndex,
    });
  }

  closeSegment(state: SegmentChannelState, channel: TChannel): void {
    const segment = state.openSegment;
    state.openSegment = null;
    if (!segment || segment.notes.length === 0) return;
    const generation = this.segmentGeneration;
    const pending: PendingSegment = {
      segmentStart: segment.segmentStart,
      buffer: null,
      bufferReady: false,
      source: null,
      done: false,
      bufferPromise: Promise.resolve(null),
      generation,
    };
    pending.bufferPromise = this.renderSegmentBuffer(channel, segment)
      .then((buffer) => {
        if (this.segmentGeneration !== generation) {
          // A seek/stop/loop happened while this segment was rendering.
          // Drop the result: scheduling it now would play audio at the
          // wrong moment (its absoluteStart was computed against a
          // startTime/resumeTime that's no longer current), and letting
          // it linger in state.pending would let updateSegmentPipeline
          // start it later regardless. Also remove it from state.pending
          // in case it's a newer SegmentChannelState array than the one
          // this closure captured (initSegmentPipeline replaces the whole
          // array on seek), so it can't be picked up from there either.
          const idx = state.pending.indexOf(pending);
          if (idx !== -1) state.pending.splice(idx, 1);
          pending.done = true;
          return null;
        }
        pending.buffer = buffer;
        pending.bufferReady = true;
        return buffer;
      })
      .catch((err) => {
        console.warn("segment render failed", err);
        pending.bufferReady = true;
        return null;
      });
    state.pending.push(pending);
  }

  startPendingSegment(channel: TChannel, pending: PendingSegment): void {
    if (!pending.buffer) {
      pending.done = true;
      return;
    }
    const timeOffset = this.resumeTime - this.startTime;
    const schedulingOffset = this.startDelay - timeOffset;
    const nominalStart = pending.segmentStart + schedulingOffset;
    const absoluteStart = Math.max(0, nominalStart);
    this.warnIfStartTimeMissed(
      `segment (channel ${channel.channelNumber})`,
      nominalStart,
    );
    const source = new AudioBufferSourceNode(this.audioContext, {
      buffer: pending.buffer,
    });
    source.connect(channel.gainL);
    source.connect(channel.gainR);
    source.onended = () => {
      pending.done = true;
      source.disconnect();
    };
    source.start(absoluteStart);
    pending.source = source;
  }

  updateSegmentPipeline(lookAheadCheckTime: number): void {
    const channels = this.channels;
    const states = this.segmentChannelStates;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      if (
        state.openSegment &&
        state.openSegment.segmentStart + this.segmentDuration <=
          lookAheadCheckTime
      ) {
        this.closeSegment(state, channels[ch]);
      }
      const pending = state.pending;
      let write = 0;
      for (let i = 0; i < pending.length; i++) {
        if (!pending[i].done) pending[write++] = pending[i];
      }
      pending.length = write;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        if (!p.source && p.bufferReady) {
          this.startPendingSegment(channels[ch], p);
        }
      }
    }
  }

  initChunkPipeline(): void {
    this.chunkState = { openChunk: null, pending: [] };
  }

  async drainChunkPipeline(): Promise<void> {
    const state = this.chunkState;
    if (state.openChunk) {
      this.closeChunk(state);
    }
    const pending = state.pending;
    const allBufferPromises: Promise<AudioBuffer | null>[] = new Array(
      pending.length,
    );
    for (let i = 0; i < pending.length; i++) {
      allBufferPromises[i] = pending[i].bufferPromise;
    }
    await Promise.allSettled(allBufferPromises);
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (!p.source && p.bufferReady) {
        this.startPendingChunk(p);
      }
    }
    await this.waitForPendingSources("drainChunkPipeline", () => state.pending);
  }

  stopChunkSources(): void {
    // Invalidate in-flight renderChunkBuffer() calls (same rationale as
    // stopSegmentSources — stale renders must not be scheduled after a
    // seek/stop/loop).
    this.chunkGeneration++;
    const state = this.chunkState;
    const pending = state.pending;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (p.source) {
        try {
          p.source.stop();
        } catch {
          // already stopped/ended
        }
        // disconnect is handled by the source's onended handler
        p.source = null;
      }
    }
    state.pending = [];
    state.openChunk = null;
  }

  appendToChunkQueue(
    channel: TChannel,
    t: number,
    timelineIndex: number,
    noteNumber: number,
    velocity: number,
  ): void {
    const state = this.chunkState;
    const voiceParams = this.segmentVoiceParams[timelineIndex];
    if (!voiceParams) return;

    if (
      state.openChunk &&
      this.segmentDuration <= t - state.openChunk.chunkStart
    ) {
      this.closeChunk(state);
    }
    if (!state.openChunk) {
      state.openChunk = { chunkStart: t, notes: [] };
    }
    state.openChunk.notes.push({
      channelNumber: channel.channelNumber,
      offset: t - state.openChunk.chunkStart,
      noteNumber,
      velocity,
      voiceParams,
      noteDuration: this.noteOnDurations[timelineIndex] ?? 0,
      noteEvent: this.noteOnEvents[timelineIndex],
      audioBufferId: this.noteAudioBufferIds[timelineIndex],
      voice: this.segmentVoices[timelineIndex] ?? undefined,
      // Snapshot per-channel state now — channel volume/pan/expression
      // are baked into the buffer so they must be captured at note-append
      // time before subsequent events on the same channel change them.
      channelDetune: channel.detune,
      channelStateArray: channel.state.array.slice(),
      programNumber: channel.programNumber,
      isDrum: channel.isDrum,
      timelineIndex,
    });
  }

  closeChunk(state: ChunkState): void {
    const chunk = state.openChunk;
    state.openChunk = null;
    if (!chunk || chunk.notes.length === 0) return;
    const generation = this.chunkGeneration;
    const pending: PendingChunk = {
      chunkStart: chunk.chunkStart,
      buffer: null,
      bufferReady: false,
      source: null,
      done: false,
      bufferPromise: Promise.resolve(null),
      generation,
    };
    pending.bufferPromise = this.renderChunkBuffer(chunk)
      .then((buffer) => {
        if (this.chunkGeneration !== generation) {
          const idx = state.pending.indexOf(pending);
          if (idx !== -1) state.pending.splice(idx, 1);
          pending.done = true;
          return null;
        }
        pending.buffer = buffer;
        pending.bufferReady = true;
        return buffer;
      })
      .catch((err) => {
        console.warn("chunk render failed", err);
        pending.bufferReady = true;
        return null;
      });
    state.pending.push(pending);
  }

  startPendingChunk(pending: PendingChunk): void {
    if (!pending.buffer) {
      pending.done = true;
      return;
    }
    const timeOffset = this.resumeTime - this.startTime;
    const schedulingOffset = this.startDelay - timeOffset;
    const nominalStart = pending.chunkStart + schedulingOffset;
    const absoluteStart = Math.max(0, nominalStart);
    this.warnIfStartTimeMissed("chunk", nominalStart);
    const source = new AudioBufferSourceNode(this.audioContext, {
      buffer: pending.buffer,
    });
    // chunk buffers are stereo and already include channel volume/pan,
    // so connect directly to masterVolume (bypassing per-channel gainL/R).
    source.connect(this.masterVolume);
    source.onended = () => {
      pending.done = true;
      source.disconnect();
    };
    source.start(absoluteStart);
    pending.source = source;
  }

  updateChunkPipeline(lookAheadCheckTime: number): void {
    const state = this.chunkState;
    if (
      state.openChunk &&
      state.openChunk.chunkStart + this.segmentDuration <= lookAheadCheckTime
    ) {
      this.closeChunk(state);
    }
    const pending = state.pending;
    let write = 0;
    for (let i = 0; i < pending.length; i++) {
      if (!pending[i].done) pending[write++] = pending[i];
    }
    pending.length = write;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (!p.source && p.bufferReady) {
        this.startPendingChunk(p);
      }
    }
  }

  // forAudioOffline=false → realtime "chunk" mode (soft-clamp only; never
  //                         peak-normalize per window)
  // Both paths use simpleNote when the note has no in-interval automation
  // (pitch bend / CC are already excluded by isSimpleNote). Onset detune /
  // volume come from the per-note channelDetune / channelStateArray
  // snapshot taken at append (or offline walk) time — same as segment.
  //
  // Simple-note optimization: cache hits are placed as BufferSources; cache
  // misses are scheduled directly into this offline context (no per-note
  // OfflineAudioContext / startRendering). Complex notes still use one OAC
  // each so in-note pitch-bend / CC cannot cross-talk on a shared channel.
  async renderChunkBuffer(
    chunk: OpenChunk,
    forAudioOffline = false,
  ): Promise<AudioBuffer | null> {
    const notes = chunk.notes;
    if (notes.length === 0) return null;

    // Compute total duration across all notes in all channels.
    let totalDuration = 0;
    const notesLen = notes.length;
    for (let i = 0; i < notesLen; i++) {
      const n = notes[i];
      const releaseEnd = n.voiceParams.volRelease * envelopeCurve * 5;
      const end = n.offset + n.noteDuration + releaseEnd;
      if (end > totalDuration) totalDuration = end;
    }
    if (totalDuration <= 0) return null;

    // Over-allocate then trim — avoids a second isSimpleNote pass.
    const simpleNotes = new Array<ChunkNoteEntry>(notesLen);
    const complexNotes = new Array<ChunkNoteEntry>(notesLen);
    let simpleCount = 0;
    let complexCount = 0;
    for (let i = 0; i < notesLen; i++) {
      const n = notes[i];
      if (this.isSimpleNote(n)) simpleNotes[simpleCount++] = n;
      else complexNotes[complexCount++] = n;
    }
    simpleNotes.length = simpleCount;
    complexNotes.length = complexCount;

    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );

    // --- simple: hit → BufferSource; miss →
    //   count > 1 → getSimpleNoteBuffer (separate OAC + cache fill for reuse)
    //   count ≤ 1 → direct into this mix OAC (no extra startRendering)
    const simpleMisses = new Array<ChunkNoteEntry>(simpleCount);
    let missCount = 0;
    const simpleCounts = this.simpleNoteCounts;
    if (simpleCount > 0) {
      for (let i = 0; i < simpleCount; i++) {
        const n = simpleNotes[i];
        const cached = await this.lookupSimpleNoteBuffer(n, true);
        if (cached) {
          const src = new AudioBufferSourceNode(offlineContext, {
            buffer: cached,
          });
          src.connect(offlineContext.destination);
          src.start(n.offset);
          continue;
        }
        const key = this.makeSimpleNoteKey(n, true);
        const count = simpleCounts.get(key) ?? 0;
        if (count > 1) {
          // First (or concurrent) occurrence of a multi-use key: bake once
          // into simpleNoteBufferCache so later hits in this or other
          // windows/segments skip graph setup entirely.
          const buffer = await this.getSimpleNoteBuffer(
            {
              channelNumber: n.channelNumber,
              audioBufferId: n.audioBufferId,
              noteNumber: n.noteNumber,
              velocity: n.velocity,
              noteDuration: n.noteDuration,
              noteEvent: n.noteEvent,
              channelDetune: n.channelDetune,
              channelStateArray: n.channelStateArray,
              programNumber: n.programNumber,
              isDrum: n.isDrum,
              voiceParams: n.voiceParams,
              voice: n.voice,
            },
            true,
          );
          const src = new AudioBufferSourceNode(offlineContext, {
            buffer,
          });
          src.connect(offlineContext.destination);
          src.start(n.offset);
        } else {
          simpleMisses[missCount++] = n;
        }
      }
      if (missCount > 0) {
        const seenCh = new Uint8Array(16);
        const channelNumbers = new Array<number>(16);
        let chCount = 0;
        for (let i = 0; i < missCount; i++) {
          const chn = simpleMisses[i].channelNumber;
          if (!seenCh[chn]) {
            seenCh[chn] = 1;
            channelNumbers[chCount++] = chn;
          }
        }
        channelNumbers.length = chCount;
        const offlinePlayer = this.createOfflineRenderPlayer(
          offlineContext,
          channelNumbers,
          true,
        );
        const directNotes = new Array<{
          channelNumber: number;
          audioBufferId?: number;
          noteNumber: number;
          velocity: number;
          noteDuration: number;
          noteEvent?: NoteOnEventEntry;
          channelDetune: number;
          channelStateArray: Float32Array;
          programNumber: number;
          isDrum: boolean;
          voiceParams: VoiceParams;
          voice?: Voice;
          offset: number;
        }>(missCount);
        for (let i = 0; i < missCount; i++) {
          const n = simpleMisses[i];
          directNotes[i] = {
            channelNumber: n.channelNumber,
            audioBufferId: n.audioBufferId,
            noteNumber: n.noteNumber,
            velocity: n.velocity,
            noteDuration: n.noteDuration,
            noteEvent: n.noteEvent,
            channelDetune: n.channelDetune,
            channelStateArray: n.channelStateArray,
            programNumber: n.programNumber,
            isDrum: n.isDrum,
            voiceParams: n.voiceParams,
            voice: n.voice,
            offset: n.offset,
          };
        }
        await this.scheduleSimpleNotesDirect(
          offlineContext,
          offlinePlayer,
          directNotes,
          true,
        );
      }
    }

    // --- complex: per-note full bake (in-note pitch bend / CC) ---
    // Identical automation patterns (count > 1) share one OAC via
    // complexNoteBufferCache; unique patterns still bake once each.
    const complexLen = complexNotes.length;
    if (complexLen > 0) {
      const complexPromises = new Array<Promise<AudioBuffer>>(complexLen);
      for (let i = 0; i < complexLen; i++) {
        const n = complexNotes[i];
        const entry = {
          channelNumber: n.channelNumber,
          noteNumber: n.noteNumber,
          velocity: n.velocity,
          voiceParams: n.voiceParams,
          noteDuration: n.noteDuration,
          noteEvent: n.noteEvent,
          channelDetune: n.channelDetune,
          channelStateArray: n.channelStateArray,
          programNumber: n.programNumber,
          isDrum: n.isDrum,
          audioBufferId: n.audioBufferId,
          voice: n.voice,
        };
        complexPromises[i] = (async () => {
          const cached = await this.lookupComplexNoteBuffer(entry, true);
          if (cached) {
            return cached;
          }
          return await this.getComplexNoteBuffer(entry, true);
        })();
      }
      const complexBuffers = await Promise.all(complexPromises);
      for (let i = 0; i < complexLen; i++) {
        const n = complexNotes[i];
        const src = new AudioBufferSourceNode(offlineContext, {
          buffer: complexBuffers[i],
        });
        src.connect(offlineContext.destination);
        src.start(n.offset);
      }
    }

    const buffer = await offlineContext.startRendering();
    // Realtime chunk: never peak-normalize per window (dense chunks would
    // get quieter than sparse ones). Soft-clamp only samples outside
    // [-1, 1] so relative level stays stable across chunk boundaries.
    if (!forAudioOffline) {
      this.softClampBuffer(buffer);
    }
    return buffer;
  }

  async render(): Promise<AudioBuffer | undefined> {
    if (this.isRendering) return;
    if (this.timeline.length === 0) return;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    this.isRendering = true;
    this.renderedAudioBuffer = null;
    this.dispatchEvent(new Event("rendering"));

    // Collect every note into ChunkNoteEntry[], then bake in short time
    // windows via renderChunkBuffer(). A single OfflineAudioContext holding
    // the entire song can produce a buffer where only the opening attack is
    // audible under heavy per-note graphs. Windowed renders keep the node
    // count bounded; windows are mixed into one final AudioBuffer.
    const settings = (this.constructor as typeof Player).channelSettings;
    const renderChannels = Array.from({ length: this.numChannels }, (_, ch) => {
      const channel = this.createChannelInstance(ch, settings);
      channel.player = this;
      return channel;
    });
    renderChannels[9].isDrum = true;

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const notes: ChunkNoteEntry[] = [];

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      // Same time base as realtime chunk/segment (no startDelay). Pass the
      // real event time so any time-dependent controller/pitchBend handling
      // matches playback; state snapshots for each noteOn then reflect the
      // correct cumulative pitch bend.
      const offset = event.startTime * inverseTempo;
      this.processTimelineEvent(event, offset, {
        channels: renderChannels,
        onNoteOn: (renderChannel: TChannel, event: TimelineEvent) => {
          const noteEvent = this.noteOnEvents[i];
          const noteDuration = noteEvent?.duration ??
            this.noteOnDurations[i] ?? 0;
          if (noteDuration <= 0) return;
          const { noteNumber, velocity } = event;
          const voice = this.resolveVoice(
            renderChannel,
            noteNumber!,
            velocity!,
          );
          if (!voice) return;
          const voiceParams = voice.getAllParams(
            this.getControllerState(renderChannel, noteNumber!, velocity!, 0),
          );
          notes.push({
            channelNumber: renderChannel.channelNumber,
            offset,
            noteNumber: noteNumber!,
            velocity: velocity!,
            voiceParams,
            noteDuration,
            noteEvent,
            audioBufferId: this.noteAudioBufferIds[i],
            voice,
            channelDetune: renderChannel.detune,
            channelStateArray: renderChannel.state.array.slice(),
            programNumber: renderChannel.programNumber,
            isDrum: renderChannel.isDrum,
            timelineIndex: i,
          });
        },
      });
    }

    if (notes.length === 0) {
      this.isRendering = false;
      this.dispatchEvent(new Event("rendered"));
      return undefined;
    }

    // Window length in seconds (audioWindowDuration). Keep small enough that
    // concurrent notes in one offlineAudioContext stay manageable; large
    // enough to limit the number of startRendering() calls.
    const windowSec = this.audioWindowDuration;
    let maxEnd = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const releaseEnd = (n.voiceParams.volRelease ?? 0) * envelopeCurve * 5;
      const end = n.offset + n.noteDuration + releaseEnd;
      if (end > maxEnd) maxEnd = end;
    }

    const sampleRate = this.audioContext.sampleRate;
    const totalFrames = Math.ceil(maxEnd * sampleRate);
    const mixed = new AudioBuffer({
      numberOfChannels: 2,
      length: totalFrames,
      sampleRate,
    });
    const mixedL = mixed.getChannelData(0);
    const mixedR = mixed.getChannelData(1);

    const windowCount = Math.max(1, Math.ceil(maxEnd / windowSec));
    for (let w = 0; w < windowCount; w++) {
      const winStart = w * windowSec;
      const winEnd = winStart + windowSec;
      // Only notes whose onset falls inside [winStart, winEnd) are rendered
      // in this window; each note is fully rendered (including its release)
      // relative to onset, so release tails are not cut and there is no
      // double-mixing across windows.
      const localNotes = new Array<ChunkNoteEntry>(notes.length);
      let localCount = 0;
      for (let ni = 0; ni < notes.length; ni++) {
        const n = notes[ni];
        if (n.offset < winStart || n.offset >= winEnd) continue;
        // Shift offsets so the offline context starts near 0 (small context).
        // channelStateArray is a typed array — copy so mutations in one
        // window can't affect another.
        localNotes[localCount++] = {
          ...n,
          offset: n.offset - winStart,
          channelStateArray: n.channelStateArray.slice(),
        };
      }
      if (localCount === 0) continue;
      localNotes.length = localCount;

      const chunk: OpenChunk = { chunkStart: winStart, notes: localNotes };
      // forAudioOffline=true: allow simpleNote cache; no per-window clamp
      // (final peakNormalize on the mixed buffer preserves dynamics).
      const buf = await this.renderChunkBuffer(chunk, true);
      if (!buf) continue;

      // Mix into the final buffer at the correct absolute frame offset.
      const destOffset = Math.floor(winStart * sampleRate);
      const copyFrames = Math.min(buf.length, totalFrames - destOffset);
      if (copyFrames <= 0) continue;
      const srcL = buf.getChannelData(0);
      const srcR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : srcL;
      for (let i = 0; i < copyFrames; i++) {
        mixedL[destOffset + i] += srcL[i];
        mixedR[destOffset + i] += srcR[i];
      }
    }

    // Peak normalize instead of tanh soft-clip: linear gain preserves
    // timbre when overlapping tails sum above 1.0. Only scale down when
    // the peak exceeds the target; quiet songs keep their original level.
    this.peakNormalizeBuffer(mixed);

    this.renderedAudioBuffer = mixed;
    this.isRendering = false;
    this.dispatchEvent(new Event("rendered"));
    return this.renderedAudioBuffer;
  }

  // Clamp any sample outside [-1, 1] without changing overall gain.
  // Used by realtime chunk mode so dense polyphony cannot grit on output
  // while quiet and loud chunks keep the same relative level (unlike
  // peakNormalize, which scales whole windows independently).
  softClampBuffer(buffer: AudioBuffer): void {
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const x = data[i];
        if (x > 1) data[i] = 1;
        else if (x < -1) data[i] = -1;
      }
    }
  }

  // Peak-normalize an AudioBuffer in place so the absolute peak is at most
  // PEAK_TARGET (0.95). Used by audio (final mix) and segment offline
  // renders to avoid hard-clip grit when overlapping notes sum above 1.0.
  // Linear gain only scales *down* when needed — quiet material is unchanged.
  // Not used for realtime chunk windows (see softClampBuffer).
  peakNormalizeBuffer(buffer: AudioBuffer, peakTarget = 0.95): void {
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    let peak = 0;
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const a = data[i] < 0 ? -data[i] : data[i];
        if (a > peak) peak = a;
      }
    }
    if (peak <= peakTarget || peak === 0) return;
    const scale = peakTarget / peak;
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] *= scale;
      }
    }
  }

  async preloadSamples(): Promise<void> {
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    const entries = this.preloadEntries;
    const cache = this.rawAudioBufferCache;
    const tasks = new Array<Promise<AudioBuffer>>(entries.length);
    let taskCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (cache.has(entry.audioBufferId)) continue;
      tasks[taskCount++] = this.getRawAudioBuffer(
        entry.audioBufferId,
        entry.voiceParams,
      );
    }
    if (taskCount === 0) return;
    tasks.length = taskCount;
    await Promise.all(tasks);
  }

  async createAdsRenderedBuffer(
    channel: TChannel,
    note: TNote,
    voiceParams: VoiceParams,
    audioBuffer: AudioBuffer,
    isDrum = false,
  ): Promise<RenderedBuffer> {
    const isLoop = isDrum
      ? (this.isLoopDrum(channel, note.noteNumber) &&
        voiceParams.sampleModes % 2 !== 0)
      : (voiceParams.sampleModes % 2 !== 0);
    const volAttack = voiceParams.volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    const adsDuration = volHold + decayDuration;
    const sampleLoopStart = voiceParams.loopStart / voiceParams.sampleRate;
    const sampleLoopDuration = isLoop
      ? (voiceParams.loopEnd - voiceParams.loopStart) / voiceParams.sampleRate
      : 0;
    const playbackRate = voiceParams.playbackRate;
    const outputLoopStart = sampleLoopStart / playbackRate;
    const outputLoopDuration = sampleLoopDuration / playbackRate;
    const loopCount = isLoop && adsDuration > outputLoopStart
      ? Math.ceil((adsDuration - outputLoopStart) / outputLoopDuration)
      : 0;
    const alignedLoopStart = outputLoopStart + loopCount * outputLoopDuration;
    const renderDuration = isLoop
      ? alignedLoopStart + outputLoopDuration
      : audioBuffer.duration / playbackRate;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      Math.ceil(renderDuration * sampleRate),
      sampleRate,
    );
    const bufferSource = new AudioBufferSourceNode(offlineContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.playbackRate.value = playbackRate;
    bufferSource.loop = isLoop;
    if (isLoop) {
      bufferSource.loopStart = sampleLoopStart;
      bufferSource.loopEnd = sampleLoopStart + sampleLoopDuration;
    }
    const initialFreq = this.clampCutoffFrequency(
      this.centToHz(voiceParams.initialFilterFc),
    );
    const filterIsAudible = voiceParams.modEnvToFilterFc !== 0 ||
      voiceParams.initialFilterFc < FULLY_OPEN_FILTER_CENTS;
    const filterEnvelopeNode = filterIsAudible
      ? new BiquadFilterNode(offlineContext, {
        type: "lowpass",
        Q: voiceParams.initialFilterQ / 10,
        frequency: initialFreq,
      })
      : null;
    const volumeEnvelopeNode = new GainNode(offlineContext);
    const offlineNote = Object.assign(
      new Note(note.noteNumber, note.velocity, 0),
      {
        voiceParams: note.voiceParams,
        filterEnvelopeNode,
        volumeEnvelopeNode,
        adjustedBaseFreq: note.adjustedBaseFreq,
      },
    ) as unknown as TNote;
    this.setVolumeEnvelope(channel, offlineNote, 0);
    if (filterEnvelopeNode) {
      this.setFilterEnvelope(channel, offlineNote, 0);
      bufferSource.connect(filterEnvelopeNode);
      filterEnvelopeNode.connect(volumeEnvelopeNode);
    } else {
      bufferSource.connect(volumeEnvelopeNode);
    }
    volumeEnvelopeNode.connect(offlineContext.destination);
    if (voiceParams.sample.type === "compressed") {
      bufferSource.start(0, voiceParams.start / audioBuffer.sampleRate);
    } else {
      bufferSource.start(0);
    }
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop,
      adsDuration,
      loopStart: alignedLoopStart,
      loopDuration: outputLoopDuration,
    });
  }

  async createAdsrRenderedBuffer(
    channel: TChannel,
    note: TNote,
    voiceParams: VoiceParams,
    audioBuffer: AudioBuffer,
    noteDuration: number,
    isDrum = false,
  ): Promise<RenderedBuffer> {
    const isLoop = isDrum
      ? (this.isLoopDrum(channel, note.noteNumber) &&
        voiceParams.sampleModes % 2 !== 0)
      : (voiceParams.sampleModes % 2 !== 0);
    const volAttack = voiceParams.volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const decayDuration = voiceParams.volDecay;
    const adsDuration = volHold + decayDuration;
    const releaseDuration = voiceParams.volRelease;
    const loopStartTime = voiceParams.loopStart / voiceParams.sampleRate;
    const loopDuration = isLoop
      ? (voiceParams.loopEnd - voiceParams.loopStart) / voiceParams.sampleRate
      : 0;
    const noteLoopCount = isLoop && noteDuration > loopStartTime
      ? Math.ceil((noteDuration - loopStartTime) / loopDuration)
      : 0;
    const alignedNoteEnd = isLoop
      ? loopStartTime + noteLoopCount * loopDuration
      : noteDuration;
    const noteOffTime = alignedNoteEnd;
    const totalDuration = noteOffTime + releaseDuration;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const bufferSource = new AudioBufferSourceNode(offlineContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.playbackRate.value = voiceParams.playbackRate;
    bufferSource.loop = isLoop;
    if (isLoop) {
      bufferSource.loopStart = loopStartTime;
      bufferSource.loopEnd = loopStartTime + loopDuration;
    }
    const initialFreq = this.clampCutoffFrequency(
      this.centToHz(voiceParams.initialFilterFc),
    );
    const filterIsAudible = voiceParams.modEnvToFilterFc !== 0 ||
      voiceParams.initialFilterFc < FULLY_OPEN_FILTER_CENTS;
    const filterEnvelopeNode = filterIsAudible
      ? new BiquadFilterNode(offlineContext, {
        type: "lowpass",
        Q: voiceParams.initialFilterQ / 10,
        frequency: initialFreq,
      })
      : null;
    const volumeEnvelopeNode = new GainNode(offlineContext);
    const offlineNote = Object.assign(
      new Note(note.noteNumber, note.velocity, 0),
      {
        voiceParams: note.voiceParams,
        filterEnvelopeNode,
        volumeEnvelopeNode,
        adjustedBaseFreq: note.adjustedBaseFreq,
      },
    ) as unknown as TNote;
    this.setVolumeEnvelope(channel, offlineNote, 0);
    this.setFilterEnvelope(channel, offlineNote, 0);

    const attackVolume = cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume *
      cbToRatio(-1000 * voiceParams.volSustain);
    const volDelayTime = voiceParams.volDelay;
    const volAttackTime = volDelayTime + voiceParams.volAttack;
    const volHoldTime = volAttackTime + voiceParams.volHold;
    let gainAtNoteOff;
    if (noteOffTime <= volDelayTime) {
      gainAtNoteOff = 0;
    } else if (noteOffTime <= volAttackTime) {
      gainAtNoteOff = 1e-6 + (attackVolume - 1e-6) *
          (noteOffTime - volDelayTime) / voiceParams.volAttack;
    } else if (noteOffTime <= volHoldTime) {
      gainAtNoteOff = attackVolume;
    } else if (noteOffTime <= volHoldTime + voiceParams.volDecay) {
      const decayFraction = (noteOffTime - volHoldTime) / voiceParams.volDecay;
      gainAtNoteOff = attackVolume *
        Math.pow(sustainVolume / attackVolume, decayFraction);
    } else {
      gainAtNoteOff = sustainVolume;
    }
    volumeEnvelopeNode.gain
      .cancelScheduledValues(noteOffTime)
      .setValueAtTime(gainAtNoteOff, noteOffTime)
      .setTargetAtTime(0, noteOffTime, releaseDuration * envelopeCurve);
    if (filterEnvelopeNode) {
      const modEnvToFilterFc = voiceParams.modEnvToFilterFc;
      const peekFreq = this.clampCutoffFrequency(
        this.centToHz(voiceParams.initialFilterFc + modEnvToFilterFc),
      );
      const sustainFreq = this.clampCutoffFrequency(
        this.centToHz(
          voiceParams.initialFilterFc +
            modEnvToFilterFc * (1 - voiceParams.modSustain),
        ),
      );
      const modDelayTime = voiceParams.modDelay;
      const modAttackTime = modDelayTime + voiceParams.modAttack;
      const modHoldTime = modAttackTime + voiceParams.modHold;
      let freqAtNoteOff;
      if (noteOffTime <= modDelayTime) {
        freqAtNoteOff = initialFreq;
      } else if (noteOffTime <= modAttackTime) {
        freqAtNoteOff = initialFreq + (peekFreq - initialFreq) *
            (noteOffTime - modDelayTime) / voiceParams.modAttack;
      } else if (noteOffTime <= modHoldTime) {
        freqAtNoteOff = peekFreq;
      } else if (noteOffTime <= modHoldTime + voiceParams.modDecay) {
        const decayFraction = (noteOffTime - modHoldTime) /
          voiceParams.modDecay;
        freqAtNoteOff = peekFreq *
          Math.pow(sustainFreq / peekFreq, decayFraction);
      } else {
        freqAtNoteOff = sustainFreq;
      }
      filterEnvelopeNode.frequency
        .cancelScheduledValues(noteOffTime)
        .setValueAtTime(freqAtNoteOff, noteOffTime)
        .exponentialRampToValueAtTime(
          initialFreq,
          noteOffTime + voiceParams.modRelease,
        );
    }

    if (filterEnvelopeNode) {
      bufferSource.connect(filterEnvelopeNode);
      filterEnvelopeNode.connect(volumeEnvelopeNode);
    } else {
      bufferSource.connect(volumeEnvelopeNode);
    }
    volumeEnvelopeNode.connect(offlineContext.destination);
    // Match createAdsRenderedBuffer: compressed samples keep the full
    // decoded buffer, so the SF2 start offset must be applied here. PCM
    // samples are already sliced to [start, end) in createAudioBuffer.
    if (voiceParams.sample.type === "compressed") {
      bufferSource.start(0, voiceParams.start / audioBuffer.sampleRate);
    } else {
      bufferSource.start(0);
    }
    const buffer = await offlineContext.startRendering();
    return new RenderedBuffer(buffer, {
      isLoop: false,
      isFull: false,
      adsDuration,
      noteDuration: noteOffTime,
      releaseDuration,
    });
  }

  // "segment" / "chunk" mode: combine the voiceParams resolved during cacheVoiceIds()
  // (at the correct point in program-change order) with noteOnDurations
  // (which needs its own full-timeline pass and isn't ready until after
  // that loop) to decide which notes are safe to bake into a segment/chunk.
  // Notes that ring too long, or that participate in an exclusive class
  // (hi-hat choke groups etc.), are left out so they keep going through
  // normal per-note real-time ("ads"-style) scheduling instead — that
  // path is the only way to cut a note off early once it has started.
  // Cheap (no voice resolution), so tempoChange() can call this again
  // after buildNoteOnDurations() without redoing the full classification.

  finalizeSegmentClassification(): void {
    const { noteOnDurations, segmentVoiceParams } = this;
    const bakedSet = new Set<number>();
    for (let i = 0; i < segmentVoiceParams.length; i++) {
      const voiceParams = segmentVoiceParams[i];
      if (!voiceParams) continue;
      if ((voiceParams.exclusiveClass ?? 0) !== 0) continue;
      const duration = noteOnDurations[i] ?? 0;
      const releaseTail = voiceParams.volRelease * envelopeCurve * 5;
      if (this.maxSegmentNoteDuration < duration + releaseTail) continue;
      bakedSet.add(i);
    }
    this.segmentBakedSet = bakedSet;
  }

  // Treat notes with no in-interval automation as simple.
  // noteEvent.events is filled by buildNoteOnDurations with every
  // controller / pitchBend / sysEx / programChange that occurs while the
  // note is active — so pitch bend IS part of the simple/complex test,
  // not only CC. Notes that start after a pitch bend but have no further
  // automation remain simple; their onset detune is taken from the
  // per-note channelDetune snapshot instead.
  // (Conservative approximation — events in the release gap after noteOff
  // are not captured.)
  finalizeSimpleNoteClassification(): void {
    const simple = new Set<number>();
    // Prefer the segment-baked subset when available (segment/chunk); fall
    // back to every noteOn with a known duration (note / audio mode).
    const candidates = this.segmentBakedSet.size > 0
      ? this.segmentBakedSet
      : null;
    if (candidates) {
      const candidateArr = Array.from(candidates);
      for (let ci = 0; ci < candidateArr.length; ci++) {
        const i = candidateArr[ci];
        const noteEvent = this.noteOnEvents[i];
        if (!noteEvent) continue;
        if (noteEvent.duration <= 0) continue;
        if (noteEvent.durationTicks === Infinity) continue;
        if (noteEvent.events.length > 0) continue;
        simple.add(i);
      }
    } else {
      for (let i = 0; i < this.noteOnEvents.length; i++) {
        const noteEvent = this.noteOnEvents[i];
        if (!noteEvent) continue;
        if (noteEvent.duration <= 0) continue;
        if (noteEvent.durationTicks === Infinity) continue;
        if (noteEvent.events.length > 0) continue;
        simple.add(i);
      }
    }
    this.simpleNoteSet = simple;
  }

  // Walk the timeline once (same event application as audio-mode render())
  // and count how often each simple-note cache key will appear. Used by
  // segment/chunk/audio miss paths: count > 1 → bake via getSimpleNoteBuffer
  // (fills simpleNoteBufferCache for later hits); count === 1 → stay on the
  // shared mix OAC (scheduleSimpleNotesDirect) so a one-shot note never pays
  // an extra startRendering.
  // bakeChannelMix matches the mode: segment = dry mono, note/chunk/audio =
  // stereo mix. Key format is identical to makeSimpleNoteKey.
  buildSimpleNoteCounts(): void {
    this.simpleNoteCounts.clear();
    if (!this.simpleNoteCache) return;
    const cacheMode = this.cacheMode;
    if (
      cacheMode !== "note" && cacheMode !== "segment" &&
      cacheMode !== "chunk" && cacheMode !== "audio"
    ) {
      return;
    }
    if (this.simpleNoteSet.size === 0) return;

    const bakeChannelMix = cacheMode !== "segment";
    const settings = (this.constructor as typeof Player).channelSettings;
    const channels = Array.from({ length: this.numChannels }, (_, ch) => {
      const channel = this.createChannelInstance(ch, settings);
      channel.player = this;
      return channel;
    });
    if (channels[9]) channels[9].isDrum = true;

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const needsSegmentVoice = cacheMode === "segment" || cacheMode === "chunk";

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const offset = event.startTime * inverseTempo;
      this.processTimelineEvent(event, offset, {
        channels,
        onNoteOn: (renderChannel: TChannel, noteEvent: TimelineEvent) => {
          if (!this.simpleNoteSet.has(i)) return;
          const noteOnEvent = this.noteOnEvents[i];
          if (!noteOnEvent || noteOnEvent.duration <= 0) return;

          let voiceParams: VoiceParams | null = null;
          let voice: Voice | null | undefined = null;
          if (needsSegmentVoice) {
            voiceParams = this.segmentVoiceParams[i];
            voice = this.segmentVoices[i];
          }
          if (!voiceParams) {
            voice = this.resolveVoice(
              renderChannel,
              noteEvent.noteNumber!,
              noteEvent.velocity!,
            );
            if (!voice) return;
            voiceParams = voice.getAllParams(
              this.getControllerState(
                renderChannel,
                noteEvent.noteNumber!,
                noteEvent.velocity!,
                0,
              ),
            );
          }
          if (!voiceParams) return;

          const key = this.makeSimpleNoteKey(
            {
              audioBufferId: this.noteAudioBufferIds[i],
              noteNumber: noteEvent.noteNumber!,
              velocity: noteEvent.velocity!,
              noteDuration: noteOnEvent.duration,
              noteEvent: noteOnEvent,
              channelDetune: renderChannel.detune,
              channelStateArray: renderChannel.state.array,
              programNumber: renderChannel.programNumber,
              isDrum: renderChannel.isDrum,
              voiceParams,
            },
            bakeChannelMix,
          );
          this.simpleNoteCounts.set(
            key,
            (this.simpleNoteCounts.get(key) ?? 0) + 1,
          );
        },
      });
    }
  }

  isSimpleNote(n: {
    timelineIndex?: number;
    noteEvent?: NoteOnEventEntry;
  }): boolean {
    if (!this.simpleNoteCache) return false;
    if (n.timelineIndex !== undefined) {
      return this.simpleNoteSet.has(n.timelineIndex);
    }
    const noteEvent = n.noteEvent;
    if (!noteEvent || noteEvent.duration <= 0) return false;
    if (noteEvent.durationTicks === Infinity) return false;
    return noteEvent.events.length === 0;
  }

  // bakeChannelMix flag (keys, getSimple/ComplexNoteBuffer, renderEntryAudioBuffer):
  //   true  → "mix": stereo offline graph keeps the channel bus (vol/pan/
  //           expression) and mix-level sends (e.g. Midy delay). note/chunk/audio.
  //           Those mix-level values belong in the cache key.
  //   false → "dry": mono note body only; volumeNode is rewired past the
  //           channel bus (dropping delay/reverb sends hung off it) so segment
  //           mode can apply gainL/gainR (and leave delay) live. Mix-level
  //           state must not split the dry cache key.
  //
  // Shared body is buildNoteCacheKeyParts; subclasses extend the key via
  // appendNoteKeyStateParts / isComplexKeyController instead of copying
  // these two methods.
  makeSimpleNoteKey(
    n: {
      audioBufferId?: number;
      noteNumber: number;
      velocity: number;
      noteDuration: number;
      noteEvent?: NoteOnEventEntry;
      channelDetune: number;
      channelStateArray: Float32Array;
      programNumber: number;
      isDrum: boolean;
      voiceParams: VoiceParams;
    },
    bakeChannelMix: boolean,
  ): string {
    return this.buildNoteCacheKeyParts(n, bakeChannelMix, false).join("|");
  }

  // Controllers that change the offline-baked waveform when replayed inside
  // renderEntryAudioBuffer. Sustain (64), all-notes-off, etc. affect note
  // lifetime which is already captured by durationTicks — including them in
  // the key would split otherwise-identical bakes.
  // Subclasses extend via isComplexKeyController (do not replace this set).
  static readonly COMPLEX_KEY_CONTROLLER_TYPES: ReadonlySet<number> = new Set([
    1, // modulation
    7, // volume
    10, // pan
    11, // expression
    6, // data entry MSB (RPN / pitch-bend range)
    38, // data entry LSB
    100, // RPN LSB
    101, // RPN MSB
  ]);

  /**
   * Whether a CC type is part of the complex-note automation fingerprint.
   * Base uses COMPLEX_KEY_CONTROLLER_TYPES; Midy adds LSB / sound CCs / delay.
   */
  protected isComplexKeyController(controllerType: number): boolean {
    return Player.COMPLEX_KEY_CONTROLLER_TYPES.has(controllerType);
  }

  /**
   * Append channel-state fields that affect the offline bake to a note
   * cache key. Base: volumeMSB / panMSB / expressionMSB when bakeChannelMix
   * (zeros when dry so field positions stay stable — dry leaves the channel
   * bus live). Subclasses push note-body slots always and mix-level slots
   * (LSB, delay send, …) only when bakeChannelMix is true.
   */
  protected appendNoteKeyStateParts(
    parts: (string | number)[],
    channelStateArray: Float32Array,
    bakeChannelMix: boolean,
  ): void {
    // ControllerState indices: volumeMSB=135, panMSB=138, expressionMSB=139
    // Mix-level only: ignored for dry (segment) keys on purpose.
    const vol = bakeChannelMix ? (channelStateArray[128 + 7] ?? 0) : 0;
    const pan = bakeChannelMix ? (channelStateArray[128 + 10] ?? 0) : 0;
    const expr = bakeChannelMix ? (channelStateArray[128 + 11] ?? 0) : 0;
    parts.push(
      Math.round(vol * 1e4),
      Math.round(pan * 1e4),
      Math.round(expr * 1e4),
    );
  }

  /**
   * Shared key body for simple + complex note caches.
   * complex=false → fine detune quantize, no automation suffix.
   * complex=true  → coarse detune + "cx" prefix + automation fingerprint.
   */
  protected buildNoteCacheKeyParts(
    n: {
      audioBufferId?: number;
      noteNumber: number;
      velocity: number;
      noteDuration: number;
      noteEvent?: NoteOnEventEntry;
      channelDetune: number;
      channelStateArray: Float32Array;
      programNumber: number;
      isDrum: boolean;
      voiceParams: VoiceParams;
    },
    bakeChannelMix: boolean,
    complex: boolean,
  ): (string | number)[] {
    const durTicks = n.noteEvent?.durationTicks ??
      Math.round(n.noteDuration * 1000);
    // Complex uses coarser detune: cumulative pitch-bend FP drift between a
    // clean count-walk and live playback can otherwise split identical bakes.
    const detuneQ = complex
      ? Math.round(n.channelDetune)
      : Math.round(n.channelDetune * 100) / 100;
    const parts: (string | number)[] = [];
    if (complex) parts.push("cx");
    parts.push(
      bakeChannelMix ? "mix" : "dry",
      n.audioBufferId ?? -1,
      n.noteNumber,
      n.velocity,
      durTicks,
      detuneQ,
    );
    this.appendNoteKeyStateParts(parts, n.channelStateArray, bakeChannelMix);
    parts.push(
      n.programNumber,
      n.isDrum ? 1 : 0,
      Math.round(n.voiceParams.volRelease * 1e6),
      Math.round(n.voiceParams.playbackRate * 1e6),
    );
    if (complex) {
      parts.push(this.serializeNoteAutomationEvents(n.noteEvent));
    }
    return parts;
  }

  // Serialize in-note automation as a tempo-independent relative-tick string.
  // programChange is omitted (renderEntryAudioBuffer skips it). Field names
  // match TimelineEvent usage in this module / BasePlayer.
  serializeNoteAutomationEvents(
    noteEvent: NoteOnEventEntry | undefined,
  ): string {
    if (!noteEvent || noteEvent.events.length === 0) return "";
    const startTicks = noteEvent.startTicks ?? 0;
    const parts: string[] = [];
    for (let i = 0; i < noteEvent.events.length; i++) {
      const event = noteEvent.events[i];
      if (event.type === "programChange") continue;
      // Prefer startTime (absolute ticks on TimelineEvent) when ticks is
      // missing; both are set by extractMidiData in BasePlayer.
      const absTick = event.ticks ?? event.startTime ?? 0;
      const rel = absTick - startTicks;
      switch (event.type) {
        case "controller": {
          const ct = event.controllerType ?? -1;
          if (!this.isComplexKeyController(ct)) continue;
          parts.push(`cc:${rel}:${ct}:${event.value}`);
          break;
        }
        case "pitchBend": {
          // TimelineEvent.value is the 14-bit pitch wheel (0..16383).
          const v = event.value ?? 0;
          parts.push(`pb:${rel}:${v}`);
          break;
        }
        case "sysEx": {
          const data = event.data;
          parts.push(
            `sx:${rel}:${
              data ? Array.from(data as ArrayLike<number>).join(",") : ""
            }`,
          );
          break;
        }
        default:
          break;
      }
    }
    return parts.join(";");
  }

  // bakeChannelMix matches makeSimpleNoteKey. Automation fingerprint is
  // relative ticks so the same pitch-bend / CC pattern at different absolute
  // times (or after tempo change with rebuilt durations) still collides.
  makeComplexNoteKey(
    n: {
      audioBufferId?: number;
      noteNumber: number;
      velocity: number;
      noteDuration: number;
      noteEvent?: NoteOnEventEntry;
      channelDetune: number;
      channelStateArray: Float32Array;
      programNumber: number;
      isDrum: boolean;
      voiceParams: VoiceParams;
    },
    bakeChannelMix: boolean,
  ): string {
    return this.buildNoteCacheKeyParts(n, bakeChannelMix, true).join("|");
  }

  // Pre-count complex-note cache keys (same key as makeComplexNoteKey).
  // Only keys with count > 1 are filled into complexNoteBufferCache on first
  // miss; unique patterns stay on the one-shot renderEntryAudioBuffer path.
  buildComplexNoteCounts(): void {
    this.complexNoteCounts.clear();
    if (!this.complexNoteCache) return;
    const cacheMode = this.cacheMode;
    if (
      cacheMode !== "note" && cacheMode !== "segment" &&
      cacheMode !== "chunk" && cacheMode !== "audio"
    ) {
      return;
    }

    const bakeChannelMix = cacheMode !== "segment";
    const settings = (this.constructor as typeof Player).channelSettings;
    const channels = Array.from({ length: this.numChannels }, (_, ch) => {
      const channel = this.createChannelInstance(ch, settings);
      channel.player = this;
      return channel;
    });
    if (channels[9]) channels[9].isDrum = true;

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const needsSegmentVoice = cacheMode === "segment" || cacheMode === "chunk";
    // Complex candidates: baked notes that are not simple, or all non-simple
    // noteOns when no segment set exists (note / audio mode).
    const candidates = this.segmentBakedSet.size > 0
      ? this.segmentBakedSet
      : null;

    const considerIndex = (i: number): boolean => {
      if (this.simpleNoteSet.has(i)) return false;
      const noteOnEvent = this.noteOnEvents[i];
      if (!noteOnEvent || noteOnEvent.duration <= 0) return false;
      if (noteOnEvent.durationTicks === Infinity) return false;
      // Must have automation — otherwise it would be simple.
      if (noteOnEvent.events.length === 0) return false;
      return true;
    };

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const offset = event.startTime * inverseTempo;
      this.processTimelineEvent(event, offset, {
        channels,
        onNoteOn: (renderChannel: TChannel, noteEvent: TimelineEvent) => {
          if (candidates && !candidates.has(i)) return;
          if (!considerIndex(i)) return;
          const noteOnEvent = this.noteOnEvents[i]!;

          let voiceParams: VoiceParams | null = null;
          if (needsSegmentVoice) {
            voiceParams = this.segmentVoiceParams[i];
          }
          if (!voiceParams) {
            const voice = this.resolveVoice(
              renderChannel,
              noteEvent.noteNumber!,
              noteEvent.velocity!,
            );
            if (!voice) return;
            voiceParams = voice.getAllParams(
              this.getControllerState(
                renderChannel,
                noteEvent.noteNumber!,
                noteEvent.velocity!,
                0,
              ),
            );
          }
          if (!voiceParams) return;

          const key = this.makeComplexNoteKey(
            {
              audioBufferId: this.noteAudioBufferIds[i],
              noteNumber: noteEvent.noteNumber!,
              velocity: noteEvent.velocity!,
              noteDuration: noteOnEvent.duration,
              noteEvent: noteOnEvent,
              channelDetune: renderChannel.detune,
              channelStateArray: renderChannel.state.array,
              programNumber: renderChannel.programNumber,
              isDrum: renderChannel.isDrum,
              voiceParams,
            },
            bakeChannelMix,
          );
          this.complexNoteCounts.set(
            key,
            (this.complexNoteCounts.get(key) ?? 0) + 1,
          );
        },
      });
    }
  }

  async lookupComplexNoteBuffer(
    n: {
      audioBufferId?: number;
      noteNumber: number;
      velocity: number;
      noteDuration: number;
      noteEvent?: NoteOnEventEntry;
      channelDetune: number;
      channelStateArray: Float32Array;
      programNumber: number;
      isDrum: boolean;
      voiceParams: VoiceParams;
    },
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer | null> {
    if (!this.complexNoteCache) return null;
    const key = this.makeComplexNoteKey(n, bakeChannelMix);
    // Only multi-use keys participate in the cache.
    if ((this.complexNoteCounts.get(key) ?? 0) <= 1) return null;
    const cached = this.complexNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) return cached;
    if (cached instanceof Promise) {
      try {
        return await cached;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Bake a complex note (with in-interval automation) and cache it when the
  // key appears more than once. Single-use keys call renderEntryAudioBuffer
  // without touching complexNoteBufferCache.
  async getComplexNoteBuffer(
    entry: BakeNoteEntry,
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer> {
    const key = this.makeComplexNoteKey(entry, bakeChannelMix);
    const count = this.complexNoteCounts.get(key) ?? 0;
    if (count <= 1) {
      return await this.renderEntryAudioBuffer(entry, bakeChannelMix);
    }
    const cached = this.complexNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) return cached;
    if (cached instanceof Promise) return await cached;

    const renderPromise = (async () => {
      try {
        const buffer = await this.renderEntryAudioBuffer(entry, bakeChannelMix);
        this.complexNoteBufferCache.set(key, buffer);
        return buffer;
      } catch (err) {
        this.complexNoteBufferCache.delete(key);
        throw err;
      }
    })();
    this.complexNoteBufferCache.set(key, renderPromise);
    return await renderPromise;
  }

  // Resolve a cached simple-note buffer without starting a new bake.
  // Returns null on miss (caller should schedule into the shared mix OAC).
  // In-flight Promise from note-mode / other paths is awaited.
  async lookupSimpleNoteBuffer(
    n: BakeNoteEntry,
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer | null> {
    if (!this.simpleNoteCache) return null;
    const key = this.makeSimpleNoteKey(n, bakeChannelMix);
    const cached = this.simpleNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) return cached;
    if (cached instanceof Promise) {
      try {
        return await cached;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Seed an offline channel from a BakeNoteEntry snapshot (state array,
   * program, detune, drum flag, modulation depth). Optionally applies
   * channel volume/pan for mix-baked paths.
   */
  protected prepareOfflineChannel(
    offlinePlayer: Player<TNote, TChannel>,
    entry: Pick<
      BakeNoteEntry,
      | "channelNumber"
      | "channelStateArray"
      | "isDrum"
      | "programNumber"
      | "channelDetune"
    >,
    bakeChannelMix: boolean,
    volumeTime = 0,
  ): TChannel | undefined {
    const dstChannel = offlinePlayer.channels[entry.channelNumber];
    if (!dstChannel) return;
    dstChannel.state.array.set(entry.channelStateArray);
    dstChannel.isDrum = entry.isDrum;
    dstChannel.programNumber = entry.programNumber;
    dstChannel.modulationDepthRange =
      this.channels[entry.channelNumber]?.modulationDepthRange ?? 50;
    dstChannel.detune = entry.channelDetune;
    if (bakeChannelMix) {
      offlinePlayer.updateChannelVolume(dstChannel, volumeTime);
    }
    return dstChannel;
  }

  /**
   * noteOn into an offline player: preload sample, attach voiceParams.
   *
   * bakeChannelMix=false (dry): after noteOn, disconnect volumeNode from the
   * channel bus (and any mix-level sends hung off it — delay, etc.) and
   * connect it straight to the offline destination. That keeps the baked
   * buffer free of channel vol/pan and effect sends so segment mode can
   * apply them live.
   * bakeChannelMix=true (mix): leave the graph as noteOn built it so vol/pan
   * and sends are inside the buffer.
   */
  protected async scheduleOfflineNoteOn(
    offlinePlayer: Player<TNote, TChannel>,
    offlineContext: OfflineAudioContext,
    dstChannel: TChannel,
    entry: Pick<
      BakeNoteEntry,
      | "noteNumber"
      | "velocity"
      | "voiceParams"
      | "audioBufferId"
      | "voice"
    >,
    startTime: number,
    bakeChannelMix: boolean,
  ): Promise<TNote | undefined> {
    if (entry.audioBufferId !== undefined) {
      await offlinePlayer.getRawAudioBuffer(
        entry.audioBufferId,
        entry.voiceParams,
      );
    }
    const preNote = offlinePlayer.createNoteInstance(
      entry.noteNumber,
      entry.velocity,
      startTime,
    );
    preNote.voiceParams = entry.voiceParams;
    preNote.voice = entry.voice ?? null;
    preNote.audioBufferId = entry.audioBufferId;
    const offlineNote = await offlinePlayer.noteOnChannel(
      dstChannel,
      entry.noteNumber,
      entry.velocity,
      startTime,
      preNote,
    ) as TNote | undefined;
    const volumeNode = offlineNote?.volumeNode ?? preNote.volumeNode;
    // Dry: drop channel bus + mix-level sends (delay connects off volumeNode).
    if (!bakeChannelMix && volumeNode) {
      volumeNode.disconnect();
      volumeNode.connect(offlineContext.destination);
    }
    return offlineNote;
  }

  // Schedule simple notes (no in-interval automation) into an existing
  // OfflineAudioContext via a lightweight offline Player — used on cache
  // miss so segment/chunk/audio mix pays one startRendering instead of
  // one per note + one mix. Does not populate simpleNoteBufferCache
  // (approach: critical path first; cache remains for note mode / hits
  // filled by getSimpleNoteBuffer elsewhere).
  async scheduleSimpleNotesDirect(
    offlineContext: OfflineAudioContext,
    offlinePlayer: Player<TNote, TChannel>,
    notes: (BakeNoteEntry & { offset: number })[],
    bakeChannelMix: boolean,
  ): Promise<void> {
    const sorted = notes.slice().sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const dstChannel = this.prepareOfflineChannel(
        offlinePlayer,
        n,
        bakeChannelMix,
        n.offset,
      );
      if (!dstChannel) continue;
      await this.scheduleOfflineNoteOn(
        offlinePlayer,
        offlineContext,
        dstChannel,
        n,
        n.offset,
        bakeChannelMix,
      );
      offlinePlayer.noteOffChannel(
        dstChannel,
        n.noteNumber,
        0,
        n.offset + n.noteDuration,
        true,
      );
    }
  }

  // Bake a simple note and cache it.
  // bakeChannelMix=true: stereo with channel vol/pan (chunk/audio).
  // bakeChannelMix=false: mono dry signal (segment; vol/pan live).
  // Still used by "note" mode. Segment/chunk/audio prefer lookup + direct
  // schedule on miss so the mix OAC does not wait on a second startRendering.
  // Implementation is renderEntryAudioBuffer + cache (simple notes have no
  // in-interval automation, so the event replay loop is a no-op).
  async getSimpleNoteBuffer(
    n: BakeNoteEntry,
    bakeChannelMix = true,
  ): Promise<AudioBuffer> {
    const key = this.makeSimpleNoteKey(n, bakeChannelMix);
    const cached = this.simpleNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) return cached;
    if (cached instanceof Promise) return await cached;

    const renderPromise = (async () => {
      const buffer = await this.renderEntryAudioBuffer(n, bakeChannelMix);
      this.simpleNoteBufferCache.set(key, buffer);
      return buffer;
    })();

    this.simpleNoteBufferCache.set(key, renderPromise);
    try {
      return await renderPromise;
    } catch (err) {
      this.simpleNoteBufferCache.delete(key);
      throw err;
    }
  }

  // Bakes an entire segment (all notes queued for one channel within
  // segmentDuration seconds) into a single AudioBuffer using exactly one
  // OfflineAudioContext / startRendering() call, instead of one offline
  // context per note followed by a manual JS mixdown. Each note still gets
  // its own full envelope/pitch-bend/LFO/CC#1 bake (same fidelity as
  // "note" mode), but all notes share one offline render graph and are
  // simply scheduled at their respective offsets within it — the audio
  // graph itself does the mixing instead of a JS sample-accumulation loop.
  // TChannel volume/pan/expression are intentionally NOT baked in (same as
  // before): each note's volumeNode is rewired to bypass the channel bus
  // and connect straight to the offline destination, so the combined
  // segment buffer stays mixable through the real channel.gainL/gainR in
  // real time.
  //
  // Simple-note optimization: cache hits → BufferSource; cache misses are
  // scheduled directly into this offline context (no per-note startRendering).
  async renderSegmentBuffer(
    channel: TChannel,
    segment: OpenSegment,
  ): Promise<AudioBuffer | null> {
    const notes = segment.notes;
    if (notes.length === 0) return null;
    let totalDuration = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const releaseEndDuration = n.voiceParams.volRelease * envelopeCurve * 5;
      const end = n.offset + n.noteDuration + releaseEndDuration;
      if (end > totalDuration) totalDuration = end;
    }
    if (totalDuration <= 0) return null;

    // simple = no automation → cacheable dry mono / complex = full noteOn
    const notesLen = notes.length;
    const simpleNotes = new Array<SegmentNoteEntry>(notesLen);
    const complexNotes = new Array<SegmentNoteEntry>(notesLen);
    let simpleCount = 0;
    let complexCount = 0;
    for (let i = 0; i < notesLen; i++) {
      const n = notes[i];
      if (this.isSimpleNote(n)) simpleNotes[simpleCount++] = n;
      else complexNotes[complexCount++] = n;
    }
    simpleNotes.length = simpleCount;
    complexNotes.length = complexCount;

    const ch = channel.channelNumber;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      1,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );

    // --- simple: hit → BufferSource; miss →
    //   count > 1 → getSimpleNoteBuffer (separate OAC + cache fill for reuse)
    //   count ≤ 1 → direct into this mix OAC (no extra startRendering)
    // Use per-note onset snapshots so mid-segment pitch bend / CC does not
    // leave later simple notes at the segment-open detune/volume state.
    const simpleMisses = new Array<SegmentNoteEntry>(simpleCount);
    let missCount = 0;
    const simpleCounts = this.simpleNoteCounts;
    const isDrum = channel.isDrum;
    if (simpleCount > 0) {
      for (let i = 0; i < simpleCount; i++) {
        const n = simpleNotes[i];
        const bakeInput = {
          channelNumber: ch,
          audioBufferId: n.audioBufferId,
          noteNumber: n.noteNumber,
          velocity: n.velocity,
          noteDuration: n.noteDuration,
          noteEvent: n.noteEvent,
          channelDetune: n.channelDetune,
          channelStateArray: n.channelStateArray,
          programNumber: n.programNumber,
          isDrum,
          voiceParams: n.voiceParams,
          voice: n.voice,
        };
        const cached = await this.lookupSimpleNoteBuffer(bakeInput, false);
        if (cached) {
          const src = new AudioBufferSourceNode(offlineContext, {
            buffer: cached,
          });
          // dry mono — channel vol/pan stay live via gainL/gainR
          src.connect(offlineContext.destination);
          src.start(n.offset);
          continue;
        }
        const key = this.makeSimpleNoteKey(bakeInput, false);
        const count = simpleCounts.get(key) ?? 0;
        if (count > 1) {
          const buffer = await this.getSimpleNoteBuffer(bakeInput, false);
          const src = new AudioBufferSourceNode(offlineContext, {
            buffer,
          });
          src.connect(offlineContext.destination);
          src.start(n.offset);
        } else {
          simpleMisses[missCount++] = n;
        }
      }
      if (missCount > 0) {
        const offlinePlayer = this.createOfflineRenderPlayer(
          offlineContext,
          [ch],
          true,
        );
        const directNotes = new Array<{
          channelNumber: number;
          audioBufferId?: number;
          noteNumber: number;
          velocity: number;
          noteDuration: number;
          noteEvent?: NoteOnEventEntry;
          channelDetune: number;
          channelStateArray: Float32Array;
          programNumber: number;
          isDrum: boolean;
          voiceParams: VoiceParams;
          voice?: Voice;
          offset: number;
        }>(missCount);
        for (let i = 0; i < missCount; i++) {
          const n = simpleMisses[i];
          directNotes[i] = {
            channelNumber: ch,
            audioBufferId: n.audioBufferId,
            noteNumber: n.noteNumber,
            velocity: n.velocity,
            noteDuration: n.noteDuration,
            noteEvent: n.noteEvent,
            channelDetune: n.channelDetune,
            channelStateArray: n.channelStateArray,
            programNumber: n.programNumber,
            isDrum,
            voiceParams: n.voiceParams,
            voice: n.voice,
            offset: n.offset,
          };
        }
        await this.scheduleSimpleNotesDirect(
          offlineContext,
          offlinePlayer,
          directNotes,
          false,
        );
      }
    }

    // --- complex: per-note full bake (same fidelity as "note" mode) ---
    // One offline context per automated note avoids shared-channel pitch-bend
    // replay bugs. Dry mono buffers keep channel vol/pan live via gainL/R.
    // Identical automation patterns (count > 1) share one OAC via
    // complexNoteBufferCache; unique patterns still bake once each.
    if (complexCount > 0) {
      const complexPromises = new Array<Promise<AudioBuffer>>(complexCount);
      for (let i = 0; i < complexCount; i++) {
        const n = complexNotes[i];
        const entry = {
          channelNumber: ch,
          noteNumber: n.noteNumber,
          velocity: n.velocity,
          voiceParams: n.voiceParams,
          noteDuration: n.noteDuration,
          noteEvent: n.noteEvent,
          channelDetune: n.channelDetune,
          channelStateArray: n.channelStateArray,
          programNumber: n.programNumber,
          isDrum,
          audioBufferId: n.audioBufferId,
          voice: n.voice,
        };
        complexPromises[i] = (async () => {
          const cached = await this.lookupComplexNoteBuffer(entry, false);
          if (cached) {
            return cached;
          }
          return await this.getComplexNoteBuffer(entry, false);
        })();
      }
      const complexBuffers = await Promise.all(complexPromises);
      for (let i = 0; i < complexCount; i++) {
        const n = complexNotes[i];
        const src = new AudioBufferSourceNode(offlineContext, {
          buffer: complexBuffers[i],
        });
        src.connect(offlineContext.destination);
        src.start(n.offset);
      }
    }

    const buffer = await offlineContext.startRendering();
    // Prevent hard-clip grit from dense polyphony; only scales down when
    // peak exceeds the target (same helper as chunk/audio).
    this.peakNormalizeBuffer(buffer);
    return buffer;
  }

  // Bake one note (with its in-note automation) into an AudioBuffer.
  // bakeChannelMix=true  → stereo mix bake (channel vol/pan/expression and
  //                       mix-level sends such as Midy delay stay in-graph)
  // bakeChannelMix=false → mono dry bake (volumeNode rewired to destination;
  //                       segment keeps gainL/gainR and delay live)
  // Complex notes in segment/chunk/audio all go through this path so pitch
  // bend is applied exactly like "note" mode's createFullRenderedBuffer —
  // one offline graph per note, no shared-channel event replay.
  // Simple-note caches (getSimpleNoteBuffer) also land here: with no
  // in-interval automation the event loop is a no-op.
  async renderEntryAudioBuffer(
    entry: BakeNoteEntry,
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer> {
    const { startTime: noteStartTime = 0, events: noteEvents = [] } =
      entry.noteEvent ?? {};
    const releaseEndDuration = entry.voiceParams.volRelease * envelopeCurve * 5;
    const totalDuration = Math.max(
      0.001,
      entry.noteDuration + releaseEndDuration,
    );
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      bakeChannelMix ? 2 : 1,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    const offlinePlayer = this.createOfflineRenderPlayer(
      offlineContext,
      [entry.channelNumber],
      true,
    );
    const dstChannel = this.prepareOfflineChannel(
      offlinePlayer,
      entry,
      bakeChannelMix,
      0,
    );
    if (!dstChannel) {
      return offlineContext.startRendering();
    }
    await this.scheduleOfflineNoteOn(
      offlinePlayer,
      offlineContext,
      dstChannel,
      entry,
      0,
      bakeChannelMix,
    );
    for (let i = 0; i < noteEvents.length; i++) {
      const event = noteEvents[i];
      if (event.type === "programChange") continue;
      const t = (event.startTime as number) / this.tempo - noteStartTime;
      if (t < 0 || t > entry.noteDuration) continue;
      offlinePlayer.processTimelineEvent(event, t, {
        channels: offlinePlayer.channels,
      });
    }
    offlinePlayer.noteOffChannel(
      dstChannel,
      entry.noteNumber,
      0,
      entry.noteDuration,
      true,
    );
    await Promise.resolve();
    return await offlineContext.startRendering();
  }

  async createFullRenderedBuffer(
    channel: TChannel,
    note: { noteNumber: number; velocity: number },
    voiceParams: VoiceParams,
    noteDuration: number,
    noteEvent: NoteOnEventEntry | undefined = undefined,
  ): Promise<RenderedBuffer> {
    const releaseEndDuration = voiceParams.volRelease * envelopeCurve * 5;
    const buffer = await this.renderEntryAudioBuffer({
      channelNumber: channel.channelNumber,
      noteNumber: note.noteNumber,
      velocity: note.velocity,
      voiceParams,
      noteDuration,
      noteEvent,
      channelDetune: channel.detune,
      channelStateArray: channel.state.array.slice(),
      programNumber: channel.programNumber,
      isDrum: channel.isDrum,
    }, true);
    return new RenderedBuffer(buffer, {
      isLoop: false,
      isFull: true,
      noteDuration,
      releaseDuration: releaseEndDuration,
    });
  }

  async getAudioBuffer(
    channel: TChannel,
    note: TNote,
    realtime: boolean,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    const cacheMode = this.cacheMode;
    const { noteNumber, velocity } = note;
    const audioBufferId = note.audioBufferId !== undefined
      ? note.audioBufferId
      : this.getVoiceId(channel, noteNumber, velocity);
    if (!realtime) {
      if (cacheMode === "note") {
        return await this.getNoteModeBuffer(channel, note, audioBufferId);
      } else if (cacheMode === "adsr") {
        return await this.getAdsrCachedBuffer(channel, note, audioBufferId);
      }
    }
    if (cacheMode === "none") {
      if (!audioBufferId) {
        return await this.createAudioBuffer(note.voiceParams as VoiceParams);
      }
      return await this.getRawAudioBuffer(
        audioBufferId,
        note.voiceParams as VoiceParams,
      );
    }
    // fallback to ADS cache:
    // - "ads" (realtime or not)
    // - "adsr" + realtime
    // - "note" + realtime
    return await this.getAdsCachedBuffer(
      channel,
      note,
      audioBufferId,
      realtime,
    );
  }

  async getAdsCachedBuffer(
    channel: TChannel,
    note: TNote,
    audioBufferId: number | undefined,
    realtime: boolean,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    if (!audioBufferId) return undefined;
    const cacheKey = audioBufferId + (note.noteNumber << 1) + 1;
    const voiceParams = note.voiceParams;
    if (!voiceParams) return undefined;
    if (realtime) {
      const cached = this.realtimeVoiceCache.get(cacheKey);
      if (cached) return cached;
      const rawBuffer = await this.getRawAudioBuffer(
        audioBufferId,
        voiceParams,
      );
      const rendered = await this.createAdsRenderedBuffer(
        channel,
        note,
        voiceParams,
        rawBuffer,
        channel.isDrum,
      );
      this.realtimeVoiceCache.set(cacheKey, rendered);
      return rendered;
    } else {
      const cache = this.voiceCache.get(cacheKey);
      if (cache) {
        cache.counter += 1;
        if (cache.maxCount <= cache.counter) {
          this.voiceCache.delete(cacheKey);
        }
        return cache.audioBuffer;
      } else {
        const maxCount = this.voiceCounter.get(cacheKey) ?? 0;
        const rawBuffer = await this.getRawAudioBuffer(
          audioBufferId,
          voiceParams,
        );
        const rendered = await this.createAdsRenderedBuffer(
          channel,
          note,
          voiceParams,
          rawBuffer,
          channel.isDrum,
        );
        const cache = { audioBuffer: rendered, maxCount, counter: 1 };
        this.voiceCache.set(cacheKey, cache);
        return rendered;
      }
    }
  }

  async getAdsrCachedBuffer(
    channel: TChannel,
    note: TNote,
    audioBufferId: number | undefined,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    if (!audioBufferId) return undefined;
    const voiceParams = note.voiceParams;
    if (!voiceParams) return undefined;
    const timelineIndex = note.timelineIndex;
    if (timelineIndex === null) return undefined;
    const noteEvent = this.noteOnEvents[timelineIndex];
    const noteDurationTicks = noteEvent?.durationTicks ?? 0;
    const safeTicks = noteDurationTicks === Infinity
      ? 0xFFFFFFFFn
      : BigInt(noteDurationTicks);
    const volReleaseBits = f64ToBigInt(voiceParams.volRelease);
    const playbackRateBits = f64ToBigInt(voiceParams.playbackRate);
    const cacheKey = (BigInt(audioBufferId) << 160n) |
      (playbackRateBits << 96n) |
      (safeTicks << 64n) |
      volReleaseBits;
    let durationMap = this.adsrVoiceCache.get(audioBufferId);
    if (!durationMap) {
      durationMap = new Map();
      this.adsrVoiceCache.set(audioBufferId, durationMap);
    }
    const cached = durationMap.get(cacheKey);
    if (cached instanceof RenderedBuffer) {
      return cached;
    }
    if (cached instanceof Promise) {
      return await cached;
    }
    const noteDuration = noteEvent?.duration ?? 0;
    const renderPromise = (async () => {
      try {
        const rawBuffer = await this.getRawAudioBuffer(
          audioBufferId!,
          voiceParams,
        );
        const rendered = await this.createAdsrRenderedBuffer(
          channel,
          note,
          voiceParams,
          rawBuffer,
          noteDuration,
          channel.isDrum,
        );
        durationMap!.set(cacheKey, rendered);
        return rendered;
      } catch (err) {
        durationMap!.delete(cacheKey);
        throw err;
      }
    })();
    durationMap.set(cacheKey, renderPromise);
    return await renderPromise;
  }

  // "note" mode buffer: simple notes share simpleNoteBufferCache; complex
  // notes (in-note automation) are fully baked once per onset with no
  // secondary cache — the old per-timelineIndex fullVoiceCache rarely hit.
  async getNoteModeBuffer(
    channel: TChannel,
    note: TNote,
    audioBufferId: number | undefined,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    const voiceParams = note.voiceParams;
    if (!voiceParams) return undefined;
    const timelineIndex = note.timelineIndex;
    const noteEvent = timelineIndex != null
      ? this.noteOnEvents[timelineIndex]
      : undefined;
    const noteDuration = noteEvent?.duration ?? 0;
    const releaseEndDuration = voiceParams.volRelease * envelopeCurve * 5;

    if (
      this.isSimpleNote({
        timelineIndex: timelineIndex ?? undefined,
        noteEvent,
      })
    ) {
      const buffer = await this.getSimpleNoteBuffer({
        channelNumber: channel.channelNumber,
        audioBufferId,
        noteNumber: note.noteNumber,
        velocity: note.velocity,
        noteDuration,
        noteEvent,
        channelDetune: channel.detune,
        channelStateArray: channel.state.array.slice(),
        programNumber: channel.programNumber,
        isDrum: channel.isDrum,
        voiceParams,
        voice: note.voice ?? undefined,
      }, true);
      return new RenderedBuffer(buffer, {
        isLoop: false,
        isFull: true,
        noteDuration,
        releaseDuration: releaseEndDuration,
      });
    }

    // Complex: reuse identical automation patterns when count > 1.
    const complexEntry = {
      channelNumber: channel.channelNumber,
      audioBufferId,
      noteNumber: note.noteNumber,
      velocity: note.velocity,
      noteDuration,
      noteEvent,
      channelDetune: channel.detune,
      channelStateArray: channel.state.array.slice(),
      programNumber: channel.programNumber,
      isDrum: channel.isDrum,
      voiceParams,
      voice: note.voice ?? undefined,
    };
    const cachedComplex = await this.lookupComplexNoteBuffer(
      complexEntry,
      true,
    );
    if (cachedComplex) {
      return new RenderedBuffer(cachedComplex, {
        isLoop: false,
        isFull: true,
        noteDuration,
        releaseDuration: releaseEndDuration,
      });
    }
    const complexBuffer = await this.getComplexNoteBuffer(complexEntry, true);
    return new RenderedBuffer(complexBuffer, {
      isLoop: false,
      isFull: true,
      noteDuration,
      releaseDuration: releaseEndDuration,
    });
  }

  override async setNoteAudioNode(
    channel: TChannel,
    note: TNote,
    realtime: boolean,
  ): Promise<void> {
    const audioContext = this.audioContext;
    const now = audioContext.currentTime;
    const { noteNumber, velocity, startTime } = note;
    const state = channel.state;
    const controllerState = this.getControllerState(
      channel,
      noteNumber,
      velocity,
      note.pressure,
    );
    const voiceParams = note.voiceParams ??
      note.voice?.getAllParams(controllerState) ?? null;
    note.voiceParams = voiceParams;
    if (!voiceParams) return;
    if (note.isSegmentGhost) {
      // No real bufferSource/volumeNode is created: this note's sound
      // comes from the combined segment buffer, baked and scheduled
      // separately by the segment pipeline (appendToSegmentQueue /
      // closeSegment / renderSegmentBuffer). This note object only exists
      // so activeNotes/FIFO noteOff matching stays correct relative to
      // any fallback (non-segment) notes on the same channel.
      return;
    }

    const audioBuffer = await this.getAudioBuffer(channel, note, realtime);
    // If pause()/stop() interrupts during preparation, abort without creating a node.
    if (note.ending || !audioBuffer) return;
    const isRendered = audioBuffer instanceof RenderedBuffer;
    note.renderedBuffer = isRendered ? audioBuffer : null;
    note.bufferSource = this.createBufferSource(
      channel,
      note.noteNumber,
      voiceParams,
      audioBuffer as RenderedBuffer | AudioBuffer,
    );
    note.volumeNode = new GainNode(audioContext);

    const cacheMode = this.cacheMode;
    const isFullCached = isRendered &&
      (audioBuffer as RenderedBuffer).isFull === true;
    // Offline mix bakers (segment/chunk/audio simple path): leaner graph.
    // Detect via flag (preferred) or OfflineAudioContext (renderEntry etc.).
    const isOfflineBake = this.offlineRenderOnly ||
      this.audioContext instanceof OfflineAudioContext;
    if (cacheMode === "none") {
      // Offline: drive envelope on volumeNode itself (one fewer GainNode per
      // note). Realtime keeps a separate envelope gain so channel bus /
      // modulation can still tap volumeNode independently.
      if (isOfflineBake) {
        note.volumeEnvelopeNode = note.volumeNode;
      } else {
        note.volumeEnvelopeNode = new GainNode(audioContext);
      }
      // Skip Biquad when filter is fully open and mod envelope does not move it.
      const filterIsAudible = voiceParams.modEnvToFilterFc !== 0 ||
        voiceParams.initialFilterFc < FULLY_OPEN_FILTER_CENTS;
      note.filterEnvelopeNode = filterIsAudible
        ? new BiquadFilterNode(audioContext, {
          type: "lowpass",
          Q: voiceParams.initialFilterQ / 10,
        })
        : null;
      this.setVolumeEnvelope(channel, note, now);
      if (note.filterEnvelopeNode) this.setFilterEnvelope(channel, note, now);
      // Pitch env only when modEnv actually sweeps rate; otherwise a single
      // playbackRate value is enough (avoids cancel/ramp scheduling).
      if (voiceParams.modEnvToPitch !== 0) {
        this.setPitchEnvelope(note, now);
      } else {
        note.bufferSource.playbackRate.value = voiceParams.playbackRate;
      }
      // Keep setDetune (smoothed setTarget) for offline too — static
      // .value assignment can sound slightly different at the attack.
      this.setDetune(channel, note, now);
      // LFO nodes only when the voice routes LFO somewhere and mod wheel > 0.
      const modLfoIsAudible = voiceParams.modLfoToPitch !== 0 ||
        voiceParams.modLfoToFilterFc !== 0 ||
        voiceParams.modLfoToVolume !== 0;
      if (modLfoIsAudible && 0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      if (note.filterEnvelopeNode) {
        note.bufferSource.connect(note.filterEnvelopeNode);
        note.filterEnvelopeNode.connect(note.volumeEnvelopeNode);
      } else {
        note.bufferSource.connect(note.volumeEnvelopeNode);
      }
      if (!isOfflineBake) {
        note.volumeEnvelopeNode.connect(note.volumeNode);
      }
    } else if (isFullCached) { // "note" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      note.bufferSource.connect(note.volumeNode);
    } else { // "ads" / "adsr" mode
      note.volumeEnvelopeNode = null;
      note.filterEnvelopeNode = null;
      this.setDetune(channel, note, now);
      if (0 < state.modulationDepthMSB) {
        this.startModulation(channel, note, now);
      }
      note.bufferSource.connect(note.volumeNode);
    }
    // Offline bake has no realtime deadline; skip the miss warning noise.
    if (!realtime && !isOfflineBake) {
      this.warnIfStartTimeMissed(
        `note (channel ${channel.channelNumber}, note ${note.noteNumber})`,
        startTime,
      );
    }
    if (!isRendered && voiceParams.sample.type === "compressed") {
      note.bufferSource.start(
        startTime,
        voiceParams.start / (audioBuffer as AudioBuffer).sampleRate,
      );
    } else {
      note.bufferSource.start(startTime);
    }
  }

  override releaseNote(
    _channel: TChannel,
    note: TNote,
    endTime: number,
  ): Promise<void> | void {
    if (note.isSegmentGhost) return;
    const now = this.audioContext.currentTime;
    if (note.renderedBuffer?.isFull) {
      const rb = note.renderedBuffer;
      const naturalEndTime = note.startTime + rb.buffer.duration;
      const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
      const isEarlyCut = endTime < noteOffTime;
      if (isEarlyCut) {
        const volDuration = note.voiceParams?.volRelease ?? 0;
        const volRelease = endTime + volDuration;
        try {
          note.volumeNode?.gain
            .cancelScheduledValues(endTime)
            .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
        } catch { /* already closed */ }
        return this.waitSourceEnded(note, volRelease);
      }
      if (naturalEndTime <= now) {
        this.disconnectNote(note);
        return;
      }
      return this.waitSourceEnded(note, naturalEndTime);
    }

    const volDuration = note.voiceParams?.volRelease ?? 0;
    const volRelease = endTime + volDuration;

    if (note.volumeEnvelopeNode) {
      // "none" mode
      try {
        note.filterEnvelopeNode?.frequency
          .cancelScheduledValues(endTime)
          .exponentialRampToValueAtTime(
            note.adjustedBaseFreq,
            endTime + (note.voiceParams?.modRelease ?? 0),
          );
        note.volumeEnvelopeNode.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    } else {
      // "ads" / "adsr" mode
      const isAdsr = note.renderedBuffer?.releaseDuration != null &&
        !note.renderedBuffer.isFull;
      if (isAdsr) {
        const rb = note.renderedBuffer!;
        const naturalEndTime = note.startTime + rb.buffer.duration;
        const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
        const isEarlyCut = endTime < noteOffTime;
        if (isEarlyCut) {
          try {
            note.volumeNode?.gain
              .cancelScheduledValues(endTime)
              .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
          } catch { /* already closed */ }
          return this.waitSourceEnded(note, volRelease);
        }
        if (naturalEndTime <= now) {
          this.disconnectNote(note);
          return;
        }
        return this.waitSourceEnded(note, naturalEndTime);
      }
      try {
        note.volumeNode?.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    }

    // waitSourceEnded always settles (onended or timeout).
    return this.waitSourceEnded(note, volRelease);
  }
}

// Re-export core types/classes so consumers can import from either module.
export {
  BasePlayer,
  cbToRatio,
  Channel,
  type ControlChangeHandler,
  ControllerState,
  envelopeCurve,
  f64ToBigInt,
  filterEnvelopeKeySet,
  FULLY_OPEN_FILTER_CENTS,
  type MessageHandler,
  Note,
  pitchEnvelopeKeySet,
  RenderedBuffer,
  type TimelineEvent,
  volumeEnvelopeKeySet,
} from "./base-player.ts";
