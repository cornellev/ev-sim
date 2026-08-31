import { HeadlessEpisode } from "../../app/simulation/headless/HeadlessEpisode.js";
import { simulationSha256 } from "../../app/simulation/kernel/SimulationHashes.js";
import { createHeadlessArtifactSink } from "./HeadlessArtifactSink.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { defaultHeadlessProvenance, HeadlessSession } from "./HeadlessSession.js";

export const POLICY_ACTION_TAPE_KIND = "cev-sim.headless.policy-action-tape";
export const POLICY_ACTION_TAPE_VERSION = 1;

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
        provenanceProvider = defaultHeadlessProvenance,
        sessionFactory = (options) => new HeadlessSession(options),
    } = {}) {
        this.episodeFactory = episodeFactory;
        this.artifactSinkFactory = artifactSinkFactory;
        this.provenanceProvider = provenanceProvider;
        this.sessionFactory = sessionFactory;
    }

    _session() {
        return this.sessionFactory({
            episodeFactory: this.episodeFactory,
            artifactSinkFactory: this.artifactSinkFactory,
            provenanceProvider: this.provenanceProvider,
        });
    }

    async validate(bundle, { episodeSpec = {} } = {}) {
        const session = this._session();
        try {
            const descriptor = await session.prepare(bundle, episodeSpec);
            const verified = session.verified;
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
            await session.close();
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
        const session = this._session();
        let iterator = null;
        const emit = async (event) => {
            if (onEvent) await onEvent(event);
        };
        try {
            const descriptor = await session.prepare(bundle, episodeSpec);
            const reset = await session.reset(undefined, { artifactPolicy, outputUri });
            await emit({
                kind: "cev-sim.headless.reset",
                version: 1,
                environmentIndex: session.episode.episodeSpec.environmentIndex,
                descriptor,
                ...reset,
                info: {
                    ...reset.info,
                    step: String(reset.info.step),
                    simulationTimeNs: String(reset.info.simulationTimeNs),
                },
            });

            iterator = actionIterator(actions);
            let expectedPolicyStep = 1;
            let interruptedBySignal = false;
            while (session.state !== "terminal") {
                const next = await nextAction(iterator, signal);
                if (next.aborted) {
                    interruptedBySignal = true;
                    break;
                }
                if (next.done) break;
                const action = normalizeActionRecord(next.value, expectedPolicyStep);
                const lastTransition = session.step(action);
                await emit({
                    kind: "cev-sim.headless.transition",
                    version: 1,
                    environmentIndex: session.episode.episodeSpec.environmentIndex,
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

            const interrupted = session.state !== "terminal";
            const published = await session.finalize({
                status: interrupted ? "interrupted" : "completed",
                interruptedBySignal,
                expect,
                actionTapeHash,
            });
            const runResult = published.runResult;
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
            await session.abort();
            throw error;
        } finally {
            await session.close();
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
