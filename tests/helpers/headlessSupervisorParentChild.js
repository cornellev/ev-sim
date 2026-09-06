import path from "node:path";

import { measuredStateProfileRef, routeSafetyProfileRef } from "../../app/simulation/headless/ProfileRegistry.js";
import { createStateSensorBackendSelection } from "../../app/simulation/sensors/StateSensorBackend.js";
import { canonicalStringify } from "../../app/simulation/RunManifest.js";
import { HeadlessSupervisor } from "../../server/headless/HeadlessSupervisor.js";
import { createPortableHeadlessBundle } from "./headlessRunnerBundle.js";

const root = path.resolve(process.argv[2]);
const bundle = await createPortableHeadlessBundle();
const bundleId = "parent-death";
const supervisor = new HeadlessSupervisor({ socket: path.join(root, "unused.sock") });
const created = await supervisor.createBatch({
    clientProtocol: { major: 1, minor: 3 },
    runBundles: [{
        bundleId,
        resolvedHash: bundle.resolvedHash,
        simulationSemanticHash: bundle.simulationSemanticHash,
        canonicalJson: Buffer.from(canonicalStringify(bundle)),
    }],
    episodes: [{
        environmentIndex: 0,
        environmentId: "environment-0",
        runBundleId: bundleId,
        resetSeed: "1",
        actionRepeat: 5,
        maxEpisodeSteps: "0",
        observationProfile: measuredStateProfileRef(),
        rewardProfile: routeSafetyProfileRef(),
        backendSelections: [...bundle.resolved.backendSelections, createStateSensorBackendSelection()],
    }],
    artifactPolicy: { profile: 3, outputUri: path.join(root, "artifacts") },
});
if (created.error.code !== 0) throw new Error(created.error.message);
const environment = supervisor.batches.get(created.batch.batchId).environments[0];
process.send?.({ workerPid: environment.worker.pid });
setInterval(() => {}, 60_000);
