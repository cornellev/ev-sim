import { isDeepStrictEqual } from "node:util";

import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import {
    assertMarketplaceInstalled,
    assertMarketplaceRelease,
    hashMarketplaceRelease,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    assertCanonicalTimestamp,
    assertCanonicalUuid,
    assertPlainMarketplaceTree,
    assertReleaseVersion,
    assertSha256,
} from "../MarketplaceFormats.js";
import {
    canonicalMarketplaceBytes,
    hashMarketplaceBytes,
    parseMarketplaceJsonBytes,
} from "../MarketplaceJson.js";

export const MARKETPLACE_INSTALL_DOCUMENT_VERSION = 1;
export const MARKETPLACE_INSTALL_KINDS = Object.freeze({
    preflight: "cev-sim.marketplace-install-preflight",
    finalPlan: "cev-sim.marketplace-install-final-plan",
    job: "cev-sim.marketplace-install-job",
    transaction: "cev-sim.marketplace-install-transaction",
    artifactRecord: "cev-sim.marketplace-artifact-record",
    quarantineRecord: "cev-sim.marketplace-quarantine-record",
});

export const MARKETPLACE_JOB_PHASES = Object.freeze([
    "queued",
    "download",
    "verify",
    "plan",
    "awaiting-confirmation",
    "commit",
    "recover",
    "failed",
    "cancelled",
    "complete",
]);

export const MARKETPLACE_PRECOMMIT_PHASES = Object.freeze(new Set([
    "queued", "download", "verify", "plan", "awaiting-confirmation",
]));

function invalid(path, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${path}: ${message}`, { path });
}

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected an object");
    return value;
}

function exactKeys(value, required, optional, path) {
    object(value, path);
    const allowed = new Set([...required, ...optional]);
    for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "is required");
    for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${path}.${key}`, "is not allowed");
}

function nonNegative(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(path, "expected a non-negative safe integer");
}

function positive(value, path) {
    if (!Number.isSafeInteger(value) || value < 1) invalid(path, "expected a positive safe integer");
}

function text(value, path, max = 4096) {
    if (typeof value !== "string" || value.length < 1 || value.length > max) invalid(path, "expected bounded non-empty text");
}

function strings(value, path, { hashes = false } = {}) {
    if (!Array.isArray(value)) invalid(path, "expected an array");
    const seen = new Set();
    value.forEach((entry, index) => {
        if (hashes) assertSha256(entry, `${path}.${index}`);
        else text(entry, `${path}.${index}`, 16_384);
        if (seen.has(entry)) invalid(`${path}.${index}`, "duplicate value");
        seen.add(entry);
    });
}

function freeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach((entry) => freeze(entry, seen));
    return Object.freeze(value);
}

function cloneFrozen(value) {
    return freeze(structuredClone(value));
}

function assertKind(value, kind, path = "$.") {
    if (value.kind !== kind || value.version !== MARKETPLACE_INSTALL_DOCUMENT_VERSION) {
        invalid(path, `expected ${kind}@${MARKETPLACE_INSTALL_DOCUMENT_VERSION}`);
    }
}

function assertExactReleaseRef(value, path) {
    exactKeys(value, ["itemId", "releaseVersion", "artifactSha256"], [], path);
    text(value.itemId, `${path}.itemId`, 255);
    assertReleaseVersion(value.releaseVersion, `${path}.releaseVersion`);
    assertSha256(value.artifactSha256, `${path}.artifactSha256`);
}

function assertSourcePin(value, path) {
    exactKeys(value, [
        "sourceId", "registryId", "trustedRootFingerprint", "snapshotId", "catalogRevision", "catalogSha256",
    ], [], path);
    assertCanonicalUuid(value.sourceId, `${path}.sourceId`);
    assertCanonicalUuid(value.registryId, `${path}.registryId`);
    assertSha256(value.trustedRootFingerprint, `${path}.trustedRootFingerprint`);
    assertCanonicalUuid(value.snapshotId, `${path}.snapshotId`);
    positive(value.catalogRevision, `${path}.catalogRevision`);
    assertSha256(value.catalogSha256, `${path}.catalogSha256`);
}

function assertArtifactDescriptor(value, path) {
    exactKeys(value, ["mediaType", "sha256", "sizeBytes"], [], path);
    text(value.mediaType, `${path}.mediaType`, 255);
    assertSha256(value.sha256, `${path}.sha256`);
    nonNegative(value.sizeBytes, `${path}.sizeBytes`);
}

function assertHostProfile(value, path) {
    exactKeys(value, [
        "cevSim", "platform", "architecture", "runtimes", "contracts", "backends", "features",
    ], [], path);
    text(value.cevSim, `${path}.cevSim`, 255);
    text(value.platform, `${path}.platform`, 255);
    text(value.architecture, `${path}.architecture`, 255);
    strings(value.runtimes, `${path}.runtimes`);
    if (!Array.isArray(value.contracts)) invalid(`${path}.contracts`, "expected an array");
    value.contracts.forEach((entry, index) => {
        const entryPath = `${path}.contracts.${index}`;
        exactKeys(entry, ["kind", "versions"], [], entryPath);
        text(entry.kind, `${entryPath}.kind`, 255);
        if (!Array.isArray(entry.versions) || !entry.versions.length) invalid(`${entryPath}.versions`, "expected versions");
        const versions = new Set();
        entry.versions.forEach((version, versionIndex) => {
            positive(version, `${entryPath}.versions.${versionIndex}`);
            if (versions.has(version)) invalid(`${entryPath}.versions.${versionIndex}`, "duplicate version");
            versions.add(version);
        });
    });
    if (!Array.isArray(value.backends)) invalid(`${path}.backends`, "expected an array");
    value.backends.forEach((entry, index) => {
        const entryPath = `${path}.backends.${index}`;
        exactKeys(entry, ["kind", "id", "version"], [], entryPath);
        text(entry.kind, `${entryPath}.kind`, 255);
        text(entry.id, `${entryPath}.id`, 255);
        positive(entry.version, `${entryPath}.version`);
    });
    strings(value.features, `${path}.features`);
}

function assertPreflightRelease(value, path) {
    exactKeys(value, [
        "release", "releaseHash", "compatibility", "yanked", "warnings",
    ], [], path);
    const release = assertMarketplaceRelease(value.release);
    if (!isDeepStrictEqual(release, value.release)) invalid(`${path}.release`, "release is not canonical");
    assertSha256(value.releaseHash, `${path}.releaseHash`);
    if (value.releaseHash !== hashMarketplaceRelease(release)) invalid(`${path}.releaseHash`, "does not match release bytes");
    exactKeys(value.compatibility, ["compatible", "issues"], [], `${path}.compatibility`);
    if (typeof value.compatibility.compatible !== "boolean") invalid(`${path}.compatibility.compatible`, "expected boolean");
    if (!Array.isArray(value.compatibility.issues)) invalid(`${path}.compatibility.issues`, "expected array");
    value.compatibility.issues.forEach((entry, index) => {
        const issuePath = `${path}.compatibility.issues.${index}`;
        exactKeys(entry, ["path", "code", "required", "actual"], [], issuePath);
        text(entry.path, `${issuePath}.path`, 1024);
        text(entry.code, `${issuePath}.code`, 255);
    });
    if (value.compatibility.compatible !== (value.compatibility.issues.length === 0)) {
        invalid(`${path}.compatibility.compatible`, "does not match compatibility issues");
    }
    if (typeof value.yanked !== "boolean") invalid(`${path}.yanked`, "expected boolean");
    strings(value.warnings, `${path}.warnings`);
}

export function assertInstallPreflight(value) {
    assertPlainMarketplaceTree(value);
    exactKeys(value, [
        "kind", "version", "source", "root", "releases", "artifacts", "totalDownloadBytes",
        "installedRevision", "hostProfile", "hostProfileHash", "warnings",
    ], [], "$preflight");
    assertKind(value, MARKETPLACE_INSTALL_KINDS.preflight, "$preflight");
    assertSourcePin(value.source, "$preflight.source");
    assertExactReleaseRef(value.root, "$preflight.root");
    if (!Array.isArray(value.releases) || value.releases.length < 1) invalid("$preflight.releases", "expected releases");
    value.releases.forEach((entry, index) => assertPreflightRelease(entry, `$preflight.releases.${index}`));
    const releaseKeys = new Set();
    value.releases.forEach((entry, index) => {
        const releaseKey = `${entry.release.itemId}\u0000${entry.release.releaseVersion}\u0000${entry.release.artifact.sha256}`;
        if (releaseKeys.has(releaseKey)) invalid(`$preflight.releases.${index}`, "duplicate exact release");
        releaseKeys.add(releaseKey);
    });
    const rootRelease = value.releases.at(-1).release;
    if (!isDeepStrictEqual(value.root, {
        itemId: rootRelease.itemId,
        releaseVersion: rootRelease.releaseVersion,
        artifactSha256: rootRelease.artifact.sha256,
    })) invalid("$preflight.root", "must be the final dependency-first release");
    if (!Array.isArray(value.artifacts)) invalid("$preflight.artifacts", "expected array");
    value.artifacts.forEach((entry, index) => assertArtifactDescriptor(entry, `$preflight.artifacts.${index}`));
    const expectedArtifacts = [...new Map(value.releases.map((entry) => [
        entry.release.artifact.sha256,
        entry.release.artifact,
    ])).values()].sort((left, right) => compareUtf8(left.sha256, right.sha256));
    if (!isDeepStrictEqual(value.artifacts, expectedArtifacts)) invalid("$preflight.artifacts", "must be the sorted deduplicated release artifacts");
    nonNegative(value.totalDownloadBytes, "$preflight.totalDownloadBytes");
    const totalDownloadBytes = value.artifacts.reduce((total, entry) => total + entry.sizeBytes, 0);
    if (!Number.isSafeInteger(totalDownloadBytes) || value.totalDownloadBytes !== totalDownloadBytes) {
        invalid("$preflight.totalDownloadBytes", "does not match artifact bytes");
    }
    nonNegative(value.installedRevision, "$preflight.installedRevision");
    assertHostProfile(value.hostProfile, "$preflight.hostProfile");
    assertSha256(value.hostProfileHash, "$preflight.hostProfileHash");
    if (value.hostProfileHash !== hashMarketplaceBytes(canonicalMarketplaceBytes(value.hostProfile))) {
        invalid("$preflight.hostProfileHash", "does not match the host profile");
    }
    strings(value.warnings, "$preflight.warnings");
    return cloneFrozen(value);
}

function assertFinalRelease(value, path) {
    exactKeys(value, [
        "release", "releaseHash", "adapterId", "artifact", "inspection", "adapterPlan",
        "rights", "conflicts", "mappings", "warnings", "blockingIssues",
    ], [], path);
    const release = assertMarketplaceRelease(value.release);
    if (!isDeepStrictEqual(release, value.release)) invalid(`${path}.release`, "release is not canonical");
    assertSha256(value.releaseHash, `${path}.releaseHash`);
    if (value.releaseHash !== hashMarketplaceRelease(release)) invalid(`${path}.releaseHash`, "does not match release bytes");
    text(value.adapterId, `${path}.adapterId`, 255);
    assertArtifactDescriptor(value.artifact, `${path}.artifact`);
    if (!isDeepStrictEqual(value.artifact, release.artifact)) invalid(`${path}.artifact`, "does not match release artifact");
    object(value.inspection, `${path}.inspection`);
    object(value.adapterPlan, `${path}.adapterPlan`);
    for (const key of ["rights", "conflicts", "mappings"]) {
        if (!Array.isArray(value[key])) invalid(`${path}.${key}`, "expected array");
    }
    strings(value.warnings, `${path}.warnings`);
    strings(value.blockingIssues, `${path}.blockingIssues`);
}

export function assertInstallFinalPlan(value) {
    assertPlainMarketplaceTree(value);
    exactKeys(value, [
        "kind", "version", "preflightHash", "installedRevision", "hostProfileHash", "releases",
        "committable", "blockingIssues", "warnings",
    ], [], "$finalPlan");
    assertKind(value, MARKETPLACE_INSTALL_KINDS.finalPlan, "$finalPlan");
    assertSha256(value.preflightHash, "$finalPlan.preflightHash");
    nonNegative(value.installedRevision, "$finalPlan.installedRevision");
    assertSha256(value.hostProfileHash, "$finalPlan.hostProfileHash");
    if (!Array.isArray(value.releases) || value.releases.length < 1) invalid("$finalPlan.releases", "expected releases");
    value.releases.forEach((entry, index) => assertFinalRelease(entry, `$finalPlan.releases.${index}`));
    const releaseKeys = new Set();
    value.releases.forEach((entry, index) => {
        const releaseKey = `${entry.release.itemId}\u0000${entry.release.releaseVersion}\u0000${entry.release.artifact.sha256}`;
        if (releaseKeys.has(releaseKey)) invalid(`$finalPlan.releases.${index}`, "duplicate exact release");
        releaseKeys.add(releaseKey);
    });
    if (typeof value.committable !== "boolean") invalid("$finalPlan.committable", "expected boolean");
    strings(value.blockingIssues, "$finalPlan.blockingIssues");
    if (value.committable !== (value.blockingIssues.length === 0)) {
        invalid("$finalPlan.committable", "does not match blocking issues");
    }
    strings(value.warnings, "$finalPlan.warnings");
    return cloneFrozen(value);
}

export function assertInstallJob(value) {
    assertPlainMarketplaceTree(value);
    exactKeys(value, [
        "kind", "version", "jobId", "revision", "phase", "createdAt", "updatedAt", "planHash",
        "finalPlanHash", "progress", "error", "receiptHashes",
    ], [], "$job");
    assertKind(value, MARKETPLACE_INSTALL_KINDS.job, "$job");
    assertCanonicalUuid(value.jobId, "$job.jobId");
    nonNegative(value.revision, "$job.revision");
    if (!MARKETPLACE_JOB_PHASES.includes(value.phase)) invalid("$job.phase", "unsupported job phase");
    assertCanonicalTimestamp(value.createdAt, "$job.createdAt");
    assertCanonicalTimestamp(value.updatedAt, "$job.updatedAt");
    assertSha256(value.planHash, "$job.planHash");
    if (value.finalPlanHash !== null) assertSha256(value.finalPlanHash, "$job.finalPlanHash");
    exactKeys(value.progress, [
        "artifactsTotal", "artifactsComplete", "bytesTotal", "bytesComplete", "currentDigest",
    ], [], "$job.progress");
    for (const key of ["artifactsTotal", "artifactsComplete", "bytesTotal", "bytesComplete"]) {
        nonNegative(value.progress[key], `$job.progress.${key}`);
    }
    if (value.progress.artifactsComplete > value.progress.artifactsTotal) invalid("$job.progress.artifactsComplete", "exceeds total");
    if (value.progress.bytesComplete > value.progress.bytesTotal) invalid("$job.progress.bytesComplete", "exceeds total");
    if (value.progress.currentDigest !== null) assertSha256(value.progress.currentDigest, "$job.progress.currentDigest");
    if (value.error !== null) {
        exactKeys(value.error, ["code", "message"], [], "$job.error");
        text(value.error.code, "$job.error.code", 128);
        text(value.error.message, "$job.error.message", 4096);
    }
    strings(value.receiptHashes, "$job.receiptHashes", { hashes: true });
    if (value.phase !== "complete" && value.receiptHashes.length) invalid("$job.receiptHashes", "receipts require a complete job");
    return cloneFrozen(value);
}

export function assertInstallTransaction(value) {
    assertPlainMarketplaceTree(value);
    exactKeys(value, [
        "kind", "version", "transactionId", "jobId", "operation", "finalPlanHash", "installedBase",
        "installedTarget", "receiptHashes", "adapterCommits",
    ], [], "$transaction");
    assertKind(value, MARKETPLACE_INSTALL_KINDS.transaction, "$transaction");
    assertCanonicalUuid(value.transactionId, "$transaction.transactionId");
    if (value.jobId !== null) assertCanonicalUuid(value.jobId, "$transaction.jobId");
    if (!["install", "remove-membership"].includes(value.operation)) invalid("$transaction.operation", "unsupported transaction operation");
    if (value.finalPlanHash !== null) assertSha256(value.finalPlanHash, "$transaction.finalPlanHash");
    for (const [name, entry] of [["installedBase", value.installedBase], ["installedTarget", value.installedTarget]]) {
        exactKeys(entry, ["revision", "sha256"], [], `$transaction.${name}`);
        nonNegative(entry.revision, `$transaction.${name}.revision`);
        assertSha256(entry.sha256, `$transaction.${name}.sha256`);
    }
    strings(value.receiptHashes, "$transaction.receiptHashes", { hashes: true });
    if (!Array.isArray(value.adapterCommits)) invalid("$transaction.adapterCommits", "expected array");
    value.adapterCommits.forEach((entry, index) => {
        exactKeys(entry, ["adapterId", "itemId", "releaseVersion", "artifactSha256"], [], `$transaction.adapterCommits.${index}`);
        text(entry.adapterId, `$transaction.adapterCommits.${index}.adapterId`, 255);
        text(entry.itemId, `$transaction.adapterCommits.${index}.itemId`, 255);
        assertReleaseVersion(entry.releaseVersion, `$transaction.adapterCommits.${index}.releaseVersion`);
        assertSha256(entry.artifactSha256, `$transaction.adapterCommits.${index}.artifactSha256`);
    });
    return cloneFrozen(value);
}

export function assertArtifactRecord(value) {
    assertPlainMarketplaceTree(value);
    exactKeys(value, ["kind", "version", "sha256", "sizeBytes", "mediaType"], [], "$artifactRecord");
    assertKind(value, MARKETPLACE_INSTALL_KINDS.artifactRecord, "$artifactRecord");
    assertSha256(value.sha256, "$artifactRecord.sha256");
    nonNegative(value.sizeBytes, "$artifactRecord.sizeBytes");
    text(value.mediaType, "$artifactRecord.mediaType", 255);
    return cloneFrozen(value);
}

export function assertQuarantineRecord(value) {
    assertPlainMarketplaceTree(value);
    exactKeys(value, [
        "kind", "version", "quarantineId", "createdAt", "expectedSha256", "actualSha256", "sizeBytes", "reasonCode",
    ], [], "$quarantine");
    assertKind(value, MARKETPLACE_INSTALL_KINDS.quarantineRecord, "$quarantine");
    assertCanonicalUuid(value.quarantineId, "$quarantine.quarantineId");
    assertCanonicalTimestamp(value.createdAt, "$quarantine.createdAt");
    assertSha256(value.expectedSha256, "$quarantine.expectedSha256");
    assertSha256(value.actualSha256, "$quarantine.actualSha256");
    nonNegative(value.sizeBytes, "$quarantine.sizeBytes");
    text(value.reasonCode, "$quarantine.reasonCode", 128);
    return cloneFrozen(value);
}

export const INSTALL_DOCUMENT_ASSERTIONS = Object.freeze({
    [MARKETPLACE_INSTALL_KINDS.preflight]: assertInstallPreflight,
    [MARKETPLACE_INSTALL_KINDS.finalPlan]: assertInstallFinalPlan,
    [MARKETPLACE_INSTALL_KINDS.job]: assertInstallJob,
    [MARKETPLACE_INSTALL_KINDS.transaction]: assertInstallTransaction,
    [MARKETPLACE_INSTALL_KINDS.artifactRecord]: assertArtifactRecord,
    [MARKETPLACE_INSTALL_KINDS.quarantineRecord]: assertQuarantineRecord,
});

export function assertInstallDocument(value) {
    const assertion = INSTALL_DOCUMENT_ASSERTIONS[value?.kind];
    if (!assertion) invalid("$.kind", "unsupported local installation document");
    return assertion(value);
}

export function installDocumentBytes(value, assertion = assertInstallDocument) {
    return canonicalMarketplaceBytes(assertion(value));
}

export function parseInstallDocument(bytes, assertion = assertInstallDocument) {
    const { document } = parseMarketplaceJsonBytes(bytes);
    return assertion(document);
}

export function hashInstallDocument(value, assertion = assertInstallDocument) {
    return hashMarketplaceBytes(installDocumentBytes(value, assertion));
}

export function installedDocumentHash(value) {
    return hashMarketplaceBytes(canonicalMarketplaceBytes(assertMarketplaceInstalled(value)));
}
