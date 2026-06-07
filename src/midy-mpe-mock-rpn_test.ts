/**
 * RPN / data entry tests — Cases 57, 58
 *
 * Covers: setRPNMSB + setRPNLSB + dataEntryMSB (pitch bend range, fine tuning),
 * dataIncrement, dataDecrement.
 *
 * What is NOT covered here:
 *   - NRPN (non-registered parameter)  → not yet implemented in library
 *   - RPN #2 (coarse tuning via RPN)   → use setCoarseTuning directly instead
 *
 * Suggested next tests:
 *   - RPN null (0x7F / 0x7F) — should be a safe no-op
 *   - dataEntryLSB (CC#38) refines the LSB before handleRPN fires
 *   - setRPNMSB / setRPNLSB on drum channel — should be ignored
 */
import {
  assertAlmostEquals,
  assertEquals,
  sanOptions,
  setMockCurrentTime,
  setupMidyPlayer,
} from "./midy-mpe-mock-setup.ts";

Deno.test(
  "Case 1: RPN #0 (pitch bend range) via setRPN + dataEntryMSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 520.0);
    const t = player.audioContext.currentTime;

    // Select RPN #0 and write dataMSB=2 → pitchBendRange = 200 cent.
    // setPitchBendRange stores value/12800: 200/12800 = 0.015625.
    channel.setRPNMSB(0);
    channel.setRPNLSB(0);
    channel.dataEntryMSB(2, t);

    assertAlmostEquals(
      channel.state.pitchWheelSensitivity,
      200 / 12800,
      1e-9,
      "pitchWheelSensitivity must be 200/12800 (2 semitones)",
    );
  },
);

Deno.test(
  "Case 2: dataIncrement and dataDecrement adjust dataLSB and re-trigger RPN",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 530.0);
    const t = player.audioContext.currentTime;

    // Select RPN #1 (fine tuning). dataMSB=64 → centre (≈0 cent).
    channel.setRPNMSB(0);
    channel.setRPNLSB(1);
    channel.dataEntryMSB(64, t);
    const base = channel.fineTuning;

    channel.dataIncrement(t);
    assertEquals(channel.fineTuning > base, true, "fineTuning must increase after increment");

    channel.dataDecrement(t);
    assertAlmostEquals(channel.fineTuning, base, 1e-6, "fineTuning must return to base after decrement");
  },
);

Deno.test(
  "Case 3: RPN null (0x7F / 0x7F) is a safe no-op",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 540.0);
    const t = player.audioContext.currentTime;

    const prevSensitivity = channel.state.pitchWheelSensitivity;
    const prevFineTuning = channel.fineTuning;

    // Select RPN null — subsequent data entry must be ignored.
    channel.setRPNMSB(0x7F);
    channel.setRPNLSB(0x7F);
    channel.dataEntryMSB(64, t);
    channel.dataIncrement(t);
    channel.dataDecrement(t);

    assertAlmostEquals(
      channel.state.pitchWheelSensitivity,
      prevSensitivity,
      1e-9,
      "pitchWheelSensitivity must be unchanged after RPN null",
    );
    assertAlmostEquals(
      channel.fineTuning,
      prevFineTuning,
      1e-9,
      "fineTuning must be unchanged after RPN null",
    );
  },
);

Deno.test(
  "Case 4: dataEntryLSB (CC#38) refines LSB before handleRPN fires",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 550.0);
    const t = player.audioContext.currentTime;

    // RPN #1 (fine tuning). Write MSB=64 first, then refine with LSB=64.
    // pitchBendRange formula: (dataMSB * 128 + dataLSB - 8192) / 8192 * 100
    // With MSB=64, LSB=0:  (64*128 + 0  - 8192) / 8192 * 100 = 0
    // With MSB=64, LSB=64: (64*128 + 64 - 8192) / 8192 * 100 ≈ 0.0763 cent
    channel.setRPNMSB(0);
    channel.setRPNLSB(1);
    channel.dataEntryMSB(64, t);
    const afterMSBOnly = channel.fineTuning;

    channel.dataEntryLSB(64, t);
    const afterLSB = channel.fineTuning;

    assertEquals(
      afterLSB !== afterMSBOnly,
      true,
      "fineTuning must change after dataEntryLSB refines the value",
    );
  },
);

Deno.test(
  "Case 5: RPN #2 (coarse tuning) updates coarseTuning via dataEntryMSB",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const channel = player.channels[1];
    setMockCurrentTime(player.audioContext, 560.0);
    const t = player.audioContext.currentTime;

    // RPN #2: coarse tuning. dataMSB=69 → (69 - 64) * 100 = 500 cent.
    channel.setRPNMSB(0);
    channel.setRPNLSB(2);
    channel.dataEntryMSB(69, t);

    assertAlmostEquals(
      channel.coarseTuning,
      500,
      1e-6,
      "coarseTuning must be 500 cent (5 semitones above centre)",
    );
  },
);

Deno.test(
  "Case 6: setRPNMSB / setRPNLSB on drum channel — dataEntryMSB is ignored",
  sanOptions,
  () => {
    const player = setupMidyPlayer();
    const drum = player.channels[9];
    drum.isDrum = true;
    setMockCurrentTime(player.audioContext, 570.0);
    const t = player.audioContext.currentTime;

    const prevSensitivity = drum.state.pitchWheelSensitivity;

    drum.setRPNMSB(0);
    drum.setRPNLSB(0);
    drum.dataEntryMSB(2, t);

    assertEquals(
      drum.state.pitchWheelSensitivity,
      prevSensitivity,
      "drum pitchWheelSensitivity must be unchanged",
    );
  },
);
