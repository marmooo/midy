import { gmliteFactory } from "./setup.ts";
import { registerRPNTests } from "../basic-mock/rpn.ts";

registerRPNTests(gmliteFactory, "GMLite");
