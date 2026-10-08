import { gmliteFactory } from "./setup.ts";
import { registerMessageTests } from "../basic-mock/message.ts";

registerMessageTests(gmliteFactory, "GM1");
