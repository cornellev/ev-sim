const GiB = 1024 ** 3;

export const VISUAL_ASSET_CONTRACT_CEILINGS = Object.freeze({
    publishedBytes: 32 * GiB,
    stagingBytes: 4 * GiB,
    assetBytes: 1 * GiB,
    assetEntries: 16_384,
    graphDepth: 64,
    nodesPerMesh: 100_000,
    trianglesPerMesh: 4_000_000,
    textureDimension: 8_192,
    textureMipLevels: 14,
    decodedClosureBytes: 4 * GiB,
    concurrentUploads: 2,
    concurrentValidations: 1,
    openReaders: 32,
    validationTimeoutMs: 60_000,
    abandonedStageTtlMs: 60 * 60 * 1000,
    gltfJsonBytes: 32 * 1024 * 1024,
    validatorMemoryMb: 512,
});

const COUNT_KEYS = new Set([
    "assetEntries", "graphDepth", "nodesPerMesh", "trianglesPerMesh",
    "textureDimension", "textureMipLevels", "concurrentUploads",
    "concurrentValidations", "openReaders", "validationTimeoutMs",
    "abandonedStageTtlMs", "gltfJsonBytes", "validatorMemoryMb",
]);

function clampLimit(key, value, ceiling) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        throw new TypeError(`Visual asset limit ${key} must be a non-negative number.`);
    }
    const integer = COUNT_KEYS.has(key) ? Math.floor(numeric) : numeric;
    return integer > ceiling ? ceiling : integer;
}

export function resolveVisualAssetLimits(overrides = {}) {
    const resolved = {};
    for (const [key, ceiling] of Object.entries(VISUAL_ASSET_CONTRACT_CEILINGS)) {
        resolved[key] = overrides[key] === undefined ? ceiling : clampLimit(key, overrides[key], ceiling);
    }
    return Object.freeze(resolved);
}
