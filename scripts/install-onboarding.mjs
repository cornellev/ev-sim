#!/usr/bin/env node
import path from "node:path";
import { installZenohRouter, localZenohCacheRoot } from "../server/interfaces/ZenohLocalRouter.js";

const [installation = process.cwd()] = process.argv.slice(2);
const { binary } = await installZenohRouter(path.join(localZenohCacheRoot(), "router"), {
    legacyRoot: path.join(path.resolve(installation), ".onboarding", "router"),
});
console.log(`Prefetched router: ${binary}`);
console.log("Start the simulator to listen. Import the mapped protobuf interface in Run Configuration and enable Zenoh for the run.");
