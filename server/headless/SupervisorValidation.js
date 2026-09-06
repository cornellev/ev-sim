import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeEpisodeSpec } from "../../app/simulation/headless/HeadlessEpisode.js";
import { hashSpace } from "../../app/simulation/headless/TensorProtocol.js";
import { ERROR_CODE, HEADLESS_PROTOCOL } from "./HeadlessProtocol.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { HeadlessSupervisor } from "./HeadlessSupervisor.js";
import { canonicalRunBundleStringify, verifyRunBundle } from "./RunBundle.js";

const ERROR_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(ERROR_CODE).map(([name, value]) => [value, name]),
));

export function errorFromStatus(status = {}) {
    const code = ERROR_NAMES[Number(status.code)] || "INTERNAL";
    let details = null;
    const encoded = status.canonicalDetailJson;
    if (encoded?.length > 0) {
        try {
            details = JSON.parse(Buffer.from(encoded).toString("utf8"));
        } catch {
            details = null;
        }
    }
    return new HeadlessRunnerError(code, status.message || "Supervisor validation failed.", details);
}

export async function validateBundleWithSupervisor(bundle, {
    config,
    episodeSpec = {},
    supervisorFactory = (options) => new HeadlessSupervisor(options),
} = {}) {
    if (!config) throw new HeadlessRunnerError("USAGE", "Supervisor-backed validation requires --config.");
    const verified = verifyRunBundle(bundle);
    const normalizedEpisode = normalizeEpisodeSpec(verified.resolved, episodeSpec);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-supervisor-validation-"));
    let supervisor = null;
    let batchId = null;
    try {
        supervisor = supervisorFactory({
            config,
            socket: path.join(root, "supervisor.sock"),
        });
        const created = await supervisor.createBatch({
            clientProtocol: HEADLESS_PROTOCOL,
            runBundles: [{
                bundleId: normalizedEpisode.runBundleId,
                resolvedHash: verified.resolvedHash,
                simulationSemanticHash: verified.simulationSemanticHash,
                canonicalJson: Buffer.from(canonicalRunBundleStringify(bundle)),
            }],
            episodes: [normalizedEpisode],
            artifactPolicy: {
                profile: 3,
                outputUri: path.join(root, "artifacts"),
            },
        });
        if (Number(created.error?.code) !== ERROR_CODE.OK) throw errorFromStatus(created.error);
        batchId = created.batch.batchId;
        const environment = created.batch.environments[0];
        return {
            kind: "cev-sim.headless.validation",
            version: 1,
            ok: true,
            validationMode: "supervisor",
            manifestId: verified.resolved.manifest.id,
            resolvedHash: verified.resolvedHash,
            simulationSemanticHash: verified.simulationSemanticHash,
            episodeHash: environment.episodeHash,
            actionSpace: created.batch.actionSpace,
            observationSpace: created.batch.observationSpace,
            actionSpaceHash: hashSpace(created.batch.actionSpace),
            observationSpaceHash: hashSpace(created.batch.observationSpace),
        };
    } finally {
        try {
            if (batchId) {
                await supervisor.closeBatch({
                    batchId,
                    finalizeActiveEpisodes: false,
                });
            }
            await supervisor?.close();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    }
}
