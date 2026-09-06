import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { simulationIdentityVersion } from "./RunIdentity.js";

export const SIMULATION_HASH_VERSION = 1;

/**
 * Decimal places used so hashed floats are stable across CPU libm implementations.
 * Six places is 1e-6 (micrometer-scale for meter quantities). Independently
 * resolved IGVC local frames retain ~1e-9 m of Mercator cancellation noise,
 * which 12-decimal rounding does not absorb.
 */
export const CANONICAL_NUMBER_DECIMALS = 6;

export function canonicalFiniteNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError("Simulation hashes require finite numbers.");
    }
    const rounded = Number(value.toFixed(CANONICAL_NUMBER_DECIMALS));
    return Object.is(rounded, -0) ? 0 : rounded;
}

export function canonicalNumericTree(value) {
    if (typeof value === "number" && Number.isFinite(value)) return canonicalFiniteNumber(value);
    if (Array.isArray(value)) return value.map(canonicalNumericTree);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, canonicalNumericTree(entry)]),
    );
}

const textEncoder = new TextEncoder();
const utf8KeyCache = new Map();
const VOLATILE_KEYS = new Set([
    "clientRevision",
    "createdAt",
    "definitionHash",
    "exportedAt",
    "resolvedHash",
    "revision",
    "simulationSemanticHash",
    "updatedAt",
]);

function compareUtf8(left, right) {
    let a = utf8KeyCache.get(left);
    if (!a) {
        a = textEncoder.encode(String(left));
        utf8KeyCache.set(left, a);
    }
    let b = utf8KeyCache.get(right);
    if (!b) {
        b = textEncoder.encode(String(right));
        utf8KeyCache.set(right, b);
    }
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function byteHex(value) {
    const bytes = value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return bytesToHex(bytes);
}

/**
 * JSON-compatible canonical normalization shared by browser and Node hashing.
 * Object keys use the Protobuf contract's UTF-8 byte ordering. Binary values
 * are tagged so different typed-array representations cannot collide.
 */
export function canonicalizeSimulationValue(value, seen = new WeakSet()) {
    if (value === null) return null;
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        return undefined;
    }
    if (typeof value === "bigint") {
        return { $bigint: value.toString(10) };
    }
    if (typeof value === "number") {
        return canonicalFiniteNumber(value);
    }
    if (typeof value !== "object") return value;

    if (seen.has(value)) throw new TypeError("Cannot hash a circular simulation value.");
    seen.add(value);
    try {
        if (value instanceof ArrayBuffer) {
            return { $bytes: bytesToHex(new Uint8Array(value)) };
        }
        if (ArrayBuffer.isView(value)) {
            return {
                $typedArray: value.constructor?.name || "TypedArray",
                bytes: byteHex(value),
            };
        }
        if (value instanceof Date) return value.toISOString();
        if (Array.isArray(value)) {
            return value.map((entry) => canonicalizeSimulationValue(entry, seen) ?? null);
        }
        if (value instanceof Map) {
            return [...value.entries()]
                .map(([key, entry]) => [
                    canonicalizeSimulationValue(key, seen),
                    canonicalizeSimulationValue(entry, seen) ?? null,
                ])
                .sort(([left], [right]) => compareUtf8(
                    JSON.stringify(left),
                    JSON.stringify(right),
                ));
        }
        if (value instanceof Set) {
            return [...value]
                .map((entry) => canonicalizeSimulationValue(entry, seen))
                .sort((left, right) => compareUtf8(JSON.stringify(left), JSON.stringify(right)));
        }

        const normalized = {};
        for (const key of Object.keys(value).sort(compareUtf8)) {
            const entry = canonicalizeSimulationValue(value[key], seen);
            if (entry !== undefined) normalized[key] = entry;
        }
        return normalized;
    } finally {
        seen.delete(value);
    }
}

export function canonicalSimulationStringify(value) {
    return JSON.stringify(canonicalizeSimulationValue(value));
}

export function simulationSha256(value) {
    const bytes = typeof value === "string"
        ? textEncoder.encode(value)
        : textEncoder.encode(canonicalSimulationStringify(value));
    return bytesToHex(sha256(bytes));
}

function stripVolatile(value) {
    if (Array.isArray(value)) return value.map(stripVolatile);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !VOLATILE_KEYS.has(key))
            .map(([key, entry]) => [key, stripVolatile(entry)]),
    );
}

function projectWorldEnvironmentIdentity(value) {
    if (Array.isArray(value)) {
        value.forEach(projectWorldEnvironmentIdentity);
        return;
    }
    if (!value || typeof value !== "object") return;
    if (value.world?.hash && value.environment) {
        value.environment = { worldHash: value.world.hash };
        if (value.dependencyHashes) delete value.dependencyHashes.environment;
    }
    for (const entry of Object.values(value)) projectWorldEnvironmentIdentity(entry);
}

/**
 * Project an immutable resolved run onto fields that can affect authoritative
 * simulation transitions. Full resolvedHash remains the bundle-integrity hash.
 */
function legacySimulationSemanticProjection(resolved = {}) {
    const projection = stripVolatile(structuredClone(resolved));
    // Preserve the authored environment manifest/hash for bundle integrity,
    // while simulation identity follows only the normalized world semantics.
    projectWorldEnvironmentIdentity(projection);
    if (projection.manifest) {
        delete projection.manifest.logging;
        // Candidate-model declarations are evidence provenance only. Project v10
        // back to the prior semantic shape so otherwise-identical runs keep the
        // same simulationSemanticHash / episodeHash / trajectoryHash.
        delete projection.manifest.provenance;
        if (Number(projection.manifest.version) === 10) {
            projection.manifest.version = 9;
        }
        if (projection.manifest.clock) {
            delete projection.manifest.clock.pacing;
            delete projection.manifest.clock.speed;
            if (projection.manifest.clock.modules) {
                delete projection.manifest.clock.modules.rendering;
                delete projection.manifest.clock.modules.baking;
            }
        }
    }
    // Resolved documents also carry the authored manifest version; keep the
    // portable envelope aligned with the projected semantic shape.
    if (Number(projection.version) === 10) {
        projection.version = 9;
    }
    delete projection.artifactPolicy;
    delete projection.resourceLimits;
    return {
        kind: "cev-sim.simulation-semantics",
        version: SIMULATION_HASH_VERSION,
        resolved: projection,
    };
}

// These are document-envelope fields, not a recursive blacklist: script inputs
// and behavioral objects may legitimately use any of these names.
function omitIdentityMetadata(document) {
    if (!document || typeof document !== "object") return;
    for (const key of VOLATILE_KEYS) delete document[key];
}

function projectSensorRig(rig) {
    const projected = structuredClone(rig ?? null);
    for (const sensor of projected?.sensors ?? []) {
        if (sensor.enabled === false) delete sensor.render;
    }
    return projected;
}

function projectScenarioDefinition(scenario, worldHash) {
    const projected = structuredClone(scenario ?? null);
    if (!projected) return projected;
    omitIdentityMetadata(projected);
    if (projected.environment) projected.environment = { worldHash };
    return projected;
}

function projectEvidence(envelope) {
    for (const key of ["evidence", "provenance", "correspondence", "sourcePolicyEvidence", "replayEvidence"]) {
        delete envelope[key];
        if (envelope.dependencyHashes) delete envelope.dependencyHashes[key];
    }
}

function projectResolvedEnvironment(envelope, worldHash) {
    if (envelope.environment) envelope.environment = { worldHash };
    if (envelope.dependencyHashes) delete envelope.dependencyHashes.environment;
}

export function simulationSemanticProjection(resolved = {}) {
    const version = simulationIdentityVersion(resolved);
    if (version === 1) return legacySimulationSemanticProjection(resolved);
    const projection = structuredClone(resolved);
    const worldHash = resolved.world?.hash;
    if (!worldHash) throw new Error("world-bound@2 requires a resolved world hash.");
    omitIdentityMetadata(projection);
    projectResolvedEnvironment(projection, worldHash);
    projectEvidence(projection);
    const manifest = projection.manifest;
    omitIdentityMetadata(manifest);
    if (manifest) {
        manifest.environment = { worldHash };
        manifest.sensorRig = projectSensorRig(manifest.sensorRig);
        delete manifest.logging;
        delete manifest.provenance;
        if (manifest.clock) {
            delete manifest.clock.pacing;
            delete manifest.clock.speed;
            if (manifest.clock.modules) {
                delete manifest.clock.modules.rendering;
                delete manifest.clock.modules.baking;
            }
        }
    }
    if (projection.scenario) {
        const scenario = projection.scenario;
        const scenarioWorldHash = scenario.world?.hash ?? worldHash;
        omitIdentityMetadata(scenario);
        projectEvidence(scenario);
        projectResolvedEnvironment(scenario, scenarioWorldHash);
        scenario.scenario = projectScenarioDefinition(scenario.scenario, scenarioWorldHash);
        const scenarioHash = simulationSha256({
            kind: "cev-sim.scenario-semantics", version: 2, scenario: scenario.scenario,
        });
        if (manifest?.scenario) manifest.scenario.expectedHash = scenarioHash;
        if (scenario.dependencyHashes) scenario.dependencyHashes.scenario = scenarioHash;
        if (projection.dependencyHashes) projection.dependencyHashes.scenario = scenarioHash;
    }
    delete projection.artifactPolicy;
    delete projection.resourceLimits;
    return { kind: "cev-sim.simulation-semantics", version, resolved: projection };
}

export function computeSimulationSemanticHash(resolved) {
    return simulationSha256(simulationSemanticProjection(resolved));
}

function normalizeProfile(profile = {}) {
    return {
        id: String(profile.id || ""),
        version: Math.max(0, Math.floor(Number(profile.version) || 0)),
        configHash: String(profile.configHash || profile.config_hash || ""),
    };
}

function normalizeBackend(entry = {}) {
    return {
        kind: Math.max(0, Math.floor(Number(entry.kind) || 0)),
        capabilityId: String(entry.capabilityId || entry.capability_id || ""),
        version: String(entry.version || ""),
        configHash: String(entry.configHash || entry.config_hash || ""),
    };
}

export function canonicalEpisodeIdentity(input = {}) {
    const version = input.identityVersion
        ?? (input.kind === "cev-sim.episode-identity" ? input.version : 1);
    if (![1, 2].includes(version)) throw new Error(`Unsupported episode identity version ${version}.`);
    const backends = (input.backendSelections || input.backend_selections || [])
        .map(normalizeBackend)
        .sort((left, right) => left.kind - right.kind
            || compareUtf8(left.capabilityId, right.capabilityId)
            || compareUtf8(left.version, right.version)
            || compareUtf8(left.configHash, right.configHash));
    return {
        kind: "cev-sim.episode-identity",
        version,
        protocolMajor: Math.max(0, Math.floor(Number(input.protocolMajor ?? input.protocol_major) || 0)),
        simulationSemanticHash: String(
            input.simulationSemanticHash
            || input.simulation_semantic_hash
            || "",
        ),
        resetSeed: String(input.resetSeed ?? input.reset_seed ?? "0"),
        actionRepeat: Math.max(1, Math.floor(Number(input.actionRepeat ?? input.action_repeat) || 1)),
        maxEpisodeSteps: String(input.maxEpisodeSteps ?? input.max_episode_steps ?? "0"),
        observationProfile: normalizeProfile(input.observationProfile || input.observation_profile),
        rewardProfile: normalizeProfile(input.rewardProfile || input.reward_profile),
        backendSelections: backends,
    };
}

export function computeEpisodeHash(input) {
    return simulationSha256(canonicalEpisodeIdentity(input));
}

export function defaultEpisodeIdentity(resolved, overrides = {}) {
    const identityVersion = simulationIdentityVersion(resolved);
    const simulationSemanticHash = overrides.simulationSemanticHash
        || resolved?.simulationSemanticHash
        || computeSimulationSemanticHash(resolved);
    return canonicalEpisodeIdentity({
        protocolMajor: 1,
        simulationSemanticHash,
        resetSeed: resolved?.manifest?.seed ?? "0",
        actionRepeat: 1,
        maxEpisodeSteps: resolved?.manifest?.clock?.maxSteps ?? 0,
        observationProfile: {
            id: "browser-runtime-state",
            version: 1,
            configHash: simulationSha256(identityVersion === 2
                ? projectSensorRig(resolved?.manifest?.sensorRig)
                : resolved?.manifest?.sensorRig ?? null),
        },
        rewardProfile: {
            id: "browser-scenario-outcomes",
            version: 1,
            configHash: simulationSha256(identityVersion === 2
                ? projectScenarioDefinition(resolved?.scenario?.scenario, resolved?.scenario?.world?.hash ?? resolved?.world?.hash)
                : resolved?.scenario?.scenario ?? null),
        },
        backendSelections: resolved?.backendSelections ?? [],
        ...overrides,
        identityVersion,
    });
}

export class TrajectoryHasher {
    constructor(episodeHash) {
        this.reset(episodeHash);
    }

    reset(episodeHash) {
        this.episodeHash = String(episodeHash || "");
        this.steps = 0;
        this.digest = simulationSha256({
            kind: "cev-sim.trajectory-seed",
            version: SIMULATION_HASH_VERSION,
            episodeHash: this.episodeHash,
        });
        return this.digest;
    }

    update({ step, timeNs, actions = [], state = null } = {}) {
        const nextStep = Math.max(0, Math.floor(Number(step) || 0));
        if (nextStep <= this.steps) {
            throw new Error(`Trajectory steps must increase monotonically; received ${nextStep} after ${this.steps}.`);
        }
        this.digest = simulationSha256({
            kind: "cev-sim.trajectory-step",
            version: SIMULATION_HASH_VERSION,
            previousHash: this.digest,
            step: nextStep,
            timeNs: String(timeNs ?? 0),
            actions,
            state,
        });
        this.steps = nextStep;
        return this.digest;
    }

    snapshot() {
        return {
            episodeHash: this.episodeHash,
            trajectoryHash: this.digest,
            steps: this.steps,
        };
    }
}
