import { gmliteFactory } from "./setup.ts";
import { registerChannelTests } from "../basic-mock/channel.ts";

registerChannelTests(gmliteFactory, "GM1");
