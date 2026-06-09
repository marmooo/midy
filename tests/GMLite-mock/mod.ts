// Registers all basic-mock tests against MidyGMLite.
import { gmliteFactory } from "./setup.ts";
import {
  registerCCTests,
  registerChannelTests,
  registerNoteTests,
  registerPedalTests,
  registerRPNTests,
  registerTimelineTests,
} from "../basic-mock/mod.ts";

const label = "GMLite";
const factory = gmliteFactory;
registerNoteTests(factory, label);
registerCCTests(factory, label);
registerPedalTests(factory, label);
registerChannelTests(factory, label);
registerRPNTests(factory, label);
registerTimelineTests(factory, label);
