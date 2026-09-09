import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import { normalizeEpisodeSpec } from "../../app/simulation/headless/HeadlessEpisode.js";
import { simulationSha256 } from "../../app/simulation/kernel/SimulationHashes.js";
import { hashSpace, namedTensor, tensorMap } from "../../app/simulation/headless/TensorProtocol.js";
import { ERROR_CODE, HEADLESS_PROTOCOL } from "./HeadlessProtocol.js";
import {
    actionIterator,
    nextAction,
    normalizeActionRecord,
    validatePolicyActionTape,
} from "./HeadlessRunner.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { HeadlessSupervisor } from "./HeadlessSupervisor.js";
import { errorFromStatus } from "./SupervisorValidation.js";
import { canonicalRunBundleStringify, verifyRunBundle, verifyRunBundleIntegrity } from "./RunBundle.js";
import { stageRunPackage } from "./VisualAssetAdmission.js";

const ARTIFACT_PROFILES = Object.freeze({
    evaluation: 1,
    training: 2,
    disabled: 3,
});

function assertResponse(response, result = null) {
    if (Number(response?.error?.code) !== ERROR_CODE.OK) throw errorFromStatus(response?.error);
    if (result && Number(result.error?.code) !== ERROR_CODE.OK) throw errorFromStatus(result.error);
    return result;
}

function artifactPolicyForSupervisor(policy = {}, outputUri) {
    policy ||= {};
    const supplied = policy.profile;
    const profile = supplied === undefined
        ? 0
        : typeof supplied === "number"
            ? supplied
            : ARTIFACT_PROFILES[supplied];
    if (!Number.isSafeInteger(profile) || profile < 0 || profile > 3) {
        throw new HeadlessRunnerError("INVALID_REQUEST", "Artifact profile must be evaluation, training, or disabled.");
    }
    return {
        profile,
        outputUri,
        fullSflogSampleRate: Number(policy.fullSflogSampleRate || 0),
        fullSflogOnFailure: policy.fullSflogOnFailure ?? true,
    };
}

function inlineSupervisorConfig(config) {
    const resolved = { ...config };
    delete resolved.socket;
    delete resolved.tcp;
    return resolved;
}

export class SupervisorRunner {
    constructor({
        supervisorFactory = (options) => new HeadlessSupervisor(options),
    } = {}) {
        this.supervisorFactory = supervisorFactory;
    }

    async run(bundle, {
        config,
        episodeSpec = {},
        actions = [],
        artifactPolicy = null,
        outputUri = null,
        onEvent = null,
        signal = null,
        packagePath = null,
        expect = null,
        actionTapeHash = null,
    } = {}) {
        if (!config) throw new HeadlessRunnerError("USAGE", "Supervisor-backed execution requires --config.");
        if (!outputUri) throw new HeadlessRunnerError("USAGE", "Supervisor-backed execution requires --output.");
        const verified = packagePath ? verifyRunBundleIntegrity(bundle) : verifyRunBundle(bundle);
        const episode = normalizeEpisodeSpec(verified.resolved, episodeSpec);
        const supervisorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-supervisor-runner-"));
        let supervisor = null;
        let batchId = null;
        let admission = null;
        let iterator = null;
        let terminal = false;
        const emit = async (event) => {
            if (onEvent) await onEvent(event);
        };
        try {
            supervisor = this.supervisorFactory({
                config: inlineSupervisorConfig(config),
                socket: path.join(supervisorRoot, "supervisor.sock"),
                inlineObservations: true,
            });
            if (packagePath) {
                const capabilities = await supervisor.getCapabilities({ clientProtocol: HEADLESS_PROTOCOL });
                assertResponse(capabilities);
                if (!capabilities.assetAdmissionProfiles.includes("cev-sim.run-package@1")) {
                    throw new HeadlessRunnerError(
                        "UNSUPPORTED_CAPABILITY",
                        "Supervisor does not advertise cev-sim.run-package@1 admission.",
                    );
                }
                const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir, {
                    signal, limits: supervisor.config.assetAdmission.limits,
                });
                try {
                    const admitted = await supervisor.admitRunPackage({
                        clientProtocol: HEADLESS_PROTOCOL,
                        stagingId: staged.stagingId,
                        archiveHash: staged.archiveHash,
                    });
                    assertResponse(admitted);
                    admission = admitted.admission;
                } finally {
                    await fs.rm(staged.path, { force: true }).catch(() => {});
                }
            }
            signal?.throwIfAborted();
            const created = await supervisor.createBatch({
                clientProtocol: HEADLESS_PROTOCOL,
                runBundles: [{
                    bundleId: episode.runBundleId,
                    resolvedHash: verified.resolvedHash,
                    simulationSemanticHash: verified.simulationSemanticHash,
                    canonicalJson: Buffer.from(canonicalRunBundleStringify(bundle)),
                    ...(admission ? { assetAdmission: admission } : {}),
                }],
                episodes: [episode],
                artifactPolicy: artifactPolicyForSupervisor(artifactPolicy, outputUri),
            }, { signal });
            assertResponse(created);
            batchId = created.batch.batchId;
            const environment = created.batch.environments[0];
            const descriptor = {
                episodeHash: environment.episodeHash,
                actionSpace: created.batch.actionSpace,
                observationSpace: created.batch.observationSpace,
                actionSpaceHash: hashSpace(created.batch.actionSpace),
                observationSpaceHash: hashSpace(created.batch.observationSpace),
            };

            const resetResponse = await supervisor.resetBatch({
                batchId,
                episodes: [episode],
            }, { signal });
            const reset = assertResponse(resetResponse, resetResponse.results?.[0]);
            await emit({
                kind: "cev-sim.headless.reset",
                version: 1,
                executionMode: "supervisor",
                environmentIndex: 0,
                descriptor,
                observation: reset.observation,
                info: reset.info,
            });

            iterator = actionIterator(actions);
            let expectedPolicyStep = 1;
            while (!terminal) {
                const next = await nextAction(iterator, signal);
                if (next.done || next.aborted) break;
                const action = normalizeActionRecord(next.value, expectedPolicyStep);
                const response = await supervisor.stepBatch({
                    batchId,
                    actions: [{
                        environmentIndex: 0,
                        action: tensorMap([namedTensor("action", "float32", [2], action)]),
                    }],
                }, { signal });
                const transition = assertResponse(response, response.results?.[0]);
                await emit({
                    kind: "cev-sim.headless.transition",
                    version: 1,
                    executionMode: "supervisor",
                    environmentIndex: 0,
                    policyStep: expectedPolicyStep,
                    observation: transition.observation,
                    reward: transition.reward,
                    terminated: transition.terminated,
                    truncated: transition.truncated,
                    info: transition.info,
                });
                terminal = transition.terminated || transition.truncated;
                expectedPolicyStep += 1;
            }
            await iterator.return?.();
            iterator = null;

            const finalizedResponse = await supervisor.finalizeBatch({
                batchId,
                environmentIndices: [0],
            }, {
                finalizeOptions: {
                    interruptedBySignal: !terminal && Boolean(signal?.aborted),
                    expect,
                    actionTapeHash,
                },
            });
            const finalized = assertResponse(finalizedResponse, finalizedResponse.results?.[0]);
            const runResult = JSON.parse(Buffer.from(finalized.canonicalResultJson).toString("utf8"));
            const outputDirectory = finalized.artifacts?.[0]?.uri
                ? path.dirname(finalized.artifacts[0].uri)
                : null;
            const event = {
                kind: "cev-sim.headless.result",
                version: 1,
                executionMode: "supervisor",
                result: runResult,
                artifacts: finalized.artifacts || [],
                outputDirectory,
            };
            await emit(event);
            return event;
        } catch (error) {
            try {
                await iterator?.return?.();
            } catch {
                // Preserve the primary runner or action-input failure.
            }
            throw error;
        } finally {
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
                    try {
                        await supervisor?.close();
                    } finally {
                        await fs.rm(supervisorRoot, { recursive: true, force: true });
                    }
                }
            }
        }
    }

    async replay(bundle, tape, options = {}) {
        const validated = validatePolicyActionTape(tape);
        return this.run(bundle, {
            ...options,
            episodeSpec: { ...(validated.episodeSpec || {}), ...(options.episodeSpec || {}) },
            actions: validated.actions,
            expect: validated.expect || null,
            actionTapeHash: simulationSha256(validated),
        });
    }
}
