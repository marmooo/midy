import { gmliteFactory } from "./setup.ts";
import { registerCCTests } from "../basic-mock/cc.ts";

registerCCTests(gmliteFactory, "full");
