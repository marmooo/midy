// Registers all basic-mock tests against MidyGM1.
import { gmliteFactory } from "./setup.ts";
import {
  registerCCTests,
  registerChannelTests,
  registerNoteTests,
  registerPedalTests,
  registerRPNTests,
  registerTimelineTests,
} from "../basic-mock/mod.ts";

const label = "GM1";
const factory = gmliteFactory;
registerNoteTests(factory, label);
registerCCTests(factory, label);
registerPedalTests(factory, label);
registerChannelTests(factory, label);
registerRPNTests(factory, label);
registerTimelineTests(factory, label);
