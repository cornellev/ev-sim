import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { RecordingController } from "../../app/logging/RecordingController.js";
import { builtInProfile } from "../../app/logging/LogProfiles.js";
import { LogService } from "../logging/LogService.js";
import { stringifyJsonProtocol } from "./JsonProtocol.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";

const PROFILE_BY_NUMBER = Object.freeze({ 1: "evaluation", 2: "training", 3: "disabled" });
const PROFILE_NAMES = new Set(["evaluation", "training", "disabled"]);

function artifactFailure(message, cause) {
    return new HeadlessRunnerError("ARTIFACT_FAILURE", message, null, cause ? { cause } : {});
}

function normalizeProfile(value) {
    if (typeof value === "number") return PROFILE_BY_NUMBER[value] ?? null;
    const normalized = String(value || "").trim().toLowerCase();
    return PROFILE_NAMES.has(normalized) ? normalized : null;
}

export function resolveArtifactPolicy(policy, manifest = {}, outputUri = null) {
    const suppliedProfile = normalizeProfile(policy?.profile);
    if (policy?.profile !== undefined && policy?.profile !== null && !suppliedProfile) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Unsupported artifact profile ${String(policy.profile)}.`);
    }
    const logging = manifest.logging || {};
    let profile;
    let logRequired;
    if (suppliedProfile) {
        profile = suppliedProfile;
        logRequired = profile === "evaluation";
    } else {
        profile = logging.policy === "disabled" ? "disabled" : "evaluation";
        logRequired = logging.policy === "required";
    }
    const sampleRate = Number(policy?.fullSflogSampleRate ?? policy?.full_sflog_sample_rate ?? 0);
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
        throw new HeadlessRunnerError("INVALID_REQUEST", "full_sflog_sample_rate must be within [0, 1].");
    }
    const failureValue = policy?.fullSflogOnFailure ?? policy?.full_sflog_on_failure;
    return Object.freeze({
        profile,
        outputUri: String(policy?.outputUri ?? policy?.output_uri ?? outputUri ?? "").trim(),
        fullSflogSampleRate: profile === "evaluation" ? 1 : sampleRate,
        fullSflogOnFailure: profile === "training" ? failureValue !== false : profile === "evaluation",
        logRequired,
        signalProfileId: suppliedProfile
            ? "simulation-run-full-sensors"
            : String(logging.profileId || "simulation-run-full-sensors"),
    });
}

export function isTrainingLogSampled(episodeHash, sampleRate) {
    if (sampleRate <= 0) return false;
    if (sampleRate >= 1) return true;
    const digest = createHash("sha256")
        .update("cev-sim.training-artifact-sample.v1\0")
        .update(String(episodeHash || ""))
        .digest("hex");
    const top53 = BigInt(`0x${digest.slice(0, 16)}`) >> 11n;
    return Number(top53) / 2 ** 53 < sampleRate;
}

function directLogTransport(service) {
    return {
        createSession: (input) => service.createSession({ ...input, id: "run" }),
        appendBatch: (id, sequence, batch) => service.appendBatch(id, { sequence, ...batch }),
        finalize: (id, patch) => service.finalize(id, patch),
    };
}

async function writeJson(filePath, value) {
    await fs.writeFile(filePath, `${stringifyJsonProtocol(value, 2)}\n`, { flag: "wx" });
}

async function fileRef(directory, name) {
    const filePath = path.join(directory, name);
    const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return {
        name,
        uri: name,
        mimeType: name.endsWith(".sflog") ? "application/x-sflog" : "application/json",
        sizeBytes: String(stat.size),
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}

async function exists(filePath) {
    try {
        await fs.lstat(filePath);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

/** Filesystem-backed artifact sink with whole-directory atomic publication. */
export class HeadlessArtifactSink {
    constructor({ bundle, episode, policy, provenance }) {
        this.bundle = bundle;
        this.episode = episode;
        this.policy = policy;
        this.provenance = provenance;
        this.outputDirectory = null;
        this.stagingDirectory = null;
        this.recording = null;
        this.started = false;
    }

    async start() {
        if (this.started) throw artifactFailure("The artifact sink has already started.");
        if (!this.policy.outputUri) throw artifactFailure("An artifact output directory is required.");
        const outputDirectory = path.resolve(this.policy.outputUri);
        const parent = path.dirname(outputDirectory);
        const base = path.basename(outputDirectory);
        if (!base || base === "." || base === path.parse(outputDirectory).root) {
            throw artifactFailure("The artifact output directory is invalid.");
        }
        try {
            await fs.mkdir(parent, { recursive: true });
            if (await exists(outputDirectory)) {
                throw artifactFailure(`Artifact output directory already exists: ${outputDirectory}`);
            }
            this.stagingDirectory = await fs.mkdtemp(path.join(parent, `.${base}.tmp-`));
            this.outputDirectory = outputDirectory;
            await writeJson(path.join(this.stagingDirectory, "run-bundle.json"), this.bundle);
            await writeJson(path.join(this.stagingDirectory, "provenance.json"), this.provenance);
            if (this.policy.profile !== "disabled") {
                const service = new LogService(this.stagingDirectory);
                this.recording = new RecordingController(this.episode.runtime.signalStore, {
                    transport: directLogTransport(service),
                });
                this.recording.attachSimulation(this.episode.kernel);
                const attachments = [
                    { name: "run-manifest.json", mime: "application/json", bytes: stringifyJsonProtocol(this.bundle.resolved) },
                    { name: "run-bundle.json", mime: "application/json", bytes: stringifyJsonProtocol(this.bundle) },
                    { name: "provenance.json", mime: "application/json", bytes: stringifyJsonProtocol(this.provenance) },
                ];
                if (this.bundle.resolved.calibration) {
                    attachments.push({ name: "calibration.json", mime: "application/json", bytes: stringifyJsonProtocol(this.bundle.resolved.calibration) });
                }
                await this.recording.start({
                    name: `${this.bundle.resolved.manifest.name}: ${this.episode.kernel.episodeHash}`,
                    environmentId: this.bundle.resolved.manifest.environment?.id ?? null,
                    simulator: this.episode.kernel.getSnapshot(),
                    profile: builtInProfile(this.policy.signalProfileId),
                    appVersion: this.provenance.runtimeVersion,
                    gitHash: this.provenance.gitHash,
                    runId: `run-${this.episode.kernel.episodeHash.slice(0, 16)}`,
                    manifestId: this.bundle.resolved.manifest.id,
                    manifestRevision: this.bundle.resolved.manifest.revision ?? null,
                    definitionHash: this.bundle.resolved.definitionHash ?? null,
                    resolvedHash: this.bundle.resolvedHash,
                    provenance: this.provenance,
                    haltSimulationOnError: this.policy.logRequired,
                    timeBase: "simulation",
                    attachments,
                });
            }
            this.started = true;
        } catch (error) {
            if (error instanceof HeadlessRunnerError) throw error;
            throw artifactFailure(`Could not initialize artifact output: ${error.message}`, error);
        }
    }

    async finalize(runResult) {
        if (!this.started || !this.stagingDirectory) throw artifactFailure("The artifact sink has not started.");
        let result = structuredClone(runResult);
        const resultPath = path.join(this.stagingDirectory, "run-results.json");
        try {
            await writeJson(resultPath, result);
            let retainLog = this.policy.profile === "evaluation";
            if (this.policy.profile === "training") {
                retainLog = isTrainingLogSampled(result.episodeHash, this.policy.fullSflogSampleRate)
                    || (!result.passed && this.policy.fullSflogOnFailure);
            }
            if (this.recording) {
                this.recording.addAttachment({
                    name: "run-results.json",
                    mime: "application/json",
                    bytes: stringifyJsonProtocol(result),
                });
                try {
                    const metadata = await this.recording.stop({ runResult: result });
                    if (metadata?.incomplete || metadata?.loggingError) {
                        throw new Error(metadata.loggingError || "The SFLog is incomplete.");
                    }
                } catch (error) {
                    if (this.policy.logRequired) throw error;
                    result = {
                        ...result,
                        degraded: true,
                        artifactWarnings: [...(result.artifactWarnings || []), `Optional SFLog finalization failed: ${error.message}`],
                    };
                    await fs.rm(resultPath, { force: true });
                    await writeJson(resultPath, result);
                    retainLog = false;
                }
            }
            if (!retainLog) {
                await Promise.all(["run.sflog", "run.json", "run.partial"].map((name) => (
                    fs.rm(path.join(this.stagingDirectory, name), { force: true })
                )));
            }
            const names = (await fs.readdir(this.stagingDirectory))
                .filter((name) => !name.endsWith(".partial"))
                .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
            const artifacts = await Promise.all(names.map((name) => fileRef(this.stagingDirectory, name)));
            await fs.rename(this.stagingDirectory, this.outputDirectory);
            this.stagingDirectory = null;
            return { runResult: result, artifacts, outputDirectory: this.outputDirectory };
        } catch (error) {
            if (error instanceof HeadlessRunnerError) throw error;
            throw artifactFailure(`Could not finalize artifact output: ${error.message}`, error);
        }
    }

    async abort() {
        if (this.recording?.session) {
            try {
                await this.recording.stop({ incomplete: true, loggingError: "Runner aborted before artifact finalization." });
            } catch {
                // The staging directory is removed below; preserve the original failure.
            }
        }
        if (this.stagingDirectory) {
            await fs.rm(this.stagingDirectory, { recursive: true, force: true });
            this.stagingDirectory = null;
        }
    }
}

export function createHeadlessArtifactSink(options) {
    return new HeadlessArtifactSink(options);
}
