import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeEpisodeSpec } from "../../app/simulation/headless/HeadlessEpisode.js";
import { hashSpace } from "../../app/simulation/headless/TensorProtocol.js";
import { ERROR_CODE, HEADLESS_PROTOCOL } from "./HeadlessProtocol.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { HeadlessSupervisor } from "./HeadlessSupervisor.js";
import { canonicalRunBundleStringify, verifyRunBundle } from "./RunBundle.js";
import { verifyRunBundleIntegrity } from "./RunBundle.js";
import { stageRunPackage } from "./VisualAssetAdmission.js";

const ERROR_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(ERROR_CODE).map(([name, value]) => [value, name]),
));

function inlineSupervisorConfig(config) {
    const resolved = { ...config };
    delete resolved.socket;
    delete resolved.tcp;
    return resolved;
}

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
    packagePath = null,
} = {}) {
    if (!config) throw new HeadlessRunnerError("USAGE", "Supervisor-backed validation requires --config.");
    const verified = packagePath ? verifyRunBundleIntegrity(bundle) : verifyRunBundle(bundle);
    const normalizedEpisode = normalizeEpisodeSpec(verified.resolved, episodeSpec);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-supervisor-validation-"));
    let supervisor = null;
    let batchId = null;
    let admission = null;
    try {
        supervisor = supervisorFactory({
            config: inlineSupervisorConfig(config),
            socket: path.join(root, "supervisor.sock"),
            inlineObservations: true,
        });
        if (packagePath) {
            const capabilities = await supervisor.getCapabilities({ clientProtocol: HEADLESS_PROTOCOL });
            if (Number(capabilities.error?.code) !== ERROR_CODE.OK) throw errorFromStatus(capabilities.error);
            if (!capabilities.assetAdmissionProfiles.includes("cev-sim.run-package@1")) {
                throw new HeadlessRunnerError(
                    "UNSUPPORTED_CAPABILITY",
                    "Supervisor does not advertise cev-sim.run-package@1 admission.",
                );
            }
            const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir);
            try {
                const admitted = await supervisor.admitRunPackage({
                    clientProtocol: HEADLESS_PROTOCOL,
                    stagingId: staged.stagingId,
                    archiveHash: staged.archiveHash,
                });
                if (Number(admitted.error?.code) !== ERROR_CODE.OK) throw errorFromStatus(admitted.error);
                admission = admitted.admission;
            } finally {
                await fs.rm(staged.path, { force: true }).catch(() => {});
            }
        }
        const created = await supervisor.createBatch({
            clientProtocol: HEADLESS_PROTOCOL,
            runBundles: [{
                bundleId: normalizedEpisode.runBundleId,
                resolvedHash: verified.resolvedHash,
                simulationSemanticHash: verified.simulationSemanticHash,
                canonicalJson: Buffer.from(canonicalRunBundleStringify(bundle)),
                ...(admission ? { assetAdmission: admission } : {}),
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
            try {
                if (batchId) {
                    await supervisor.closeBatch({
                        batchId,
                        finalizeActiveEpisodes: false,
                    });
                }
            } finally {
                try {
                    if (admission) await supervisor?.releaseAssetAdmission({ handle: admission.handle });
                } finally {
                    await supervisor?.close();
                }
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    }
}
