import {
    canonicalExactStringify,
    defaultVisualLodPolicy,
    hashVisualLodPolicy,
    sha256ExactUtf8,
} from "./VisualLayer.js";

export const VISUAL_SCALE_PROFILE_KIND = "cev-sim.visual-scale-profile";
export const VISUAL_SCALE_PROFILE_VERSION = 1;
export const VISUAL_SCALE_REPORT_KIND = "cev-sim.visual-scale-report";
export const VISUAL_SCALE_REPORT_VERSION = 1;

export const VISUAL_BYTES = Object.freeze({
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
});

export const VISUAL_RESIDENCY_LIMITS = Object.freeze({
    requiredRadiusMeters: 100,
    prefetchRadiusMeters: 120,
    maxResidentChunks: 128,
    maxProjections: 64,
});

export const VISUAL_SCALE_PROFILE_IDS = Object.freeze({
    nvidiaX64ConsumerV1: "nvidia-x64-consumer-v1",
    jetsonAgxOrinV1: "jetson-agx-orin-v1",
    jetsonAgxThorV1: "jetson-agx-thor-v1",
    hostedQuickV1: "hosted-quick-v1",
});

const { MiB, GiB } = VISUAL_BYTES;

const X64_WORKLOAD = Object.freeze({
    extentMeters: Object.freeze({ x: 400, z: 400 }),
    chunks: 400,
    instances: 2000,
    lodTriangles: Object.freeze([8_000_000, 2_000_000, 500_000]),
    encodedClosureBytes: 1 * GiB,
    decodedClosureBytes: 4 * GiB,
    environments: 2,
    bakeViews: 1000,
    bakePassesPerView: 2,
    bakeWidth: 1920,
    bakeHeight: 1080,
});

const ORIN_WORKLOAD = Object.freeze({
    extentMeters: Object.freeze({ x: 300, z: 300 }),
    chunks: 225,
    instances: 1000,
    lodTriangles: Object.freeze([4_000_000, 1_000_000, 250_000]),
    encodedClosureBytes: 512 * MiB,
    decodedClosureBytes: 2 * GiB,
    environments: 1,
    bakeViews: 500,
    bakePassesPerView: 2,
    bakeWidth: 1920,
    bakeHeight: 1080,
});

const X64_CEILINGS = Object.freeze({
    encodedCpuBytes: 1 * GiB,
    decodedCpuBytes: 4 * GiB,
    gpuBytes: 4 * GiB,
    transientBytes: 512 * MiB,
    bakeBufferBytes: 512 * MiB,
    unifiedMemoryBytes: null,
    maxConcurrentFetches: 4,
    maxConcurrentDecodes: 2,
});

const ORIN_CEILINGS = Object.freeze({
    encodedCpuBytes: 512 * MiB,
    decodedCpuBytes: 2 * GiB,
    gpuBytes: 2 * GiB,
    transientBytes: 256 * MiB,
    bakeBufferBytes: 256 * MiB,
    unifiedMemoryBytes: 8 * GiB,
    maxConcurrentFetches: 2,
    maxConcurrentDecodes: 1,
});

const THOR_CEILINGS = Object.freeze({
    ...X64_CEILINGS,
    unifiedMemoryBytes: 12 * GiB,
});

const X64_TARGETS = Object.freeze({
    coldAoiMs: 15_000,
    warmAoiMs: 2_000,
    displayP95Ms: 33.3,
    minDisplayFps: 30,
    bakeSampleP95Ms: 100,
    totalBakeMs: 20 * 60_000,
    multiEnvironmentMinFps: 15,
    cancelMs: 2_000,
    switchMs: 3_000,
    recoveryMs: 5_000,
    teardownResidueFraction: 0.1,
    teardownResidueFloorBytes: 128 * MiB,
});

const ORIN_TARGETS = Object.freeze({
    coldAoiMs: 20_000,
    warmAoiMs: 3_000,
    displayP95Ms: 66.7,
    minDisplayFps: 15,
    bakeSampleP95Ms: 200,
    totalBakeMs: 30 * 60_000,
    multiEnvironmentMinFps: null,
    cancelMs: 2_000,
    switchMs: 4_000,
    recoveryMs: 8_000,
    teardownResidueFraction: 0.1,
    teardownResidueFloorBytes: 128 * MiB,
});

const HOST_REQUIREMENTS = Object.freeze({
    [VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1]: Object.freeze({
        architecture: "x64",
        hostRole: "x64-nvidia",
        requireGpu: true,
        requireHardwareWebgl2: true,
        telemetry: "nvidia-smi",
        minUnifiedMemoryBytes: null,
        modelIncludes: null,
        unsupportedModels: Object.freeze([]),
    }),
    [VISUAL_SCALE_PROFILE_IDS.jetsonAgxOrinV1]: Object.freeze({
        architecture: "arm64",
        hostRole: "jetson-agx-orin",
        requireGpu: true,
        requireHardwareWebgl2: true,
        telemetry: "tegrastats",
        minUnifiedMemoryBytes: 32 * GiB,
        modelIncludes: Object.freeze(["jetson agx orin"]),
        unsupportedModels: Object.freeze(["orin nx", "orin nano"]),
    }),
    [VISUAL_SCALE_PROFILE_IDS.jetsonAgxThorV1]: Object.freeze({
        architecture: "arm64",
        hostRole: "jetson-agx-thor",
        requireGpu: true,
        requireHardwareWebgl2: true,
        telemetry: "tegrastats",
        minUnifiedMemoryBytes: 64 * GiB,
        modelIncludes: Object.freeze(["jetson agx thor"]),
        unsupportedModels: Object.freeze(["orin nx", "orin nano"]),
    }),
});

function profileRecord(id, workload, ceilings, targets, advertised) {
    return Object.freeze({
        kind: VISUAL_SCALE_PROFILE_KIND,
        version: VISUAL_SCALE_PROFILE_VERSION,
        id,
        advertised,
        lodPolicy: defaultVisualLodPolicy(),
        residency: VISUAL_RESIDENCY_LIMITS,
        workload,
        ceilings,
        targets,
        host: HOST_REQUIREMENTS[id] ?? Object.freeze({
            architecture: null,
            hostRole: null,
            requireGpu: false,
            requireHardwareWebgl2: false,
            telemetry: null,
            minUnifiedMemoryBytes: null,
            modelIncludes: null,
            unsupportedModels: Object.freeze([]),
        }),
    });
}

const PROFILES = Object.freeze({
    [VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1]: profileRecord(
        VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1,
        X64_WORKLOAD,
        X64_CEILINGS,
        X64_TARGETS,
        true,
    ),
    [VISUAL_SCALE_PROFILE_IDS.jetsonAgxOrinV1]: profileRecord(
        VISUAL_SCALE_PROFILE_IDS.jetsonAgxOrinV1,
        ORIN_WORKLOAD,
        ORIN_CEILINGS,
        ORIN_TARGETS,
        true,
    ),
    [VISUAL_SCALE_PROFILE_IDS.jetsonAgxThorV1]: profileRecord(
        VISUAL_SCALE_PROFILE_IDS.jetsonAgxThorV1,
        X64_WORKLOAD,
        THOR_CEILINGS,
        X64_TARGETS,
        true,
    ),
    [VISUAL_SCALE_PROFILE_IDS.hostedQuickV1]: profileRecord(
        VISUAL_SCALE_PROFILE_IDS.hostedQuickV1,
        Object.freeze({
            extentMeters: Object.freeze({ x: 40, z: 40 }),
            chunks: 4,
            instances: 8,
            lodTriangles: Object.freeze([2_048, 512, 128]),
            encodedClosureBytes: 4 * MiB,
            decodedClosureBytes: 16 * MiB,
            environments: 1,
            bakeViews: 4,
            bakePassesPerView: 2,
            bakeWidth: 64,
            bakeHeight: 64,
        }),
        Object.freeze({
            encodedCpuBytes: 8 * MiB,
            decodedCpuBytes: 32 * MiB,
            gpuBytes: 32 * MiB,
            transientBytes: 8 * MiB,
            bakeBufferBytes: 8 * MiB,
            unifiedMemoryBytes: null,
            maxConcurrentFetches: 2,
            maxConcurrentDecodes: 1,
        }),
        Object.freeze({
            coldAoiMs: 2_000,
            warmAoiMs: 500,
            displayP95Ms: 50,
            minDisplayFps: 20,
            bakeSampleP95Ms: 50,
            totalBakeMs: 5_000,
            multiEnvironmentMinFps: null,
            cancelMs: 500,
            switchMs: 500,
            recoveryMs: 500,
            teardownResidueFraction: 0.1,
            teardownResidueFloorBytes: 16 * MiB,
        }),
        false,
    ),
});

export function listVisualScaleProfiles({ advertisedOnly = false } = {}) {
    return Object.values(PROFILES).filter((profile) => !advertisedOnly || profile.advertised);
}

export function getVisualScaleProfile(id = VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1) {
    const profile = PROFILES[id];
    if (!profile) {
        throw new TypeError(`Unknown visual-scale profile ${id}.`);
    }
    return profile;
}

export function advertisedVisualScaleProfileIds() {
    return listVisualScaleProfiles({ advertisedOnly: true }).map((profile) => profile.id);
}

export function hashVisualScaleProfile(profile) {
    const canonical = getVisualScaleProfile(profile?.id ?? profile);
    return sha256ExactUtf8(canonicalExactStringify({
        kind: canonical.kind,
        version: canonical.version,
        id: canonical.id,
        advertised: canonical.advertised,
        lodPolicy: canonical.lodPolicy,
        residency: canonical.residency,
        workload: canonical.workload,
        ceilings: canonical.ceilings,
        targets: canonical.targets,
        host: canonical.host,
    }));
}

export function visualScaleIdentity(profile = getVisualScaleProfile()) {
    const resolved = typeof profile === "string" ? getVisualScaleProfile(profile) : profile;
    return {
        profileId: resolved.id,
        profileHash: hashVisualScaleProfile(resolved),
        lodPolicyHash: hashVisualLodPolicy(resolved.lodPolicy),
        advertised: resolved.advertised === true,
    };
}

export function teardownResidueCeiling(baselineBytes, profile = getVisualScaleProfile()) {
    const floor = profile.targets.teardownResidueFloorBytes;
    const fraction = Math.ceil(Math.max(0, Number(baselineBytes) || 0) * profile.targets.teardownResidueFraction);
    return Math.max(floor, fraction);
}

export function overlayByteLimit(profile = getVisualScaleProfile()) {
    return profile.ceilings.bakeBufferBytes;
}
