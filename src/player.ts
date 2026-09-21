// Full-featured MIDI player with cache-mode playback strategies.
// Mode types and pure helpers live in {@link ./cache-strategy.ts};
// this module owns scheduling, offline bake, and Web Audio graph logic.
// Inherits real-time core from {@link BasePlayer}.
import { parseMidi } from "midi-file";
import { type Voice } from "@marmooo/soundfont";

import {
  BasePlayer,
  cbToRatio,
  Channel,
  ControllerState,
  envelopeCurve,
  f64ToBigInt,
  getVoiceParams,
  isFilterAudible,
  Note,
  RenderedBuffer,
  sf2FilterQ,
  type TimelineEvent,
  type VoiceParams,
} from "./base-player.ts";

import {
  bakeChannelMixForMode,
  type BakeNoteEntry,
  type CacheEntry,
  type CacheMode,
  type ChunkNoteEntry,
  type ChunkState,
  DEFAULT_CACHE_MODE,
  isChunkCacheMode,
  isSegmentCacheMode,
  isTiledCacheMode,
  needsNoteOnDurations,
  type NoteOnEntry,
  type NoteOnEventEntry,
  type OpenChunk,
  type OpenSegment,
  type PendingChunk,
  type PendingOffItem,
  type PendingSegment,
  type SegmentChannelState,
  type SegmentNoteEntry,
  usesSimpleComplexNoteCache,
} from "./cache-strategy.ts";

import {
  BakeWorkerPool,
  getSharedBakeWorkerPool,
  type MixSourceEntry,
} from "./bake-worker-pool.ts";

// Re-export cache strategy API (backward compatible with previous player.ts exports).
export {
  bakeChannelMixForMode,
  type BakeNoteEntry,
  type CacheEntry,
  type CacheMode,
  type ChunkNoteEntry,
  type ChunkState,
  DEFAULT_CACHE_MODE,
  isChunkCacheMode,
  isMidiFileOnlyCacheMode,
  isRealtimeCacheMode,
  isSegmentCacheMode,
  isTiledCacheMode,
  needsNoteOnDurations,
  type NoteOnEntry,
  type NoteOnEventEntry,
  type OpenChunk,
  type OpenSegment,
  type PendingChunk,
  type PendingOffItem,
  type PendingSegment,
  type SegmentChannelState,
  type SegmentNoteEntry,
  usesSimpleComplexNoteCache,
} from "./cache-strategy.ts";

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
  // identical onset -- including "note" mode playback and offline segment/
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
  // Runtime hit/miss counters for simpleNoteBufferCache / complexNoteBufferCache.
  // Reset at the start of each start() (before prewarm). Survives map.clear()
  // at end-of-song so post-playback logs still show rates even when
  // simpleCache size is 0. prewarm fills count as misses (first bake);
  // subsequent lookups/gets during play count as hits.
  simpleNoteCacheHits: number = 0;
  simpleNoteCacheMisses: number = 0;
  complexNoteCacheHits: number = 0;
  // Multi-use key, first bake (eligible for cache, not present yet).
  complexNoteCacheMisses: number = 0;
  // count <= 1: intentionally not cached (not a "miss" for hit-rate).
  complexNoteCacheUniqueBakes: number = 0;
  // Peak Map size observed while entries were inserted (post-play size may
  // be 0 after clearPlaybackCaches / resetAllStates).
  simpleNoteCachePeakSize: number = 0;
  complexNoteCachePeakSize: number = 0;
  // True while prewarmSimpleNoteCache is running (stats only).
  private noteCacheStatsInPrewarm: boolean = false;
  simpleNoteCachePrewarmMisses: number = 0;
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
  // tiled modes (segment / chunk): shared window + classification
  tileDuration: number = 1;
  // Soft budget for chunk-tile bake cost (Σ noteDuration+releaseTail, complex weighted).
  // When a *new onset group* would push cumulative cost over budget, the open
  // chunk is closed and a new tile starts at that onset. Same-timestamp notes
  // (chords) always stay in one tile. Time-based tileDuration remains the hard
  // upper bound (default 1s). 0 disables cost-based split.
  // Typical single-note cost is often ~1–2 (duration + release tail). Dense
  // 1s windows can sum to 50+. Budget ~12–24 splits outliers without
  // one-note tiles. Tune from [midy] chunk-tile-shape costAvg / notesAvg.
  chunkCostBudget: number = 16;
  // Extra weight for complex (automation) notes in the cost estimate.
  chunkComplexCostWeight: number = 1.75;
  maxTiledNoteDuration: number = 8;
  tiledBakedSet: Set<number> = new Set();
  tiledVoiceParams: (VoiceParams | null)[] = [];
  tiledVoices: (Voice | null)[] = [];
  // segment mode
  segmentChannelStates: (SegmentChannelState | null)[] = [];
  segmentGeneration: number = 0;
  // chunk mode
  chunkState: ChunkState = { openChunk: null, pending: [] };
  chunkGeneration: number = 0;
  // --- Chunk pipeline A/B stats (reset each start(); realtime only) ---
  chunkBakeCount: number = 0;
  chunkBakeSumMs: number = 0;
  chunkBakeMaxMs: number = 0;
  private chunkBakeSamplesMs: number[] = [];
  private static readonly CHUNK_BAKE_SAMPLE_CAP = 512;
  chunkPureTaTiles: number = 0;
  chunkOacTiles: number = 0;
  chunkStarts: number = 0;
  chunkLateStarts: number = 0;
  chunkLateSumMs: number = 0;
  chunkLateMaxMs: number = 0;
  chunkDroppedLate: number = 0;
  // Bake-phase breakdown (sums over all tiles; realtime only).
  chunkBakeSimpleSumMs: number = 0;
  chunkBakeComplexSumMs: number = 0;
  chunkBakeMixSumMs: number = 0;
  chunkBakeOacSumMs: number = 0;
  // Per-tile composition stats (sums over tiles; realtime only).
  chunkBakeNoteCountSum: number = 0;
  chunkBakeComplexCountSum: number = 0;
  chunkBakeSumNoteDuration: number = 0;
  chunkBakeSumCost: number = 0;
  // Cap concurrent OfflineAudioContext work. iOS Safari retains OAC / rendered
  // AudioBuffer memory aggressively; Promise.all over many complex notes in
  // one chunk was creating dozens of OACs at once and crashing the tab.
  // Logic (what gets baked) is unchanged -- only peak concurrency.
  maxConcurrentOfflineRenders: number = 1;
  private offlineRenderActive: number = 0;
  private offlineRenderWaiters: Array<() => void> = [];
  // Cap concurrent realtime chunk tile bakes (pure-TA + OAC). Without this,
  // hundreds of renderChunkBuffer() calls race the worker pool / OAC gate and
  // wall-clock "bake" times become mostly queue-wait → late/dropped starts.
  // 0 = unlimited (legacy). Default matches a small worker pool.
  maxConcurrentChunkBakes: number = 4;
  private chunkBakeActive: number = 0;
  private chunkBakeWaiters: Array<() => void> = [];

  // Debug / experiment: mix cached simple-note AudioBuffers by direct
  // TypedArray addition instead of scheduling AudioBufferSourceNodes into
  // OfflineAudioContext + startRendering. Complex notes and uncached
  // simple misses still go through OAC. Set false to force the legacy OAC
  // mix path for A/B comparison.
  useTypedArraySimpleMix: boolean = true;

  // Switch for simple-note full bake path.
  // true  → TypedArray (no Offline OAC) when simple + modulationDepthMSB === 0
  // false → always use the OfflineAudioContext path
  useTypedArraySimpleNoteBake: boolean = true;

  // Switch for chunk simple-cache-miss handling.
  // true  → bake miss via getSimpleNoteBuffer (TypedArray path when enabled)
  //         and TypedArray-mix into the chunk; avoids scheduleSimpleNotesDirect
  //         OAC for pure-simple chunks.
  // false → legacy: realtime misses / one-shot offline misses go through
  //         scheduleSimpleNotesDirect on a shared OfflineAudioContext.
  useTypedArrayChunkSimpleMiss: boolean = true;

  // Switch for chunk complex-note handling.
  // true  → bake each complex note via getComplexNoteBuffer, then TypedArray-mix
  //         into the chunk (same pattern as segment). Eliminates tile-level
  //         OfflineAudioContext when combined with useTypedArrayChunkSimpleMiss.
  // false → legacy: scheduleComplexNotesDirect on a shared OfflineAudioContext.
  useTypedArrayChunkComplexBake: boolean = true;

  // Almost-simple pan (CC10-only in-interval automation) on the TypedArray
  // simple path. Set false to force pan notes through the legacy complex OAC
  // path.
  useAlmostSimplePan: boolean = true;

  // Offload tile-level TypedArray mix (simpleHits + complexBufs → dest) to a
  // Web Worker pool. This is the primary worker path for segment / chunk:
  // one (or a few parallel) postMessage(s) per tile, not per note.
  // Restores multi-core utilisation lost when moving from OfflineAudioContext
  // to single-threaded TypedArray loops.
  // false → always mix on the main thread (A/B / debugging).
  useWorkerTypedArrayMix: boolean = true;

  // Worker pool size. 0 = auto (min(4, hardwareConcurrency)).
  workerPoolSize: number = 0;

  // Prefer Transferable ArrayBuffers when posting mix / sample-render jobs
  // (zero-copy). Default false (structured clone) for safer ownership; set
  // true once call sites no longer need the source Float32Arrays after post.
  useWorkerTransferable: boolean = false;

  // Min number of mix entries before a worker is used (below this the
  // postMessage overhead dominates). Applies to tile-level mix only.
  workerMixMinEntries: number = 4;

  // Offload pure TypedArray simple-note sample render (resample + loop +
  // optional lowpass + gains) to the worker pool — note / ads / adsr modes
  // only. Segment / chunk intentionally ignore this flag: per-note
  // postMessage overhead dominated wall time in practice, so those modes
  // bake note bodies on the main thread and only offload the tile mix
  // (useWorkerTypedArrayMix). Curve computation always stays on main.
  useWorkerSimpleNoteBake: boolean = true;

  private bakeWorkerPool: BakeWorkerPool | null = null;

  // Simple-note prewarm budget (start() before playNotes).
  // Phase 1: keys whose earliest onset falls in the song-head window
  // (prewarmSimpleHeadSec; 0 = auto lookAhead+maxTiledNoteDuration).
  // Head keys use prewarmSimpleHeadMinCount (default 1 = include one-shots).
  // Phase 2: remaining multi-use keys (prewarmSimpleMinCount) if budget left.
  // Within each phase: earliest onset first, then frequency desc.
  // Stops when wall time exceeds prewarmSimpleMaxMs (0 = no limit).
  // Wall-clock budget for prewarm (ms). 0 = bake all candidates.
  prewarmSimpleMaxMs: number = 3000;
  // Min appearances for post-head (phase 2) keys. Default: multi-use only.
  prewarmSimpleMinCount: number = 2;
  // Song-time window (seconds) for phase-1 priority. 0 = auto
  // (lookAhead + maxTiledNoteDuration).
  prewarmSimpleHeadSec: number = 0;
  // Min appearances inside the head window (1 = include one-shot keys).
  prewarmSimpleHeadMinCount: number = 1;

  // Song-time window (seconds) to fully bake before arming the playback clock.
  // Only applies to segment/chunk modes. 0 = disable preroll.
  // Light songs finish early; heavy songs wait up to prerollMaxMs.
  prerollSec: number = 6;
  // Wall-clock cap for preroll bake (ms). 0 = no cap.
  prerollMaxMs: number = 0;
  // Song time up to which tiled notes were already queued/baked in preroll.
  // scheduleTimelineEvents skips appendTo*Queue for tiled notes with t < this
  // so preroll tiles are not duplicated. Reset on stop / non-tiled play.
  prerollUntilSongTime: number = 0;
  // Peak prerollUntilSongTime this play (survives end-of-song reset for stats).
  prerollUntilPeak: number = 0;
  // Soft cap on notes per chunk tile. When adding a *new onset group* would
  // exceed this, close and start a new tile (same-timestamp chords stay).
  // 0 = disabled. Guards against one huge dense chord/arpeggio tile.
  maxChunkNotes: number = 48;
  // Log a detailed breakdown when a single tile bake exceeds this (ms).
  // 0 = disable. Use to hunt bakeMax outliers (complex OAC, miss storms, mix).
  chunkBakeHeavyThresholdMs: number = 1500;

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
  // Serialize OfflineAudioContext work across the whole Player.
  //
  // Always waits for a slot. Sibling bakers (chunk / segment / prewarm /
  // note-mode) therefore cannot pile up N OfflineAudioContexts after the
  // first one yields on await — the previous depth>0 early-return did that
  // because depth stayed raised while scheduleTimelineEvents closed the
  // next tiles.
  //
  // Nested per-note bakes from inside an already-held slot MUST NOT call
  // this method (deadlock at maxConcurrentOfflineRenders === 1). They go
  // through renderEntryAudioBufferUngated via fromOuterSlot on
  // getSimpleNoteBuffer / getComplexNoteBuffer. A global "in slot" flag
  // would look held to sibling note-mode bakes too; the opt-in argument
  // is scoped to the call, not to the Player instance.
  protected async runWithOfflineRenderGate<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const max = Math.max(1, this.maxConcurrentOfflineRenders | 0);
    while (this.offlineRenderActive >= max) {
      await new Promise<void>((resolve) => {
        this.offlineRenderWaiters.push(resolve);
      });
    }
    this.offlineRenderActive++;
    try {
      return await fn();
    } finally {
      this.offlineRenderActive--;
      const next = this.offlineRenderWaiters.shift();
      if (next) next();
    }
  }

  // Serializes/limits concurrent realtime chunk tile bakes so pure-TA tiles
  // cannot stampede the worker mix pool. forAudioOffline (song export) skips
  // this gate. maxConcurrentChunkBakes <= 0 → pass-through (unlimited).
  protected async runWithChunkBakeGate<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const max = this.maxConcurrentChunkBakes | 0;
    if (max <= 0) return await fn();
    while (this.chunkBakeActive >= max) {
      await new Promise<void>((resolve) => {
        this.chunkBakeWaiters.push(resolve);
      });
    }
    this.chunkBakeActive++;
    try {
      return await fn();
    } finally {
      this.chunkBakeActive--;
      const next = this.chunkBakeWaiters.shift();
      if (next) next();
    }
  }

  // Copy PCM into a fresh AudioBuffer allocated against the live context so
  // the OfflineAudioContext's rendered buffer can be dropped. On iOS the
  // buffer returned by startRendering often keeps the OAC graph alive.
  protected detachAudioBuffer(src: AudioBuffer): AudioBuffer {
    const dst = this.audioContext.createBuffer(
      src.numberOfChannels,
      src.length,
      src.sampleRate,
    );
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      dst.copyToChannel(src.getChannelData(ch), ch);
    }
    return dst;
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
    this.tiledBakedSet.clear();
    this.simpleNoteSet.clear();
    this.simpleNoteBufferCache.clear();
    this.simpleNoteCounts.clear();
    this.complexNoteBufferCache.clear();
    this.complexNoteCounts.clear();
    this.tiledVoiceParams = [];
    this.tiledVoices = [];
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
      soundOff = false,
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
        soundOff: soundOff || undefined,
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
                    if (activeStack && activeStack.length > 0) {
                      // Release at pedal-up time, not the deferred note-off time.
                      finalizeEntry(activeStack.shift()!, t, event.ticks);
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
            case 120: // All Sound Off — instant mute, no release tail
            case 123: { // All Notes Off — normal release
              const soundOff = event.controllerType === 120;
              const pairs = Array.from(activeNotes);
              for (let pi = 0; pi < pairs.length; pi++) {
                const key = pairs[pi][0];
                if (key % numChannels !== ch) continue;
                const stack = pairs[pi][1];
                for (let ei = 0; ei < stack.length; ei++) {
                  finalizeEntry(stack[ei], t, event.ticks, soundOff);
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
    const needsTiledData = isTiledCacheMode(cacheMode);
    const tiledVoiceParams: (VoiceParams | null)[] = needsTiledData
      ? new Array(timeline.length).fill(null)
      : [];
    const tiledVoices: (Voice | null)[] = needsTiledData
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
          // Exclusive-class drum notes are excluded from tiledVoiceParams
          // (and therefore from segment/chunk notes) because segmenting them
          // would bring no benefit -- exclusive class guarantees at most one
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
              const voiceParams = getVoiceParams(voice, controllerState);
              if (needsTiledData && !isExcludedDrum) {
                tiledVoiceParams[i] = voiceParams;
                tiledVoices[i] = voice;
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
    if (needsNoteOnDurations(cacheMode)) {
      this.buildNoteOnDurations();
    }
    if (needsTiledData) {
      this.tiledVoiceParams = tiledVoiceParams;
      this.tiledVoices = tiledVoices;
      this.finalizeSegmentClassification();
      // Simple/complex-note classification is shared by note / segment / chunk / audio.
      this.finalizeSimpleNoteClassification();
      this.buildSimpleNoteCounts();
      this.buildComplexNoteCounts();
    } else if (usesSimpleComplexNoteCache(cacheMode)) {
      // audio mode uses renderChunkBuffer's simple-note path;
      // note mode reuses simpleNoteBufferCache for identical onsets.
      this.finalizeSimpleNoteClassification();
      this.buildSimpleNoteCounts();
      this.buildComplexNoteCounts();
    }
  }

  // Whether a drum note should be excluded from segment/chunk baking.
  // Exclusive-class drums are scheduled via the normal noteOn path so they
  // can still choke each other; segmenting them adds no polyphony win.
  // GM1 uses a fixed table; GM2 overrides with per-kit tables.
  protected isSegmentExcludedDrum(
    channel: TChannel,
    noteNumber: number,
  ): boolean {
    return channel.isDrum && this.drumExclusiveClasses[noteNumber] !== 0;
  }

  // Side effects while walking the timeline inside cacheVoiceIds (bank
  // select, etc.). Base does nothing; GM2 applies CC#0 / CC#32 so program
  // changes resolve against the correct bank during the walk.
  protected onCacheTimelineEvent(_event: TimelineEvent): void {}

  // Restore mode defaults after cacheVoiceIds has resolved voice ids.
  // Base = GM1 System On; GM2 overrides with GM2 System On.
  protected applySystemDefaultsAfterCache(scheduleTime: number): void {
    this.GM1SystemOn(scheduleTime);
  }

  // Factory for a fresh ControllerState used when resetting channels inside
  // cacheVoiceIds / prepareVoices. Base returns the shared GM-Lite state;
  // MidyGM2 / Midy override so channel.state keeps the right prototype
  // (softPedal, portamento, LSB controllers, delaySendLevel, ...).
  // Using `new ControllerState()` from this module would install the base
  // class and silence notes once subclass code reads missing getters.
  protected override createControllerState(): ControllerState {
    return new ControllerState();
  }

  // -------------------------------------------------------------------------
  // Preparation: note classification & cache keys (simple / complex / tiled)
  // Called from cacheVoiceIds / tempoChange. Pure-ish relative to the graph.
  // -------------------------------------------------------------------------

  // "segment" / "chunk" mode: combine the voiceParams resolved during cacheVoiceIds()
  // (at the correct point in program-change order) with noteOnDurations
  // (which needs its own full-timeline pass and isn't ready until after
  // that loop) to decide which notes are safe to bake into a segment/chunk.
  // Notes that ring too long, or that participate in an exclusive class
  // (hi-hat choke groups etc.), are left out so they keep going through
  // normal per-note real-time ("ads"-style) scheduling instead -- that
  // path is the only way to cut a note off early once it has started.
  // Cheap (no voice resolution), so tempoChange() can call this again
  // after buildNoteOnDurations() without redoing the full classification.

  finalizeSegmentClassification(): void {
    const {
      noteOnDurations,
      tiledVoiceParams,
      noteOnEvents,
      maxTiledNoteDuration,
    } = this;
    const bakedSet = new Set<number>();
    for (let i = 0; i < tiledVoiceParams.length; i++) {
      const voiceParams = tiledVoiceParams[i];
      if (!voiceParams) continue;
      if ((voiceParams.exclusiveClass ?? 0) !== 0) continue;
      const duration = noteOnDurations[i] ?? 0;
      // All Sound Off ends the voice with no release tail.
      const releaseTail = noteOnEvents[i]?.soundOff
        ? 0
        : voiceParams.releaseVolEnv * envelopeCurve * 5;
      if (maxTiledNoteDuration < duration + releaseTail) continue;
      bakedSet.add(i);
    }
    this.tiledBakedSet = bakedSet;
  }

  // Controllers that only scale amplitude (GM/FluidSynth x² curve) and do not
  // change the pitched sample body. Notes whose in-interval automation is
  // exclusively these can stay on the simple TypedArray path: the gain curve
  // is applied sample-by-sample when baking the note buffer.
  static readonly GAIN_ONLY_CONTROLLER_TYPES: ReadonlySet<number> = new Set([
    7, // volume
    11, // expression
  ]);

  // CC10 pan: stereo balance only. Handled on the simple TypedArray path via
  // a per-sample L/R curve (computePanCurve).
  static readonly PAN_CONTROLLER_TYPE = 10;

  // Sustain (CC#64) and note-stop controllers only determine the duration,
  // which buildNoteOnDurations has already resolved. They do not alter a
  // baked waveform, so they must not force an expensive complex-note bake.
  // Volume (7) / expression (11) also no longer force complex: they are
  // handled as a per-sample gain curve on the simple TypedArray bake path
  // ("almost simple"). Pitch bend, SysEx, pan, modulation, etc. still force
  // the full complex Offline path.
  protected hasWaveformAutomation(noteEvent: NoteOnEventEntry): boolean {
    const events = noteEvent.events;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === "pitchBend" || event.type === "sysEx") return true;
      if (event.type !== "controller") continue;
      const controller = event.controllerType ?? -1;
      if (controller === 64 || controller === 120 || controller === 123) {
        continue;
      }
      if (Player.GAIN_ONLY_CONTROLLER_TYPES.has(controller)) {
        continue;
      }
      if (
        this.useAlmostSimplePan &&
        controller === Player.PAN_CONTROLLER_TYPE
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  // True when the note has in-interval automation, but only volume/expression
  // (plus duration-only CCs already ignored by hasWaveformAutomation).
  // Used for stats and for including a gain-curve fingerprint in the simple
  // cache key so different expression trajectories do not collide.
  protected hasGainOnlyAutomation(noteEvent: NoteOnEventEntry): boolean {
    const events = noteEvent.events;
    if (events.length === 0) return false;
    let sawGain = false;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === "pitchBend" || event.type === "sysEx") return false;
      if (event.type === "programChange") continue;
      if (event.type !== "controller") return false;
      const controller = event.controllerType ?? -1;
      if (controller === 64 || controller === 120 || controller === 123) {
        continue;
      }
      if (Player.GAIN_ONLY_CONTROLLER_TYPES.has(controller)) {
        sawGain = true;
        continue;
      }
      if (controller === Player.PAN_CONTROLLER_TYPE) {
        continue;
      }
      return false;
    }
    return sawGain;
  }

  // True when in-interval automation includes CC10 pan and nothing that
  // forces complex (pitch bend / mod / other CC / SysEx). Gain may coexist.
  protected hasPanOnlyAutomation(noteEvent: NoteOnEventEntry): boolean {
    if (!this.useAlmostSimplePan) return false;
    const events = noteEvent.events;
    if (events.length === 0) return false;
    let sawPan = false;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === "pitchBend" || event.type === "sysEx") return false;
      if (event.type === "programChange") continue;
      if (event.type !== "controller") return false;
      const controller = event.controllerType ?? -1;
      if (controller === 64 || controller === 120 || controller === 123) {
        continue;
      }
      if (Player.GAIN_ONLY_CONTROLLER_TYPES.has(controller)) {
        continue;
      }
      if (controller === Player.PAN_CONTROLLER_TYPE) {
        sawPan = true;
        continue;
      }
      return false;
    }
    return sawPan;
  }

  // Gain and/or pan only — the extended "almost simple" set for mix bake.
  protected hasPanOrGainOnlyAutomation(noteEvent: NoteOnEventEntry): boolean {
    return this.hasGainOnlyAutomation(noteEvent) ||
      this.hasPanOnlyAutomation(noteEvent);
  }

  // Treat notes with no waveform-changing in-interval automation as simple.
  // noteEvent.events is filled by buildNoteOnDurations with every
  // controller / pitchBend / sysEx / programChange that occurs while the
  // note is active -- so pitch bend IS part of the simple/complex test,
  // not only CC. Notes that start after a pitch bend but have no further
  // automation remain simple; their onset detune is taken from the
  // per-note channelDetune snapshot instead.
  // Volume/expression-only automation ("almost simple") is also classified
  // as simple: the gain curve is baked via TypedArray (see
  // computeGainOnlyChannelCurve / renderSimpleNoteTypedArray).
  // (Conservative approximation -- events in the release gap after noteOff
  // are not captured.)
  finalizeSimpleNoteClassification(): void {
    const simple = new Set<number>();
    // Prefer the segment-baked subset when available (segment/chunk); fall
    // back to every noteOn with a known duration (note / audio mode).
    const noteOnEvents = this.noteOnEvents;
    const candidates = this.tiledBakedSet.size > 0 ? this.tiledBakedSet : null;
    if (candidates) {
      const candidateArr = Array.from(candidates);
      for (let ci = 0; ci < candidateArr.length; ci++) {
        const i = candidateArr[ci];
        const noteEvent = noteOnEvents[i];
        if (!noteEvent) continue;
        if (noteEvent.duration <= 0) continue;
        if (noteEvent.durationTicks === Infinity) continue;
        if (this.hasWaveformAutomation(noteEvent)) continue;
        simple.add(i);
      }
    } else {
      for (let i = 0; i < noteOnEvents.length; i++) {
        const noteEvent = noteOnEvents[i];
        if (!noteEvent) continue;
        if (noteEvent.duration <= 0) continue;
        if (noteEvent.durationTicks === Infinity) continue;
        if (this.hasWaveformAutomation(noteEvent)) continue;
        simple.add(i);
      }
    }
    this.simpleNoteSet = simple;
  }

  // Flags present on a complex note's in-interval automation.
  // Multi-label (a note can set several flags). Used to decide which
  // TypedArray path to implement next.
  protected inspectComplexAutomation(noteEvent: NoteOnEventEntry): {
    pitchBend: boolean;
    pan: boolean;
    mod: boolean;
    gain: boolean;
    otherCc: boolean;
    sysEx: boolean;
    programChange: boolean;
  } {
    let pitchBend = false;
    let pan = false;
    let mod = false;
    let gain = false;
    let otherCc = false;
    let sysEx = false;
    let programChange = false;
    const events = noteEvent.events;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === "pitchBend") {
        pitchBend = true;
        continue;
      }
      if (event.type === "sysEx") {
        sysEx = true;
        continue;
      }
      if (event.type === "programChange") {
        programChange = true;
        continue;
      }
      if (event.type !== "controller") continue;
      const controller = event.controllerType ?? -1;
      // Duration-only; ignored by hasWaveformAutomation too.
      if (controller === 64 || controller === 120 || controller === 123) {
        continue;
      }
      if (Player.GAIN_ONLY_CONTROLLER_TYPES.has(controller)) {
        gain = true;
        continue;
      }
      if (controller === 10) {
        pan = true;
        continue;
      }
      if (controller === 1) {
        mod = true;
        continue;
      }
      otherCc = true;
    }
    return { pitchBend, pan, mod, gain, sysEx, programChange, otherCc };
  }

  // Breakdown of complex notes for post-start() logging.
  // - with*: multi-label counts (sum can exceed complex)
  // - only* / bendGain / panGain / mixed: exclusive buckets for prioritization
  protected countComplexBreakdown(): {
    complex: number;
    withPitchBend: number;
    withPan: number;
    withMod: number;
    withGain: number;
    withOtherCc: number;
    withSysEx: number;
    withProgramChange: number;
    onlyPitchBend: number;
    onlyPan: number;
    onlyMod: number;
    onlyOtherCc: number;
    onlySysEx: number;
    bendGain: number;
    panGain: number;
    mixed: number;
  } {
    const noteOnEvents = this.noteOnEvents;
    const candidates = this.tiledBakedSet.size > 0 ? this.tiledBakedSet : null;
    let complex = 0;
    let withPitchBend = 0;
    let withPan = 0;
    let withMod = 0;
    let withGain = 0;
    let withOtherCc = 0;
    let withSysEx = 0;
    let withProgramChange = 0;
    let onlyPitchBend = 0;
    let onlyPan = 0;
    let onlyMod = 0;
    let onlyOtherCc = 0;
    let onlySysEx = 0;
    let bendGain = 0;
    let panGain = 0;
    let mixed = 0;

    const consider = (i: number) => {
      const noteEvent = noteOnEvents[i];
      if (!noteEvent) return;
      if (noteEvent.duration <= 0) return;
      if (noteEvent.durationTicks === Infinity) return;
      if (!this.hasWaveformAutomation(noteEvent)) return;
      complex++;
      const f = this.inspectComplexAutomation(noteEvent);
      if (f.pitchBend) withPitchBend++;
      if (f.pan) withPan++;
      if (f.mod) withMod++;
      if (f.gain) withGain++;
      if (f.otherCc) withOtherCc++;
      if (f.sysEx) withSysEx++;
      if (f.programChange) withProgramChange++;

      // Exclusive buckets: waveform kinds only (gain is optional companion).
      const kinds: string[] = [];
      if (f.pitchBend) kinds.push("bend");
      if (f.pan) kinds.push("pan");
      if (f.mod) kinds.push("mod");
      if (f.otherCc) kinds.push("otherCc");
      if (f.sysEx) kinds.push("sysEx");
      if (f.programChange) kinds.push("pc");

      if (kinds.length === 1 && kinds[0] === "bend") {
        if (f.gain) bendGain++;
        else onlyPitchBend++;
      } else if (kinds.length === 1 && kinds[0] === "pan") {
        if (f.gain) panGain++;
        else onlyPan++;
      } else if (kinds.length === 1 && kinds[0] === "mod") {
        onlyMod++;
      } else if (kinds.length === 1 && kinds[0] === "otherCc") {
        onlyOtherCc++;
      } else if (kinds.length === 1 && kinds[0] === "sysEx") {
        onlySysEx++;
      } else {
        mixed++;
      }
    };

    if (candidates) {
      for (const i of candidates) consider(i);
    } else {
      for (let i = 0; i < noteOnEvents.length; i++) consider(i);
    }

    return {
      complex,
      withPitchBend,
      withPan,
      withMod,
      withGain,
      withOtherCc,
      withSysEx,
      withProgramChange,
      onlyPitchBend,
      onlyPan,
      onlyMod,
      onlyOtherCc,
      onlySysEx,
      bendGain,
      panGain,
      mixed,
    };
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

    const bakeChannelMix = bakeChannelMixForMode(cacheMode);
    const settings = (this.constructor as typeof Player).channelSettings;
    const numChannels = this.numChannels;
    const channels = new Array<TChannel>(numChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      const channel = this.createChannelInstance(ch, settings);
      channel.player = this;
      channels[ch] = channel;
    }
    if (channels[9]) channels[9].isDrum = true;

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const needsSegmentVoice = isTiledCacheMode(cacheMode);
    const simpleNoteSet = this.simpleNoteSet;
    const noteOnEvents = this.noteOnEvents;
    const tiledVoiceParams = this.tiledVoiceParams;
    const tiledVoices = this.tiledVoices;
    const noteAudioBufferIds = this.noteAudioBufferIds;
    const simpleNoteCounts = this.simpleNoteCounts;

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const offset = event.startTime * inverseTempo;
      this.processTimelineEvent(event, offset, {
        channels,
        onNoteOn: (renderChannel: TChannel, noteEvent: TimelineEvent) => {
          if (!simpleNoteSet.has(i)) return;
          const noteOnEvent = noteOnEvents[i];
          if (!noteOnEvent || noteOnEvent.duration <= 0) return;

          let voiceParams: VoiceParams | null = null;
          let voice: Voice | null | undefined = null;
          if (needsSegmentVoice) {
            voiceParams = tiledVoiceParams[i];
            voice = tiledVoices[i];
          }
          if (!voiceParams) {
            voice = this.resolveVoice(
              renderChannel,
              noteEvent.noteNumber!,
              noteEvent.velocity!,
            );
            if (!voice) return;
            voiceParams = getVoiceParams(
              voice,
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
              audioBufferId: noteAudioBufferIds[i],
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
          simpleNoteCounts.set(key, (simpleNoteCounts.get(key) ?? 0) + 1);
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
    return !this.hasWaveformAutomation(noteEvent);
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
  // lifetime which is already captured by durationTicks -- including them in
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

  // Whether a CC type is part of the complex-note automation fingerprint.
  // Base uses COMPLEX_KEY_CONTROLLER_TYPES; Midy adds LSB / sound CCs / delay.
  protected isComplexKeyController(controllerType: number): boolean {
    return Player.COMPLEX_KEY_CONTROLLER_TYPES.has(controllerType);
  }

  // Append channel-state fields that affect the offline bake to a note
  // cache key. Base: volumeMSB / panMSB / expressionMSB when bakeChannelMix
  // (zeros when dry so field positions stay stable -- dry leaves the channel
  // bus live). Subclasses push note-body slots always and mix-level slots
  // (LSB, delay send, …) only when bakeChannelMix is true.
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

  // Shared key body for simple + complex note caches.
  // complex=false → fine detune quantize, no automation suffix.
  // complex=true  → coarse detune + "cx" prefix + automation fingerprint.
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
      Math.round(n.voiceParams.releaseVolEnv * 1e6),
      Math.round(n.voiceParams.playbackRate * 1e6),
      // Distinguish All Sound Off (zero release) from normal note-off of the
      // same duration so the shared simple-note cache never reuses a buffer
      // that still has a release tail.
      n.noteEvent?.soundOff ? 1 : 0,
    );
    if (complex) {
      parts.push(this.serializeNoteAutomationEvents(n.noteEvent));
    } else if (n.noteEvent && this.hasPanOrGainOnlyAutomation(n.noteEvent)) {
      // Almost-simple: gain and/or pan curves are baked into the TypedArray
      // buffer, so the simple key must distinguish different trajectories.
      parts.push(this.serializeGainOnlyAutomationEvents(n.noteEvent));
      parts.push(this.serializePanAutomationEvents(n.noteEvent));
    }
    return parts;
  }

  // Fingerprint of volume/expression events only (relative ticks). Used as a
  // suffix on simple-note cache keys for almost-simple notes.
  serializeGainOnlyAutomationEvents(
    noteEvent: NoteOnEventEntry | undefined,
  ): string {
    if (!noteEvent || noteEvent.events.length === 0) return "";
    const startTicks = noteEvent.startTicks ?? 0;
    const parts: string[] = [];
    for (let i = 0; i < noteEvent.events.length; i++) {
      const event = noteEvent.events[i];
      if (event.type !== "controller") continue;
      const ct = event.controllerType ?? -1;
      if (!Player.GAIN_ONLY_CONTROLLER_TYPES.has(ct)) continue;
      const absTick = event.ticks ?? event.startTime ?? 0;
      const rel = absTick - startTicks;
      parts.push(`g:${rel}:${ct}:${event.value}`);
    }
    return parts.join(";");
  }

  // Fingerprint of pan (CC10) events only (relative ticks). Used as a suffix
  // on simple-note cache keys for pan almost-simple notes.
  serializePanAutomationEvents(
    noteEvent: NoteOnEventEntry | undefined,
  ): string {
    if (!noteEvent || noteEvent.events.length === 0) return "";
    const startTicks = noteEvent.startTicks ?? 0;
    const parts: string[] = [];
    for (let i = 0; i < noteEvent.events.length; i++) {
      const event = noteEvent.events[i];
      if (event.type !== "controller") continue;
      const ct = event.controllerType ?? -1;
      if (ct !== Player.PAN_CONTROLLER_TYPE) continue;
      const absTick = event.ticks ?? event.startTime ?? 0;
      const rel = absTick - startTicks;
      parts.push(`p:${rel}:${event.value}`);
    }
    return parts.join(";");
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
          const data = event.data as ArrayLike<number> | undefined;
          let dataStr = "";
          if (data) {
            const len = data.length;
            const segs = new Array<string>(len);
            for (let di = 0; di < len; di++) segs[di] = String(data[di]);
            dataStr = segs.join(",");
          }
          parts.push(`sx:${rel}:${dataStr}`);
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

    const bakeChannelMix = bakeChannelMixForMode(cacheMode);
    const settings = (this.constructor as typeof Player).channelSettings;
    const numChannels = this.numChannels;
    const channels = new Array<TChannel>(numChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      const channel = this.createChannelInstance(ch, settings);
      channel.player = this;
      channels[ch] = channel;
    }
    if (channels[9]) channels[9].isDrum = true;

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const needsSegmentVoice = isTiledCacheMode(cacheMode);
    // Complex candidates: baked notes that are not simple, or all non-simple
    // noteOns when no segment set exists (note / audio mode).
    const candidates = this.tiledBakedSet.size > 0 ? this.tiledBakedSet : null;
    const simpleNoteSet = this.simpleNoteSet;
    const noteOnEvents = this.noteOnEvents;
    const tiledVoiceParams = this.tiledVoiceParams;
    const noteAudioBufferIds = this.noteAudioBufferIds;
    const complexNoteCounts = this.complexNoteCounts;

    const considerIndex = (i: number): boolean => {
      if (simpleNoteSet.has(i)) return false;
      const noteOnEvent = noteOnEvents[i];
      if (!noteOnEvent || noteOnEvent.duration <= 0) return false;
      if (noteOnEvent.durationTicks === Infinity) return false;
      // Must have automation -- otherwise it would be simple.
      if (!this.hasWaveformAutomation(noteOnEvent)) return false;
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
          const noteOnEvent = noteOnEvents[i]!;

          let voiceParams: VoiceParams | null = null;
          if (needsSegmentVoice) {
            voiceParams = tiledVoiceParams[i];
          }
          if (!voiceParams) {
            const voice = this.resolveVoice(
              renderChannel,
              noteEvent.noteNumber!,
              noteEvent.velocity!,
            );
            if (!voice) return;
            voiceParams = getVoiceParams(
              voice,
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
              audioBufferId: noteAudioBufferIds[i],
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
          complexNoteCounts.set(key, (complexNoteCounts.get(key) ?? 0) + 1);
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Playback scheduling & control
  // -------------------------------------------------------------------------

  override scheduleTimelineEvents(
    scheduleTime: number,
    queueIndex: number,
  ): number {
    const timeOffset = this.resumeTime - this.startTime;
    const cacheMode = this.cacheMode;
    const isSegmentMode = isSegmentCacheMode(cacheMode);
    const isChunkMode = isChunkCacheMode(cacheMode);
    // Segment/chunk mode needs notes discovered far enough ahead that
    // closeSegment/closeChunk + render have time to finish before each
    // segment/chunk's scheduled start time. The worst case render length scales
    // with how long a single note in the segment can ring
    // (maxTiledNoteDuration), on top of the segment's own discovery
    // window (lookAhead), so segment/chunk mode adds the two rather than reusing
    // the plain lookAhead other cache modes use for note-on scheduling.
    const effectiveLookAhead = isTiledCacheMode(cacheMode)
      ? this.lookAhead + this.maxTiledNoteDuration
      : this.lookAhead;
    const lookAheadCheckTime = scheduleTime + timeOffset + effectiveLookAhead;
    const schedulingOffset = this.startDelay - timeOffset;
    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const noteAudioBufferIds = this.noteAudioBufferIds;
    const tiledBakedSet = this.tiledBakedSet;
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
            tiledBakedSet.has(queueIndex);
          const isChunkNote = isChunkMode &&
            tiledBakedSet.has(queueIndex);
          if (isSegmentNote || isChunkNote) {
            note.isTiledGhost = true;
            note.tiledNoteDuration = noteOnDurations[queueIndex] ?? 0;
          }
          channel.noteOn(
            event.noteNumber!,
            event.velocity!,
            startTime,
            note,
          );
          // Tiled notes with t < prerollUntilSongTime were already appended
          // and baked during prerollTiledPipeline — do not queue them again.
          const alreadyPrerolled = t < this.prerollUntilSongTime;
          if (isSegmentNote && !alreadyPrerolled) {
            this.appendToSegmentQueue(
              channel.channelNumber,
              t,
              queueIndex,
              event.noteNumber!,
              event.velocity!,
            );
          }
          if (isChunkNote && !alreadyPrerolled) {
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
    // Drop tiled sources + pending buffers first so large AudioBuffers are
    // detached from live AudioBufferSourceNodes before Map.clear().
    this.releaseTiledPlaybackResources();
    if (this.audioModeBufferSource) {
      this.neuterBufferSource(this.audioModeBufferSource);
      this.audioModeBufferSource = null;
    }
    this.renderedAudioBuffer = null;

    this.rawAudioBufferCache.clear();
    this.voiceCache.clear();
    this.realtimeVoiceCache.clear();
    this.adsrVoiceCache.clear();
    // Replace maps rather than only clear(): in-flight Promise callbacks that
    // still hold the old Map entry lose their only strong path into the shared
    // cache object once we drop this reference.
    this.simpleNoteBufferCache = new Map();
    this.simpleNoteCounts = new Map();
    this.complexNoteBufferCache = new Map();
    this.complexNoteCounts = new Map();
  }

  // Stop tiled BufferSources, null pending AudioBuffers, bump generations so
  // in-flight OfflineAudioContext results are discarded on completion.
  // Does not change bake logic -- only releases references for GC / iOS.
  protected releaseTiledPlaybackResources(): void {
    this.segmentGeneration++;
    this.chunkGeneration++;
    this.prerollUntilSongTime = 0;

    const states = this.segmentChannelStates;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        this.neuterBufferSource(p.source);
        p.source = null;
        p.buffer = null;
        p.bufferReady = true;
        p.done = true;
      }
      state.pending = [];
      state.openSegment = null;
    }

    const chunkPending = this.chunkState.pending;
    for (let i = 0; i < chunkPending.length; i++) {
      const p = chunkPending[i];
      this.neuterBufferSource(p.source);
      p.source = null;
      p.buffer = null;
      p.bufferReady = true;
      p.done = true;
    }
    this.chunkState.pending = [];
    this.chunkState.openChunk = null;
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
          this.neuterBufferSource(bufferSource);
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
          this.neuterBufferSource(bufferSource);
          this.audioModeBufferSource = null;
          // await this.suspendAudioContext();
          this.isPausing = false;
          exitReason = "paused";
          break outer;
        } else if (this.isStopping) {
          this.cancelScheduledTasks();
          this.neuterBufferSource(bufferSource);
          this.audioModeBufferSource = null;
          await this.suspendAudioContext();
          this.isStopping = false;
          exitReason = "stopped";
          break outer;
        } else if (this.isSeeking) {
          this.cancelScheduledTasks();
          this.neuterBufferSource(bufferSource);
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
    // Preroll tiled tiles BEFORE arming startTime so bake time does not
    // eat into the lookAhead window (late chunk/note starts at song head).
    this.prerollUntilSongTime = 0;
    this.prerollUntilPeak = 0;
    if (isTiledCacheMode(this.cacheMode)) {
      await this.prerollTiledPipeline();
    } else {
      this.initTiledPipeline();
    }
    // Arm playback clock only after head tiles are ready (or preroll skipped).
    this.startTime = audioContext.currentTime;
    if (isTiledCacheMode(this.cacheMode)) {
      this.startReadyTiledSources();
    }
    if (paused) {
      this.dispatchEvent(new Event("resumed"));
    } else {
      this.dispatchEvent(new Event("started"));
    }
    let queueIndex = this.getQueueIndex(this.resumeTime);
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
            this.resumeTime = 0;
            queueIndex = 0;
            this.prerollUntilSongTime = 0;
            this.resetTiledPipeline();
            if (isTiledCacheMode(this.cacheMode)) {
              await this.prerollTiledPipeline();
            }
            this.startTime = audioContext.currentTime;
            if (isTiledCacheMode(this.cacheMode)) {
              this.startReadyTiledSources();
            }
            this.dispatchEvent(new Event("looped"));
            continue;
          } else {
            await this.drainTiledPipeline();
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
        this.stopTiledSources();
        await this.stopNotes(now);
        // await this.suspendAudioContext();
        this.isPausing = false;
        exitReason = "paused";
        break;
      } else if (this.isStopping) {
        this.cancelScheduledTasks();
        this.stopTiledSources();
        await this.stopNotes(now);
        await this.suspendAudioContext();
        this.isStopping = false;
        exitReason = "stopped";
        break;
      } else if (this.isSeeking) {
        this.cancelScheduledTasks();
        await this.stopNotes(now);
        this.stopTiledSources();
        this.prerollUntilSongTime = 0;
        const nextQueueIndex = this.getQueueIndex(this.resumeTime);
        this.updateStates(queueIndex, nextQueueIndex);
        queueIndex = nextQueueIndex;
        if (isTiledCacheMode(this.cacheMode)) {
          await this.prerollTiledPipeline();
        } else {
          this.initTiledPipeline();
        }
        this.startTime = audioContext.currentTime;
        if (isTiledCacheMode(this.cacheMode)) {
          this.startReadyTiledSources();
        }
        this.isSeeking = false;
        this.dispatchEvent(new Event("seeked"));
        continue;
      }
      queueIndex = this.scheduleTimelineEvents(now, queueIndex);
      if (isTiledCacheMode(this.cacheMode)) {
        const timeOffset = this.resumeTime - this.startTime;
        this.updateTiledPipeline(
          now + timeOffset + this.lookAhead + this.maxTiledNoteDuration,
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
    // Hit/miss rates for this play (including prewarm). Counters survive
    // end-of-song map clears so the post-play log remains meaningful.
    this.resetNoteCacheHitStats();
    // Chunk/segment/note/audio: fill multi-use simple buffers before the
    // realtime pipeline so early tiles are mostly BufferSource hits instead
    // of blocking per-note OACs (or a heavy all-direct mix graph).
    if (preload && usesSimpleComplexNoteCache(this.cacheMode)) {
      await this.prewarmSimpleNoteCache();
    }
    this.playPromise = this.playNotes();
    await this.playPromise;
    // Post-playback cache / complex-breakdown stats.
    try {
      const cx = this.countComplexBreakdown();
      const cxPct = (n: number) =>
        cx.complex > 0 ? ((100 * n) / cx.complex).toFixed(1) : "0.0";
      const sHit = this.simpleNoteCacheHits;
      const sMiss = this.simpleNoteCacheMisses;
      const sTotal = sHit + sMiss;
      const sRate = sTotal > 0 ? ((100 * sHit) / sTotal).toFixed(1) : "n/a";
      const cHit = this.complexNoteCacheHits;
      const cMiss = this.complexNoteCacheMisses;
      const cUnique = this.complexNoteCacheUniqueBakes;
      const cEligible = cHit + cMiss;
      const cRate = cEligible > 0
        ? ((100 * cHit) / cEligible).toFixed(1)
        : "n/a";
      // hit = served from Map (buffer or in-flight Promise).
      // miss = first bake for that key. unique = complex count<=1 (never cached).
      // prewarmMiss = misses that occurred inside prewarmSimpleNoteCache.
      // rate = hit/(hit+miss); unique excluded from complex rate denominator.
      console.log(
        `[midy] note-cache | simple: hit=${sHit} miss=${sMiss} ` +
          `rate=${sRate}% peak=${this.simpleNoteCachePeakSize} ` +
          `prewarmMiss=${this.simpleNoteCachePrewarmMisses} | ` +
          `complex: hit=${cHit} miss=${cMiss} unique=${cUnique} ` +
          `rate=${cRate}% peak=${this.complexNoteCachePeakSize}`,
      );
      // Multi-label (with*) can sum > complex. Exclusive buckets sum to complex.
      console.log(
        `[midy] complex breakdown | total=${cx.complex} | ` +
          `with: bend=${cx.withPitchBend}(${cxPct(cx.withPitchBend)}%) ` +
          `pan=${cx.withPan}(${cxPct(cx.withPan)}%) ` +
          `mod=${cx.withMod}(${cxPct(cx.withMod)}%) ` +
          `gain=${cx.withGain}(${cxPct(cx.withGain)}%) ` +
          `otherCc=${cx.withOtherCc}(${cxPct(cx.withOtherCc)}%) ` +
          `sysEx=${cx.withSysEx}(${cxPct(cx.withSysEx)}%) ` +
          `pc=${cx.withProgramChange}(${cxPct(cx.withProgramChange)}%) | ` +
          `exclusive: onlyBend=${cx.onlyPitchBend}(${
            cxPct(cx.onlyPitchBend)
          }%) ` +
          `bend+gain=${cx.bendGain}(${cxPct(cx.bendGain)}%) ` +
          `onlyPan=${cx.onlyPan}(${cxPct(cx.onlyPan)}%) ` +
          `pan+gain=${cx.panGain}(${cxPct(cx.panGain)}%) ` +
          `onlyMod=${cx.onlyMod}(${cxPct(cx.onlyMod)}%) ` +
          `onlyOtherCc=${cx.onlyOtherCc}(${cxPct(cx.onlyOtherCc)}%) ` +
          `onlySysEx=${cx.onlySysEx}(${cxPct(cx.onlySysEx)}%) ` +
          `mixed=${cx.mixed}(${cxPct(cx.mixed)}%)`,
      );
      // Chunk pipeline stability (realtime only; excludes renderFastMode).
      const cb = this.chunkBakeCount;
      const bakeAvg = cb > 0 ? this.chunkBakeSumMs / cb : 0;
      const bakeP50 = this.chunkBakePercentile(50);
      const bakeP95 = this.chunkBakePercentile(95);
      const lateN = this.chunkLateStarts;
      const lateAvg = lateN > 0 ? this.chunkLateSumMs / lateN : 0;
      const purePct = cb > 0
        ? ((100 * this.chunkPureTaTiles) / cb).toFixed(1)
        : "0.0";
      const poolSize = this.bakeWorkerPool
        ? this.bakeWorkerPool.poolSize
        : (this.workerPoolSize > 0 ? this.workerPoolSize : Math.max(
          1,
          Math.min(
            4,
            typeof navigator !== "undefined"
              ? (navigator.hardwareConcurrency || 2)
              : 2,
          ),
        ));
      console.log(
        `[midy] worker | tileMix=${this.useWorkerTypedArrayMix} ` +
          `noteBake=${this.useWorkerSimpleNoteBake} ` +
          `(noteBake active only for note/ads/adsr; tiled uses tileMix) ` +
          `transferable=${this.useWorkerTransferable} ` +
          `poolSize=${poolSize} ` +
          `mixMinEntries=${this.workerMixMinEntries} ` +
          `poolStarted=${!!this.bakeWorkerPool}`,
      );
      const simpleAvg = cb > 0 ? this.chunkBakeSimpleSumMs / cb : 0;
      const complexAvg = cb > 0 ? this.chunkBakeComplexSumMs / cb : 0;
      const mixAvg = cb > 0 ? this.chunkBakeMixSumMs / cb : 0;
      const oacAvg = cb > 0 ? this.chunkBakeOacSumMs / cb : 0;
      console.log(
        `[midy] chunk-pipeline | tiles=${cb} ` +
          `bakeAvg=${bakeAvg.toFixed(1)}ms bakeP50=${bakeP50.toFixed(1)}ms ` +
          `bakeP95=${bakeP95.toFixed(1)}ms bakeMax=${
            this.chunkBakeMaxMs.toFixed(1)
          }ms | ` +
          `pureTA=${this.chunkPureTaTiles}(${purePct}%) oac=${this.chunkOacTiles} | ` +
          `starts=${this.chunkStarts} late=${lateN} ` +
          `lateAvg=${lateAvg.toFixed(1)}ms lateMax=${
            this.chunkLateMaxMs.toFixed(1)
          }ms ` +
          `dropped=${this.chunkDroppedLate} | ` +
          `prerollUntil=${this.prerollUntilSongTime.toFixed(2)}s ` +
          `prerollPeak=${this.prerollUntilPeak.toFixed(2)}s ` +
          `prerollSec=${this.prerollSec}`,
      );
      const notesAvg = cb > 0 ? this.chunkBakeNoteCountSum / cb : 0;
      const complexNotesAvg = cb > 0 ? this.chunkBakeComplexCountSum / cb : 0;
      const sumDurAvg = cb > 0 ? this.chunkBakeSumNoteDuration / cb : 0;
      const costAvg = cb > 0 ? this.chunkBakeSumCost / cb : 0;
      console.log(
        `[midy] chunk-bake-parts | ` +
          `simpleAvg=${simpleAvg.toFixed(1)}ms ` +
          `complexAvg=${complexAvg.toFixed(1)}ms ` +
          `mixAvg=${mixAvg.toFixed(1)}ms ` +
          `oacAvg=${oacAvg.toFixed(1)}ms ` +
          `| simpleSum=${this.chunkBakeSimpleSumMs.toFixed(0)}ms ` +
          `complexSum=${this.chunkBakeComplexSumMs.toFixed(0)}ms ` +
          `mixSum=${this.chunkBakeMixSumMs.toFixed(0)}ms ` +
          `oacSum=${this.chunkBakeOacSumMs.toFixed(0)}ms`,
      );
      console.log(
        `[midy] chunk-tile-shape | ` +
          `notesAvg=${notesAvg.toFixed(1)} ` +
          `complexNotesAvg=${complexNotesAvg.toFixed(1)} ` +
          `sumDurAvg=${sumDurAvg.toFixed(3)}s ` +
          `costAvg=${costAvg.toFixed(3)} ` +
          `budget=${this.chunkCostBudget} ` +
          `complexWeight=${this.chunkComplexCostWeight} ` +
          `tileDuration=${this.tileDuration} ` +
          `maxChunkBakes=${this.maxConcurrentChunkBakes} ` +
          `maxChunkNotes=${this.maxChunkNotes}`,
      );
    } catch (e) {
      console.warn("[midy] stats log failed", e);
    }
  }

  // Bake simple-note cache keys before playNotes, prioritizing the song head.
  // Phase 1 fills keys whose earliest onset is inside prewarmSimpleHeadSec
  // (including one-shots when headMinCount=1). Phase 2 spends any remaining
  // wall budget on later multi-use keys. Logging is intentional for bake
  // diagnosis (share console output when tuning budgets).
  async prewarmSimpleNoteCache(): Promise<void> {
    if (!this.simpleNoteCache) return;
    if (this.simpleNoteCounts.size === 0) return;
    const cacheMode = this.cacheMode;
    if (!usesSimpleComplexNoteCache(cacheMode)) return;

    this.noteCacheStatsInPrewarm = true;
    try {
      await this.prewarmSimpleNoteCacheBody();
    } finally {
      this.noteCacheStatsInPrewarm = false;
    }
  }

  private async prewarmSimpleNoteCacheBody(): Promise<void> {
    const cacheMode = this.cacheMode;
    const restMinCount = Math.max(1, this.prewarmSimpleMinCount | 0);
    const headMinCount = Math.max(1, this.prewarmSimpleHeadMinCount | 0);
    const maxMs = Math.max(0, this.prewarmSimpleMaxMs | 0);
    const headSec = this.prewarmSimpleHeadSec > 0
      ? this.prewarmSimpleHeadSec
      : Math.max(0.001, this.lookAhead + this.maxTiledNoteDuration);

    const bakeChannelMix = bakeChannelMixForMode(cacheMode);
    const settings = (this.constructor as typeof Player).channelSettings;
    const numChannels = this.numChannels;
    const channels = new Array<TChannel>(numChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      const channel = this.createChannelInstance(ch, settings);
      channel.player = this;
      channels[ch] = channel;
    }
    if (channels[9]) channels[9].isDrum = true;

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const needsSegmentVoice = isTiledCacheMode(cacheMode);
    const simpleNoteSet = this.simpleNoteSet;
    const noteOnEvents = this.noteOnEvents;
    const tiledVoiceParams = this.tiledVoiceParams;
    const tiledVoices = this.tiledVoices;
    const noteAudioBufferIds = this.noteAudioBufferIds;
    const simpleNoteCounts = this.simpleNoteCounts;

    type Cand = {
      key: string;
      entry: BakeNoteEntry;
      count: number;
      earliest: number;
    };
    // All simple keys seen while walking; earliest onset tracked.
    const allKeys = new Map<string, Cand>();

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const offset = event.startTime * inverseTempo;
      this.processTimelineEvent(event, offset, {
        channels,
        onNoteOn: (renderChannel: TChannel, noteEvent: TimelineEvent) => {
          if (!simpleNoteSet.has(i)) return;
          const noteOnEvent = noteOnEvents[i];
          if (!noteOnEvent || noteOnEvent.duration <= 0) return;

          let voiceParams: VoiceParams | null = null;
          let voice: Voice | null | undefined = null;
          if (needsSegmentVoice) {
            voiceParams = tiledVoiceParams[i];
            voice = tiledVoices[i];
          }
          if (!voiceParams) {
            voice = this.resolveVoice(
              renderChannel,
              noteEvent.noteNumber!,
              noteEvent.velocity!,
            );
            if (!voice) return;
            voiceParams = getVoiceParams(
              voice,
              this.getControllerState(
                renderChannel,
                noteEvent.noteNumber!,
                noteEvent.velocity!,
                0,
              ),
            );
          }
          if (!voiceParams) return;

          const entry: BakeNoteEntry = {
            channelNumber: renderChannel.channelNumber,
            audioBufferId: noteAudioBufferIds[i],
            noteNumber: noteEvent.noteNumber!,
            velocity: noteEvent.velocity!,
            noteDuration: noteOnEvent.duration,
            noteEvent: noteOnEvent,
            channelDetune: renderChannel.detune,
            channelStateArray: renderChannel.state.array.slice(),
            programNumber: renderChannel.programNumber,
            isDrum: renderChannel.isDrum,
            voiceParams,
            voice: voice ?? undefined,
          };
          const key = this.makeSimpleNoteKey(entry, bakeChannelMix);
          const count = simpleNoteCounts.get(key) ?? 0;
          const prev = allKeys.get(key);
          if (prev) {
            if (offset < prev.earliest) {
              prev.earliest = offset;
              // Prefer the earliest-onset snapshot for the bake entry.
              prev.entry = entry;
            }
            return;
          }
          allKeys.set(key, { key, entry, count, earliest: offset });
        },
      });
    }

    if (allKeys.size === 0) return;

    const head: Cand[] = [];
    const rest: Cand[] = [];
    {
      const values = Array.from(allKeys.values());
      for (let i = 0; i < values.length; i++) {
        const c = values[i];
        if (c.earliest < headSec && c.count >= headMinCount) {
          head.push(c);
        } else if (c.count >= restMinCount) {
          // Post-head multi-use, or head keys that failed headMinCount
          // (shouldn't happen when headMinCount <= restMinCount).
          if (c.earliest >= headSec) rest.push(c);
        }
      }
    }

    const byEarliestThenCount = (a: Cand, b: Cand): number => {
      if (a.earliest !== b.earliest) return a.earliest - b.earliest;
      return b.count - a.count;
    };
    head.sort(byEarliestThenCount);
    rest.sort(byEarliestThenCount);

    const t0 = performance.now();
    let stoppedEarly = false;

    const bakeList = async (list: Cand[]): Promise<void> => {
      for (let i = 0; i < list.length; i++) {
        if (maxMs > 0 && performance.now() - t0 >= maxMs) {
          stoppedEarly = true;
          break;
        }
        try {
          await this.getSimpleNoteBuffer(list[i].entry, bakeChannelMix);
        } catch {
          // Skip failed keys; playback will bake on demand.
        }
      }
    };

    await bakeList(head);
    if (!stoppedEarly && rest.length > 0) {
      await bakeList(rest);
    }
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
      this.stopTiledSources();
      if (this.audioModeBufferSource) {
        this.neuterBufferSource(this.audioModeBufferSource);
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
      needsNoteOnDurations(cacheMode)
    ) {
      this.buildNoteOnDurations();
      this.adsrVoiceCache.clear();
    }
    if (isTiledCacheMode(cacheMode)) {
      this.finalizeSegmentClassification();
    }
    if (
      usesSimpleComplexNoteCache(cacheMode)
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

  // Bake tiled tiles covering [resumeTime, resumeTime + prerollSec] before the
  // playback clock is armed. Uses a shadow channel walk so this.channels is
  // left untouched for the live scheduleTimelineEvents pass.
  // Pending buffers stay in chunkState / segmentChannelStates; sources are
  // started later via startReadyTiledSources() once startTime is set.
  async prerollTiledPipeline(): Promise<void> {
    const cacheMode = this.cacheMode;
    if (!isTiledCacheMode(cacheMode)) {
      this.initTiledPipeline();
      return;
    }
    const prerollSec = Math.max(0, this.prerollSec);
    this.initTiledPipeline();
    if (prerollSec <= 0) {
      this.prerollUntilSongTime = 0;
      return;
    }

    // Ensure tiled note classification exists (needed for append gating).
    if (this.tiledBakedSet.size === 0 && isTiledCacheMode(cacheMode)) {
      this.finalizeSegmentClassification();
    }

    const t0 = performance.now();
    const maxMs = Math.max(0, this.prerollMaxMs | 0);
    const songStart = this.resumeTime;
    // totalTime can be 0 if calcTotalTime saw no noteOffs yet; fall back to
    // last timeline event so preroll still covers the head window.
    let total = this.totalTime;
    if (!(total > 0) && this.timeline.length > 0) {
      const inv = 1 / this.tempo;
      total = this.timeline[this.timeline.length - 1].startTime * inv;
    }
    const songEnd = Math.min(
      total > 0 ? total : songStart + prerollSec,
      songStart + prerollSec,
    );
    if (songEnd <= songStart) {
      this.prerollUntilSongTime = songStart;
      console.warn(
        `[midy] preroll skipped: songEnd(${songEnd.toFixed(3)}) <= songStart(${
          songStart.toFixed(3)
        }) ` +
          `totalTime=${this.totalTime} timeline=${this.timeline.length} prerollSec=${prerollSec}`,
      );
      return;
    }
    console.log(
      `[midy] preroll start | mode=${cacheMode} window=[${
        songStart.toFixed(2)
      }, ${songEnd.toFixed(2)}] ` +
        `tiledNotes=${this.tiledBakedSet.size} maxChunkBakes=${this.maxConcurrentChunkBakes}`,
    );

    const isSegmentMode = isSegmentCacheMode(cacheMode);
    const isChunkMode = isChunkCacheMode(cacheMode);
    // Walk this.channels so appendToSegmentQueue snapshots match (it reads
    // this.channels by channelNumber). Controller events set absolute values,
    // so the later live scheduleTimelineEvents re-walk from resumeTime is safe.
    // Do NOT call channel.noteOn here — only queue tiled notes for offline bake.

    const timeline = this.timeline;
    const inverseTempo = 1 / this.tempo;
    const tiledBakedSet = this.tiledBakedSet;
    let queueIndex = this.getQueueIndex(songStart);
    let stoppedEarly = false;

    while (queueIndex < timeline.length) {
      if (maxMs > 0 && performance.now() - t0 >= maxMs) {
        stoppedEarly = true;
        break;
      }
      const event = timeline[queueIndex];
      const t = event.startTime * inverseTempo;
      if (t >= songEnd) break;

      this.processTimelineEvent(event, t, {
        onNoteOn: (channel: TChannel, noteEvent: TimelineEvent) => {
          const isSegmentNote = isSegmentMode &&
            tiledBakedSet.has(queueIndex);
          const isChunkNote = isChunkMode &&
            tiledBakedSet.has(queueIndex);
          if (!isSegmentNote && !isChunkNote) return;
          if (isSegmentNote) {
            this.appendToSegmentQueue(
              channel.channelNumber,
              t,
              queueIndex,
              noteEvent.noteNumber!,
              noteEvent.velocity!,
            );
          }
          if (isChunkNote) {
            this.appendToChunkQueue(
              channel,
              t,
              queueIndex,
              noteEvent.noteNumber!,
              noteEvent.velocity!,
            );
          }
        },
      });
      queueIndex++;
    }

    // Close any open tile still collecting notes inside the preroll window.
    if (isChunkMode && this.chunkState.openChunk) {
      this.closeChunk(this.chunkState);
    }
    if (isSegmentMode) {
      const states = this.segmentChannelStates;
      const liveChannels = this.channels;
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (state?.openSegment) {
          this.closeSegment(state, liveChannels[ch]);
        }
      }
    }

    // Await every in-flight offline bake before arming the clock.
    const bufferPromises: Promise<AudioBuffer | null>[] = [];
    if (isChunkMode) {
      const pending = this.chunkState.pending;
      for (let i = 0; i < pending.length; i++) {
        bufferPromises.push(pending[i].bufferPromise);
      }
    }
    if (isSegmentMode) {
      const states = this.segmentChannelStates;
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (!state) continue;
        const pending = state.pending;
        for (let i = 0; i < pending.length; i++) {
          bufferPromises.push(pending[i].bufferPromise);
        }
      }
    }
    if (bufferPromises.length > 0) {
      await Promise.allSettled(bufferPromises);
    }

    // Mark song time covered so live scheduling does not re-append these notes.
    // If we stopped early on wall budget, only claim time up to the last event
    // we actually walked (queueIndex points at the first unprocessed event).
    let coveredEnd = songEnd;
    if (stoppedEarly && queueIndex > 0 && queueIndex <= timeline.length) {
      const lastIdx = Math.min(queueIndex, timeline.length) - 1;
      if (lastIdx >= 0) {
        const lastT = timeline[lastIdx].startTime * inverseTempo;
        // Include the tile that may still be open beyond last note onset:
        // we already closed open tiles, so coveredEnd is last onset + epsilon.
        coveredEnd = Math.min(songEnd, lastT + 1e-6);
      }
    }
    this.prerollUntilSongTime = coveredEnd;
    if (coveredEnd > this.prerollUntilPeak) {
      this.prerollUntilPeak = coveredEnd;
    }
    const pendingCount = isChunkMode ? this.chunkState.pending.length : 0;
    console.log(
      `[midy] preroll done | coveredEnd=${coveredEnd.toFixed(2)}s ` +
        `wall=${(performance.now() - t0).toFixed(0)}ms ` +
        `pendingTiles=${pendingCount} stoppedEarly=${stoppedEarly}`,
    );
  }

  // Start preroll-baked tiles now that startTime is set.
  startReadyTiledSources(): void {
    if (this.cacheMode === "chunk") {
      const pending = this.chunkState.pending;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        if (!p.source && p.bufferReady) {
          this.startPendingChunk(p);
        }
      }
    } else if (this.cacheMode === "segment") {
      const states = this.segmentChannelStates;
      const channels = this.channels;
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (!state) continue;
        const pending = state.pending;
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i];
          if (!p.source && p.bufferReady) {
            this.startPendingSegment(channels[ch], p);
          }
        }
      }
    }
  }

  initSegmentPipeline(): void {
    const numChannels = this.numChannels;
    const states = new Array<SegmentChannelState>(numChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      states[ch] = { openSegment: null, pending: [] };
    }
    this.segmentChannelStates = states;
  }

  // No-op unless cacheMode is segment/chunk.
  initTiledPipeline(): void {
    if (this.cacheMode === "segment") this.initSegmentPipeline();
    else if (this.cacheMode === "chunk") this.initChunkPipeline();
  }

  // Stop sources + invalidate in-flight offline renders (segment/chunk).
  stopTiledSources(): void {
    if (this.cacheMode === "segment") this.stopSegmentSources();
    else if (this.cacheMode === "chunk") this.stopChunkSources();
  }

  // Close open tiles, await pending bakes, start any ready sources.
  async drainTiledPipeline(): Promise<void> {
    if (this.cacheMode === "segment") await this.drainSegmentPipeline();
    else if (this.cacheMode === "chunk") await this.drainChunkPipeline();
  }

  // Loop boundary: bump generation and open a fresh empty pipeline.
  resetTiledPipeline(): void {
    if (this.cacheMode === "segment") {
      this.segmentGeneration++;
      this.initSegmentPipeline();
    } else if (this.cacheMode === "chunk") {
      this.chunkGeneration++;
      this.initChunkPipeline();
    }
  }

  // Advance open tiles / start ready sources for the current tiled mode.
  updateTiledPipeline(lookAheadCheckTime: number): void {
    if (this.cacheMode === "segment") {
      this.updateSegmentPipeline(lookAheadCheckTime);
    } else if (this.cacheMode === "chunk") {
      this.updateChunkPipeline(lookAheadCheckTime);
    }
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
    // finally finish, and -- since startRendering() is serialized by the
    // browser -- can delay the fresh segments that should render next,
    // pushing them past lookAhead too.
    // Also neuter sources + drop buffer refs so iOS can reclaim PCM.
    this.segmentGeneration++;
    const states = this.segmentChannelStates;
    for (let ch = 0; ch < states.length; ch++) {
      const state = states[ch];
      if (!state) continue;
      const pending = state.pending;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        this.neuterBufferSource(p.source);
        p.source = null;
        p.buffer = null;
        p.bufferReady = true;
        p.done = true;
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
    const voiceParams = this.tiledVoiceParams[timelineIndex];
    if (!voiceParams) return;
    const channel = this.channels[channelNumber];
    if (
      state.openSegment &&
      this.tileDuration <= t - state.openSegment.segmentStart
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
      voice: this.tiledVoices[timelineIndex] ?? undefined,
      // Per-note onset snapshot -- simple-note bakes need the detune/state
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
          pending.buffer = null;
          pending.done = true;
          return null;
        }
        pending.buffer = buffer;
        pending.bufferReady = true;
        return buffer;
      })
      .catch((err) => {
        console.warn("segment render failed", err);
        pending.buffer = null;
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
    const now = this.audioContext.currentTime;
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
      this.neuterBufferSource(source);
      // Drop the tile buffer once the source has finished so repeated
      // loadMIDI/play cycles do not keep every past tile alive via pending.
      pending.buffer = null;
      pending.source = null;
    };
    // If the offline bake finished late, start at `now` with a buffer
    // offset so remaining notes stay time-aligned with the rest of the
    // song. Starting at a past `when` (or at 0) would replay the whole
    // segment late and drop / smear dense runs (e.g. glissandi).
    if (nominalStart <= now) {
      const offsetSec = now - nominalStart;
      if (offsetSec >= pending.buffer.duration) {
        pending.done = true;
        this.neuterBufferSource(source);
        pending.buffer = null;
        pending.source = null;
        return;
      }
      source.start(now, offsetSec);
    } else {
      source.start(nominalStart);
    }
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
        state.openSegment.segmentStart + this.tileDuration <=
          lookAheadCheckTime
      ) {
        this.closeSegment(state, channels[ch]);
      }
      const pending = state.pending;
      let write = 0;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        if (p.done) {
          // Finished tiles: drop buffer so repeated play cycles don't retain
          // every past segment AudioBuffer until the next loadMIDI.
          this.neuterBufferSource(p.source);
          p.source = null;
          p.buffer = null;
          continue;
        }
        pending[write++] = p;
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
    // stopSegmentSources -- stale renders must not be scheduled after a
    // seek/stop/loop). Also neuter sources + drop buffer refs for iOS.
    this.chunkGeneration++;
    const state = this.chunkState;
    const pending = state.pending;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      this.neuterBufferSource(p.source);
      p.source = null;
      p.buffer = null;
      p.bufferReady = true;
      p.done = true;
    }
    state.pending = [];
    state.openChunk = null;
  }

  /** Estimate bake cost for one note (seconds of note body + release tail). */
  private estimateChunkNoteCost(
    noteDuration: number,
    voiceParams: VoiceParams,
    noteEvent: NoteOnEventEntry | undefined,
    isComplex: boolean,
  ): number {
    const releaseTail = noteEvent?.soundOff
      ? 0
      : voiceParams.releaseVolEnv * envelopeCurve * 5;
    const base = noteDuration + releaseTail;
    return isComplex ? base * this.chunkComplexCostWeight : base;
  }

  appendToChunkQueue(
    channel: TChannel,
    t: number,
    timelineIndex: number,
    noteNumber: number,
    velocity: number,
  ): void {
    const state = this.chunkState;
    const voiceParams = this.tiledVoiceParams[timelineIndex];
    if (!voiceParams) return;

    const noteDuration = this.noteOnDurations[timelineIndex] ?? 0;
    const noteEvent = this.noteOnEvents[timelineIndex];
    const isComplex = !this.isSimpleNote({
      timelineIndex,
      noteEvent,
    });
    const noteCost = this.estimateChunkNoteCost(
      noteDuration,
      voiceParams,
      noteEvent,
      isComplex,
    );

    // Close by wall-time upper bound first (max tileDuration).
    if (
      state.openChunk &&
      this.tileDuration <= t - state.openChunk.chunkStart
    ) {
      this.closeChunk(state);
    }
    // Split at onset-group boundaries only (never mid-chord).
    // Same song-time onsets always stay together even if over budget / max notes.
    // Triggers: cost budget, or maxChunkNotes soft cap.
    const budget = this.chunkCostBudget;
    const maxNotes = this.maxChunkNotes | 0;
    if (
      state.openChunk &&
      state.openChunk.notes.length > 0 &&
      t > state.openChunk.lastOnsetTime
    ) {
      const overCost = budget > 0 &&
        state.openChunk.cost + noteCost > budget;
      const overNotes = maxNotes > 0 &&
        state.openChunk.notes.length >= maxNotes;
      if (overCost || overNotes) {
        this.closeChunk(state);
      }
    }
    if (!state.openChunk) {
      state.openChunk = {
        chunkStart: t,
        notes: [],
        cost: 0,
        complexCount: 0,
        sumNoteDuration: 0,
        lastOnsetTime: t,
      };
    }
    state.openChunk.notes.push({
      channelNumber: channel.channelNumber,
      offset: t - state.openChunk.chunkStart,
      noteNumber,
      velocity,
      voiceParams,
      noteDuration,
      noteEvent,
      audioBufferId: this.noteAudioBufferIds[timelineIndex],
      voice: this.tiledVoices[timelineIndex] ?? undefined,
      // Snapshot per-channel state now -- channel volume/pan/expression
      // are baked into the buffer so they must be captured at note-append
      // time before subsequent events on the same channel change them.
      channelDetune: channel.detune,
      channelStateArray: channel.state.array.slice(),
      programNumber: channel.programNumber,
      isDrum: channel.isDrum,
      timelineIndex,
    });
    state.openChunk.cost += noteCost;
    state.openChunk.sumNoteDuration += noteDuration;
    state.openChunk.lastOnsetTime = t;
    if (isComplex) state.openChunk.complexCount++;
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
    pending.bufferPromise = this.runWithChunkBakeGate(() =>
      this.renderChunkBuffer(chunk)
    )
      .then((buffer) => {
        if (this.chunkGeneration !== generation) {
          const idx = state.pending.indexOf(pending);
          if (idx !== -1) state.pending.splice(idx, 1);
          pending.buffer = null;
          pending.done = true;
          return null;
        }
        pending.buffer = buffer;
        pending.bufferReady = true;
        return buffer;
      })
      .catch((err) => {
        console.warn("chunk render failed", err);
        pending.buffer = null;
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
    const now = this.audioContext.currentTime;
    this.warnIfStartTimeMissed("chunk", nominalStart);
    this.chunkStarts++;
    if (nominalStart <= now) {
      const lateMs = (now - nominalStart) * 1000;
      this.chunkLateStarts++;
      this.chunkLateSumMs += lateMs;
      if (lateMs > this.chunkLateMaxMs) this.chunkLateMaxMs = lateMs;
    }
    const source = new AudioBufferSourceNode(this.audioContext, {
      buffer: pending.buffer,
    });
    // chunk buffers are stereo and already include channel volume/pan,
    // so connect directly to masterVolume (bypassing per-channel gainL/R).
    source.connect(this.masterVolume);
    source.onended = () => {
      pending.done = true;
      this.neuterBufferSource(source);
      pending.buffer = null;
      pending.source = null;
    };
    // Same late-start handling as startPendingSegment: offset into the
    // buffer when the offline bake finishes after the scheduled time.
    if (nominalStart <= now) {
      const offsetSec = now - nominalStart;
      if (offsetSec >= pending.buffer.duration) {
        this.chunkDroppedLate++;
        pending.done = true;
        this.neuterBufferSource(source);
        pending.buffer = null;
        pending.source = null;
        return;
      }
      source.start(now, offsetSec);
    } else {
      source.start(nominalStart);
    }
    pending.source = source;
  }

  updateChunkPipeline(lookAheadCheckTime: number): void {
    const state = this.chunkState;
    if (
      state.openChunk &&
      state.openChunk.chunkStart + this.tileDuration <= lookAheadCheckTime
    ) {
      this.closeChunk(state);
    }
    const pending = state.pending;
    let write = 0;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (p.done) {
        this.neuterBufferSource(p.source);
        p.source = null;
        p.buffer = null;
        continue;
      }
      pending[write++] = p;
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
  // snapshot taken at append (or offline walk) time -- same as segment.
  //
  // Simple-note optimization: cache hits are placed as BufferSources; cache
  // misses are scheduled directly into this offline context (no per-note
  // OfflineAudioContext / startRendering). Complex notes share one mix OAC
  // and are grouped by MIDI channel (see scheduleComplexNotesDirect).
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
      const releaseEnd = n.noteEvent?.soundOff
        ? 0
        : n.voiceParams.releaseVolEnv * envelopeCurve * 5;
      const end = n.offset + n.noteDuration + releaseEnd;
      if (end > totalDuration) totalDuration = end;
    }
    if (totalDuration <= 0) return null;

    // Over-allocate then trim -- avoids a second isSimpleNote pass.
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

    // Realtime A/B: wall time + pure-TA vs tile-level OAC path.
    // forAudioOffline (renderFastMode windows) is excluded so song-export
    // does not pollute playback stability numbers.
    const trackStats = !forAudioOffline;
    const bakeT0 = trackStats ? performance.now() : 0;
    let pureTaPath = false;
    let simpleMs = 0;
    let complexMs = 0;
    let mixMs = 0;
    let oacMs = 0;

    const sampleRate = this.audioContext.sampleRate;
    const bufferLength = Math.ceil(totalDuration * sampleRate);
    const useTA = this.useTypedArraySimpleMix;

    // Collect simple hits for TypedArray mix (or schedule into OAC if !useTA).
    // useTypedArrayChunkSimpleMiss: bake cache misses into buffers (via
    // getSimpleNoteBuffer / TypedArray note bake) and mix with TA, instead of
    // scheduleSimpleNotesDirect on a shared OAC. Pure-simple chunks then skip
    // OfflineAudioContext entirely.
    //
    // Simple/complex resolution runs OUTSIDE the offline gate so pure-TA
    // tiles from different chunks can progress in parallel. Nested OAC work
    // inside getSimpleNoteBuffer / getComplexNoteBuffer still takes its own
    // gate slot (fromOuterSlot=false).
    const simpleHits: { buffer: AudioBuffer; offset: number }[] = [];
    const simpleMisses = new Array<ChunkNoteEntry>(simpleCount);
    let missCount = 0;
    let simpleCacheHits = 0;
    let simpleMissesBaked = 0;
    const simpleCounts = this.simpleNoteCounts;
    const bakeChunkMiss = this.useTypedArrayChunkSimpleMiss;

    const tSimple0 = performance.now();
    if (simpleCount > 0) {
      const simpleResults = await Promise.all(
        simpleNotes.map(async (n) => {
          const cached = await this.lookupSimpleNoteBuffer(n, true);
          if (cached) {
            return {
              kind: "hit" as const,
              buffer: cached,
              offset: n.offset,
              baked: false,
            };
          }
          if (bakeChunkMiss) {
            const noteBuf = await this.getSimpleNoteBuffer(
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
              false, // not holding an outer gate slot
            );
            return {
              kind: "hit" as const,
              buffer: noteBuf,
              offset: n.offset,
              baked: true,
            };
          }
          if (!forAudioOffline) {
            return { kind: "miss" as const, note: n };
          }
          const key = this.makeSimpleNoteKey(n, true);
          const count = simpleCounts.get(key) ?? 0;
          if (count > 1) {
            const noteBuf = await this.getSimpleNoteBuffer(
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
              false,
            );
            return {
              kind: "hit" as const,
              buffer: noteBuf,
              offset: n.offset,
              baked: true,
            };
          }
          return { kind: "miss" as const, note: n };
        }),
      );
      for (let i = 0; i < simpleResults.length; i++) {
        const r = simpleResults[i];
        if (r.kind === "hit") {
          simpleHits.push({ buffer: r.buffer, offset: r.offset });
          if ("baked" in r && r.baked) simpleMissesBaked++;
          else simpleCacheHits++;
        } else {
          simpleMisses[missCount++] = r.note;
        }
      }
      simpleMisses.length = missCount;
    }
    simpleMs = performance.now() - tSimple0;

    // Complex: optional per-note bake → TypedArray mix (segment-style).
    // fromOuterSlot=false so each complex OAC bake contends for the gate
    // independently (maxConcurrentOfflineRenders still limits peak OACs).
    const bakeChunkComplex = this.useTypedArrayChunkComplexBake;
    const complexBufs: { buffer: AudioBuffer; offset: number }[] = [];
    const tComplex0 = performance.now();
    if (bakeChunkComplex && complexCount > 0) {
      const complexResults = await Promise.all(
        complexNotes.map(async (n) => {
          const entry: BakeNoteEntry = {
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
          let buf = await this.lookupComplexNoteBuffer(entry, true);
          if (!buf) {
            buf = await this.getComplexNoteBuffer(entry, true, false);
          }
          return { buffer: buf, offset: n.offset };
        }),
      );
      for (let i = 0; i < complexResults.length; i++) {
        complexBufs.push(complexResults[i]);
      }
    }
    complexMs = performance.now() - tComplex0;

    // With bakeChunkMiss, simple misses are already in simpleHits → missCount
    // stays 0. With bakeChunkComplex, complex notes are in complexBufs.
    // OAC only when mix is legacy, residual simple misses, or legacy complex.
    const needsOAC = !useTA || missCount > 0 ||
      (complexCount > 0 && !bakeChunkComplex);

    // Pure TypedArray path: no Offline gate — multiple tiles can bake in
    // parallel. Worker pool (useWorkerTypedArrayMix) handles the mix.
    if (useTA && !needsOAC) {
      pureTaPath = true;
      const allEntries = simpleHits.length > 0 && complexBufs.length > 0
        ? simpleHits.concat(complexBufs)
        : simpleHits.length > 0
        ? simpleHits
        : complexBufs;
      const tMix0 = performance.now();
      const buffer = await this.mixEntriesToBuffer(
        allEntries,
        2,
        bufferLength,
        sampleRate,
        1,
      );
      mixMs = performance.now() - tMix0;
      if (!forAudioOffline) {
        this.softClampBuffer(buffer);
      }
      if (trackStats) {
        let topNoteDuration = 0;
        let topReleaseTail = 0;
        for (let i = 0; i < notesLen; i++) {
          const n = notes[i];
          const rel = n.noteEvent?.soundOff
            ? 0
            : n.voiceParams.releaseVolEnv * envelopeCurve * 5;
          if (n.noteDuration > topNoteDuration) {
            topNoteDuration = n.noteDuration;
          }
          if (rel > topReleaseTail) topReleaseTail = rel;
        }
        this.recordChunkBake(performance.now() - bakeT0, pureTaPath, {
          simpleMs,
          complexMs,
          mixMs,
          oacMs: 0,
          noteCount: notesLen,
          complexCount,
          sumNoteDuration: chunk.sumNoteDuration,
          cost: chunk.cost,
          chunkStart: chunk.chunkStart,
          bufferDuration: bufferLength / sampleRate,
          simpleHits: simpleCacheHits,
          simpleMissesBaked,
          topNoteDuration,
          topReleaseTail,
        });
      }
      return buffer;
    }

    // OAC path (legacy full mix, or hybrid: complex/misses via OAC + TA hits).
    // Gate serialises large OfflineAudioContext allocations (iOS memory).
    const tOac0 = performance.now();
    const result = await this.runWithOfflineRenderGate(async () => {
      const offlineContext = new OfflineAudioContext(
        2,
        bufferLength,
        sampleRate,
      );

      if (!useTA) {
        // Legacy: schedule all simple hits as BufferSources
        for (let i = 0; i < simpleHits.length; i++) {
          const h = simpleHits[i];
          const src = new AudioBufferSourceNode(offlineContext, {
            buffer: h.buffer,
          });
          src.connect(offlineContext.destination);
          src.start(h.offset);
        }
        // Complex buffers already baked (bakeChunkComplex) → BufferSource
        for (let i = 0; i < complexBufs.length; i++) {
          const h = complexBufs[i];
          const src = new AudioBufferSourceNode(offlineContext, {
            buffer: h.buffer,
          });
          src.connect(offlineContext.destination);
          src.start(h.offset);
        }
      }

      // Residual simple misses → shared offline schedule
      if (missCount > 0) {
        await this.scheduleSimpleNotesDirect(
          offlineContext,
          simpleMisses,
          true,
        );
      }

      // Skipped when bakeChunkComplex already filled complexBufs for TA mix.
      if (!bakeChunkComplex && complexCount > 0) {
        const directComplexNotes: (BakeNoteEntry & { offset: number })[] = [];
        for (let i = 0; i < complexCount; i++) {
          const n = complexNotes[i];
          const entry: BakeNoteEntry = {
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
          const buf = await this.lookupComplexNoteBuffer(entry, true);
          if (!buf) {
            directComplexNotes.push({ ...entry, offset: n.offset });
            continue;
          }
          const src = new AudioBufferSourceNode(offlineContext, {
            buffer: buf,
          });
          src.connect(offlineContext.destination);
          src.start(n.offset);
        }
        if (directComplexNotes.length > 0) {
          await this.scheduleComplexNotesDirect(
            offlineContext,
            directComplexNotes,
            true,
          );
        }
      }

      const rendered = await offlineContext.startRendering();

      const buffer = this.detachAudioBuffer(rendered);

      // Hybrid: add pre-baked simple/complex buffers on top of OAC result
      if (useTA) {
        if (simpleHits.length > 0) {
          this.mixSimpleBuffersTypedArray(buffer, simpleHits, sampleRate, 1);
        }
        if (complexBufs.length > 0) {
          this.mixSimpleBuffersTypedArray(buffer, complexBufs, sampleRate, 1);
        }
      }

      // Realtime chunk: never peak-normalize per window (dense chunks would
      // get quieter than sparse ones). Soft-clamp only samples outside
      // [-1, 1] so relative level stays stable across chunk boundaries.
      if (!forAudioOffline) {
        this.softClampBuffer(buffer);
      }

      return buffer;
    });
    oacMs = performance.now() - tOac0;

    if (trackStats) {
      let topNoteDuration = 0;
      let topReleaseTail = 0;
      for (let i = 0; i < notesLen; i++) {
        const n = notes[i];
        const rel = n.noteEvent?.soundOff
          ? 0
          : n.voiceParams.releaseVolEnv * envelopeCurve * 5;
        if (n.noteDuration > topNoteDuration) topNoteDuration = n.noteDuration;
        if (rel > topReleaseTail) topReleaseTail = rel;
      }
      this.recordChunkBake(performance.now() - bakeT0, pureTaPath, {
        simpleMs,
        complexMs,
        mixMs,
        oacMs,
        noteCount: notesLen,
        complexCount,
        sumNoteDuration: chunk.sumNoteDuration,
        cost: chunk.cost,
        chunkStart: chunk.chunkStart,
        bufferDuration: bufferLength / sampleRate,
        simpleHits: simpleCacheHits,
        simpleMissesBaked,
        topNoteDuration,
        topReleaseTail,
      });
    }
    return result;
  }

  async render(): Promise<AudioBuffer | undefined> {
    if (this.isRendering) return;
    if (this.timeline.length === 0) return;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    this.isRendering = true;
    this.renderedAudioBuffer = null;
    this.dispatchEvent(new Event("rendering"));

    let buffer: AudioBuffer | undefined;
    switch (this.cacheMode) {
      case "note":
      case "segment":
      case "chunk":
      case "adsr":
      case "ads":
      case "none":
        buffer = await this.renderWholeSongLive(this.cacheMode);
        break;
      case "audio":
      default:
        buffer = await this.renderFastMode();
        break;
    }

    this.renderedAudioBuffer = buffer ?? null;
    this.isRendering = false;
    this.dispatchEvent(new Event("rendered"));
    return this.renderedAudioBuffer ?? undefined;
  }

  // Belongs to no cacheMode's real pipeline (see render() doc above).
  // Collect every note into ChunkNoteEntry[], then bake in short time
  // windows via renderChunkBuffer(). A single OfflineAudioContext holding
  // the entire song can produce a buffer where only the opening attack is
  // audible under heavy per-note graphs. Windowed renders keep the node
  // count bounded; windows are mixed into one final AudioBuffer.
  async renderFastMode(): Promise<AudioBuffer | undefined> {
    const settings = (this.constructor as typeof Player).channelSettings;
    const numChannels = this.numChannels;
    const renderChannels = new Array<TChannel>(numChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      const channel = this.createChannelInstance(ch, settings);
      channel.player = this;
      renderChannels[ch] = channel;
    }
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
          const voiceParams = getVoiceParams(
            voice,
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
      return undefined;
    }

    // Window length in seconds (audioWindowDuration). Keep small enough that
    // concurrent notes in one offlineAudioContext stay manageable; large
    // enough to limit the number of startRendering() calls.
    const windowSec = this.audioWindowDuration;
    let maxEnd = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const releaseEnd = n.noteEvent?.soundOff
        ? 0
        : (n.voiceParams.releaseVolEnv ?? 0) * envelopeCurve * 5;
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
        // channelStateArray is a typed array -- copy so mutations in one
        // window can't affect another.
        localNotes[localCount++] = {
          ...n,
          offset: n.offset - winStart,
          channelStateArray: n.channelStateArray.slice(),
        };
      }
      if (localCount === 0) continue;
      localNotes.length = localCount;

      const chunk: OpenChunk = {
        chunkStart: winStart,
        notes: localNotes,
        cost: 0,
        complexCount: 0,
        sumNoteDuration: 0,
        lastOnsetTime: winStart,
      };
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

    return mixed;
  }

  // Drive the real note/segment/chunk/ads/adsr/none scheduling pipelines
  // against one OfflineAudioContext sized for the whole song, so the
  // exported buffer matches what `cacheMode` actually sounds like live.
  //
  // Builds a fresh, non-lightweight Player of the same subclass bound to
  // that OfflineAudioContext, with its own cacheMode set to the requested
  // mode -- note classification (tiledBakedSet / simpleNoteSet /
  // noteOnDurations) depends on cacheMode, so it must be (re)computed for
  // the mode being rendered rather than reused from `this`.
  //
  // Segment/chunk buffers are scheduled via the same appendToSegmentQueue /
  // appendToChunkQueue / closeSegment / closeChunk / startPendingSegment /
  // startPendingChunk used by real playback. note / adsr / ads / none notes
  // go through the same channel.noteOn() -> noteOnChannel() ->
  // setNoteAudioNode() dispatch real playback uses (cacheMode picks the
  // live-graph / cached-buffer / ads(r)-buffer branch there).
  //
  // Deliberately does NOT reuse waitForPendingSources()/drainChunkPipeline():
  // those poll AudioBufferSourceNode.onended, which only fires once
  // offlineContext.startRendering() actually runs -- polling for it before
  // that call would hang. Instead this awaits each pending tile's
  // bufferPromise directly, then starts its source without waiting for it
  // to finish playing.
  private async renderWholeSongLive(
    cacheMode: CacheMode,
  ): Promise<AudioBuffer | undefined> {
    if (this.timeline.length === 0) return undefined;

    // Release tails / segment-chunk lookahead aren't known ahead of the
    // scheduling walk here, so pad generously rather than measuring exactly
    // (renderFastMode's windowed mixer does the tight per-note version).
    const tailMargin = Math.max(0, this.maxTiledNoteDuration) + 10;
    const totalDuration = Math.max(0.001, this.totalTime + tailMargin);
    const sampleRate = this.audioContext.sampleRate;
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    );
    // Match createOfflineRenderPlayer(): OAC.suspend/resume are unused here
    // but some shared code paths call them defensively.
    offlineContext.suspend = () => Promise.resolve();
    offlineContext.resume = () => Promise.resolve();

    const activeChannelNumbers = Array.from(
      { length: this.numChannels },
      (_, i) => i,
    );
    const offlinePlayer = new (this.constructor as new (
      audioContext: AudioContext | OfflineAudioContext,
      options?: {
        activeChannelNumbers?: Iterable<number>;
        offlineRenderOnly?: boolean;
      },
    ) => Player<TNote, TChannel>)(
      offlineContext as unknown as AudioContext,
      { activeChannelNumbers, offlineRenderOnly: false },
    );
    offlinePlayer.soundFonts = this.soundFonts;
    offlinePlayer.soundFontTable = this.soundFontTable;
    offlinePlayer.rawAudioBufferCache = this.rawAudioBufferCache;
    offlinePlayer.instruments = this.instruments;
    offlinePlayer.timeline = this.timeline;
    offlinePlayer.ticksPerBeat = this.ticksPerBeat;
    offlinePlayer.tempo = this.tempo;
    offlinePlayer.totalTime = this.totalTime;
    offlinePlayer.tileDuration = this.tileDuration;
    offlinePlayer.chunkCostBudget = this.chunkCostBudget;
    offlinePlayer.chunkComplexCostWeight = this.chunkComplexCostWeight;
    offlinePlayer.maxConcurrentChunkBakes = this.maxConcurrentChunkBakes;
    offlinePlayer.maxChunkNotes = this.maxChunkNotes;
    offlinePlayer.maxTiledNoteDuration = this.maxTiledNoteDuration;
    offlinePlayer.lookAhead = this.lookAhead;
    offlinePlayer.cacheMode = cacheMode;
    // Absolute time base: no real-time start delay / resume offset.
    offlinePlayer.startTime = 0;
    offlinePlayer.resumeTime = 0;
    offlinePlayer.startDelay = 0;

    // (Re)classify notes for THIS mode -- tiledBakedSet / simpleNoteSet /
    // noteOnDurations all depend on cacheMode, so this cannot be reused
    // from `this.cacheVoiceIds()` unless `this.cacheMode === cacheMode`.
    offlinePlayer.cacheVoiceIds();
    await offlinePlayer.preloadSamples();

    const isSegmentMode = isSegmentCacheMode(cacheMode);
    const isChunkMode = isChunkCacheMode(cacheMode);
    if (isSegmentMode) offlinePlayer.initSegmentPipeline();
    if (isChunkMode) offlinePlayer.initChunkPipeline();

    const timeline = offlinePlayer.timeline;
    const inverseTempo = 1 / offlinePlayer.tempo;
    const channels = offlinePlayer.channels;
    const tiledBakedSet = offlinePlayer.tiledBakedSet;
    const noteOnDurations = offlinePlayer.noteOnDurations;
    const noteAudioBufferIds = offlinePlayer.noteAudioBufferIds;
    const allNotes: TNote[] = [];

    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const t = event.startTime * inverseTempo;
      // Track this iteration's noteOn/noteOff promise so it can be awaited
      // before moving to the next timeline event (see below) -- real-time
      // playback can safely fire-and-forget these because noteOn and its
      // note's later noteOff are naturally seconds apart in wall-clock
      // time, but here the whole timeline is walked in one tight loop, so
      // without awaiting, a note's noteOff can reach noteOnChannel() before
      // its own noteOn's async setNoteAudioNode() has finished. noteOnChannel
      // checks note.ending (set by noteOff) right after that await and, if
      // it's already true, skips setNoteRouting() entirely -- the note gets
      // built but never connected to any output, i.e. silently dropped.
      let pending: Promise<unknown> | undefined;
      offlinePlayer.processTimelineEvent(event, t, {
        channels,
        onNoteOn: (channel, ev) => {
          const note = offlinePlayer.createNoteInstance(
            ev.noteNumber!,
            ev.velocity!,
            t,
          );
          note.timelineIndex = i;
          note.audioBufferId = noteAudioBufferIds[i];
          const isSegmentNote = isSegmentMode && tiledBakedSet.has(i);
          const isChunkNote = isChunkMode && tiledBakedSet.has(i);
          if (isSegmentNote || isChunkNote) {
            note.isTiledGhost = true;
            note.tiledNoteDuration = noteOnDurations[i] ?? 0;
          }
          allNotes.push(note);
          pending = channel.noteOn(ev.noteNumber!, ev.velocity!, t, note);
          if (isSegmentNote) {
            offlinePlayer.appendToSegmentQueue(
              channel.channelNumber,
              t,
              i,
              ev.noteNumber!,
              ev.velocity!,
            );
          }
          if (isChunkNote) {
            offlinePlayer.appendToChunkQueue(
              channel,
              t,
              i,
              ev.noteNumber!,
              ev.velocity!,
            );
          }
        },
        onNoteOff: (channel, ev) => {
          pending = channel.noteOff(ev.noteNumber!, ev.velocity!, t, false);
        },
      });
      if (pending) await pending;
    }

    // Wait for every note's async setup (decode / getAudioBuffer / bake) to
    // finish before rendering, or its bufferSource.start() may not have
    // been called yet.
    await Promise.all(allNotes.map((n) => n.ready));

    if (isSegmentMode) {
      const states = offlinePlayer.segmentChannelStates;
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (state?.openSegment) {
          offlinePlayer.closeSegment(state, channels[ch]);
        }
      }
      const allPending = states.flatMap((s) => s?.pending ?? []);
      await Promise.allSettled(allPending.map((p) => p.bufferPromise));
      for (let ch = 0; ch < states.length; ch++) {
        const state = states[ch];
        if (!state) continue;
        for (let i = 0; i < state.pending.length; i++) {
          const p = state.pending[i];
          if (!p.source && p.bufferReady) {
            offlinePlayer.startPendingSegment(channels[ch], p);
          }
        }
      }
    }
    if (isChunkMode) {
      const state = offlinePlayer.chunkState;
      if (state.openChunk) offlinePlayer.closeChunk(state);
      await Promise.allSettled(state.pending.map((p) => p.bufferPromise));
      for (let i = 0; i < state.pending.length; i++) {
        const p = state.pending[i];
        if (!p.source && p.bufferReady) {
          offlinePlayer.startPendingChunk(p);
        }
      }
    }

    const rendered = await offlineContext.startRendering();
    return this.detachAudioBuffer(rendered);
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

  // Sum pre-baked simple-note buffers into a destination AudioBuffer by
  // direct Float32Array addition (no OfflineAudioContext). Used when
  // useTypedArraySimpleMix is true. gain scales the mix (segment polyphony
  // headroom). mono dest + stereo src takes channel 0 of src.
  protected mixSimpleBuffersTypedArray(
    dest: AudioBuffer,
    entries: { buffer: AudioBuffer; offset: number }[],
    sampleRate: number,
    gain = 1,
  ): void {
    const destChCount = dest.numberOfChannels;
    const destLen = dest.length;
    const destChannels: Float32Array[] = new Array(destChCount);
    for (let c = 0; c < destChCount; c++) {
      destChannels[c] = dest.getChannelData(c);
    }
    const g = gain;
    for (let ei = 0; ei < entries.length; ei++) {
      const { buffer: src, offset } = entries[ei];
      const startSample = Math.round(offset * sampleRate);
      if (startSample >= destLen) continue;
      const srcChCount = src.numberOfChannels;
      const srcLen = src.length;
      const copyLen = Math.min(srcLen, destLen - startSample);
      if (copyLen <= 0) continue;
      if (destChCount === 1) {
        // mono dest: sum L (or mono) of src
        const srcData = src.getChannelData(0);
        const dst = destChannels[0];
        for (let i = 0; i < copyLen; i++) {
          dst[startSample + i] += srcData[i] * g;
        }
      } else {
        // stereo dest
        for (let c = 0; c < destChCount; c++) {
          const srcData = src.getChannelData(Math.min(c, srcChCount - 1));
          const dst = destChannels[c];
          for (let i = 0; i < copyLen; i++) {
            dst[startSample + i] += srcData[i] * g;
          }
        }
      }
    }
  }

  /** Lazy shared / instance worker pool for TypedArray mix. */
  protected getBakeWorkerPool(): BakeWorkerPool {
    if (!this.bakeWorkerPool) {
      this.bakeWorkerPool = getSharedBakeWorkerPool(this.workerPoolSize);
    }
    return this.bakeWorkerPool;
  }

  /**
   * Build an AudioBuffer by mixing pre-baked note buffers (tile-level).
   *
   * Primary worker path for segment / chunk: one job (or a few parallel
   * partial mixes via mixParallel) per tile. Per-note sample bake is not
   * involved here — callers already hold AudioBuffers.
   *
   * Uses a Web Worker pool when useWorkerTypedArrayMix is enabled and the
   * entry count is large enough; otherwise falls back to the main-thread
   * mixSimpleBuffersTypedArray path.
   */
  protected async mixEntriesToBuffer(
    entries: { buffer: AudioBuffer; offset: number }[],
    destChCount: 1 | 2,
    bufferLength: number,
    sampleRate: number,
    gain = 1,
  ): Promise<AudioBuffer> {
    const buffer = this.createEmptyBuffer(
      destChCount,
      bufferLength,
      sampleRate,
    );
    if (entries.length === 0) return buffer;

    const useWorker = this.useWorkerTypedArrayMix &&
      entries.length >= this.workerMixMinEntries &&
      typeof Worker !== "undefined";

    if (!useWorker) {
      this.mixSimpleBuffersTypedArray(buffer, entries, sampleRate, gain);
      return buffer;
    }

    try {
      const transferable = this.useWorkerTransferable;
      const mixEntries: MixSourceEntry[] = new Array(entries.length);
      for (let i = 0; i < entries.length; i++) {
        const { buffer: src, offset } = entries[i];
        const startSample = Math.round(offset * sampleRate);
        const left = src.getChannelData(0);
        const right = src.numberOfChannels > 1
          ? src.getChannelData(1)
          : undefined;
        // Transferable detaches the underlying ArrayBuffer — must slice so
        // live AudioBuffers stay usable. Structured-clone path can pass the
        // channel views directly (clone copies; no need for an extra slice
        // on the main thread before postMessage).
        if (transferable) {
          mixEntries[i] = {
            left: left.slice(),
            right: right ? right.slice() : undefined,
            startSample,
            gain,
          };
        } else {
          mixEntries[i] = {
            left,
            right,
            startSample,
            gain,
          };
        }
      }

      const pool = this.getBakeWorkerPool();
      const result = await pool.mixParallel(
        mixEntries,
        bufferLength,
        destChCount,
        transferable,
      );

      buffer.copyToChannel(result.left, 0);
      if (destChCount > 1 && result.right) {
        buffer.copyToChannel(result.right, 1);
      }
      return buffer;
    } catch (err) {
      // Worker failure → fall back to main-thread mix so playback continues.
      console.warn(
        "[midy] worker mix failed, falling back to main thread",
        err,
      );
      this.mixSimpleBuffersTypedArray(buffer, entries, sampleRate, gain);
      return buffer;
    }
  }

  // Build a per-sample channel gain curve (vol² × expr²) for almost-simple
  // notes. Starts from onset vol/expr, then steps to each in-interval CC7/CC11
  // event. Matches updateChannelVolume's GM/FluidSynth x² convention without
  // perceptual smoothing (offline bake uses instantaneous values, same as the
  // complex OAC path's processTimelineEvent → setVolume/setExpression).
  protected computeGainOnlyChannelCurve(
    noteEvent: NoteOnEventEntry,
    vol0: number,
    expr0: number,
    length: number,
    sampleRate: number,
    tMax: number,
  ): Float32Array {
    const curve = new Float32Array(length);
    type Step = { t: number; vol: number; expr: number };
    const steps: Step[] = [{ t: 0, vol: vol0, expr: expr0 }];
    const events = noteEvent.events;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type !== "controller") continue;
      const ct = event.controllerType ?? -1;
      if (!Player.GAIN_ONLY_CONTROLLER_TYPES.has(ct)) continue;
      let t = this.relativeTimeInNote(event, noteEvent, noteEvent.startTime);
      if (t < -1e-4 || t > tMax) continue;
      if (t < 0) t = 0;
      const prev = steps[steps.length - 1];
      let vol = prev.vol;
      let expr = prev.expr;
      const raw = (event.value ?? 0) / 127;
      if (ct === 7) vol = raw;
      else if (ct === 11) expr = raw;
      steps.push({ t, vol, expr });
    }
    // Sort by time (events should already be chronological, but be safe).
    steps.sort((a, b) => a.t - b.t);
    const invSr = 1 / sampleRate;
    let si = 0;
    let curVol = steps[0].vol;
    let curExpr = steps[0].expr;
    let curGain = curVol * curVol * curExpr * curExpr;
    for (let i = 0; i < length; i++) {
      const t = i * invSr;
      while (si + 1 < steps.length && steps[si + 1].t <= t + 1e-9) {
        si++;
        curVol = steps[si].vol;
        curExpr = steps[si].expr;
        curGain = curVol * curVol * curExpr * curExpr;
      }
      curve[i] = curGain;
    }
    return curve;
  }

  // Build per-sample pan L/R gains for almost-simple pan notes.
  // Starts from onset pan (0..1), then steps to each in-interval CC10 event.
  // Uses the same panToGain mapping as updateChannelVolume / mix bake.
  protected computePanCurve(
    noteEvent: NoteOnEventEntry,
    pan0: number,
    length: number,
    sampleRate: number,
    tMax: number,
  ): { left: Float32Array; right: Float32Array } {
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    type Step = { t: number; pan: number };
    const steps: Step[] = [{ t: 0, pan: pan0 }];
    const events = noteEvent.events;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type !== "controller") continue;
      const ct = event.controllerType ?? -1;
      if (ct !== Player.PAN_CONTROLLER_TYPE) continue;
      let t = this.relativeTimeInNote(event, noteEvent, noteEvent.startTime);
      if (t < -1e-4 || t > tMax) continue;
      if (t < 0) t = 0;
      const raw = (event.value ?? 64) / 127;
      steps.push({ t, pan: raw });
    }
    steps.sort((a, b) => a.t - b.t);
    const invSr = 1 / sampleRate;
    let si = 0;
    let curPan = steps[0].pan;
    let cur = this.panToGain(curPan);
    for (let i = 0; i < length; i++) {
      const t = i * invSr;
      while (si + 1 < steps.length && steps[si + 1].t <= t + 1e-9) {
        si++;
        curPan = steps[si].pan;
        cur = this.panToGain(curPan);
      }
      left[i] = cur.gainLeft;
      right[i] = cur.gainRight;
    }
    return { left, right };
  }

  // Precompute ADS volume envelope gains (no release; holds at sustain).
  // Matches setVolumeEnvelope; pass attenuationScale = filterDcGain when filter is on.
  protected computeAdsVolumeGains(
    voiceParams: VoiceParams,
    length: number,
    sampleRate: number,
    attenuationScale = 1,
  ): Float32Array {
    const gains = new Float32Array(length);
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation) *
      attenuationScale;
    const sustainVolume = attackVolume *
      cbToRatio(-1000 * voiceParams.sustainVolEnv);
    const delay = voiceParams.delayVolEnv;
    const attackEnd = delay + voiceParams.attackVolEnv;
    const holdEnd = attackEnd + voiceParams.holdVolEnv;
    const decayEnd = holdEnd + voiceParams.decayVolEnv;
    const attackDur = voiceParams.attackVolEnv;
    const decayDur = voiceParams.decayVolEnv;
    const invSr = 1 / sampleRate;
    for (let i = 0; i < length; i++) {
      const t = i * invSr;
      if (t < delay) {
        gains[i] = 0;
      } else if (t < attackEnd) {
        const frac = attackDur > 0 ? (t - delay) / attackDur : 1;
        const startG = 1e-6;
        gains[i] = startG * Math.pow(attackVolume / startG, frac);
      } else if (t < holdEnd) {
        gains[i] = attackVolume;
      } else if (t < decayEnd) {
        const frac = decayDur > 0 ? (t - holdEnd) / decayDur : 1;
        gains[i] = attackVolume *
          Math.pow(sustainVolume / attackVolume, frac);
      } else {
        gains[i] = sustainVolume;
      }
    }
    return gains;
  }

  // Precompute full ADSR volume envelope gains including release.
  // Matches createAdsrRenderedBuffer manual note-off ramp (setTargetAtTime).
  protected computeAdsrVolumeGains(
    voiceParams: VoiceParams,
    noteOffTime: number,
    length: number,
    sampleRate: number,
    attenuationScale = 1,
  ): Float32Array {
    const gains = new Float32Array(length);
    const attackVolume = cbToRatio(-voiceParams.initialAttenuation) *
      attenuationScale;
    const sustainVolume = attackVolume *
      cbToRatio(-1000 * voiceParams.sustainVolEnv);
    const delay = voiceParams.delayVolEnv;
    const attackEnd = delay + voiceParams.attackVolEnv;
    const holdEnd = attackEnd + voiceParams.holdVolEnv;
    const decayEnd = holdEnd + voiceParams.decayVolEnv;
    const attackDur = voiceParams.attackVolEnv;
    const decayDur = voiceParams.decayVolEnv;
    const releaseDur = voiceParams.releaseVolEnv;
    const invSr = 1 / sampleRate;
    let gainAtNoteOff: number;
    if (noteOffTime <= delay) {
      gainAtNoteOff = 0;
    } else if (noteOffTime <= attackEnd) {
      gainAtNoteOff = 1e-6 + (attackVolume - 1e-6) *
          (noteOffTime - delay) / Math.max(attackDur, 1e-12);
    } else if (noteOffTime <= holdEnd) {
      gainAtNoteOff = attackVolume;
    } else if (noteOffTime <= decayEnd) {
      const decayFraction = (noteOffTime - holdEnd) / Math.max(decayDur, 1e-12);
      gainAtNoteOff = attackVolume *
        Math.pow(sustainVolume / attackVolume, decayFraction);
    } else {
      gainAtNoteOff = sustainVolume;
    }
    const timeConstant = releaseDur * envelopeCurve;
    for (let i = 0; i < length; i++) {
      const t = i * invSr;
      if (t < noteOffTime) {
        if (t < delay) {
          gains[i] = 0;
        } else if (t < attackEnd) {
          const frac = attackDur > 0 ? (t - delay) / attackDur : 1;
          const startG = 1e-6;
          gains[i] = startG * Math.pow(attackVolume / startG, frac);
        } else if (t < holdEnd) {
          gains[i] = attackVolume;
        } else if (t < decayEnd) {
          const frac = decayDur > 0 ? (t - holdEnd) / decayDur : 1;
          gains[i] = attackVolume *
            Math.pow(sustainVolume / attackVolume, frac);
        } else {
          gains[i] = sustainVolume;
        }
      } else {
        if (timeConstant <= 0 || gainAtNoteOff === 0) {
          gains[i] = 0;
        } else {
          gains[i] = gainAtNoteOff *
            Math.exp(-(t - noteOffTime) / timeConstant);
        }
      }
    }
    return gains;
  }

  // Filter cutoff Hz curve matching setFilterEnvelope (+ ADSR release ramp).
  // Returns null when filter is not audible (caller skips biquad).
  protected computeFilterFreqCurve(
    voiceParams: VoiceParams,
    length: number,
    sampleRate: number,
    noteOffTime: number | null,
  ): Float32Array | null {
    if (
      !isFilterAudible(
        voiceParams.initialFilterFc,
        voiceParams.initialFilterQ,
        voiceParams.modEnvToFilterFc,
      )
    ) {
      return null;
    }
    const modEnvToFilterFc = voiceParams.modEnvToFilterFc;
    const baseCent = voiceParams.initialFilterFc;
    const peekCent = baseCent + modEnvToFilterFc;
    const sustainCent = baseCent +
      modEnvToFilterFc * (1 - voiceParams.sustainModEnv);
    const baseFreq = this.clampCutoffFrequency(this.centToHz(baseCent));
    const peekFreq = this.clampCutoffFrequency(this.centToHz(peekCent));
    const sustainFreq = this.clampCutoffFrequency(this.centToHz(sustainCent));
    const delay = voiceParams.delayModEnv;
    const attackEnd = delay + voiceParams.attackModEnv;
    const holdEnd = attackEnd + voiceParams.holdModEnv;
    const decayEnd = holdEnd + voiceParams.decayModEnv;
    const attackDur = voiceParams.attackModEnv;
    const decayDur = voiceParams.decayModEnv;
    const releaseDur = voiceParams.releaseModEnv;
    const invSr = 1 / sampleRate;
    const freqs = new Float32Array(length);

    const freqAt = (t: number): number => {
      if (t < delay) return baseFreq;
      if (t < attackEnd) {
        const frac = attackDur > 0 ? (t - delay) / attackDur : 1;
        // exponentialRamp base -> peek
        if (baseFreq <= 0) return peekFreq;
        return baseFreq * Math.pow(peekFreq / baseFreq, frac);
      }
      if (t < holdEnd) return peekFreq;
      if (t < decayEnd) {
        const frac = decayDur > 0 ? (t - holdEnd) / decayDur : 1;
        if (peekFreq <= 0) return sustainFreq;
        return peekFreq * Math.pow(sustainFreq / peekFreq, frac);
      }
      return sustainFreq;
    };

    let freqAtNoteOff = 0;
    if (noteOffTime != null) {
      freqAtNoteOff = freqAt(noteOffTime);
    }

    for (let i = 0; i < length; i++) {
      const t = i * invSr;
      if (noteOffTime != null && t >= noteOffTime) {
        // exponentialRamp freqAtNoteOff -> baseFreq over releaseModEnv
        if (releaseDur <= 0) {
          freqs[i] = baseFreq;
        } else {
          const frac = Math.min(1, (t - noteOffTime) / releaseDur);
          if (freqAtNoteOff <= 0) {
            freqs[i] = baseFreq;
          } else {
            freqs[i] = freqAtNoteOff *
              Math.pow(baseFreq / freqAtNoteOff, frac);
          }
        }
      } else {
        freqs[i] = freqAt(t);
      }
    }
    return freqs;
  }

  // RBJ cookbook lowpass coefficients (normalized a0=1).
  protected biquadLowpassCoeffs(
    freq: number,
    q: number,
    sampleRate: number,
  ): { b0: number; b1: number; b2: number; a1: number; a2: number } {
    const nyquist = sampleRate * 0.5;
    let f = freq;
    if (f < 1) f = 1;
    if (f > nyquist - 1) f = nyquist - 1;
    const w0 = 2 * Math.PI * f / sampleRate;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Math.max(q, 0.001));
    const b0n = (1 - cosw0) * 0.5;
    const b1n = 1 - cosw0;
    const b2n = (1 - cosw0) * 0.5;
    const a0 = 1 + alpha;
    const a1n = -2 * cosw0;
    const a2n = 1 - alpha;
    const invA0 = 1 / a0;
    return {
      b0: b0n * invA0,
      b1: b1n * invA0,
      b2: b2n * invA0,
      a1: a1n * invA0,
      a2: a2n * invA0,
    };
  }

  // Render pitched + looped sample, optional time-varying lowpass, then volume.
  // Graph order matches WebAudio: source -> biquad -> gain.
  protected renderSampleTypedArray(
    srcBuffer: AudioBuffer,
    dest: AudioBuffer,
    playbackRate: number,
    isLoop: boolean,
    loopStartSrc: number,
    loopEndSrc: number,
    startOffsetSrc: number,
    gains: Float32Array,
    filterFreqs: Float32Array | null,
    filterQ: number,
  ): void {
    const srcRate = srcBuffer.sampleRate;
    const destRate = dest.sampleRate;
    const destLen = dest.length;
    const srcChCount = srcBuffer.numberOfChannels;
    const destChCount = dest.numberOfChannels;
    const srcChannels: Float32Array[] = new Array(srcChCount);
    for (let c = 0; c < srcChCount; c++) {
      srcChannels[c] = srcBuffer.getChannelData(c);
    }
    const srcLen = srcBuffer.length;
    const loopStartSample = loopStartSrc * srcRate;
    const loopEndSample = loopEndSrc * srcRate;
    const loopLenSample = loopEndSample - loopStartSample;
    const startSample = startOffsetSrc * srcRate;
    const step = playbackRate * (srcRate / destRate);
    const useFilter = filterFreqs != null;

    for (let c = 0; c < destChCount; c++) {
      const dst = dest.getChannelData(c);
      const srcData = srcChannels[Math.min(c, srcChCount - 1)];
      let srcPos = startSample;
      let z1 = 0;
      let z2 = 0;
      let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
      let lastFreq = -1;
      for (let i = 0; i < destLen; i++) {
        let pos = srcPos;
        if (isLoop && loopLenSample > 0 && pos >= loopEndSample) {
          const over = pos - loopStartSample;
          pos = loopStartSample + (over % loopLenSample);
          if (pos < loopStartSample) pos += loopLenSample;
        }
        let x = 0;
        if (pos >= 0 && pos < srcLen - 1) {
          const i0 = Math.floor(pos);
          const frac = pos - i0;
          const s0 = srcData[i0];
          const s1 = srcData[i0 + 1];
          x = s0 + (s1 - s0) * frac;
        } else if (pos >= 0 && pos < srcLen) {
          x = srcData[Math.floor(pos)];
        }

        if (useFilter) {
          const freq = filterFreqs![i];
          // Update coeffs when frequency moves ~1% (cheap, stable enough for bake)
          if (lastFreq < 0 || Math.abs(freq - lastFreq) > lastFreq * 0.01) {
            const coef = this.biquadLowpassCoeffs(freq, filterQ, destRate);
            b0 = coef.b0;
            b1 = coef.b1;
            b2 = coef.b2;
            a1 = coef.a1;
            a2 = coef.a2;
            lastFreq = freq;
          }
          // Transposed Direct Form II
          const y = b0 * x + z1;
          z1 = b1 * x - a1 * y + z2;
          z2 = b2 * x - a2 * y;
          dst[i] = y * gains[i];
        } else {
          dst[i] = x * gains[i];
        }
        srcPos += step;
      }
    }
  }

  /**
   * Same as renderSampleTypedArray, but optionally offloads the per-sample
   * loop to the worker pool when useWorkerSimpleNoteBake is enabled and the
   * destination is long enough that postMessage overhead is amortized.
   *
   * Intentionally disabled for segment / chunk (tiled) modes: those bake
   * many notes per tile and the per-note postMessage cost outweighed the
   * parallel gain. Tiled modes keep note bodies on the main thread and only
   * offload the tile-level mix via mixEntriesToBuffer / useWorkerTypedArrayMix.
   * note / ads / adsr still benefit — a single long note onset should not
   * monopolise the main thread even if total CPU is a bit higher.
   */
  protected async renderSampleTypedArrayMaybeWorker(
    srcBuffer: AudioBuffer,
    dest: AudioBuffer,
    playbackRate: number,
    isLoop: boolean,
    loopStartSrc: number,
    loopEndSrc: number,
    startOffsetSrc: number,
    gains: Float32Array,
    filterFreqs: Float32Array | null,
    filterQ: number,
  ): Promise<void> {
    const useWorker = this.useWorkerSimpleNoteBake &&
      !isTiledCacheMode(this.cacheMode) &&
      dest.length >= BakeWorkerPool.MIN_SAMPLES_FOR_RENDER &&
      typeof Worker !== "undefined";

    if (!useWorker) {
      this.renderSampleTypedArray(
        srcBuffer,
        dest,
        playbackRate,
        isLoop,
        loopStartSrc,
        loopEndSrc,
        startOffsetSrc,
        gains,
        filterFreqs,
        filterQ,
      );
      return;
    }

    try {
      const srcChCount = srcBuffer.numberOfChannels;
      const srcChannels: Float32Array[] = new Array(srcChCount);
      for (let c = 0; c < srcChCount; c++) {
        // slice so transferable path does not detach live AudioBuffer channels
        // unless useWorkerTransferable is explicitly true *and* we accept that
        // the source AudioBuffer becomes unusable (we always slice here for
        // safety — sample tables are shared across many notes).
        srcChannels[c] = srcBuffer.getChannelData(c).slice();
      }
      // gains / filterFreqs are single-use curves; transferable is safe.
      const gainsCopy = this.useWorkerTransferable ? gains : gains.slice();
      const filterCopy = filterFreqs
        ? (this.useWorkerTransferable ? filterFreqs : filterFreqs.slice())
        : null;

      const pool = this.getBakeWorkerPool();
      const result = await pool.renderSample(
        {
          srcChannels,
          srcRate: srcBuffer.sampleRate,
          destRate: dest.sampleRate,
          destLen: dest.length,
          destChCount: dest.numberOfChannels as 1 | 2,
          playbackRate,
          isLoop,
          loopStartSrc,
          loopEndSrc,
          startOffsetSrc,
          gains: gainsCopy,
          filterFreqs: filterCopy,
          filterQ,
        },
        this.useWorkerTransferable,
      );

      for (let c = 0; c < dest.numberOfChannels; c++) {
        dest.copyToChannel(result.channels[c], c);
      }
    } catch (err) {
      console.warn(
        "[midy] worker simple-note render failed, falling back to main",
        err,
      );
      this.renderSampleTypedArray(
        srcBuffer,
        dest,
        playbackRate,
        isLoop,
        loopStartSrc,
        loopEndSrc,
        startOffsetSrc,
        gains,
        filterFreqs,
        filterQ,
      );
    }
  }

  // Create an empty AudioBuffer on the live context (for TypedArray mix dest).
  protected createEmptyBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer {
    return this.audioContext.createBuffer(numberOfChannels, length, sampleRate);
  }

  // Peak-normalize an AudioBuffer in place so the absolute peak is at most
  // PEAK_TARGET (0.95). Used by audio (final mix) offline renders.
  // Linear gain only scales *down* when needed -- quiet material is unchanged.
  // Not used for realtime chunk windows (softClamp) or segment tiles
  // (polyphony pre-gain + softClamp) -- independent per-tile peakNormalize
  // would silence dense glissandi / chords.
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

  createAdsRenderedBuffer(
    channel: TChannel,
    note: TNote,
    voiceParams: VoiceParams,
    audioBuffer: AudioBuffer,
    isDrum = false,
  ): RenderedBuffer {
    const isLoop = isDrum
      ? (this.isLoopDrum(channel, note.noteNumber) &&
        voiceParams.sampleModes % 2 !== 0)
      : (voiceParams.sampleModes % 2 !== 0);
    const attackVolEnvTime = voiceParams.delayVolEnv + voiceParams.attackVolEnv;
    const holdVolEnvTime = attackVolEnvTime + voiceParams.holdVolEnv;
    const decayDuration = voiceParams.decayVolEnv;
    const adsDuration = holdVolEnvTime + decayDuration;
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
    const length = Math.ceil(renderDuration * sampleRate);
    const buffer = this.createEmptyBuffer(
      audioBuffer.numberOfChannels,
      length,
      sampleRate,
    );

    const filterAudible = isFilterAudible(
      voiceParams.initialFilterFc,
      voiceParams.initialFilterQ,
      voiceParams.modEnvToFilterFc,
    );
    let filterDcGain = 1;
    let filterQ = Math.SQRT1_2;
    if (filterAudible) {
      const qDc = sf2FilterQ(voiceParams.initialFilterQ);
      filterQ = qDc.q;
      filterDcGain = qDc.dcGain;
    }
    const gains = this.computeAdsVolumeGains(
      voiceParams,
      length,
      sampleRate,
      filterDcGain,
    );
    // ADS buffer has no note-off; filter holds at sustain (noteOffTime=null)
    const filterFreqs = this.computeFilterFreqCurve(
      voiceParams,
      length,
      sampleRate,
      null,
    );
    const startOffsetSrc = voiceParams.sample.type === "compressed"
      ? voiceParams.start / audioBuffer.sampleRate
      : 0;
    this.renderSampleTypedArray(
      audioBuffer,
      buffer,
      playbackRate,
      isLoop,
      sampleLoopStart,
      sampleLoopStart + sampleLoopDuration,
      startOffsetSrc,
      gains,
      filterFreqs,
      filterQ,
    );
    return new RenderedBuffer(buffer, {
      isLoop,
      adsDuration,
      loopStart: alignedLoopStart,
      loopDuration: outputLoopDuration,
    });
  }

  createAdsrRenderedBuffer(
    channel: TChannel,
    note: TNote,
    voiceParams: VoiceParams,
    audioBuffer: AudioBuffer,
    noteDuration: number,
    isDrum = false,
  ): RenderedBuffer {
    const isLoop = isDrum
      ? (this.isLoopDrum(channel, note.noteNumber) &&
        voiceParams.sampleModes % 2 !== 0)
      : (voiceParams.sampleModes % 2 !== 0);
    const attackVolEnvTime = voiceParams.delayVolEnv + voiceParams.attackVolEnv;
    const holdVolEnvTime = attackVolEnvTime + voiceParams.holdVolEnv;
    const decayDuration = voiceParams.decayVolEnv;
    const adsDuration = holdVolEnvTime + decayDuration;
    const releaseDuration = voiceParams.releaseVolEnv;
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
    const length = Math.ceil(totalDuration * sampleRate);
    const buffer = this.createEmptyBuffer(
      audioBuffer.numberOfChannels,
      length,
      sampleRate,
    );

    const filterAudible = isFilterAudible(
      voiceParams.initialFilterFc,
      voiceParams.initialFilterQ,
      voiceParams.modEnvToFilterFc,
    );
    let filterDcGain = 1;
    let filterQ = Math.SQRT1_2;
    if (filterAudible) {
      const qDc = sf2FilterQ(voiceParams.initialFilterQ);
      filterQ = qDc.q;
      filterDcGain = qDc.dcGain;
    }
    const gains = this.computeAdsrVolumeGains(
      voiceParams,
      noteOffTime,
      length,
      sampleRate,
      filterDcGain,
    );
    const filterFreqs = this.computeFilterFreqCurve(
      voiceParams,
      length,
      sampleRate,
      noteOffTime,
    );
    const startOffsetSrc = voiceParams.sample.type === "compressed"
      ? voiceParams.start / audioBuffer.sampleRate
      : 0;
    this.renderSampleTypedArray(
      audioBuffer,
      buffer,
      voiceParams.playbackRate,
      isLoop,
      loopStartTime,
      loopStartTime + loopDuration,
      startOffsetSrc,
      gains,
      filterFreqs,
      filterQ,
    );
    return new RenderedBuffer(buffer, {
      isLoop: false,
      isFull: false,
      adsDuration,
      noteDuration: noteOffTime,
      releaseDuration,
    });
  }

  // -------------------------------------------------------------------------
  // Offline note buffers (simple / complex) & entry bake
  // -------------------------------------------------------------------------

  // Reset hit/miss / peak counters. Called at the beginning of start() so
  // each play reports rates for that run only (including prewarm).
  resetNoteCacheHitStats(): void {
    this.simpleNoteCacheHits = 0;
    this.simpleNoteCacheMisses = 0;
    this.complexNoteCacheHits = 0;
    this.complexNoteCacheMisses = 0;
    this.complexNoteCacheUniqueBakes = 0;
    this.simpleNoteCachePeakSize = this.simpleNoteBufferCache.size;
    this.complexNoteCachePeakSize = this.complexNoteBufferCache.size;
    this.simpleNoteCachePrewarmMisses = 0;
    this.noteCacheStatsInPrewarm = false;
    this.resetChunkPipelineStats();
  }

  protected resetChunkPipelineStats(): void {
    this.chunkBakeCount = 0;
    this.chunkBakeSumMs = 0;
    this.chunkBakeMaxMs = 0;
    this.chunkBakeSamplesMs = [];
    this.chunkPureTaTiles = 0;
    this.chunkOacTiles = 0;
    this.chunkStarts = 0;
    this.chunkLateStarts = 0;
    this.chunkLateSumMs = 0;
    this.chunkLateMaxMs = 0;
    this.chunkDroppedLate = 0;
    this.chunkBakeSimpleSumMs = 0;
    this.chunkBakeComplexSumMs = 0;
    this.chunkBakeMixSumMs = 0;
    this.chunkBakeOacSumMs = 0;
    this.chunkBakeNoteCountSum = 0;
    this.chunkBakeComplexCountSum = 0;
    this.chunkBakeSumNoteDuration = 0;
    this.chunkBakeSumCost = 0;
  }

  protected recordChunkBake(
    ms: number,
    pureTa: boolean,
    parts?: {
      simpleMs?: number;
      complexMs?: number;
      mixMs?: number;
      oacMs?: number;
      noteCount?: number;
      complexCount?: number;
      sumNoteDuration?: number;
      cost?: number;
      chunkStart?: number;
      bufferDuration?: number;
      simpleHits?: number;
      simpleMissesBaked?: number;
      topNoteDuration?: number;
      topReleaseTail?: number;
    },
  ): void {
    this.chunkBakeCount++;
    this.chunkBakeSumMs += ms;
    if (ms > this.chunkBakeMaxMs) this.chunkBakeMaxMs = ms;
    if (pureTa) this.chunkPureTaTiles++;
    else this.chunkOacTiles++;
    if (parts) {
      this.chunkBakeSimpleSumMs += parts.simpleMs ?? 0;
      this.chunkBakeComplexSumMs += parts.complexMs ?? 0;
      this.chunkBakeMixSumMs += parts.mixMs ?? 0;
      this.chunkBakeOacSumMs += parts.oacMs ?? 0;
      this.chunkBakeNoteCountSum += parts.noteCount ?? 0;
      this.chunkBakeComplexCountSum += parts.complexCount ?? 0;
      this.chunkBakeSumNoteDuration += parts.sumNoteDuration ?? 0;
      this.chunkBakeSumCost += parts.cost ?? 0;
    }
    const samples = this.chunkBakeSamplesMs;
    if (samples.length < Player.CHUNK_BAKE_SAMPLE_CAP) {
      samples.push(ms);
    } else {
      const j = (Math.random() * this.chunkBakeCount) | 0;
      if (j < samples.length) samples[j] = ms;
    }

    const thr = this.chunkBakeHeavyThresholdMs;
    if (thr > 0 && ms >= thr) {
      const p = parts ?? {};
      const simpleMs = p.simpleMs ?? 0;
      const complexMs = p.complexMs ?? 0;
      const mixMs = p.mixMs ?? 0;
      const oacMs = p.oacMs ?? 0;
      // Dominant phase for a quick read of the log line.
      let dominant = "other";
      let domMs = 0;
      const phases: [string, number][] = [
        ["simple", simpleMs],
        ["complex", complexMs],
        ["mix", mixMs],
        ["oac", oacMs],
      ];
      for (let i = 0; i < phases.length; i++) {
        if (phases[i][1] > domMs) {
          domMs = phases[i][1];
          dominant = phases[i][0];
        }
      }
      console.warn(
        `[midy] chunk-heavy | ${ms.toFixed(0)}ms dominant=${dominant} ` +
          `path=${pureTa ? "pureTA" : "oac"} ` +
          `start=${(p.chunkStart ?? 0).toFixed(2)}s ` +
          `notes=${p.noteCount ?? "?"} complex=${p.complexCount ?? "?"} ` +
          `hits=${p.simpleHits ?? "?"} missBake=${
            p.simpleMissesBaked ?? "?"
          } ` +
          `sumDur=${(p.sumNoteDuration ?? 0).toFixed(2)}s ` +
          `bufDur=${(p.bufferDuration ?? 0).toFixed(2)}s ` +
          `cost=${(p.cost ?? 0).toFixed(2)} ` +
          `topNote=${(p.topNoteDuration ?? 0).toFixed(2)}s ` +
          `topRel=${(p.topReleaseTail ?? 0).toFixed(2)}s | ` +
          `simple=${simpleMs.toFixed(0)}ms complex=${complexMs.toFixed(0)}ms ` +
          `mix=${mixMs.toFixed(0)}ms oac=${oacMs.toFixed(0)}ms`,
      );
    }
  }

  protected chunkBakePercentile(p: number): number {
    const samples = this.chunkBakeSamplesMs;
    if (samples.length === 0) return 0;
    const sorted = samples.slice().sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx];
  }

  protected noteCacheRecordSimpleHit(): void {
    this.simpleNoteCacheHits++;
  }

  protected noteCacheRecordSimpleMiss(): void {
    this.simpleNoteCacheMisses++;
    if (this.noteCacheStatsInPrewarm) this.simpleNoteCachePrewarmMisses++;
  }

  protected noteCacheRecordComplexHit(): void {
    this.complexNoteCacheHits++;
  }

  protected noteCacheRecordComplexMiss(): void {
    this.complexNoteCacheMisses++;
  }

  protected noteCacheRecordComplexUnique(): void {
    this.complexNoteCacheUniqueBakes++;
  }

  protected noteCacheTouchPeakSizes(): void {
    const s = this.simpleNoteBufferCache.size;
    if (s > this.simpleNoteCachePeakSize) this.simpleNoteCachePeakSize = s;
    const c = this.complexNoteBufferCache.size;
    if (c > this.complexNoteCachePeakSize) this.complexNoteCachePeakSize = c;
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
    if (cached instanceof AudioBuffer) {
      this.noteCacheRecordComplexHit();
      return cached;
    }
    if (cached instanceof Promise) {
      try {
        const buf = await cached;
        this.noteCacheRecordComplexHit();
        return buf;
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
    fromOuterSlot = false,
  ): Promise<AudioBuffer> {
    const key = this.makeComplexNoteKey(entry, bakeChannelMix);
    const count = this.complexNoteCounts.get(key) ?? 0;
    const bake = () =>
      fromOuterSlot
        ? this.renderEntryAudioBufferUngated(entry, bakeChannelMix)
        : this.renderEntryAudioBuffer(entry, bakeChannelMix);
    if (count <= 1) {
      this.noteCacheRecordComplexUnique();
      return await bake();
    }
    const cached = this.complexNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) {
      this.noteCacheRecordComplexHit();
      return cached;
    }
    if (cached instanceof Promise) {
      this.noteCacheRecordComplexHit();
      return await cached;
    }

    this.noteCacheRecordComplexMiss();
    const renderPromise = (async () => {
      try {
        const buffer = await bake();
        this.complexNoteBufferCache.set(key, buffer);
        this.noteCacheTouchPeakSizes();
        return buffer;
      } catch (err) {
        this.complexNoteBufferCache.delete(key);
        throw err;
      }
    })();
    this.complexNoteBufferCache.set(key, renderPromise);
    this.noteCacheTouchPeakSizes();
    return await renderPromise;
  }

  // Resolve a cached simple-note buffer without starting a new bake.
  // Returns null on miss (caller should schedule into the shared mix OAC).
  // In-flight Promise from note-mode / other paths is awaited.
  // Counts a hit when a buffer (or in-flight Promise) is returned; does not
  // count a miss (caller may bake via getSimpleNoteBuffer or direct OAC).
  async lookupSimpleNoteBuffer(
    n: BakeNoteEntry,
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer | null> {
    if (!this.simpleNoteCache) return null;
    const key = this.makeSimpleNoteKey(n, bakeChannelMix);
    const cached = this.simpleNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) {
      this.noteCacheRecordSimpleHit();
      return cached;
    }
    if (cached instanceof Promise) {
      try {
        const buf = await cached;
        this.noteCacheRecordSimpleHit();
        return buf;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Seed an offline channel from a BakeNoteEntry snapshot (state array,
  // program, detune, drum flag, modulation depth). Optionally applies
  // channel volume/pan for mix-baked paths.
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

  // noteOn into an offline player: preload sample, attach voiceParams.
  // bakeChannelMix=false (dry): after noteOn, disconnect volumeNode from the
  // channel bus (and any mix-level sends hung off it -- delay, etc.) and
  // connect it straight to the offline destination. That keeps the baked
  // buffer free of channel vol/pan and effect sends so segment mode can
  // apply them live.
  // bakeChannelMix=true (mix): leave the graph as noteOn built it so vol/pan
  // and sends are inside the buffer.
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
  // OfflineAudioContext via a lightweight offline Player -- used on cache
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
      const offTime = n.offset + n.noteDuration;
      if (n.noteEvent?.soundOff) {
        const note = offlinePlayer.findNoteForOff(dstChannel, n.noteNumber);
        if (note) {
          offlinePlayer.removeFromActiveNotes(dstChannel, n.noteNumber);
          void offlinePlayer.soundOffNote(note, offTime);
        }
      } else {
        offlinePlayer.noteOffChannel(
          dstChannel,
          n.noteNumber,
          0,
          offTime,
          true,
        );
      }
    }
  }

  // Schedule automated notes directly into the chunk's OfflineAudioContext.
  //
  // Complex notes are grouped by MIDI channel: one offline Player / Channel
  // per channel, with CC / pitch-bend applied once in absolute time order.
  // Overlapping notes on the same channel (common dense passages) used to
  // rebuild an isolated graph + replay the same expression/bend column for
  // every note; channel-level bake matches MIDI semantics and cuts duplicate
  // work dramatically.
  protected async scheduleComplexNotesDirect(
    offlineContext: OfflineAudioContext,
    notes: (BakeNoteEntry & { offset: number })[],
    bakeChannelMix: boolean,
  ): Promise<void> {
    if (notes.length === 0) return;
    const byChannel = new Map<number, (BakeNoteEntry & { offset: number })[]>();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      let list = byChannel.get(n.channelNumber);
      if (!list) {
        list = [];
        byChannel.set(n.channelNumber, list);
      }
      list.push(n);
    }

    for (const [channelNumber, channelNotes] of byChannel) {
      channelNotes.sort((a, b) => a.offset - b.offset);
      const offlinePlayer = this.createOfflineRenderPlayer(
        offlineContext,
        [channelNumber],
        true,
      );
      const seed = channelNotes[0];
      const channel = this.prepareOfflineChannel(
        offlinePlayer,
        seed,
        bakeChannelMix,
        seed.offset,
      );
      if (!channel) continue;

      // Build a single chronological action list for this channel:
      // noteOn / noteOff / automation. Overlapping notes share the same CC
      // column; dedupe so each MIDI event is applied once.
      type Action =
        | { kind: "on"; t: number; entry: BakeNoteEntry & { offset: number } }
        | {
          kind: "off";
          t: number;
          noteNumber: number;
          entry: BakeNoteEntry & { offset: number };
        }
        | { kind: "ev"; t: number; event: TimelineEvent; key: string };

      const actions: Action[] = [];
      const seenKeys = new Set<string>();

      for (let ni = 0; ni < channelNotes.length; ni++) {
        const entry = channelNotes[ni];
        actions.push({ kind: "on", t: entry.offset, entry });
        actions.push({
          kind: "off",
          t: entry.offset + entry.noteDuration,
          noteNumber: entry.noteNumber,
          entry,
        });

        const noteEvents = entry.noteEvent?.events ?? [];
        const noteStartTime = entry.noteEvent?.startTime ?? 0;
        const releaseEnd = entry.noteEvent?.soundOff
          ? 0
          : entry.voiceParams.releaseVolEnv * envelopeCurve * 5;
        const tMax = entry.noteDuration + releaseEnd;
        for (let ei = 0; ei < noteEvents.length; ei++) {
          const event = noteEvents[ei];
          if (event.type === "programChange") continue;
          let rel = this.relativeTimeInNote(
            event,
            entry.noteEvent,
            noteStartTime,
          );
          if (rel < -1e-4 || rel > tMax) continue;
          if (rel < 0) rel = 0;
          const absT = entry.offset + rel;
          const key = event.ticks != null
            ? `${event.ticks}|${event.type}|${event.controllerType ?? ""}|${
              event.value ?? ""
            }|${event.programNumber ?? ""}`
            : `${absT.toFixed(5)}|${event.type}|${event.controllerType ?? ""}|${
              event.value ?? ""
            }|${event.programNumber ?? ""}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          actions.push({ kind: "ev", t: absT, event, key });
        }
      }

      // Order: time ascending; at equal time: events → noteOn → noteOff so
      // onset state already reflects same-tick automation.
      const kindOrder = { ev: 0, on: 1, off: 2 } as const;
      actions.sort((a, b) => {
        if (a.t !== b.t) return a.t - b.t;
        return kindOrder[a.kind] - kindOrder[b.kind];
      });

      for (let ai = 0; ai < actions.length; ai++) {
        const action = actions[ai];
        if (action.kind === "ev") {
          offlinePlayer.processTimelineEvent(action.event, action.t, {
            channels: offlinePlayer.channels,
          });
        } else if (action.kind === "on") {
          const entry = action.entry;
          if (channel.programNumber !== entry.programNumber) {
            channel.programNumber = entry.programNumber;
          }
          await this.scheduleOfflineNoteOn(
            offlinePlayer,
            offlineContext,
            channel,
            entry,
            entry.offset,
            bakeChannelMix,
          );
        } else {
          if (action.entry.noteEvent?.soundOff) {
            const note = offlinePlayer.findNoteForOff(
              channel,
              action.noteNumber,
            );
            if (note) {
              offlinePlayer.removeFromActiveNotes(channel, action.noteNumber);
              void offlinePlayer.soundOffNote(note, action.t);
            }
          } else {
            offlinePlayer.noteOffChannel(
              channel,
              action.noteNumber,
              0,
              action.t,
              true,
            );
          }
        }
      }
    }
  }

  // Bake a simple note and cache it.
  // bakeChannelMix=true: stereo with channel vol/pan (chunk/audio).
  // bakeChannelMix=false: mono dry signal (segment; vol/pan live).
  // fromOuterSlot=true: already inside runWithOfflineRenderGate (segment /
  //   audio-chunk mix). Skip the gate and bake ungated so maxConcurrent=1
  //   does not deadlock. Never pass true from a sibling / fire-and-forget
  //   caller — that is the closeChunk storm the gate exists to serialize.
  // Still used by "note" mode. Segment/chunk/audio prefer lookup + direct
  // schedule on miss so the mix OAC does not wait on a second startRendering.
  // Implementation is renderEntryAudioBuffer + cache (simple notes have no
  // in-interval automation, so the event replay loop is a no-op).
  async getSimpleNoteBuffer(
    n: BakeNoteEntry,
    bakeChannelMix = true,
    fromOuterSlot = false,
  ): Promise<AudioBuffer> {
    const key = this.makeSimpleNoteKey(n, bakeChannelMix);
    const cached = this.simpleNoteBufferCache.get(key);
    if (cached instanceof AudioBuffer) {
      this.noteCacheRecordSimpleHit();
      return cached;
    }
    if (cached instanceof Promise) {
      this.noteCacheRecordSimpleHit();
      return await cached;
    }

    this.noteCacheRecordSimpleMiss();
    const renderPromise = (async () => {
      const buffer = fromOuterSlot
        ? await this.renderEntryAudioBufferUngated(n, bakeChannelMix)
        : await this.renderEntryAudioBuffer(n, bakeChannelMix);
      this.simpleNoteBufferCache.set(key, buffer);
      this.noteCacheTouchPeakSizes();
      return buffer;
    })();

    this.simpleNoteBufferCache.set(key, renderPromise);
    this.noteCacheTouchPeakSizes();
    try {
      return await renderPromise;
    } catch (err) {
      this.simpleNoteBufferCache.delete(key);
      throw err;
    }
  }

  // Bakes an entire segment (all notes queued for one channel within
  // tileDuration seconds) into a single AudioBuffer using exactly one
  // OfflineAudioContext / startRendering() call, instead of one offline
  // context per note followed by a manual JS mixdown. Each note still gets
  // its own full envelope/pitch-bend/LFO/CC#1 bake (same fidelity as
  // "note" mode), but all notes share one offline render graph and are
  // simply scheduled at their respective offsets within it -- the audio
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
      const releaseEndDuration = n.noteEvent?.soundOff
        ? 0
        : n.voiceParams.releaseVolEnv * envelopeCurve * 5;
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
    return await this.runWithOfflineRenderGate(async () => {
      const sampleRate = this.audioContext.sampleRate;
      const bufferLength = Math.ceil(totalDuration * sampleRate);
      const useTA = this.useTypedArraySimpleMix;

      // Headroom for dense tiles (glissandi / big chords): scale the *mix*
      // by 1/sqrt(maxConcurrent) so expected level stays stable without
      // waveshaping. peakNormalize would crush the whole tile; tanh would
      // distort the waveform; hard softClamp alone would grit on peaks.
      // Count concurrent notes over the sustained interval only (not the
      // long release tail) so a few long-decaying notes don't over-attenuate.
      const maxConcurrent = this.estimateMaxConcurrentNotes(notes);
      const mixGainValue = maxConcurrent > 1 ? 1 / Math.sqrt(maxConcurrent) : 1;

      const isDrum = channel.isDrum;
      const simpleHits: { buffer: AudioBuffer; offset: number }[] = [];

      // --- simple: resolve buffers (cache hit or bake) ---
      // Important: do NOT route segment simple-misses through
      // scheduleSimpleNotesDirect on a shared offline channel. That path
      // shares activeNotes / exclusive-class / polyphony state across
      // overlapping onsets on the same channel, so dense runs (glissandi)
      // could steal or choke earlier notes and drop them from the bake.
      // Baking each miss independently keeps every onset.
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
          let buf = await this.lookupSimpleNoteBuffer(bakeInput, false);
          if (!buf) {
            // getSimpleNoteBuffer always caches; even one-shot keys are safe
            // here because segment tiles are short and the alternate
            // scheduleSimpleNotesDirect path is unsafe for same-channel polyphony.
            buf = await this.getSimpleNoteBuffer(bakeInput, false, true); // gate slot held
          }
          simpleHits.push({ buffer: buf, offset: n.offset });
        }
      }

      // Complex: still need individual bakes (automation)
      const complexBufs: { buffer: AudioBuffer; offset: number }[] = [];
      if (complexCount > 0) {
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
          let buf = await this.lookupComplexNoteBuffer(entry, false);
          if (!buf) {
            buf = await this.getComplexNoteBuffer(entry, false, true); // gate slot held
          }
          complexBufs.push({ buffer: buf, offset: n.offset });
        }
      }

      if (useTA) {
        // Pure TypedArray mix: no OfflineAudioContext for the tile mix.
        // Worker pool when entry count is high enough.
        const allEntries = simpleHits.length > 0 && complexBufs.length > 0
          ? simpleHits.concat(complexBufs)
          : simpleHits.length > 0
          ? simpleHits
          : complexBufs;
        const buffer = await this.mixEntriesToBuffer(
          allEntries,
          1,
          bufferLength,
          sampleRate,
          mixGainValue,
        );
        this.softClampBuffer(buffer);
        return buffer;
      }

      // Legacy OAC path
      const offlineContext = new OfflineAudioContext(
        1,
        bufferLength,
        sampleRate,
      );
      const mixGain = new GainNode(offlineContext, {
        gain: mixGainValue,
      });
      mixGain.connect(offlineContext.destination);

      for (let i = 0; i < simpleHits.length; i++) {
        const h = simpleHits[i];
        const src = new AudioBufferSourceNode(offlineContext, {
          buffer: h.buffer,
        });
        src.connect(mixGain);
        src.start(h.offset);
      }
      for (let i = 0; i < complexBufs.length; i++) {
        const h = complexBufs[i];
        const src = new AudioBufferSourceNode(offlineContext, {
          buffer: h.buffer,
        });
        src.connect(mixGain);
        src.start(h.offset);
      }

      const rendered = await offlineContext.startRendering();
      const buffer = this.detachAudioBuffer(rendered);
      this.softClampBuffer(buffer);
      return buffer;
    });
  }

  // Max number of notes whose sustain intervals overlap in a segment.
  // Release tails are ignored so a few long decays do not inflate the count
  // and over-attenuate the mix gain.
  estimateMaxConcurrentNotes(
    notes: { offset: number; noteDuration: number }[],
  ): number {
    const n = notes.length;
    if (n <= 1) return n;
    // Events: +1 at onset, -1 at note-off. Sort by time; onsets before
    // releases at the same time so a note-off/note-on pair still counts.
    const events = new Array<{ t: number; d: number }>(n * 2);
    for (let i = 0; i < n; i++) {
      const note = notes[i];
      const start = note.offset;
      const end = note.offset + Math.max(0, note.noteDuration);
      events[i * 2] = { t: start, d: 1 };
      events[i * 2 + 1] = { t: end, d: -1 };
    }
    events.sort((a, b) => a.t - b.t || b.d - a.d);
    let active = 0;
    let max = 0;
    for (let i = 0; i < events.length; i++) {
      active += events[i].d;
      if (active > max) max = active;
    }
    return max > 0 ? max : 1;
  }

  // Bake one note (with its in-note automation) into an AudioBuffer.
  // bakeChannelMix=true  → stereo mix bake (channel vol/pan/expression and
  //                       mix-level sends such as Midy delay stay in-graph)
  // bakeChannelMix=false → mono dry bake (volumeNode rewired to destination;
  //                       segment keeps gainL/gainR and delay live)
  // Relative seconds of a timeline event within a note, for offline replay.
  // Primary: tick span scaled by duration/durationTicks (tempo-stable).
  // Fallback: startTime/tempo − noteStartTime (historical formula).
  relativeTimeInNote(
    event: TimelineEvent,
    noteEvent: NoteOnEventEntry | undefined,
    noteStartTime: number,
  ): number {
    if (noteEvent) {
      const startTicks = noteEvent.startTicks;
      const eventTicks = event.ticks;
      const durationTicks = noteEvent.durationTicks;
      if (
        startTicks != null &&
        eventTicks != null &&
        durationTicks != null &&
        durationTicks > 0 &&
        durationTicks !== Infinity &&
        noteEvent.duration > 0
      ) {
        return (eventTicks - startTicks) *
          (noteEvent.duration / durationTicks);
      }
    }
    return (event.startTime as number) / this.tempo - noteStartTime;
  }

  // Bake one note (with its in-note automation) into an AudioBuffer.
  // bakeChannelMix=true  → stereo mix bake (channel vol/pan/expression and
  //                       mix-level sends such as Midy delay stay in-graph)
  // bakeChannelMix=false → mono dry bake (volumeNode rewired to destination;
  //                       segment keeps gainL/gainR and delay live)
  // Complex notes in segment/chunk/audio all go through this path so pitch
  // bend is applied exactly like "note" mode's createFullRenderedBuffer --
  // one offline graph per note, no shared-channel event replay.
  // Simple-note caches (getSimpleNoteBuffer) also land here: with no
  // in-interval automation the event loop is a no-op.
  async renderEntryAudioBuffer(
    entry: BakeNoteEntry,
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer> {
    return await this.runWithOfflineRenderGate(() =>
      this.renderEntryAudioBufferUngated(entry, bakeChannelMix)
    );
  }

  // Pure TypedArray full-note bake for simple notes (no waveform-changing
  // in-interval automation) when modulation wheel is unused. Also covers
  // "almost simple" notes whose only automation is volume/expression and/or
  // pan: gain curves (computeGainOnlyChannelCurve) multiply into ADSR gains;
  // pan curves (computePanCurve) scale L/R on stereo expand. Mirrors createAdsrRenderedBuffer
  // (resample + loop + time-varying lowpass + ADSR gains) and optionally
  // bakes channel volume/pan into stereo for mix modes. Avoids OfflineAudioContext,
  // offline Player construction, node graph build, and startRendering.
  // Limitations (intentionally deferred): LFO vibrato (modDepth > 0) and
  // time-varying pitch from modEnvToPitch still need the OAC path.
  private async renderSimpleNoteTypedArray(
    entry: BakeNoteEntry,
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer> {
    const voiceParams = entry.voiceParams;
    const releaseEndDuration = entry.noteEvent?.soundOff
      ? 0
      : voiceParams.releaseVolEnv * envelopeCurve * 5;
    const noteOffTime = Math.max(0, entry.noteDuration);
    const totalDuration = Math.max(0.001, noteOffTime + releaseEndDuration);
    const sampleRate = this.audioContext.sampleRate;
    const length = Math.ceil(totalDuration * sampleRate);

    let audioBuffer: AudioBuffer;
    if (entry.audioBufferId !== undefined) {
      audioBuffer = await this.getRawAudioBuffer(
        entry.audioBufferId,
        voiceParams,
      );
    } else {
      audioBuffer = await this.createAudioBuffer(voiceParams);
    }

    const isLoop = entry.isDrum
      ? (this.isLoopDrum(
        { programNumber: entry.programNumber } as TChannel,
        entry.noteNumber,
      ) && voiceParams.sampleModes % 2 !== 0)
      : (voiceParams.sampleModes % 2 !== 0);
    const loopStartTime = voiceParams.loopStart / voiceParams.sampleRate;
    const loopDuration = isLoop
      ? (voiceParams.loopEnd - voiceParams.loopStart) / voiceParams.sampleRate
      : 0;

    // Match offline setDetune: fold channel + voice cents into playbackRate.
    const detune = entry.channelDetune + (voiceParams.detune || 0);
    const playbackRate = voiceParams.playbackRate *
      Math.pow(2, detune / 1200);

    const filterAudible = isFilterAudible(
      voiceParams.initialFilterFc,
      voiceParams.initialFilterQ,
      voiceParams.modEnvToFilterFc,
    );
    let filterDcGain = 1;
    let filterQ = Math.SQRT1_2;
    if (filterAudible) {
      const qDc = sf2FilterQ(voiceParams.initialFilterQ);
      filterQ = qDc.q;
      filterDcGain = qDc.dcGain;
    }

    // Channel volume/expression (GM/FluidSynth x²) and pan when baking mix.
    // Almost-simple notes (in-interval volume/expression and/or pan only) get
    // time-varying curves so the full note stays on the TypedArray path with
    // no OfflineAudioContext.
    let channelGain = 1;
    let panLeft = 1;
    let panRight = 1;
    let channelGainCurve: Float32Array | null = null;
    let panCurveLeft: Float32Array | null = null;
    let panCurveRight: Float32Array | null = null;
    if (bakeChannelMix) {
      const state = entry.channelStateArray;
      const vol0 = state[128 + 7] ?? (100 / 127);
      const pan0 = state[128 + 10] ?? (64 / 127);
      const expr0 = state[128 + 11] ?? 1;
      channelGain = vol0 * vol0 * expr0 * expr0;
      const { gainLeft, gainRight } = this.panToGain(pan0);
      panLeft = gainLeft;
      panRight = gainRight;
      if (entry.noteEvent && this.hasGainOnlyAutomation(entry.noteEvent)) {
        channelGainCurve = this.computeGainOnlyChannelCurve(
          entry.noteEvent,
          vol0,
          expr0,
          length,
          sampleRate,
          totalDuration,
        );
      }
      if (entry.noteEvent && this.hasPanOnlyAutomation(entry.noteEvent)) {
        const pc = this.computePanCurve(
          entry.noteEvent,
          pan0,
          length,
          sampleRate,
          totalDuration,
        );
        panCurveLeft = pc.left;
        panCurveRight = pc.right;
      }
    }

    const gains = this.computeAdsrVolumeGains(
      voiceParams,
      noteOffTime,
      length,
      sampleRate,
      filterDcGain * (channelGainCurve ? 1 : channelGain),
    );
    if (channelGainCurve) {
      for (let i = 0; i < length; i++) {
        gains[i] *= channelGainCurve[i];
      }
    }
    const filterFreqs = this.computeFilterFreqCurve(
      voiceParams,
      length,
      sampleRate,
      noteOffTime,
    );
    const startOffsetSrc = voiceParams.sample.type === "compressed"
      ? voiceParams.start / audioBuffer.sampleRate
      : 0;

    // Match OAC: dry = 1ch destination, mix = stereo after pan expand.
    // Render body as mono then expand when bakeChannelMix.
    // When useWorkerSimpleNoteBake is on and the note is long enough, the
    // per-sample resample/filter loop runs on a worker; curves stay here.
    const body = this.createEmptyBuffer(1, length, sampleRate);
    await this.renderSampleTypedArrayMaybeWorker(
      audioBuffer,
      body,
      playbackRate,
      isLoop,
      loopStartTime,
      loopStartTime + loopDuration,
      startOffsetSrc,
      gains,
      filterFreqs,
      filterQ,
    );

    if (!bakeChannelMix) {
      return body;
    }

    const stereo = this.createEmptyBuffer(2, length, sampleRate);
    const src = body.getChannelData(0);
    const left = stereo.getChannelData(0);
    const right = stereo.getChannelData(1);
    if (panCurveLeft && panCurveRight) {
      for (let i = 0; i < length; i++) {
        const s = src[i];
        left[i] = s * panCurveLeft[i];
        right[i] = s * panCurveRight[i];
      }
    } else {
      for (let i = 0; i < length; i++) {
        const s = src[i];
        left[i] = s * panLeft;
        right[i] = s * panRight;
      }
    }
    return stereo;
  }

  // Per-note OAC bake with no gate. Callers that already hold a slot
  // (segment / audio-chunk mix) must use this (via fromOuterSlot) so
  // maxConcurrentOfflineRenders === 1 does not deadlock. Everyone else
  // goes through renderEntryAudioBuffer.
  // Simple notes with modulationDepthMSB === 0 take the TypedArray fast path.
  private async renderEntryAudioBufferUngated(
    entry: BakeNoteEntry,
    bakeChannelMix: boolean,
  ): Promise<AudioBuffer> {
    // Fast path: simple note (no waveform automation) + modulation wheel
    // unused → pure TypedArray bake (no OAC / offline Player / startRendering).
    const noteEvent = entry.noteEvent;
    const isSimple = !!noteEvent &&
      noteEvent.duration > 0 &&
      noteEvent.durationTicks !== Infinity &&
      !this.hasWaveformAutomation(noteEvent);
    // ControllerState index: modulationDepthMSB = 128 + 1
    const modDepth = entry.channelStateArray[128 + 1] ?? 0;
    if (
      this.useTypedArraySimpleNoteBake &&
      isSimple &&
      modDepth === 0
    ) {
      return await this.renderSimpleNoteTypedArray(
        entry,
        bakeChannelMix,
      );
    }

    const { startTime: noteStartTime = 0, events: noteEvents = [] } =
      entry.noteEvent ?? {};
    // All Sound Off (CC120): mute instantly — no volEnv release tail.
    const releaseEndDuration = entry.noteEvent?.soundOff
      ? 0
      : entry.voiceParams.releaseVolEnv * envelopeCurve * 5;
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
      const empty = await offlineContext.startRendering();
      return this.detachAudioBuffer(empty);
    }
    await this.scheduleOfflineNoteOn(
      offlinePlayer,
      offlineContext,
      dstChannel,
      entry,
      0,
      bakeChannelMix,
    );
    // Replay in-note automation relative to note-on.
    // Prefer ticks→seconds via this note's duration/durationTicks so the
    // curve stays aligned with the baked note length even when startTime
    // units and tempo interact poorly. Fallback keeps the historical
    // startTime/tempo formula.
    //
    // Allow events through the release tail (not only up to noteDuration):
    // realtime playback still applies pitch bend after note-off while the
    // voice is releasing; skipping those made bends sound early/shifted.
    const tMax = entry.noteDuration + releaseEndDuration;
    const noteOnEvent = entry.noteEvent;
    for (let i = 0; i < noteEvents.length; i++) {
      const event = noteEvents[i];
      if (event.type === "programChange") continue;
      let t = this.relativeTimeInNote(event, noteOnEvent, noteStartTime);
      if (t < -1e-4 || t > tMax) continue;
      if (t < 0) t = 0;
      offlinePlayer.processTimelineEvent(event, t, {
        channels: offlinePlayer.channels,
      });
    }
    if (entry.noteEvent?.soundOff) {
      // Instant mute (CC120 All Sound Off) — match realtime soundOffNote.
      const note = offlinePlayer.findNoteForOff(dstChannel, entry.noteNumber);
      if (note) {
        offlinePlayer.removeFromActiveNotes(dstChannel, entry.noteNumber);
        await offlinePlayer.soundOffNote(note, entry.noteDuration);
      }
    } else {
      offlinePlayer.noteOffChannel(
        dstChannel,
        entry.noteNumber,
        0,
        entry.noteDuration,
        true,
      );
    }
    await Promise.resolve();
    const rendered = await offlineContext.startRendering();
    // Detach from OfflineAudioContext so iOS can reclaim the OAC graph.
    return this.detachAudioBuffer(rendered);
  }

  async createFullRenderedBuffer(
    channel: TChannel,
    note: { noteNumber: number; velocity: number },
    voiceParams: VoiceParams,
    noteDuration: number,
    noteEvent: NoteOnEventEntry | undefined = undefined,
  ): Promise<RenderedBuffer> {
    // releaseEndDuration is unused for allocation (renderEntry handles it);
    // keep local only for any future callers that need the span.
    const releaseEndDuration = noteEvent?.soundOff
      ? 0
      : voiceParams.releaseVolEnv * envelopeCurve * 5;
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
    // Include velocity: ADS bake embeds initialAttenuation (velocity-dependent).
    // Without it, soft and loud notes of the same sample collide and dynamics vanish.
    const cacheKey = (audioBufferId! * 128 + note.velocity) * 128 +
      note.noteNumber;
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
    const volReleaseBits = f64ToBigInt(voiceParams.releaseVolEnv);
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
  // secondary cache -- the old per-timelineIndex fullVoiceCache rarely hit.
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
    const releaseEndDuration = noteEvent?.soundOff
      ? 0
      : voiceParams.releaseVolEnv * envelopeCurve * 5;

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
      (note.voice ? getVoiceParams(note.voice, controllerState) : null);
    note.voiceParams = voiceParams;
    if (!voiceParams) return;
    if (note.isTiledGhost) {
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
      // Skip Biquad when filter is fully open, Q is zero, and mod env is idle.
      const filterAudible = isFilterAudible(
        voiceParams.initialFilterFc,
        voiceParams.initialFilterQ,
        voiceParams.modEnvToFilterFc,
      );
      if (filterAudible) {
        const { q, dcGain } = sf2FilterQ(voiceParams.initialFilterQ);
        note.filterDcGain = dcGain;
        note.filterEnvelopeNode = new BiquadFilterNode(audioContext, {
          type: "lowpass",
          Q: q,
        });
      } else {
        note.filterDcGain = 1;
        note.filterEnvelopeNode = null;
      }
      this.setVolumeEnvelope(channel, note, now);
      if (note.filterEnvelopeNode) this.setFilterEnvelope(channel, note, now);
      // Pitch env only when modEnv actually sweeps rate; otherwise a single
      // playbackRate value is enough (avoids cancel/ramp scheduling).
      if (voiceParams.modEnvToPitch !== 0) {
        this.setPitchEnvelope(note, now);
      } else {
        note.bufferSource.playbackRate.value = voiceParams.playbackRate;
      }
      // Keep setDetune (smoothed setTarget) for offline too -- static
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
    if (note.isTiledGhost) return;
    const now = this.audioContext.currentTime;
    if (note.renderedBuffer?.isFull) {
      const rb = note.renderedBuffer;
      const naturalEndTime = note.startTime + rb.buffer.duration;
      const noteOffTime = note.startTime + (rb.noteDuration ?? 0);
      const isEarlyCut = endTime < noteOffTime;
      if (isEarlyCut) {
        const volDuration = note.voiceParams?.releaseVolEnv ?? 0;
        const releaseVolEnvTime = endTime + volDuration;
        try {
          note.volumeNode?.gain
            .cancelScheduledValues(endTime)
            .setTargetAtTime(0, endTime, volDuration * envelopeCurve);
        } catch { /* already closed */ }
        return this.waitSourceEnded(note, releaseVolEnvTime);
      }
      if (naturalEndTime <= now) {
        this.disconnectNote(note);
        return;
      }
      return this.waitSourceEnded(note, naturalEndTime);
    }

    const volDuration = note.voiceParams?.releaseVolEnv ?? 0;
    const releaseVolEnvTime = endTime + volDuration;

    if (note.volumeEnvelopeNode) {
      // "none" mode
      try {
        note.filterEnvelopeNode?.frequency
          .cancelScheduledValues(endTime)
          .exponentialRampToValueAtTime(
            note.adjustedBaseFreq,
            endTime + (note.voiceParams?.releaseModEnv ?? 0),
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
          return this.waitSourceEnded(note, releaseVolEnvTime);
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
    return this.waitSourceEnded(note, releaseVolEnvTime);
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
  getVoiceParams,
  getVoiceParamsForController,
  isFilterAudible,
  type MessageHandler,
  Note,
  pitchEnvelopeKeySet,
  RenderedBuffer,
  sf2FilterQ,
  type TimelineEvent,
  type VoiceParams,
  volumeEnvelopeKeySet,
} from "./base-player.ts";
