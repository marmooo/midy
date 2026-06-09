import { gmliteFactory } from "./setup.ts";
import { registerTimelineTests } from "../basic-mock/timeline.ts";

registerTimelineTests(gmliteFactory, "GMLite");
