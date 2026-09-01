export const HEADLESS_EXPERIMENT_QUEUE_KIND = "cev-sim.headless-experiment-queue";
export const HEADLESS_EXPERIMENT_QUEUE_VERSION = 1;

export const HEADLESS_RUN_BUNDLE_MANIFEST_KIND = "cev-sim.headless-run-bundle-manifest";
export const HEADLESS_RUN_BUNDLE_MANIFEST_VERSION = 1;

function trimmedText(value) {
    return String(value ?? "").trim();
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

export function createHeadlessExperimentQueue() {
    return normalizeHeadlessExperimentQueue({
        kind: HEADLESS_EXPERIMENT_QUEUE_KIND,
        version: HEADLESS_EXPERIMENT_QUEUE_VERSION,
        revision: 0,
        entries: [],
    });
}

export function normalizeHeadlessExperimentQueue(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    const entries = Array.isArray(source.entries)
        ? source.entries.map(normalizeQueueEntry)
        : [];
    return {
        kind: HEADLESS_EXPERIMENT_QUEUE_KIND,
        version: HEADLESS_EXPERIMENT_QUEUE_VERSION,
        revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
        entries,
    };
}

function normalizeQueueEntry(value = {}, index = 0) {
    const source = value && typeof value === "object" ? value : {};
    return {
        jobId: trimmedText(source.jobId, `headless-job-${index + 1}`),
        resultId: trimmedText(source.resultId),
        suiteId: trimmedText(source.suiteId),
        suiteRevision: Number(source.suiteRevision) || 0,
        suiteHash: trimmedText(source.suiteHash) || null,
        enqueuedAt: trimmedText(source.enqueuedAt) || new Date().toISOString(),
        failurePolicy: source.failurePolicy === "fail-fast" ? "fail-fast" : "continue",
        artifactProfile: ["evaluation", "training", "disabled"].includes(trimmedText(source.artifactProfile))
            ? trimmedText(source.artifactProfile)
            : null,
    };
}

export function validateHeadlessExperimentQueue(value) {
    const queue = normalizeHeadlessExperimentQueue(value);
    const issues = [];
    if (queue.kind !== HEADLESS_EXPERIMENT_QUEUE_KIND) {
        issues.push({ path: "kind", message: "Invalid headless experiment queue kind." });
    }
    const resultIds = new Set();
    for (const [index, entry] of queue.entries.entries()) {
        if (!entry.resultId) issues.push({ path: `entries.${index}.resultId`, message: "resultId is required." });
        if (!entry.jobId) issues.push({ path: `entries.${index}.jobId`, message: "jobId is required." });
        if (!entry.suiteId) issues.push({ path: `entries.${index}.suiteId`, message: "suiteId is required." });
        if (resultIds.has(entry.resultId)) {
            issues.push({ path: `entries.${index}.resultId`, message: `Duplicate queue resultId "${entry.resultId}".` });
        }
        resultIds.add(entry.resultId);
    }
    return { ok: issues.length === 0, queue, issues };
}

export function normalizeHeadlessRunBundleManifest(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    return {
        kind: HEADLESS_RUN_BUNDLE_MANIFEST_KIND,
        version: HEADLESS_RUN_BUNDLE_MANIFEST_VERSION,
        resultId: trimmedText(source.resultId),
        jobId: trimmedText(source.jobId),
        suiteId: trimmedText(source.suiteId),
        suiteRevision: Number(source.suiteRevision) || 0,
        suiteHash: trimmedText(source.suiteHash) || null,
        createdAt: trimmedText(source.createdAt) || new Date().toISOString(),
        caseCount: Number(source.caseCount) || 0,
        cases: Array.isArray(source.cases)
            ? source.cases.map((entry, index) => ({
                id: trimmedText(entry?.id, `case-${index + 1}`),
                dependencyHashes: entry?.dependencyHashes && typeof entry.dependencyHashes === "object"
                    ? clone(entry.dependencyHashes)
                    : {},
            }))
            : [],
    };
}

export function queuePositionFor(queue, resultId) {
    const index = queue.entries.findIndex((entry) => entry.resultId === resultId);
    return index >= 0 ? index + 1 : null;
}

export function appendQueueEntry(queue, entry) {
    const next = normalizeHeadlessExperimentQueue(queue);
    next.entries = [...next.entries, normalizeQueueEntry(entry, next.entries.length)];
    next.revision += 1;
    return next;
}

export function removeQueueEntry(queue, resultId) {
    const next = normalizeHeadlessExperimentQueue(queue);
    next.entries = next.entries.filter((entry) => entry.resultId !== resultId);
    next.revision += 1;
    return next;
}
