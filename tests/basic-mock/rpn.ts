// RPN #0 (pitch bend range), RPN null, limitData carry/clamp, CC#101/100/6 round-trip.
import {
  assertAlmostEquals,
  assertEquals,
  PlayerFactory,
  sanOptions,
  setMockCurrentTime,
} from "./types.ts";

export function registerRPNTests(
  makePlayer: PlayerFactory,
  label: string,
): void {
  Deno.test(
    `[${label}] RPN #0: dataMSB=2 sets pitchWheelSensitivity to 200/12800`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 1.0);
      const t = player.audioContext.currentTime;

      channel.setRPNMSB(0);
      channel.setRPNLSB(0);
      channel.dataEntryMSB(2, t);

      assertAlmostEquals(
        channel.state.pitchWheelSensitivity,
        200 / 12800,
        1e-6,
        "pitchWheelSensitivity must be 200/12800 (2 semitones)",
      );
    },
  );

  Deno.test(
    `[${label}] RPN #0: dataLSB refines pitch bend range`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 2.0);
      const t = player.audioContext.currentTime;

      channel.setRPNMSB(0);
      channel.setRPNLSB(0);
      channel.dataEntryMSB(2, t);
      const afterMSBOnly = channel.state.pitchWheelSensitivity;

      channel.dataEntryLSB(64, t);
      const afterLSB = channel.state.pitchWheelSensitivity;

      assertEquals(
        afterLSB > afterMSBOnly,
        true,
        "adding dataLSB must increase pitchWheelSensitivity",
      );
    },
  );

  Deno.test(
    `[${label}] RPN #0: dataMSB=0 dataLSB=0 sets pitchWheelSensitivity to 0`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 3.0);
      const t = player.audioContext.currentTime;

      channel.setRPNMSB(0);
      channel.setRPNLSB(0);
      channel.dataEntryMSB(0, t);

      assertAlmostEquals(
        channel.state.pitchWheelSensitivity,
        0,
        1e-6,
        "pitchWheelSensitivity must be 0 for zero semitone range",
      );
    },
  );

  Deno.test(
    `[${label}] RPN null (0x7F/0x7F) leaves pitchWheelSensitivity unchanged`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 4.0);
      const t = player.audioContext.currentTime;

      const before = channel.state.pitchWheelSensitivity;

      channel.setRPNMSB(0x7F);
      channel.setRPNLSB(0x7F);
      channel.dataEntryMSB(127, t);
      channel.dataEntryLSB(127, t);

      assertAlmostEquals(
        channel.state.pitchWheelSensitivity,
        before,
        1e-6,
        "RPN null must not change pitchWheelSensitivity",
      );
    },
  );

  Deno.test(
    `[${label}] CC#101/100/6 round-trip sets pitchWheelSensitivity`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 5.0);
      const t = player.audioContext.currentTime;

      channel.setControlChange(101, 0, t);
      channel.setControlChange(100, 0, t);
      channel.setControlChange(6, 2, t);

      assertAlmostEquals(
        channel.state.pitchWheelSensitivity,
        200 / 12800,
        1e-6,
        "CC#101/100/6 must have the same effect as setRPNMSB/LSB + dataEntryMSB",
      );
    },
  );

  Deno.test(
    `[${label}] limitData: dataLSB overflow carries into dataMSB`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 6.0);
      const t = player.audioContext.currentTime;

      // Set RPN #0, then manually set dataMSB=1, dataLSB=200 (overflow).
      // limitData(0,127,0,127): dataLSB>127 → dataMSB++ (=2), dataLSB=0
      // pitchBendRange = (2 + 0/128) * 100 = 200 cent
      channel.setRPNMSB(0);
      channel.setRPNLSB(0);
      channel.dataMSB = 1;
      channel.dataLSB = 200;
      channel.dataEntryMSB(1, t); // triggers handleRPN → limitData → handlePitchBendRangeRPN

      assertAlmostEquals(
        channel.state.pitchWheelSensitivity,
        200 / 12800,
        1e-6,
        "LSB overflow must carry into MSB giving 2 semitones",
      );
    },
  );

  Deno.test(
    `[${label}] limitData: dataMSB clamped at 127 with dataLSB set to maxLSB`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 7.0);
      const t = player.audioContext.currentTime;

      // limitData(0,127,0,127) with dataMSB=200 → clamped to dataMSB=127, dataLSB=127
      // pitchBendRange = (127 + 127/128) * 100
      channel.setRPNMSB(0);
      channel.setRPNLSB(0);
      channel.dataMSB = 200;
      channel.dataLSB = 0;
      channel.dataEntryMSB(200, t);

      const expected = (127 + 127 / 128) * 100 / 12800;
      assertAlmostEquals(
        channel.state.pitchWheelSensitivity,
        expected,
        1e-6,
        "dataMSB clamped to 127 must also set dataLSB to 127",
      );
    },
  );

  Deno.test(
    `[${label}] RPN #0 on drum channel applies (no isDrum guard in setPitchBendRange)`,
    sanOptions,
    () => {
      const player = makePlayer();
      const drum = player.channels[9];
      drum.isDrum = true;
      setMockCurrentTime(player.audioContext, 8.0);
      const t = player.audioContext.currentTime;

      drum.setRPNMSB(0);
      drum.setRPNLSB(0);
      drum.dataEntryMSB(2, t);

      // GMLite's setPitchBendRange has no isDrum guard — documents current behaviour.
      assertAlmostEquals(
        drum.state.pitchWheelSensitivity,
        200 / 12800,
        1e-6,
        "RPN #0 applies to drum channel (no isDrum guard in GMLite)",
      );
    },
  );

  Deno.test(
    `[${label}] dataEntryMSB without prior RPN selection is a no-op`,
    sanOptions,
    () => {
      const player = makePlayer();
      const channel = player.channels[1];
      setMockCurrentTime(player.audioContext, 9.0);
      const t = player.audioContext.currentTime;

      // rpnMSB/rpnLSB default to 127 (null RPN) — dataEntryMSB must be ignored.
      const before = channel.state.pitchWheelSensitivity;
      channel.dataEntryMSB(2, t);

      assertAlmostEquals(
        channel.state.pitchWheelSensitivity,
        before,
        1e-6,
        "dataEntryMSB with no RPN selected must not change pitchWheelSensitivity",
      );
    },
  );
}
