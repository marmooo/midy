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
          for (const [key, entries] of activeNotes) {
            if (key % numChannels !== ch) continue;
            for (const entry of entries) entry.events.push(event);
          }
          switch (event.controllerType) {
            case 64: { // Sustain Pedal
              const on = event.value! >= 64;
              sustainPedal[ch] = on ? 1 : 0;
              if (!on) {
                for (const [key, offItems] of pendingOff) {
                  if (key % numChannels !== ch) continue;
                  const activeStack = activeNotes.get(key);
                  for (const { t: offTime, ticks: offTicks } of offItems) {
                    if (activeStack && activeStack.length > 0) {
                      finalizeEntry(activeStack.shift()!, offTime, offTicks);
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
              for (const [key, stack] of activeNotes) {
                if (key % numChannels !== ch) continue;
                for (const entry of stack) finalizeEntry(entry, t, event.ticks);
                activeNotes.delete(key);
              }
              for (const key of pendingOff.keys()) {
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
              for (const [, stack] of activeNotes) {
                for (const entry of stack) finalizeEntry(entry, t, event.ticks);
              }
              activeNotes.clear();
            }
          } else {
            for (const [, entries] of activeNotes) {
              for (const entry of entries) entry.events.push(event);
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
          for (const [key, entries] of activeNotes) {
            if (key % numChannels !== ch) continue;
            for (const entry of entries) entry.events.push(event);
          }
          break;
        }
      }
    }
    for (const [, stack] of activeNotes) {
      for (const entry of stack) finalizeEntry(entry, totalTime, Infinity);
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
      channel.state = new ControllerState();
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
          // Drum exclusive class notes are also excluded from segmentVoiceParams:
          // the kit lookup needs the current programNumber, and segmenting them
          // would bring no benefit anyway since exclusive class guarantees at most
          // one note of the same class sounds at a time.
          const isExcludedDrum = channel.isDrum &&
            this.drumExclusiveClasses[event.noteNumber!] !== 0;
          // Exclusive class drum notes are excluded from segmentVoiceParams
          // (and therefore from segment/chunk notes) because segmenting them would
          // bring no benefit — exclusive class guarantees at most one note of
          // the same class sounds at a time, so they're scheduled via the
          // normal noteOnChannel path instead. However they still need their
          // raw sample decoded and cached so that noteOnChannel path doesn't
          // pay a decode penalty on first encounter. Preload them unconditionally.
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
      }
    }
    this.noteAudioBufferIds = noteAudioBufferIds;
    this.preloadEntries = preloadEntries;
    for (const [audioBufferId, count] of voiceCounter) {
      if (count === 1) voiceCounter.delete(audioBufferId);
    }
    this.GM1SystemOn(this.audioContext.currentTime);
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
      // Simple-note classification is shared by note / segment / chunk / audio.
      this.finalizeSimpleNoteClassification();
    } else if (cacheMode === "audio" || cacheMode === "note") {
      // audio mode uses renderChunkBuffer's simple-note path;
      // note mode reuses simpleNoteBufferCache for identical onsets.
      this.finalizeSimpleNoteClassification();
    }
  }

  override scheduleTimelineEvents(
    scheduleTime: number,
    queueIndex: number,
  ): number {
    const timeOffset = this.resumeTime - this.startTime;
    const isSegmentMode = this.cacheMode === "segment";
    const isChunkMode = this.cacheMode === "chunk";
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
          note.audioBufferId = this.noteAudioBufferIds[queueIndex];
          const isSegmentNote = isSegmentMode &&
            this.segmentBakedSet.has(queueIndex);
          const isChunkNote = isChunkMode &&
            this.segmentBakedSet.has(queueIndex);
          if (isSegmentNote || isChunkNote) {
            note.isSegmentGhost = true;
            note.segmentNoteDuration = this.noteOnDurations[queueIndex] ?? 0;
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
    const allBufferPromises: Promise<AudioBuffer | null>[] = [];
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        allBufferPromises.push(pending[i].bufferPromise);
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
      const result: PendingSegment[] = [];
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (!state) continue;
        const pending = state.pending;
        for (let i = 0; i < pending.length; i++) result.push(pending[i]);
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
    for (const state of this.segmentChannelStates) {
      if (!state) continue;
      for (const pending of state.pending) {
        if (pending.source) {
          try {
            pending.source.stop();
          } catch {
            // already stopped/ended
          }
          // disconnect is handled by the source's onended handler
          pending.source = null;
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
      state.pending = state.pending.filter((pending) => !pending.done);
      for (const pending of state.pending) {
        if (!pending.source && pending.bufferReady) {
          this.startPendingSegment(channels[ch], pending);
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
    const allBufferPromises = state.pending.map((p) => p.bufferPromise);
    await Promise.allSettled(allBufferPromises);
    for (const pending of state.pending) {
      if (!pending.source && pending.bufferReady) {
        this.startPendingChunk(pending);
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
    for (const pending of state.pending) {
      if (pending.source) {
        try {
          pending.source.stop();
        } catch {
          // already stopped/ended
        }
        // disconnect is handled by the source's onended handler
        pending.source = null;
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
    state.pending = state.pending.filter((p) => !p.done);
    for (const pending of state.pending) {
      if (!pending.source && pending.bufferReady) {
        this.startPendingChunk(pending);
      }
    }
  }

  // forAudioOffline=true  → audio mode window (no per-window clamp;
  //                         final mix is peak-normalized once)
  // forAudioOffline=false → realtime "chunk" mode (soft-clamp only; never
  //                         peak-normalize per window)
  // Both paths use simpleNote when the note has no in-interval automation
  // (pitch bend / CC are already excluded by isSimpleNote). Onset detune /
  // volume come from the per-note channelDetune / channelStateArray
  // snapshot taken at append (or offline walk) time — same as segment.
  async renderChunkBuffer(
    chunk: OpenChunk,
    forAudioOffline = false,
  ): Promise<AudioBuffer | null> {
    const notes = chunk.notes;
    if (notes.length === 0) return null;

    // Compute total duration across all notes in all channels.
    let totalDuration = 0;
    for (const n of notes) {
      const releaseEnd = n.voiceParams.volRelease * envelopeCurve * 5;
      const end = n.offset + n.noteDuration + releaseEnd;
      if (end > totalDuration) totalDuration = end;
    }
    if (totalDuration <= 0) return null;

    const simpleNotes: ChunkNoteEntry[] = [];
    const complexNotes: ChunkNoteEntry[] = [];
    for (const n of notes) {
      if (this.isSimpleNote(n)) simpleNotes.push(n);
      else complexNotes.push(n);
    }

    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );

    // --- simple: cached stereo buffers (onset detune/vol/pan baked) ---
    if (simpleNotes.length > 0) {
      const simpleBuffers = await Promise.all(
        simpleNotes.map((n) => this.getSimpleNoteBuffer(n, true)),
      );
      for (let i = 0; i < simpleNotes.length; i++) {
        const n = simpleNotes[i];
        const src = new AudioBufferSourceNode(offlineContext, {
          buffer: simpleBuffers[i],
        });
        src.connect(offlineContext.destination);
        src.start(n.offset);
      }
    }

    // --- complex: per-note full bake (in-note pitch bend / CC) ---
    if (complexNotes.length > 0) {
      const complexBuffers = await Promise.all(
        complexNotes.map((n) => this.renderEntryAudioBuffer(n, true)),
      );
      for (let i = 0; i < complexNotes.length; i++) {
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
    for (const n of notes) {
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
      const windowNotes = notes.filter((n) =>
        n.offset >= winStart && n.offset < winEnd
      );
      if (windowNotes.length === 0) continue;

      // Shift offsets so the offline context starts near 0 (small context).
      const localNotes: ChunkNoteEntry[] = windowNotes.map((n) => ({
        ...n,
        offset: n.offset - winStart,
        // channelStateArray is a typed array — copy so mutations in one
        // window can't affect another.
        channelStateArray: n.channelStateArray.slice(),
      }));

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
    const tasks: Promise<AudioBuffer>[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (this.rawAudioBufferCache.has(entry.audioBufferId)) continue;
      tasks.push(
        this.getRawAudioBuffer(entry.audioBufferId, entry.voiceParams),
      );
    }
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
      for (const i of candidates) {
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

  // bakeChannelMix=true  → stereo, channel vol/pan/expression included
  //                       (chunk / audio offline mix)
  // bakeChannelMix=false → mono, dry note only (segment offline; live
  //                       channel.gainL/gainR still apply vol/pan)
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
    const st = n.channelStateArray;
    // ControllerState indices: volumeMSB=135, panMSB=138, expressionMSB=139
    const vol = bakeChannelMix ? (st[128 + 7] ?? 0) : 0;
    const pan = bakeChannelMix ? (st[128 + 10] ?? 0) : 0;
    const expr = bakeChannelMix ? (st[128 + 11] ?? 0) : 0;
    const durTicks = n.noteEvent?.durationTicks ??
      Math.round(n.noteDuration * 1000);
    const detuneQ = Math.round(n.channelDetune * 100) / 100;
    return [
      bakeChannelMix ? "mix" : "dry",
      n.audioBufferId ?? -1,
      n.noteNumber,
      n.velocity,
      durTicks,
      detuneQ,
      Math.round(vol * 1e4),
      Math.round(pan * 1e4),
      Math.round(expr * 1e4),
      n.programNumber,
      n.isDrum ? 1 : 0,
      Math.round(n.voiceParams.volRelease * 1e6),
      Math.round(n.voiceParams.playbackRate * 1e6),
    ].join("|");
  }

  // Bake a simple note and cache it.
  // bakeChannelMix=true: stereo with channel vol/pan (chunk/audio).
  // bakeChannelMix=false: mono dry signal (segment; vol/pan live).
  async getSimpleNoteBuffer(
    n: {
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
    },
    bakeChannelMix = true,
  ): Promise<AudioBuffer> {
    const key = this.makeSimpleNoteKey(n, bakeChannelMix);
    const cached = this.simpleNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) return cached;
    if (cached instanceof Promise) return await cached;

    const renderPromise = (async () => {
      const releaseEnd = n.voiceParams.volRelease * envelopeCurve * 5;
      const totalDuration = Math.max(
        0.001,
        n.noteDuration + releaseEnd,
      );
      const sampleRate = this.audioContext.sampleRate;
      const offlineContext = new OfflineAudioContext(
        bakeChannelMix ? 2 : 1,
        Math.ceil(totalDuration * sampleRate),
        sampleRate,
      );
      const offlinePlayer = this.createOfflineRenderPlayer(
        offlineContext,
        [n.channelNumber],
        true,
      );
      const dstChannel = offlinePlayer.channels[n.channelNumber];
      dstChannel.state.array.set(n.channelStateArray);
      dstChannel.isDrum = n.isDrum;
      dstChannel.programNumber = n.programNumber;
      dstChannel.modulationDepthRange =
        this.channels[n.channelNumber]?.modulationDepthRange ?? 50;
      dstChannel.detune = n.channelDetune;
      if (bakeChannelMix) {
        offlinePlayer.updateChannelVolume(dstChannel, 0);
      }

      if (n.audioBufferId !== undefined) {
        await offlinePlayer.getRawAudioBuffer(n.audioBufferId, n.voiceParams);
      }

      const preNote = offlinePlayer.createNoteInstance(
        n.noteNumber,
        n.velocity,
        0,
      );
      preNote.voiceParams = n.voiceParams;
      preNote.voice = n.voice ?? null;
      preNote.audioBufferId = n.audioBufferId;
      await offlinePlayer.noteOnChannel(
        dstChannel,
        n.noteNumber,
        n.velocity,
        0,
        preNote,
      );
      // For dry (segment) bakes, rewire volumeNode past the channel bus so
      // the cached buffer does not embed gainL/gainR (those stay live).
      if (!bakeChannelMix && preNote.volumeNode) {
        preNote.volumeNode.disconnect();
        preNote.volumeNode.connect(offlineContext.destination);
      }
      offlinePlayer.noteOffChannel(
        dstChannel,
        n.noteNumber,
        0,
        n.noteDuration,
        true,
      );
      await Promise.resolve();
      const buffer = await offlineContext.startRendering();
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
    const simpleNotes: SegmentNoteEntry[] = [];
    const complexNotes: SegmentNoteEntry[] = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (this.isSimpleNote(n)) simpleNotes.push(n);
      else complexNotes.push(n);
    }

    const ch = channel.channelNumber;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      1,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );

    // --- simple: place cached dry mono buffers at their offsets ---
    // Use per-note onset snapshots so mid-segment pitch bend / CC does not
    // leave later simple notes at the segment-open detune/volume state.
    if (simpleNotes.length > 0) {
      const simpleBuffers = await Promise.all(
        simpleNotes.map((n) =>
          this.getSimpleNoteBuffer({
            channelNumber: ch,
            audioBufferId: n.audioBufferId,
            noteNumber: n.noteNumber,
            velocity: n.velocity,
            noteDuration: n.noteDuration,
            noteEvent: n.noteEvent,
            channelDetune: n.channelDetune,
            channelStateArray: n.channelStateArray,
            programNumber: n.programNumber,
            isDrum: channel.isDrum,
            voiceParams: n.voiceParams,
            voice: n.voice,
          }, false)
        ),
      );
      for (let i = 0; i < simpleNotes.length; i++) {
        const n = simpleNotes[i];
        const src = new AudioBufferSourceNode(offlineContext, {
          buffer: simpleBuffers[i],
        });
        // dry mono — channel vol/pan stay live via gainL/gainR
        src.connect(offlineContext.destination);
        src.start(n.offset);
      }
    }

    // --- complex: per-note full bake (same fidelity as "note" mode) ---
    // One offline context per automated note avoids shared-channel pitch-bend
    // replay bugs. Dry mono buffers keep channel vol/pan live via gainL/R.
    if (complexNotes.length > 0) {
      const complexBuffers = await Promise.all(
        complexNotes.map((n) =>
          this.renderEntryAudioBuffer({
            channelNumber: ch,
            noteNumber: n.noteNumber,
            velocity: n.velocity,
            voiceParams: n.voiceParams,
            noteDuration: n.noteDuration,
            noteEvent: n.noteEvent,
            channelDetune: n.channelDetune,
            channelStateArray: n.channelStateArray,
            programNumber: n.programNumber,
            isDrum: channel.isDrum,
            audioBufferId: n.audioBufferId,
            voice: n.voice,
          }, false)
        ),
      );
      for (let i = 0; i < complexNotes.length; i++) {
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
  // bakeChannelMix=true  → stereo, channel vol/pan/expression included
  //                       (chunk / audio / note mode)
  // bakeChannelMix=false → mono dry (segment; live gainL/gainR apply vol/pan)
  // Complex notes in segment/chunk/audio all go through this path so pitch
  // bend is applied exactly like "note" mode's createFullRenderedBuffer —
  // one offline graph per note, no shared-channel event replay.
  async renderEntryAudioBuffer(
    entry: {
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
    },
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer> {
    const { startTime: noteStartTime = 0, events: noteEvents = [] } =
      entry.noteEvent ?? {};
    const ch = entry.channelNumber;
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
    const offlinePlayer = new (this.constructor as new (
      audioContext: AudioContext | OfflineAudioContext,
      options?: { activeChannelNumbers?: Iterable<number> },
    ) => Player<TNote, TChannel>)(
      offlineContext as unknown as AudioContext,
      { activeChannelNumbers: [ch] },
    );
    offlinePlayer.cacheMode = "none";
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    offlinePlayer.rawAudioBufferCache = this.rawAudioBufferCache;
    const dstChannel = offlinePlayer.channels[ch];
    dstChannel.state.array.set(entry.channelStateArray);
    dstChannel.isDrum = entry.isDrum;
    dstChannel.programNumber = entry.programNumber;
    dstChannel.modulationDepthRange = this.channels[ch]?.modulationDepthRange ??
      50;
    dstChannel.detune = entry.channelDetune;
    if (bakeChannelMix) {
      offlinePlayer.updateChannelVolume(dstChannel, 0);
    }
    if (entry.audioBufferId !== undefined) {
      await offlinePlayer.getRawAudioBuffer(
        entry.audioBufferId,
        entry.voiceParams,
      );
    }
    const preNote = offlinePlayer.createNoteInstance(
      entry.noteNumber,
      entry.velocity,
      0,
    );
    preNote.voiceParams = entry.voiceParams;
    preNote.voice = entry.voice ?? null;
    preNote.audioBufferId = entry.audioBufferId;
    const offlineNote = await offlinePlayer.noteOnChannel(
      dstChannel,
      entry.noteNumber,
      entry.velocity,
      0,
      preNote,
    ) as TNote | undefined;
    if (!bakeChannelMix && offlineNote?.volumeNode) {
      offlineNote.volumeNode.disconnect();
      offlineNote.volumeNode.connect(offlineContext.destination);
    }
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

    return await this.createFullRenderedBuffer(
      channel,
      { noteNumber: note.noteNumber, velocity: note.velocity },
      voiceParams,
      noteDuration,
      noteEvent,
    );
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
    if (cacheMode === "none") {
      note.volumeEnvelopeNode = new GainNode(audioContext);
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
      this.setPitchEnvelope(note, now);
      this.setDetune(channel, note, now);
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
      note.volumeEnvelopeNode.connect(note.volumeNode);
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
    if (!realtime) {
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
