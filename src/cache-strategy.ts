// Cache-mode strategy types, constants, and pure helpers for the MIDI player.
//
// Modes
// -----
// - `"none"`    Full real-time control (dynamic CC, LFO, pitch). Highest CPU.
// - `"ads"`     Pre-render ADS; release fades in real time. LFO stays live.
// - `"adsr"`    Pre-render full ADSR keyed by duration ticks + volRelease.
// - `"note"`    Per-note offline bake (automation in-interval). MIDI-file only.
// - `"segment"` Per-channel tiled offline buffers; channel vol/pan stay live.
// - `"chunk"`   All-channel tiled offline mix; vol/pan snapshotted into buffer.
// - `"audio"`   Entire song pre-rendered to one buffer. Lowest CPU.
//
// Simple vs complex notes (note / segment / chunk / audio)
// -----
// Notes with no in-interval pitch-bend / CC / SysEx share `simpleNoteBufferCache`.
// Notes with automation share `complexNoteBufferCache` when the key appears
// more than once (see `complexNoteCounts`).
//
// bakeChannelMix
// -----
// - `true`  (note / chunk / audio): channel bus + effect sends inside the buffer.
// - `false` (segment dry): volumeNode rewired to destination; vol/pan/sends live.

import type { Voice, VoiceParams } from "@marmooo/soundfont-parser";
import type { RenderedBuffer, TimelineEvent } from "./base-player.ts";

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export const DEFAULT_CACHE_MODE: CacheMode = "segment";

export type CacheMode =
  | "none"
  | "ads"
  | "adsr"
  | "note"
  | "segment"
  | "chunk"
  | "audio";

// Modes that tile notes into offline buffers (per-channel or all-channel).
export function isTiledCacheMode(mode: CacheMode): boolean {
  return mode === "segment" || mode === "chunk";
}

export function isSegmentCacheMode(mode: CacheMode): boolean {
  return mode === "segment";
}

export function isChunkCacheMode(mode: CacheMode): boolean {
  return mode === "chunk";
}

// Modes that need note-on → note-off duration analysis (`buildNoteOnDurations`).
export function needsNoteOnDurations(mode: CacheMode): boolean {
  return (
    mode === "adsr" ||
    mode === "note" ||
    mode === "audio" ||
    mode === "segment" ||
    mode === "chunk"
  );
}

// Modes that classify simple/complex notes and use those buffer caches.
export function usesSimpleComplexNoteCache(mode: CacheMode): boolean {
  return (
    mode === "note" ||
    mode === "segment" ||
    mode === "chunk" ||
    mode === "audio"
  );
}

// Whether offline single-note / mix bakes should include channel vol/pan and
// mix-level effect sends inside the rendered buffer.
// Segment keeps those live via gainL/gainR (and Midy delay).
export function bakeChannelMixForMode(mode: CacheMode): boolean {
  return mode !== "segment";
}

// Modes that primarily schedule Web Audio nodes in real time (not full bake).
export function isRealtimeCacheMode(mode: CacheMode): boolean {
  return mode === "none" || mode === "ads" || mode === "adsr";
}

// Modes that only work for MIDI-file playback (not live MIDI input).
export function isMidiFileOnlyCacheMode(mode: CacheMode): boolean {
  return (
    mode === "note" ||
    mode === "segment" ||
    mode === "chunk" ||
    mode === "audio"
  );
}

// ---------------------------------------------------------------------------
// ADS / shared voice cache
// ---------------------------------------------------------------------------

export interface CacheEntry {
  audioBuffer: RenderedBuffer;
  maxCount: number;
  counter: number;
}

// ---------------------------------------------------------------------------
// Note-on duration / automation timeline (adsr / note / segment / chunk / audio)
// ---------------------------------------------------------------------------

export interface NoteOnEventEntry {
  duration: number;
  durationTicks: number;
  startTime: number;
  // Note-on absolute ticks (for relative automation keying).
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

// ---------------------------------------------------------------------------
// Segment mode
// ---------------------------------------------------------------------------

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
  // Snapshot of channel.detune / channel.state.array at segment-open
  // (first note's onset), not segment-close. `scheduleTimelineEvents`
  // applies every CC/pitchBend to the realtime channel as the timeline
  // is walked, so by `closeSegment()` the live channel already reflects
  // in-segment events. `renderSegmentBuffer` seeds the offline channel
  // from this snapshot and replays events chronologically (same approach
  // as `renderChunkBuffer`) so pitch bend is not double-counted.
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
  // Compared against the player's `segmentGeneration` when the render
  // resolves. Seek/stop/loop bumps generation so stale buffers are discarded.
  generation: number;
}

export interface SegmentChannelState {
  openSegment: OpenSegment | null;
  pending: PendingSegment[];
}

// ---------------------------------------------------------------------------
// Chunk mode (all channels in one offline window)
// ---------------------------------------------------------------------------

// Like `SegmentNoteEntry`, plus `channelNumber` / `isDrum` for the mix graph.
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
  // Per-channel state at append time. Volume/pan/expression are baked into
  // the chunk buffer, so they must be captured before later events change them.
  channelDetune: number;
  channelStateArray: Float32Array;
  programNumber: number;
  isDrum: boolean;
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

// ---------------------------------------------------------------------------
// Shared offline bake input (simple + complex notes)
// ---------------------------------------------------------------------------

// Shared input for single-note offline bakes (simple + complex).
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
