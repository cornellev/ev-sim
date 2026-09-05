import path from "node:path";

import { normalizeEpisodeSpec } from "../../app/simulation/headless/HeadlessEpisode.js";
import { hashSpace, namedTensor, tensorMap } from "../../app/simulation/headless/TensorProtocol.js";
import { canonicalStringify } from "../../app/simulation/RunManifest.js";
import { ERROR_CODE, HEADLESS_PROTOCOL } from "./HeadlessProtocol.js";
import {
    actionIterator,
    nextAction,
    normalizeActionRecord,
} from "./HeadlessRunner.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { HeadlessSupervisor } from "./HeadlessSupervisor.js";
import { errorFromStatus } from "./SupervisorValidation.js";
import { verifyRunBundle } from "./RunBundle.js";

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
    } = {}) {
        if (!config) throw new HeadlessRunnerError("USAGE", "Supervisor-backed execution requires --config.");
        if (!outputUri) throw new HeadlessRunnerError("USAGE", "Supervisor-backed execution requires --output.");
        const verified = verifyRunBundle(bundle);
        const episode = normalizeEpisodeSpec(verified.resolved, episodeSpec);
        const supervisor = this.supervisorFactory({
            config: inlineSupervisorConfig(config),
            // No listener is bound; TCP metadata keeps CLI observations inline
            // instead of emitting shared-memory references that expire on exit.
            tcp: "127.0.0.1:1",
        });
        let batchId = null;
        let iterator = null;
        let terminal = false;
        const emit = async (event) => {
            if (onEvent) await onEvent(event);
        };
        try {
            const created = await supervisor.createBatch({
                clientProtocol: HEADLESS_PROTOCOL,
                runBundles: [{
                    bundleId: episode.runBundleId,
                    resolvedHash: verified.resolvedHash,
                    simulationSemanticHash: verified.simulationSemanticHash,
                    canonicalJson: Buffer.from(canonicalStringify(bundle)),
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
            if (batchId) {
                await supervisor.closeBatch({
                    batchId,
                    finalizeActiveEpisodes: false,
                });
            }
            await supervisor.close();
        }
    }
}
