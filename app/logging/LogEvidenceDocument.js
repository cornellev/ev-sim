/**
 * Versioned sidecar-only evidence index for SFLog recordings.
 * Never rewrite .sflog bytes; preserve null/unknown lineage instead of fabricating it.
 */

import { normalizeCandidateModel, normalizeManifestProvenance } from "../simulation/RunManifest.js";

export const LOG_EVIDENCE_KIND = "cev-sim.log-evidence";
export const LOG_EVIDENCE_VERSION = 1;

function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = null) {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

function nullableHash(value) {
    const normalized = text(value);
    return normalized || null;
}

function decodeAttachmentJson(attachment) {
    if (!attachment?.bytes) return null;
    try {
        const textValue = typeof attachment.bytes === "string"
            ? attachment.bytes
            : new TextDecoder().decode(attachment.bytes);
        return JSON.parse(textValue);
    } catch {
        return null;
    }
}

export function createEmptyLogEvidence(overrides = {}) {
    return normalizeLogEvidence({
        kind: LOG_EVIDENCE_KIND,
        version: LOG_EVIDENCE_VERSION,
        ...overrides,
    });
}

export function normalizeLogEvidence(value = {}) {
    const source = object(value);
    if (source.kind !== undefined && source.kind !== LOG_EVIDENCE_KIND) {
        throw new Error(`Unsupported log evidence kind: ${JSON.stringify(source.kind)}.`);
    }
    if (source.version !== undefined && Number(source.version) !== LOG_EVIDENCE_VERSION) {
        throw new Error(`Unsupported log evidence version ${source.version}.`);
    }
    const provenance = normalizeManifestProvenance({
        candidateModels: source.candidateModels ?? source.provenance?.candidateModels,
    });
    const warnings = Array.isArray(source.source?.warnings)
        ? source.source.warnings.map((entry) => String(entry)).filter(Boolean)
        : Array.isArray(source.warnings)
            ? source.warnings.map((entry) => String(entry)).filter(Boolean)
            : [];
    const status = ["indexed", "partial", "unknown"].includes(source.source?.status)
        ? source.source.status
        : (source.status && ["indexed", "partial", "unknown"].includes(source.status) ? source.status : null);
    return {
        kind: LOG_EVIDENCE_KIND,
        version: LOG_EVIDENCE_VERSION,
        manifestId: nullableHash(source.manifestId),
        runId: nullableHash(source.runId),
        definitionHash: nullableHash(source.definitionHash),
        resolvedHash: nullableHash(source.resolvedHash),
        simulationSemanticHash: nullableHash(source.simulationSemanticHash),
        episodeHash: nullableHash(source.episodeHash),
        trajectoryHash: nullableHash(source.trajectoryHash),
        worldHash: nullableHash(source.worldHash),
        calibrationHash: nullableHash(source.calibrationHash),
        suiteId: nullableHash(source.suiteId),
        resultId: nullableHash(source.resultId),
        caseId: nullableHash(source.caseId),
        gitCommit: nullableHash(source.gitCommit ?? source.gitHash),
        candidateModels: provenance.candidateModels.map(normalizeCandidateModel),
        source: {
            status: status || "unknown",
            backfilled: Boolean(source.source?.backfilled ?? source.backfilled),
            warnings,
        },
    };
}

export function mergeLogEvidence(base = null, patch = null) {
    const left = base ? normalizeLogEvidence(base) : createEmptyLogEvidence();
    if (!patch) return left;
    const right = normalizeLogEvidence({
        ...left,
        ...object(patch),
        candidateModels: patch.candidateModels ?? left.candidateModels,
        source: {
            ...left.source,
            ...object(patch.source),
            warnings: [
                ...left.source.warnings,
                ...(Array.isArray(patch.source?.warnings) ? patch.source.warnings : []),
                ...(Array.isArray(patch.warnings) ? patch.warnings : []),
            ],
        },
    });
    const prefer = (next, previous) => (next == null ? previous : next);
    const merged = createEmptyLogEvidence({
        manifestId: prefer(right.manifestId, left.manifestId),
        runId: prefer(right.runId, left.runId),
        definitionHash: prefer(right.definitionHash, left.definitionHash),
        resolvedHash: prefer(right.resolvedHash, left.resolvedHash),
        simulationSemanticHash: prefer(right.simulationSemanticHash, left.simulationSemanticHash),
        episodeHash: prefer(right.episodeHash, left.episodeHash),
        trajectoryHash: prefer(right.trajectoryHash, left.trajectoryHash),
        worldHash: prefer(right.worldHash, left.worldHash),
        calibrationHash: prefer(right.calibrationHash, left.calibrationHash),
        suiteId: prefer(right.suiteId, left.suiteId),
        resultId: prefer(right.resultId, left.resultId),
        caseId: prefer(right.caseId, left.caseId),
        gitCommit: prefer(right.gitCommit, left.gitCommit),
        candidateModels: right.candidateModels.length > 0 ? right.candidateModels : left.candidateModels,
        source: {
            status: right.source.status === "unknown" ? left.source.status : right.source.status,
            backfilled: left.source.backfilled || right.source.backfilled,
            warnings: [...new Set([...left.source.warnings, ...right.source.warnings])],
        },
    });
    return withEvidenceStatus(merged);
}

function withEvidenceStatus(evidence) {
    const normalized = normalizeLogEvidence(evidence);
    const identityFields = [
        normalized.manifestId,
        normalized.runId,
        normalized.resolvedHash,
        normalized.definitionHash,
        normalized.simulationSemanticHash,
        normalized.episodeHash,
        normalized.trajectoryHash,
        normalized.worldHash,
        normalized.calibrationHash,
        normalized.suiteId,
        normalized.resultId,
        normalized.caseId,
        normalized.gitCommit,
    ];
    const known = identityFields.filter((value) => value != null).length
        + (normalized.candidateModels.length > 0 ? 1 : 0);
    let status = "unknown";
    if (known === 0) status = "unknown";
    else if (
        normalized.resolvedHash
        && normalized.simulationSemanticHash
        && normalized.episodeHash
        && normalized.trajectoryHash
    ) {
        status = "indexed";
    } else {
        status = "partial";
    }
    return {
        ...normalized,
        source: {
            ...normalized.source,
            status: normalized.source.warnings.length > 0 && status === "indexed" ? "partial" : status,
        },
    };
}

export function projectEvidenceFromResolvedRun(resolved = null, extras = {}) {
    const source = object(resolved);
    const manifest = object(source.manifest);
    const dependencyHashes = object(source.dependencyHashes);
    return withEvidenceStatus(createEmptyLogEvidence({
        manifestId: extras.manifestId ?? manifest.id ?? null,
        runId: extras.runId ?? null,
        definitionHash: extras.definitionHash ?? source.definitionHash ?? null,
        resolvedHash: extras.resolvedHash ?? source.resolvedHash ?? null,
        simulationSemanticHash: extras.simulationSemanticHash ?? source.simulationSemanticHash ?? null,
        episodeHash: extras.episodeHash ?? null,
        trajectoryHash: extras.trajectoryHash ?? null,
        worldHash: extras.worldHash ?? dependencyHashes.world ?? source.world?.hash ?? null,
        calibrationHash: extras.calibrationHash ?? dependencyHashes.calibration ?? source.calibration?.hash ?? null,
        suiteId: extras.suiteId ?? null,
        resultId: extras.resultId ?? null,
        caseId: extras.caseId ?? null,
        gitCommit: extras.gitCommit ?? extras.gitHash ?? null,
        candidateModels: extras.candidateModels
            ?? manifest.provenance?.candidateModels
            ?? source.provenance?.candidateModels
            ?? [],
        source: {
            status: "partial",
            backfilled: Boolean(extras.backfilled),
            warnings: Array.isArray(extras.warnings) ? extras.warnings : [],
        },
    }));
}

export function projectEvidenceFromRunResult(runResult = null, extras = {}) {
    const source = object(runResult);
    return withEvidenceStatus(createEmptyLogEvidence({
        manifestId: extras.manifestId ?? source.manifestId ?? null,
        runId: extras.runId ?? source.runId ?? null,
        definitionHash: extras.definitionHash ?? source.definitionHash ?? null,
        resolvedHash: extras.resolvedHash ?? source.resolvedHash ?? null,
        simulationSemanticHash: extras.simulationSemanticHash ?? source.simulationSemanticHash ?? null,
        episodeHash: extras.episodeHash ?? source.episodeHash ?? null,
        trajectoryHash: extras.trajectoryHash ?? source.trajectoryHash ?? null,
        worldHash: extras.worldHash ?? source.worldHash ?? source.dependencyHashes?.world ?? null,
        calibrationHash: extras.calibrationHash ?? source.calibrationHash ?? source.dependencyHashes?.calibration ?? null,
        suiteId: extras.suiteId ?? source.suiteId ?? null,
        resultId: extras.resultId ?? source.resultId ?? null,
        caseId: extras.caseId ?? source.caseId ?? null,
        gitCommit: extras.gitCommit ?? extras.gitHash ?? source.gitCommit ?? source.gitHash ?? null,
        candidateModels: extras.candidateModels ?? source.candidateModels ?? [],
        source: {
            status: "partial",
            backfilled: Boolean(extras.backfilled),
            warnings: Array.isArray(extras.warnings) ? extras.warnings : [],
        },
    }));
}

export function projectEvidenceFromMetadata(metadata = {}) {
    const source = object(metadata);
    return withEvidenceStatus(createEmptyLogEvidence({
        manifestId: source.manifestId ?? null,
        runId: source.runId ?? null,
        definitionHash: source.definitionHash ?? null,
        resolvedHash: source.resolvedHash ?? null,
        simulationSemanticHash: source.simulationSemanticHash ?? null,
        episodeHash: source.episodeHash ?? null,
        trajectoryHash: source.trajectoryHash ?? null,
        worldHash: source.worldHash ?? null,
        calibrationHash: source.calibrationHash ?? null,
        suiteId: source.suiteId ?? null,
        resultId: source.resultId ?? null,
        caseId: source.caseId ?? null,
        gitCommit: source.gitCommit ?? source.gitHash ?? null,
        candidateModels: source.evidence?.candidateModels
            ?? source.provenance?.candidateModels
            ?? [],
        source: {
            status: "partial",
            backfilled: true,
            warnings: [],
        },
    }));
}

export function backfillEvidenceFromAttachments(metadata = {}, attachments = []) {
    const warnings = [];
    const byName = new Map(
        (Array.isArray(attachments) ? attachments : [])
            .filter((entry) => entry?.name)
            .map((entry) => [String(entry.name), entry]),
    );
    let resolved = decodeAttachmentJson(byName.get("run-manifest.json"));
    if (resolved && resolved.manifest == null && resolved.kind === "cev-sim.run-manifest") {
        // Older attachments may store the authored manifest alone.
        resolved = { manifest: resolved, definitionHash: metadata.definitionHash, resolvedHash: metadata.resolvedHash };
    }
    const runResults = decodeAttachmentJson(byName.get("run-results.json"));
    const calibration = decodeAttachmentJson(byName.get("calibration.json"));
    const provenance = decodeAttachmentJson(byName.get("provenance.json"));

    if (byName.size === 0) {
        warnings.push("No attachments were available for evidence backfill.");
    } else {
        if (!byName.has("run-manifest.json")) warnings.push("Missing run-manifest.json attachment.");
        if (!byName.has("run-results.json")) warnings.push("Missing run-results.json attachment.");
    }
    if (byName.has("run-manifest.json") && !resolved) warnings.push("run-manifest.json attachment was malformed.");
    if (byName.has("run-results.json") && !runResults) warnings.push("run-results.json attachment was malformed.");
    if (byName.has("calibration.json") && !calibration) warnings.push("calibration.json attachment was malformed.");
    if (byName.has("provenance.json") && !provenance) warnings.push("provenance.json attachment was malformed.");

    let evidence = metadata.evidence
        ? mergeLogEvidence(metadata.evidence, projectEvidenceFromMetadata(metadata))
        : projectEvidenceFromMetadata(metadata);
    if (resolved) {
        evidence = mergeLogEvidence(evidence, projectEvidenceFromResolvedRun(resolved, {
            runId: metadata.runId,
            gitCommit: metadata.gitHash,
            backfilled: true,
            warnings,
        }));
    }
    if (calibration?.hash) {
        evidence = mergeLogEvidence(evidence, createEmptyLogEvidence({
            calibrationHash: calibration.hash,
            source: { backfilled: true, warnings: [] },
        }));
    }
    if (provenance) {
        evidence = mergeLogEvidence(evidence, createEmptyLogEvidence({
            gitCommit: provenance.gitHash ?? provenance.gitCommit ?? null,
            candidateModels: provenance.candidateModels ?? provenance.manifest?.provenance?.candidateModels ?? [],
            source: { backfilled: true, warnings: [] },
        }));
    }
    if (runResults) {
        evidence = mergeLogEvidence(evidence, projectEvidenceFromRunResult(runResults, {
            backfilled: true,
            warnings,
        }));
    }
    return withEvidenceStatus({
        ...evidence,
        source: {
            ...evidence.source,
            backfilled: true,
            warnings: [...new Set([...evidence.source.warnings, ...warnings])],
        },
    });
}

export function evidenceSearchHaystack(evidence = null, metadata = {}) {
    const normalized = evidence ? normalizeLogEvidence(evidence) : createEmptyLogEvidence();
    const parts = [
        metadata.id,
        metadata.name,
        metadata.environmentId,
        ...(metadata.tags || []),
        normalized.manifestId,
        normalized.runId,
        normalized.definitionHash,
        normalized.resolvedHash,
        normalized.simulationSemanticHash,
        normalized.episodeHash,
        normalized.trajectoryHash,
        normalized.worldHash,
        normalized.calibrationHash,
        normalized.suiteId,
        normalized.resultId,
        normalized.caseId,
        normalized.gitCommit,
        ...normalized.candidateModels.flatMap((model) => [
            model.role,
            model.modelId,
            model.version,
            model.digest,
        ]),
    ];
    return parts.filter(Boolean).join(" ").toLowerCase();
}

export function hasCompleteEvidenceIndex(evidence) {
    if (!evidence) return false;
    try {
        normalizeLogEvidence(evidence);
        return true;
    } catch {
        return false;
    }
}
