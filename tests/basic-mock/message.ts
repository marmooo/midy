// Raw MIDI handleMessage dispatch (status bytes → channel methods).
import {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  type BasicPlayer,
  flushNotePromises,
  PlayerFactory,
  sanOptions,
  setMockCurrentTime,
} from "./types.ts";

/** BasicPlayer plus the live MIDI message router. */
type MessagePlayer = BasicPlayer & {
  handleMessage(data: Uint8Array, scheduleTime: number): void;
};

export function registerMessageTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  function asMessagePlayer(): MessagePlayer {
    return makePlayer() as unknown as MessagePlayer;
  }

  Deno.test(
    `[${label}] handleMessage noteOn (0x90) registers active note`,
    sanOptions,
    async () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 1.0);
      const t = player.audioContext.currentTime;

      // status=0x90 ch0, note=60, velocity=100
      player.handleMessage(new Uint8Array([0x90, 60, 100]), t);
      // noteOn is async via the handler; give the microtask queue a tick.
      await flushNotePromises(player);
      // Handlers may not await noteOn — poll after a short settle.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));
      await flushNotePromises(player);

      const stack = player.channels[0].activeNotes[60];
      assertNotEquals(stack, undefined, "noteOn via handleMessage must stack");
      assertEquals((stack as unknown[]).length >= 1, true);
    },
  );

  Deno.test(
    `[${label}] handleMessage noteOff (0x80) releases the note`,
    sanOptions,
    async () => {
      const player = asMessagePlayer();
      const channel = player.channels[0];
      setMockCurrentTime(player.audioContext, 2.0);
      const t = player.audioContext.currentTime;

      await channel.noteOn(60, 100, t);
      assertEquals((channel.activeNotes[60] as unknown[]).length, 1);

      player.handleMessage(new Uint8Array([0x80, 60, 0]), t + 0.05);
      await flushNotePromises(player);
      await new Promise((r) => setTimeout(r, 20));
      await flushNotePromises(player);

      const stack = channel.activeNotes[60] as unknown[] | undefined;
      assertEquals(
        stack === undefined || stack.length === 0,
        true,
        "noteOff via handleMessage must clear the stack",
      );
    },
  );

  Deno.test(
    `[${label}] handleMessage CC (0xB0) volume updates state`,
    sanOptions,
    () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 3.0);
      const t = player.audioContext.currentTime;

      // CC#7 volume = 100 on channel 0
      player.handleMessage(new Uint8Array([0xB0, 7, 100]), t);
      assertAlmostEquals(
        player.channels[0].state.volumeMSB,
        100 / 127,
        1e-6,
      );
    },
  );

  Deno.test(
    `[${label}] handleMessage program change (0xC0)`,
    sanOptions,
    () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 4.0);
      const t = player.audioContext.currentTime;

      player.handleMessage(new Uint8Array([0xC0, 42]), t);
      assertEquals(player.channels[0].programNumber, 42);
    },
  );

  Deno.test(
    `[${label}] handleMessage pitch bend (0xE0) center is 8192/16383`,
    sanOptions,
    () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 5.0);
      const t = player.audioContext.currentTime;

      // LSB=0 MSB=64 → 64*128+0 = 8192 (center).
      // state.pitchWheel is stored normalized in [0, 1].
      player.handleMessage(new Uint8Array([0xE0, 0, 64]), t);
      assertAlmostEquals(
        player.channels[0].state.pitchWheel,
        8192 / 16383,
        1e-6,
      );
    },
  );

  Deno.test(
    `[${label}] handleMessage pitch bend max is 1.0`,
    sanOptions,
    () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 6.0);
      const t = player.audioContext.currentTime;

      // LSB=127 MSB=127 → 127*128+127 = 16383 → normalized 1.0
      player.handleMessage(new Uint8Array([0xE0, 127, 127]), t);
      assertAlmostEquals(player.channels[0].state.pitchWheel, 1.0, 1e-6);
    },
  );

  Deno.test(
    `[${label}] handleMessage routes by channel nibble`,
    sanOptions,
    async () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 7.0);
      const t = player.audioContext.currentTime;

      // noteOn on channel 3 (0x93)
      player.handleMessage(new Uint8Array([0x93, 72, 90]), t);
      await flushNotePromises(player);
      await new Promise((r) => setTimeout(r, 20));
      await flushNotePromises(player);

      assertEquals(
        player.channels[0].activeNotes[72],
        undefined,
        "channel 0 must stay empty",
      );
      const stack = player.channels[3].activeNotes[72];
      assertNotEquals(stack, undefined, "channel 3 must hold the note");
    },
  );

  Deno.test(
    `[${label}] handleMessage CC#64 sustain via status 0xB0`,
    sanOptions,
    () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 8.0);
      const t = player.audioContext.currentTime;

      player.handleMessage(new Uint8Array([0xB0, 64, 127]), t);
      assertEquals(
        player.channels[0].state.sustainPedal >= 0.5,
        true,
        "sustain ON via handleMessage",
      );
      player.handleMessage(new Uint8Array([0xB0, 64, 0]), t);
      assertEquals(
        player.channels[0].state.sustainPedal < 0.5,
        true,
        "sustain OFF via handleMessage",
      );
    },
  );

  Deno.test(
    `[${label}] handleMessage unknown status is a safe no-op`,
    sanOptions,
    () => {
      const player = asMessagePlayer();
      setMockCurrentTime(player.audioContext, 9.0);
      const t = player.audioContext.currentTime;

      // 0xF1 MIDI Time Code Quarter Frame — no handler registered
      player.handleMessage(new Uint8Array([0xF1, 0x00]), t);
      // Must not throw; channel state unchanged.
      assertEquals(player.channels[0].programNumber, 0);
    },
  );
}
