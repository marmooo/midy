// Registers all basic-mock tests against Midy.
import { gmliteFactory } from "./setup.ts";
import {
  registerCCTests,
  registerChannelTests,
  registerNoteTests,
  registerPedalTests,
  registerPlaybackTests,
  registerRPNTests,
  registerTimelineTests,
} from "../basic-mock/mod.ts";

const label = "full";
const factory = gmliteFactory;
registerNoteTests(factory, label);
registerCCTests(factory, label);
registerPedalTests(factory, label);
registerChannelTests(factory, label);
registerRPNTests(factory, label);
registerTimelineTests(factory, label);
registerPlaybackTests(factory, label);
