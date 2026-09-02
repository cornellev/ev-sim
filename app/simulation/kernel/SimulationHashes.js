import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

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
export function simulationSemanticProjection(resolved = {}) {
    const projection = stripVolatile(structuredClone(resolved));
    // Preserve the authored environment manifest/hash for bundle integrity,
    // while simulation identity follows only the normalized world semantics.
    projectWorldEnvironmentIdentity(projection);
    if (projection.manifest) {
        delete projection.manifest.logging;
        if (projection.manifest.clock) {
            delete projection.manifest.clock.pacing;
            delete projection.manifest.clock.speed;
            if (projection.manifest.clock.modules) {
                delete projection.manifest.clock.modules.rendering;
                delete projection.manifest.clock.modules.baking;
            }
        }
    }
    delete projection.artifactPolicy;
    delete projection.resourceLimits;
    return {
        kind: "cev-sim.simulation-semantics",
        version: SIMULATION_HASH_VERSION,
        resolved: projection,
    };
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
    const backends = (input.backendSelections || input.backend_selections || [])
        .map(normalizeBackend)
        .sort((left, right) => left.kind - right.kind
            || compareUtf8(left.capabilityId, right.capabilityId)
            || compareUtf8(left.version, right.version)
            || compareUtf8(left.configHash, right.configHash));
    return {
        kind: "cev-sim.episode-identity",
        version: SIMULATION_HASH_VERSION,
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
            configHash: simulationSha256(resolved?.manifest?.sensorRig ?? null),
        },
        rewardProfile: {
            id: "browser-scenario-outcomes",
            version: 1,
            configHash: simulationSha256(resolved?.scenario?.scenario ?? null),
        },
        backendSelections: resolved?.backendSelections ?? [],
        ...overrides,
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
