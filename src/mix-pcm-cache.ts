/**
 * MixPcmCache — pre-sliced PCM for worker mix prepare (midy mix-overhead opt).
 *
 * Goal: remove Float32Array.slice from the hot prepare path when a note
 * AudioBuffer is already in simpleNoteBufferCache.
 *
 * Strategy
 * --------
 * - On bake / first ensure: store owned left/right Float32Arrays (one slice).
 * - Unique + transferable mix entry: *take* those arrays for postMessage
 *   transfer (zero-copy). Cache slot is cleared; restore is deferred until
 *   after the mix await so prepare stays cheap.
 * - Shared (ref>=2) entries: borrow the same arrays without transfer; the
 *   worker pool structured-clones multi-ref buffers.
 * - Full-length notes (trimRatio≈1): transfer/borrow the whole array; no
 *   extra slice to copyLen.
 * - Partial length: subarray view for shared/clone paths; slice(0, copyLen)
 *   only when the result must be uniquely transferred (detach-safe own copy).
 *
 * Drop into midy as `src/mix-pcm-cache.ts` and wire from player.ts
 * (see INTEGRATION.md).
 */

export type MixPcmChannels = {
  left: Float32Array;
  right?: Float32Array;
};

function isDetached(arr: Float32Array): boolean {
  // After transfer, byteLength becomes 0.
  return arr.byteLength === 0;
}

export class MixPcmCache {
  /** Strong keys: same lifetime as simpleNoteBufferCache entries. */
  private readonly map = new Map<AudioBuffer, MixPcmChannels>();

  /** Buffers whose PCM was taken for transfer and still need restore. */
  private readonly pendingRestore = new Set<AudioBuffer>();

  clear(): void {
    this.map.clear();
    this.pendingRestore.clear();
  }

  delete(buf: AudioBuffer): void {
    this.map.delete(buf);
    this.pendingRestore.delete(buf);
  }

  has(buf: AudioBuffer): boolean {
    const e = this.map.get(buf);
    return !!e && !isDetached(e.left);
  }

  /**
   * Ensure owned PCM exists for `buf`. Slices once from the AudioBuffer.
   * Safe to call from bake completion and from prepare.
   */
  ensure(buf: AudioBuffer): MixPcmChannels {
    const existing = this.map.get(buf);
    if (existing && !isDetached(existing.left)) {
      return existing;
    }
    const left = buf.getChannelData(0).slice();
    const right = buf.numberOfChannels > 1
      ? buf.getChannelData(1).slice()
      : undefined;
    const entry: MixPcmChannels = { left, right };
    this.map.set(buf, entry);
    this.pendingRestore.delete(buf);
    return entry;
  }

  /**
   * Fill from an already-owned pair (e.g. bake path that produced channels).
   * Avoids a second getChannelData().slice when the caller already sliced.
   */
  setOwned(buf: AudioBuffer, left: Float32Array, right?: Float32Array): void {
    this.map.set(buf, { left, right });
    this.pendingRestore.delete(buf);
  }

  /**
   * Borrow PCM for a shared (multi-ref) entry. Does not remove from cache.
   * Returns full-length owned arrays; caller may .subarray(0, copyLen) for
   * the entry without copying when the path is structured-clone (not transfer).
   */
  borrow(buf: AudioBuffer): MixPcmChannels {
    return this.ensure(buf);
  }

  /**
   * Take PCM for a unique transferable entry. Removes the slot so transfer
   * can detach the ArrayBuffer without breaking a shared cache entry.
   * Schedules restore via {@link restoreAfterTransfer} after mix completes.
   *
   * If copyLen < full length, returns a *new* slice(0, copyLen) and keeps
   * the full-length cache entry intact (still one slice, but only for the
   * trimmed payload — rare when trimRatio≈0.99).
   */
  takeForTransfer(buf: AudioBuffer, copyLen: number): MixPcmChannels {
    const full = this.ensure(buf);
    const fullLen = full.left.length;
    if (copyLen >= fullLen) {
      // Full-length zero-copy: hand off ownership.
      this.map.delete(buf);
      this.pendingRestore.add(buf);
      return full;
    }
    // Partial: must own a trimmed buffer for transfer; keep full in cache.
    const left = full.left.slice(0, copyLen);
    const right = full.right ? full.right.slice(0, copyLen) : undefined;
    return { left, right };
  }

  /**
   * View for shared path with optional length trim (no copy when possible).
   * Shared arrays are never transferred, so subarray is safe.
   */
  viewForShared(buf: AudioBuffer, copyLen: number): MixPcmChannels {
    const full = this.borrow(buf);
    if (copyLen >= full.left.length) return full;
    return {
      left: full.left.subarray(0, copyLen),
      right: full.right ? full.right.subarray(0, copyLen) : undefined,
    };
  }

  /**
   * Restore any buffers that were transferred. Call after mix await so
   * slice cost lands off the prepare critical path.
   */
  restoreAfterTransfer(bufs: Iterable<AudioBuffer>): void {
    for (const buf of bufs) {
      if (!this.pendingRestore.has(buf) && this.has(buf)) continue;
      try {
        this.ensure(buf);
      } catch {
        // AudioBuffer may have been GC'd / evicted from simple cache.
        this.pendingRestore.delete(buf);
        this.map.delete(buf);
      }
    }
  }

  /** Restore all pending (e.g. end of tile batch). */
  restoreAllPending(): void {
    if (this.pendingRestore.size === 0) return;
    const list = [...this.pendingRestore];
    this.pendingRestore.clear();
    this.restoreAfterTransfer(list);
  }

  get size(): number {
    return this.map.size;
  }

  get pendingCount(): number {
    return this.pendingRestore.size;
  }
}
