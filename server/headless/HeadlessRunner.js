import { createRequire } from "node:module";
import process from "node:process";

import { HeadlessEpisode, TERMINATION_REASON } from "../../app/simulation/headless/HeadlessEpisode.js";
import { simulationSha256 } from "../../app/simulation/kernel/SimulationHashes.js";
import { createHeadlessArtifactSink, resolveArtifactPolicy } from "./HeadlessArtifactSink.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { verifyRunBundle } from "./RunBundle.js";

export const POLICY_ACTION_TAPE_KIND = "cev-sim.headless.policy-action-tape";
export const POLICY_ACTION_TAPE_VERSION = 1;
const PACKAGE_VERSION = createRequire(import.meta.url)("../../package.json").version;

function defaultProvenance(resolved, { episodeSpec = null } = {}) {
    return {
        kind: "cev-sim.headless.provenance",
        version: 1,
        runtimeName: "cev-sim",
        runtimeVersion: PACKAGE_VERSION,
        gitHash: process.env.GIT_HASH || process.env.NEXT_PUBLIC_GIT_HASH || null,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        backendSelections: structuredClone(episodeSpec?.backendSelections || resolved.backendSelections || []),
        createdAt: new Date().toISOString(),
    };
}

function actionIterator(actions) {
    if (actions?.[Symbol.asyncIterator]) return actions[Symbol.asyncIterator]();
    if (actions?.[Symbol.iterator]) {
        const iterator = actions[Symbol.iterator]();
        return { next: async () => iterator.next(), return: async () => iterator.return?.() ?? { done: true } };
    }
    throw new HeadlessRunnerError("INVALID_REQUEST", "Actions must be an iterable or async iterable.");
}

async function nextAction(iterator, signal) {
    if (!signal) return iterator.next();
    if (signal.aborted) return { done: true, aborted: true };
    let abortHandler;
    const aborted = new Promise((resolve) => {
        abortHandler = () => resolve({ done: true, aborted: true });
        signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
        return await Promise.race([iterator.next(), aborted]);
    } finally {
        signal.removeEventListener("abort", abortHandler);
    }
}

function normalizeActionRecord(value, expectedPolicyStep) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Policy action ${expectedPolicyStep} must be an object.`);
    }
    if (value.policyStep !== expectedPolicyStep || !Number.isSafeInteger(value.policyStep)) {
        throw new HeadlessRunnerError(
            "INVALID_REQUEST",
            `Expected policyStep ${expectedPolicyStep}, received ${String(value.policyStep)}.`,
        );
    }
    if (!Array.isArray(value.action) || value.action.length !== 2) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Policy action ${expectedPolicyStep} must contain [speed, steering].`);
    }
    return value.action;
}

function errorAssertions(finalization) {
    return (finalization.assertions || []).filter((entry) => entry.status === "failed" && entry.severity === "error");
}

function failureReason({ finalization, lastTransition, interrupted }) {
    const assertion = errorAssertions(finalization)[0];
    if (assertion) return `Assertion "${assertion.name || assertion.id}" failed${assertion.message ? `: ${assertion.message}` : "."}`;
    const outcome = finalization.scenario?.outcomes?.find((entry) => entry.passed !== true);
    if (outcome) return `Expected outcome "${outcome.name || outcome.id}" failed${outcome.detail ? `: ${outcome.detail}` : "."}`;
    if (interrupted) return "The action source ended before the episode reached a terminal transition.";
    if (lastTransition?.terminated || lastTransition?.truncated) {
        return finalization.scenario?.terminationReason || "The episode ended without satisfying its success criteria.";
    }
    return finalization.scenario?.terminationReason || "The episode did not pass.";
}

function expectationMismatches(expect, result) {
    if (!expect || typeof expect !== "object") return [];
    const mismatches = [];
    for (const field of ["episodeHash", "trajectoryHash", "passed"]) {
        if (expect[field] === null || expect[field] === undefined) continue;
        if (expect[field] !== result[field]) {
            mismatches.push({ field, expected: expect[field], actual: result[field] });
        }
    }
    return mismatches;
}

export function validatePolicyActionTape(tape) {
    if (!tape || tape.kind !== POLICY_ACTION_TAPE_KIND || Number(tape.version) !== POLICY_ACTION_TAPE_VERSION) {
        throw new HeadlessRunnerError(
            "INVALID_REQUEST",
            `Expected ${POLICY_ACTION_TAPE_KIND} version ${POLICY_ACTION_TAPE_VERSION}.`,
        );
    }
    if (!Array.isArray(tape.actions)) {
        throw new HeadlessRunnerError("INVALID_REQUEST", "Policy action tape actions must be an array.");
    }
    tape.actions.forEach((entry, index) => normalizeActionRecord(entry, index + 1));
    if (tape.episodeSpec !== undefined && (!tape.episodeSpec || typeof tape.episodeSpec !== "object" || Array.isArray(tape.episodeSpec))) {
        throw new HeadlessRunnerError("INVALID_REQUEST", "Policy action tape episodeSpec must be an object.");
    }
    if (tape.expect !== undefined && (!tape.expect || typeof tape.expect !== "object" || Array.isArray(tape.expect))) {
        throw new HeadlessRunnerError("INVALID_REQUEST", "Policy action tape expect must be an object.");
    }
    return tape;
}

export class HeadlessRunner {
    constructor({
        episodeFactory = () => new HeadlessEpisode(),
        artifactSinkFactory = createHeadlessArtifactSink,
        provenanceProvider = defaultProvenance,
    } = {}) {
        this.episodeFactory = episodeFactory;
        this.artifactSinkFactory = artifactSinkFactory;
        this.provenanceProvider = provenanceProvider;
    }

    async validate(bundle, { episodeSpec = {} } = {}) {
        const verified = verifyRunBundle(bundle);
        const episode = this.episodeFactory();
        try {
            const descriptor = await episode.prepare(verified.resolved, episodeSpec);
            return {
                kind: "cev-sim.headless.validation",
                version: 1,
                ok: true,
                manifestId: verified.resolved.manifest.id,
                resolvedHash: verified.resolvedHash,
                simulationSemanticHash: verified.simulationSemanticHash,
                ...descriptor,
            };
        } finally {
            episode.dispose();
        }
    }

    async run(bundle, {
        episodeSpec = {},
        actions = [],
        artifactPolicy = null,
        outputUri = null,
        onEvent = null,
        signal = null,
        expect = null,
        actionTapeHash = null,
    } = {}) {
        const verified = verifyRunBundle(bundle);
        const episode = this.episodeFactory();
        let artifactSink = null;
        let iterator = null;
        const emit = async (event) => {
            if (onEvent) await onEvent(event);
        };
        try {
            const descriptor = await episode.prepare(verified.resolved, episodeSpec);
            const reset = episode.reset();
            // Establish a simulation-time origin before scripts and topic routing
            // consult the SignalStore on the first fixed step.
            episode.kernel.publishSimulationEntities();
            episode.kernel.publishRuntimeState();
            await emit({
                kind: "cev-sim.headless.reset",
                version: 1,
                environmentIndex: episode.episodeSpec.environmentIndex,
                descriptor,
                ...reset,
                info: {
                    ...reset.info,
                    step: String(reset.info.step),
                    simulationTimeNs: String(reset.info.simulationTimeNs),
                },
            });

            const policy = resolveArtifactPolicy(artifactPolicy, verified.resolved.manifest, outputUri);
            const provenance = await this.provenanceProvider(verified.resolved, {
                bundle,
                descriptor,
                episodeSpec: episode.episodeSpec,
            });
            artifactSink = await this.artifactSinkFactory({ bundle, episode, policy, provenance });
            await artifactSink.start();

            iterator = actionIterator(actions);
            let expectedPolicyStep = 1;
            let lastTransition = null;
            let interruptedBySignal = false;
            while (!episode.terminal) {
                const next = await nextAction(iterator, signal);
                if (next.aborted) {
                    interruptedBySignal = true;
                    break;
                }
                if (next.done) break;
                const action = normalizeActionRecord(next.value, expectedPolicyStep);
                lastTransition = episode.step(action);
                await emit({
                    kind: "cev-sim.headless.transition",
                    version: 1,
                    environmentIndex: episode.episodeSpec.environmentIndex,
                    policyStep: expectedPolicyStep,
                    ...lastTransition,
                    info: {
                        ...lastTransition.info,
                        step: String(lastTransition.info.step),
                        simulationTimeNs: String(lastTransition.info.simulationTimeNs),
                    },
                });
                expectedPolicyStep += 1;
            }
            await iterator.return?.();
            iterator = null;

            const interrupted = !episode.terminal;
            const finalization = episode.finalize({ status: interrupted ? "interrupted" : "completed" });
            const assertionsFailed = errorAssertions(finalization).length > 0;
            const scenarioPassed = finalization.scenario
                ? finalization.scenario.passed === true
                : lastTransition?.terminated === true
                    && lastTransition.info?.terminationReason === TERMINATION_REASON.SUCCESS;
            const semanticPassed = !interrupted && scenarioPassed && !assertionsFailed;
            let runResult = {
                kind: "cev-sim.run-result",
                version: 1,
                runId: `run-${finalization.episodeHash.slice(0, 16)}`,
                manifestId: verified.resolved.manifest.id,
                environmentIndex: episode.episodeSpec.environmentIndex,
                environmentId: episode.episodeSpec.environmentId,
                scenarioId: verified.resolved.scenario?.scenario?.id ?? null,
                status: semanticPassed ? "passed" : interrupted ? "interrupted" : "failed",
                completed: !interrupted,
                passed: semanticPassed,
                interrupted,
                interruptedBySignal,
                resolvedHash: verified.resolvedHash,
                simulationSemanticHash: finalization.simulationSemanticHash,
                episodeHash: finalization.episodeHash,
                trajectoryHash: finalization.trajectoryHash,
                actionTapeHash,
                step: String(finalization.step),
                policyStep: expectedPolicyStep - 1,
                timeNs: String(finalization.timeNs),
                terminationReason: lastTransition?.info?.terminationReason ?? null,
                truncationReason: lastTransition?.info?.truncationReason ?? null,
                scenarioTerminationReason: finalization.scenario?.terminationReason ?? null,
                assertions: finalization.assertions,
                outcomes: finalization.scenario?.outcomes ?? [],
                metrics: finalization.scenario?.metrics ?? {},
                failureReason: semanticPassed ? null : failureReason({ finalization, lastTransition, interrupted }),
                degraded: false,
                artifactWarnings: [],
                completedAt: new Date().toISOString(),
            };
            const mismatches = expectationMismatches(expect, runResult);
            if (mismatches.length > 0) {
                runResult = {
                    ...runResult,
                    status: "failed",
                    passed: false,
                    expectationMismatches: mismatches,
                    failureReason: `Replay expectations did not match: ${mismatches.map((entry) => entry.field).join(", ")}.`,
                };
            }
            const published = await artifactSink.finalize(runResult);
            runResult = published.runResult;
            const event = {
                kind: "cev-sim.headless.result",
                version: 1,
                result: runResult,
                artifacts: published.artifacts,
                outputDirectory: published.outputDirectory,
            };
            await emit(event);
            return event;
        } catch (error) {
            try {
                await iterator?.return?.();
            } catch {
                // Preserve the primary runner or input failure.
            }
            await artifactSink?.abort?.();
            throw error;
        } finally {
            episode.dispose();
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
