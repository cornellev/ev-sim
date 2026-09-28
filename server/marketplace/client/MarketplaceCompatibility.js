import { createRequire } from "node:module";
import process from "node:process";

import semver from "semver";

import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { MARKETPLACE_ARTIFACTS } from "../MarketplaceContract.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes } from "../MarketplaceJson.js";

const PACKAGE_VERSION = createRequire(import.meta.url)("../../../package.json").version;

function sortedUnique(values) {
    return [...new Set(values)].sort(compareUtf8);
}

function sortedFeatureNames(values) {
    return sortedUnique(values.filter((value) => typeof value === "string" && value.length > 0));
}

function normalizeBackend(entry) {
    const version = Number(entry?.version);
    if (!entry?.available || typeof entry.id !== "string" || !entry.id
        || !Number.isSafeInteger(version) || version < 1) return null;
    return Object.freeze({ kind: String(entry.kind), id: entry.id, version });
}

export function createMarketplaceHostProfile({
    version = PACKAGE_VERSION,
    platform = process.platform,
    architecture = process.arch,
    supervisorCapabilities = {},
} = {}) {
    const backends = (supervisorCapabilities.backends ?? []).map(normalizeBackend).filter(Boolean)
        .sort((left, right) => compareUtf8(left.kind, right.kind)
            || compareUtf8(left.id, right.id) || left.version - right.version);
    const contractsByKind = new Map();
    for (const artifact of Object.values(MARKETPLACE_ARTIFACTS)) {
        if (["cev-sim.environment-package", "cev-sim.asset-package", "cev-sim.marketplace-collection"].includes(artifact.kind)) continue;
        const versions = contractsByKind.get(artifact.kind) ?? [];
        versions.push(artifact.version);
        contractsByKind.set(artifact.kind, versions);
    }
    const contracts = [...contractsByKind.entries()]
        .map(([kind, versions]) => Object.freeze({ kind, versions: Object.freeze(sortedUnique(versions)) }))
        .sort((left, right) => compareUtf8(left.kind, right.kind));
    const features = sortedFeatureNames([
        ...(supervisorCapabilities.identityProfiles ?? []),
        ...(supervisorCapabilities.assetAdmissionProfiles ?? []),
        ...(supervisorCapabilities.observationProfiles ?? []),
        ...(supervisorCapabilities.rewardProfiles ?? []),
        ...(supervisorCapabilities.transports ?? []),
        ...((supervisorCapabilities.backends ?? []).filter((entry) => entry.available).flatMap((entry) => entry.features ?? [])),
    ]);
    return Object.freeze({
        cevSim: version,
        platform,
        architecture,
        runtimes: Object.freeze(["browser", "headless"]),
        contracts: Object.freeze(contracts),
        backends: Object.freeze(backends),
        features: Object.freeze(features),
    });
}

export function hashMarketplaceHostProfile(profile) {
    return hashMarketplaceBytes(canonicalMarketplaceBytes(profile));
}

function issue(path, code, required, actual) {
    return Object.freeze({ path, code, required: structuredClone(required), actual: structuredClone(actual) });
}

export function evaluateMarketplaceCompatibility(compatibility, profile) {
    const issues = [];
    if (!semver.satisfies(profile.cevSim, compatibility.cevSim, { includePrerelease: true })) {
        issues.push(issue("compatibility.cevSim", "CEV_SIM_VERSION", compatibility.cevSim, profile.cevSim));
    }
    if (compatibility.platforms.length && !compatibility.platforms.includes(profile.platform)) {
        issues.push(issue("compatibility.platforms", "PLATFORM", compatibility.platforms, profile.platform));
    }
    if (compatibility.architectures.length && !compatibility.architectures.includes(profile.architecture)) {
        issues.push(issue("compatibility.architectures", "ARCHITECTURE", compatibility.architectures, profile.architecture));
    }
    if (compatibility.runtimes.length && !compatibility.runtimes.some((runtime) => profile.runtimes.includes(runtime))) {
        issues.push(issue("compatibility.runtimes", "RUNTIME", compatibility.runtimes, profile.runtimes));
    }
    const contracts = new Map(profile.contracts.map((entry) => [entry.kind, new Set(entry.versions)]));
    compatibility.contracts.forEach((entry, index) => {
        if (!entry.versions.some((version) => contracts.get(entry.kind)?.has(version))) {
            issues.push(issue(`compatibility.contracts.${index}`, "CONTRACT", entry, profile.contracts));
        }
    });
    const backendKeys = new Set(profile.backends.map((entry) => `${entry.kind}\u0000${entry.id}\u0000${entry.version}`));
    compatibility.backends.forEach((entry, index) => {
        if (!backendKeys.has(`${entry.kind}\u0000${entry.id}\u0000${entry.version}`)) {
            issues.push(issue(`compatibility.backends.${index}`, "BACKEND", entry, profile.backends));
        }
    });
    const features = new Set(profile.features);
    compatibility.features.forEach((entry, index) => {
        if (!features.has(entry)) issues.push(issue(`compatibility.features.${index}`, "FEATURE", entry, profile.features));
    });
    issues.sort((left, right) => compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code));
    return Object.freeze({ compatible: issues.length === 0, issues: Object.freeze(issues) });
}
