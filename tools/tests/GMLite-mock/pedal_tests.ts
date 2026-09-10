import { gmliteFactory } from "./setup.ts";
import { registerPedalTests } from "../basic-mock/pedal.ts";

registerPedalTests(gmliteFactory, "GMLite");
