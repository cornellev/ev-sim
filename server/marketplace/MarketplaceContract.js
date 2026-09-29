export const MARKETPLACE_SCHEMA_VERSION = 1;

export const MARKETPLACE_KINDS = Object.freeze({
    item: "cev-sim.marketplace-item",
    release: "cev-sim.marketplace-release",
    catalog: "cev-sim.marketplace-catalog",
    advisory: "cev-sim.marketplace-advisory",
    collection: "cev-sim.marketplace-collection",
    sources: "cev-sim.marketplace-sources",
    installed: "cev-sim.marketplace-installed",
    installReceipt: "cev-sim.marketplace-install-receipt",
});

export const MARKETPLACE_CONTENT_KINDS = Object.freeze([
    "plugin",
    "vehicle",
    "run-template",
    "run-package",
    "environment",
    "asset-pack",
    "collection",
]);

export const MARKETPLACE_ARTIFACTS = Object.freeze({
    plugin: Object.freeze({ kind: "cev-sim.plugin-package", version: 1, mediaType: "application/vnd.cev-sim.plugin-package+json" }),
    vehicle: Object.freeze({ kind: "cev-sim.vehicle-bundle", version: 1, mediaType: "application/vnd.cev-sim.vehicle-bundle+json" }),
    "run-template": Object.freeze({ kind: "cev-sim.run-bundle", version: 1, mediaType: "application/vnd.cev-sim.run-bundle+json" }),
    "run-package": Object.freeze({ kind: "cev-sim.run-package", version: 1, mediaType: "application/vnd.cev-sim.run-package+tar" }),
    environment: Object.freeze({ kind: "cev-sim.environment-package", version: 1, mediaType: "application/vnd.cev-sim.environment-package+tar" }),
    "asset-pack": Object.freeze({ kind: "cev-sim.asset-package", version: 1, mediaType: "application/vnd.cev-sim.asset-package+tar" }),
    collection: Object.freeze({ kind: "cev-sim.marketplace-collection", version: 1, mediaType: "application/vnd.cev-sim.marketplace-collection+json" }),
});

export const MARKETPLACE_RELEASE_PAYLOAD_TYPE = "application/vnd.cev-sim.marketplace-release+json";
export const MARKETPLACE_PREVIEW_MEDIA_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const MARKETPLACE_TRACKS = Object.freeze(["stable", "beta"]);
export const MARKETPLACE_ADVISORY_ACTIONS = Object.freeze(["warn", "yank", "block"]);
export const MARKETPLACE_ADVISORY_SEVERITIES = Object.freeze(["low", "moderate", "high", "critical"]);

export const MARKETPLACE_SOURCE_HEALTH = Object.freeze({
    DISABLED: "disabled",
    UNTRUSTED: "untrusted",
    EXPIRED: "expired",
    OFFLINE: "offline",
    STALE: "stale",
    READY: "ready",
});

export const MARKETPLACE_CLIENT_LIMITS = Object.freeze({
    credentialBytes: 8 * 1024,
    discoveryBytes: 64 * 1024,
    rootBytes: 512_000,
    requestTimeoutMs: 15_000,
});

export const MARKETPLACE_LIMITS = Object.freeze({
    jsonBytes: 8 * 1024 ** 2,
    catalogBytes: 64 * 1024 ** 2,
    jsonDepth: 64,
    artifactBytes: 50 * 1024 ** 3,
    previewBytes: 8 * 1024 ** 2,
});

export const PORTABLE_MARKETPLACE_ARCHIVE_LIMITS = Object.freeze({
    archiveBytes: 8 * 1024 ** 3,
    blobBytes: 1024 ** 3,
    recordBytes: 32 * 1024 ** 2,
    manifestBytes: 4 * 1024 ** 2,
    payloadEntries: 16_384,
    entries: 16_385,
    graphDepth: 64,
    temporaryBytes: 8 * 1024 ** 3,
    inodes: 16_385,
    verificationTimeoutMs: 60_000,
});

// Kept as named profiles so format-specific code can evolve additively without
// allowing one portable format to raise the frozen shared ceiling.
export const ASSET_PACKAGE_LIMITS = PORTABLE_MARKETPLACE_ARCHIVE_LIMITS;
export const ENVIRONMENT_PACKAGE_LIMITS = PORTABLE_MARKETPLACE_ARCHIVE_LIMITS;

export function artifactByteLimitFor(contentKind) {
    return contentKind === "asset-pack" || contentKind === "environment"
        ? PORTABLE_MARKETPLACE_ARCHIVE_LIMITS.archiveBytes
        : MARKETPLACE_LIMITS.artifactBytes;
}

export function artifactContractFor(contentKind) {
    return MARKETPLACE_ARTIFACTS[contentKind] ?? null;
}
