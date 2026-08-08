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
//   same as "ads" mode. Higher cache hit rate than "note" mode
//   because LFO variations do not produce separate cache entries.
// "note"
//   Renders the full noteOn-to-noteOff duration per note in an
//   OfflineAudioContext. All events during the note (volume,
//   expression, pitch bend, LFO, CC#1) are baked into the buffer,
//   so no real-time processing is needed during playback. Greatly
//   reduces CPU load for songs with many simultaneous notes.
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
}
export interface OpenSegment {
  segmentStart: number;
  notes: SegmentNoteEntry[];
  // Snapshot of channel.detune / channel.state.array taken at segment-open
  // time (the first note's onset), not segment-close time. scheduleTimelineEvents
  // applies every CC/pitchBend event to the realtime channel as the timeline
  // is walked, regardless of segment mode, so by the time closeSegment()
  // runs, the realtime channel.detune already reflects every event that
  // happened inside this segment. renderSegmentBuffer replays those same
  // events (copied per-note into noteEvents by buildNoteOnDurations) onto
  // dstChannel to bake each note's pitch bend correctly relative to its own
  // onset. Seeding dstChannel from the post-segment realtime value and then
  // replaying the segment's own events on top of it double-applies those
  // events' effect (e.g. channel.setPitchBend's `+=` accumulation),
  // corrupting pitch. Seeding from the pre-segment snapshot instead means
  // the replay starts from the correct baseline.
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
  noteOnDurations: number[] = [];
  noteOnEvents: (NoteOnEventEntry | undefined)[] = [];
  fullVoiceCache: Map<
    number,
    Map<number, RenderedBuffer | Promise<RenderedBuffer>>
  > = new Map();
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
    options?: { activeChannelNumbers?: Iterable<number> },
  ) {
    super(audioContext, options);
    this.cacheMode = DEFAULT_CACHE_MODE;
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
          const ch = event.channel;
          for (const [key, entries] of activeNotes) {
            if (key % numChannels !== ch) continue;
            for (const entry of entries) entry.events.push(event);
          }
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
    this.fullVoiceCache.clear();
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
        await Promise.allSettled(pendingPromises);
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
      this.dispatchEvent(new Event(exitReason));
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
      this.fullVoiceCache.clear();
      this.adsrVoiceCache.clear();
    }
    if (cacheMode === "segment" || cacheMode === "chunk") {
      this.finalizeSegmentClassification();
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

  async renderChunkBuffer(chunk: OpenChunk): Promise<AudioBuffer | null> {
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

    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );

    // Build a lightweight offlinePlayer that shares soundFont/cache data.
    // We need channel audio nodes wired to the offline destination, so we
    // create a full Player instance against the offline context but
    // immediately suspend/resume so they don't throw.
    const allChannelNumbers = [...new Set(notes.map((n) => n.channelNumber))];
    const offlinePlayer = new (this.constructor as new (
      audioContext: AudioContext | OfflineAudioContext,
      options?: { activeChannelNumbers?: Iterable<number> },
    ) => Player<TNote, TChannel>)(
      offlineContext as unknown as AudioContext,
      { activeChannelNumbers: allChannelNumbers },
    );
    offlinePlayer.cacheMode = "none";
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    offlinePlayer.rawAudioBufferCache = this.rawAudioBufferCache;

    // Seed each channel from the snapshot of its earliest note in this
    // chunk. That snapshot was taken at the note's onset, so it already
    // reflects every pitch-bend / CC that happened before the note (and
    // therefore before this channel's first contribution to the chunk).
    // Events that fall strictly after the seed time are applied below
    // (including ones that occur in gaps between notes — those are absent
    // from noteEvents and were the source of the pitch-bend corruption).
    const orderedNotes = notes
      .map((n, originalIndex) => ({ n, originalIndex }))
      .sort((a, b) =>
        a.n.offset - b.n.offset || a.originalIndex - b.originalIndex
      );
    const seedOffsetByChannel = new Map<number, number>();
    for (const { n } of orderedNotes) {
      const ch = n.channelNumber;
      if (seedOffsetByChannel.has(ch)) continue;
      seedOffsetByChannel.set(ch, n.offset);
      const dstChannel = offlinePlayer.channels[ch];
      dstChannel.state.array.set(n.channelStateArray);
      dstChannel.isDrum = n.isDrum;
      dstChannel.programNumber = n.programNumber;
      dstChannel.modulationDepthRange = this.channels[ch].modulationDepthRange;
      dstChannel.detune = n.channelDetune;
      // Apply channel volume/pan/expression so the offline gainL/gainR
      // nodes are set correctly before any notes start.
      offlinePlayer.updateChannelVolume(dstChannel, 0);
    }

    // Pre-fetch raw sample buffers in parallel (same optimisation as
    // renderSegmentBuffer — avoids serialising decode latency).
    const prefetchTasks: Promise<unknown>[] = [];
    const seenAudioBufferIds = new Set<number>();
    for (const n of notes) {
      const id = n.audioBufferId !== undefined
        ? n.audioBufferId
        : offlinePlayer.getVoiceId(
          offlinePlayer.channels[n.channelNumber],
          n.noteNumber,
          n.velocity,
        );
      if (id === undefined || seenAudioBufferIds.has(id)) continue;
      seenAudioBufferIds.add(id);
      prefetchTasks.push(
        offlinePlayer.getRawAudioBuffer(id, n.voiceParams),
      );
    }
    if (prefetchTasks.length > 0) await Promise.all(prefetchTasks);

    // Collect every non-note timeline event that falls inside this chunk's
    // time window. noteEvents only records events while a note is active,
    // so pitch-bends / volume CCs that occur in gaps between notes (or
    // after a note-off and before the next note-on) are missing from them.
    // Those gap events still change channel.detune / gainL/gainR on the
    // realtime player and must be baked here, otherwise subsequent notes
    // start at the wrong pitch / volume. Scan the full timeline so gaps
    // are covered; skip events at or before each channel's seed offset
    // because those are already reflected in the snapshot.
    const inverseTempo = 1 / this.tempo;
    const chunkStart = chunk.chunkStart;
    const channelSet = new Set(allChannelNumbers);
    type TimedEvent = { t: number; event: TimelineEvent };
    const windowEvents: TimedEvent[] = [];
    for (let i = 0; i < this.timeline.length; i++) {
      const event = this.timeline[i];
      if (
        event.type === "noteOn" ||
        event.type === "noteOff" ||
        event.type === "programChange"
      ) {
        continue;
      }
      if (event.channel !== undefined && !channelSet.has(event.channel)) {
        continue;
      }
      const absT = event.startTime * inverseTempo;
      const relT = absT - chunkStart;
      if (relT < 0 || relT > totalDuration) continue;
      if (event.channel !== undefined) {
        const seedOff = seedOffsetByChannel.get(event.channel);
        // Events at or before the seed are already in the snapshot
        // (controllers at the same tick as the first noteOn are processed
        // before the noteOn by timeline sort priority, so they land in the
        // snapshot). Only replay strictly later events.
        if (seedOff !== undefined && relT <= seedOff) continue;
      }
      windowEvents.push({ t: relT, event });
    }
    windowEvents.sort((a, b) => a.t - b.t);

    // Interleave noteOns with window events in time order so that when a
    // noteOn runs, channel.detune / state already reflect every pitch-bend
    // and CC that precedes it (including gap events). Scheduling all
    // noteOns first and replaying events afterwards left later notes with
    // the pre-bend detune baked into their bufferSource at start time.
    const offlineNotes: (TNote | void)[] = new Array(notes.length);
    let eventIdx = 0;
    for (const { n, originalIndex } of orderedNotes) {
      while (
        eventIdx < windowEvents.length &&
        windowEvents[eventIdx].t <= n.offset
      ) {
        const { t, event } = windowEvents[eventIdx++];
        offlinePlayer.processTimelineEvent(event, t, {
          channels: offlinePlayer.channels,
        });
      }
      const dstChannel = offlinePlayer.channels[n.channelNumber];
      const preNote = offlinePlayer.createNoteInstance(
        n.noteNumber,
        n.velocity,
        n.offset,
      );
      preNote.voiceParams = n.voiceParams;
      preNote.voice = n.voice ?? null;
      preNote.audioBufferId = n.audioBufferId;
      offlineNotes[originalIndex] = await offlinePlayer.noteOnChannel(
        dstChannel,
        n.noteNumber,
        n.velocity,
        n.offset,
        preNote,
      );
    }
    // Apply any remaining events that fall after the last noteOn (e.g. a
    // pitch-bend during a release tail that still affects sounding notes).
    while (eventIdx < windowEvents.length) {
      const { t, event } = windowEvents[eventIdx++];
      offlinePlayer.processTimelineEvent(event, t, {
        channels: offlinePlayer.channels,
      });
    }

    // Schedule noteOffs. volumeNode is already connected to
    // dstChannel.gainL/gainR (which includes baked channel volume/pan), so
    // no rewiring is needed unlike renderSegmentBuffer. The stereo mixer
    // flows: volumeNode → gainL/gainR → merger → masterVolume (offline dest).
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const dstChannel = offlinePlayer.channels[n.channelNumber];
      offlinePlayer.noteOffChannel(
        dstChannel,
        n.noteNumber,
        0,
        n.offset + n.noteDuration,
        true,
      );
    }
    await Promise.resolve();
    return await offlineContext.startRendering();
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
      const offset = event.startTime * inverseTempo + this.startDelay;
      this.processTimelineEvent(event, 0, {
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
      const buf = await this.renderChunkBuffer(chunk);
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
    const PEAK_TARGET = 0.95;
    let peak = 0;
    for (let i = 0; i < totalFrames; i++) {
      const al = mixedL[i] < 0 ? -mixedL[i] : mixedL[i];
      const ar = mixedR[i] < 0 ? -mixedR[i] : mixedR[i];
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
    }
    if (peak > PEAK_TARGET) {
      const scale = PEAK_TARGET / peak;
      for (let i = 0; i < totalFrames; i++) {
        mixedL[i] *= scale;
        mixedR[i] *= scale;
      }
    }

    this.renderedAudioBuffer = mixed;
    this.isRendering = false;
    this.dispatchEvent(new Event("rendered"));
    return this.renderedAudioBuffer;
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
    const ch = channel.channelNumber;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      1,
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
    // Seed from the snapshot taken when this segment opened, not from the
    // channel's current state — by the time closeSegment()/renderSegmentBuffer()
    // run, the realtime channel has already had every event in this segment
    // applied to it by scheduleTimelineEvents. Replaying those same events
    // (via noteEvents below) on top of the post-segment value would double-
    // apply them. See OpenSegment.channelDetune/channelStateArray doc comment.
    dstChannel.state.array.set(segment.channelStateArray);
    dstChannel.isDrum = channel.isDrum;
    dstChannel.programNumber = segment.programNumber;
    dstChannel.modulationDepthRange = channel.modulationDepthRange;
    dstChannel.detune = segment.channelDetune;

    // Pre-fetch every note's raw sample buffer in parallel first. Without
    // this, the scheduling loop below awaits noteOnChannel -> ... ->
    // getRawAudioBuffer one note at a time, and any not-yet-decoded
    // compressed sample (decodeAudioData / wasm OGG decode) serializes its
    // real decode latency into the loop. That delay pushes back when
    // startRendering() finally runs, which can push the segment's
    // bufferReady time past its scheduled absoluteStart and make it play
    // late/at the wrong time instead of on the beat. Pre-warming
    // rawAudioBufferCache (shared with the realtime player) means every
    // getRawAudioBuffer() call inside the loop below resolves from cache
    // synchronously-ish (already-resolved promise), so the loop's awaits
    // no longer wait on real decode work.
    const prefetchTasks: Promise<unknown>[] = [];
    const seenAudioBufferIds = new Set<number>();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const audioBufferId = n.audioBufferId !== undefined
        ? n.audioBufferId
        : offlinePlayer.getVoiceId(dstChannel, n.noteNumber, n.velocity);
      if (
        audioBufferId === undefined || seenAudioBufferIds.has(audioBufferId)
      ) {
        continue;
      }
      seenAudioBufferIds.add(audioBufferId);
      prefetchTasks.push(
        offlinePlayer.getRawAudioBuffer(audioBufferId, n.voiceParams),
      );
    }
    if (prefetchTasks.length > 0) await Promise.all(prefetchTasks);

    // buildNoteOnDurations() assigns each note's noteEvents by registering
    // every CC/pitchBend/etc TimelineEvent that occurs while that note is
    // active. When notes overlap in time (chords, legato, or one note's
    // release tail still ringing as the next note starts), the SAME event
    // object gets registered into multiple notes' noteEvents arrays — by
    // design, since each note independently needs to know about it. That's
    // harmless when every note renders in its own isolated offline context
    // (as "note" mode does), but here every note in the segment shares one
    // dstChannel, so applying the same pitchBend event twice (once per
    // note that references it) double-applies channel.setPitchBend's `+=`
    // accumulation onto the shared channel.detune, corrupting pitch for
    // every later note in the segment. Track already-applied event objects
    // by identity and skip them on subsequent notes.
    const appliedEvents = new Set<TimelineEvent>();

    const promises = new Array(notes.length);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const preNote = offlinePlayer.createNoteInstance(
        n.noteNumber,
        n.velocity,
        n.offset,
      );
      preNote.voiceParams = n.voiceParams;
      preNote.voice = n.voice ?? null;
      preNote.audioBufferId = n.audioBufferId;
      promises[i] = offlinePlayer.noteOnChannel(
        dstChannel,
        n.noteNumber,
        n.velocity,
        n.offset,
        preNote,
      );
    }
    const offlineNotes = await Promise.all(promises);

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const offlineNote = offlineNotes[i] as TNote | undefined;
      if (offlineNote?.volumeNode) {
        offlineNote.volumeNode.disconnect();
        offlineNote.volumeNode.connect(offlineContext.destination);
      }
      const { startTime: noteStartTime = 0, events: noteEvents = [] } =
        n.noteEvent ?? {};
      for (let j = 0; j < noteEvents.length; j++) {
        const event = noteEvents[j];
        if (appliedEvents.has(event)) continue;
        if (event.type === "programChange") continue;
        const t = (event.startTime as number) / this.tempo - noteStartTime;
        if (t < 0 || t > n.noteDuration) continue;
        appliedEvents.add(event);
        offlinePlayer.processTimelineEvent(event, n.offset + t, {
          channels: offlinePlayer.channels,
        });
      }
      // Don't await this: noteOffChannel()'s returned promise resolves
      // inside releaseNote() via bufferSource.onended, but onended can
      // only fire once the OfflineAudioContext actually renders audio —
      // i.e. after startRendering() runs, below. Awaiting it here would
      // deadlock forever (nothing ever calls startRendering() to make it
      // resolve), silently killing the whole segment. The stop()/gain
      // automation that releaseNote() schedules happens synchronously
      // (off note.ready, which is already resolved since noteOnChannel
      // above was awaited), so the scheduling itself is correct without
      // waiting for onended; we just need it to have run by the time
      // startRendering() is called, which the microtask flush below
      // guarantees.
      offlinePlayer.noteOffChannel(
        dstChannel,
        n.noteNumber,
        0,
        n.offset + n.noteDuration,
        true,
      );
    }
    // Let the note.ready.then(...) microtasks queued by noteOffChannel
    // above actually run (and call releaseNote synchronously) before
    // rendering starts.
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
    const { startTime: noteStartTime = 0, events: noteEvents = [] } =
      noteEvent ?? {};
    const ch = channel.channelNumber;
    const releaseEndDuration = voiceParams.volRelease * envelopeCurve * 5;
    const totalDuration = noteDuration + releaseEndDuration;
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
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
    dstChannel.state.array.set(channel.state.array);
    dstChannel.isDrum = channel.isDrum;
    dstChannel.programNumber = channel.programNumber;
    dstChannel.modulationDepthRange = channel.modulationDepthRange;
    dstChannel.detune = channel.detune;
    offlinePlayer.updateChannelVolume(dstChannel, 0);
    await offlinePlayer.noteOnChannel(
      dstChannel,
      note.noteNumber,
      note.velocity,
      0,
    );
    for (let i = 0; i < noteEvents.length; i++) {
      const event = noteEvents[i];
      const t = (event.startTime as number) / this.tempo - noteStartTime;
      if (t < 0 || t > noteDuration) continue;
      offlinePlayer.processTimelineEvent(event, t, {
        channels: offlinePlayer.channels,
      });
    }
    offlinePlayer.noteOffChannel(
      dstChannel,
      note.noteNumber,
      0,
      noteDuration,
      true,
    );
    const buffer = await offlineContext.startRendering();
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
        return await this.getFullCachedBuffer(channel, note, audioBufferId);
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

  async getFullCachedBuffer(
    channel: TChannel,
    note: TNote,
    audioBufferId: number | undefined,
  ): Promise<RenderedBuffer | AudioBuffer | undefined> {
    if (!audioBufferId) return undefined;
    const voiceParams = note.voiceParams;
    if (!voiceParams) return undefined;
    const timelineIndex = note.timelineIndex;
    if (!timelineIndex) return undefined;
    const noteEvent = this.noteOnEvents[timelineIndex];
    const noteDuration = noteEvent?.duration ?? 0;
    const cacheKey = timelineIndex;
    let durationMap = this.fullVoiceCache.get(audioBufferId);
    if (!durationMap) {
      durationMap = new Map();
      this.fullVoiceCache.set(audioBufferId, durationMap);
    }
    const cached = durationMap.get(cacheKey);
    if (cached instanceof RenderedBuffer) {
      note.fullCacheVoiceId = audioBufferId;
      return cached;
    }
    if (cached instanceof Promise) {
      const buf = await cached;
      if (buf == null) return await this.createAudioBuffer(voiceParams);
      note.fullCacheVoiceId = audioBufferId;
      return buf;
    }
    const renderPromise = (async () => {
      try {
        const rendered = await this.createFullRenderedBuffer(
          channel,
          { noteNumber: note.noteNumber, velocity: note.velocity },
          voiceParams,
          noteDuration,
          noteEvent,
        );
        durationMap!.set(cacheKey, rendered);
        return rendered;
      } catch (err) {
        durationMap!.delete(cacheKey);
        throw err;
      }
    })();
    durationMap.set(cacheKey, renderPromise);
    const rendered = await renderPromise;
    note.fullCacheVoiceId = audioBufferId;
    return rendered;
  }

  releaseFullCache(note: TNote): void {
    if (note.timelineIndex == null || note.fullCacheVoiceId == null) return;
    const durationMap = this.fullVoiceCache.get(note.fullCacheVoiceId);
    if (!durationMap) return;
    const entry = durationMap.get(note.timelineIndex);
    if (entry instanceof RenderedBuffer) {
      durationMap.delete(note.timelineIndex);
      if (durationMap.size === 0) {
        this.fullVoiceCache.delete(note.fullCacheVoiceId);
      }
    }
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
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            this.disconnectNote(note);
            this.releaseFullCache(note);
            resolve();
          };
          const src = note.bufferSource;
          if (!src) {
            finish();
            return;
          }
          src.onended = finish;
          try {
            src.stop(volRelease);
          } catch {
            finish();
          }
        });
      }
      if (naturalEndTime <= now) {
        this.disconnectNote(note);
        this.releaseFullCache(note);
        return;
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.disconnectNote(note);
          this.releaseFullCache(note);
          resolve();
        };
        const src = note.bufferSource;
        if (!src) {
          finish();
          return;
        }
        src.onended = finish;
        try {
          src.stop(naturalEndTime);
        } catch {
          finish();
        }
      });
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
          return new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              this.disconnectNote(note);
              resolve();
            };
            const src = note.bufferSource;
            if (!src) {
              finish();
              return;
            }
            src.onended = finish;
            try {
              src.stop(volRelease);
            } catch {
              finish();
            }
          });
        }
        if (naturalEndTime <= now) {
          this.disconnectNote(note);
          return;
        }
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            this.disconnectNote(note);
            resolve();
          };
          const src = note.bufferSource;
          if (!src) {
            finish();
            return;
          }
          src.onended = finish;
          try {
            src.stop(naturalEndTime);
          } catch {
            finish();
          }
        });
      }
      try {
        note.volumeNode?.gain
          .cancelScheduledValues(endTime)
          .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
      } catch { /* already closed */ }
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.disconnectNote(note);
        resolve();
      };
      const src = note.bufferSource;
      if (!src) {
        finish();
        return;
      }
      src.onended = finish;
      try {
        src.stop(volRelease);
      } catch {
        finish();
      }
    });
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
