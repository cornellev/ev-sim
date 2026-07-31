import { storageDelete, storageGet, storagePost, storagePut } from "../client/storageClient.js";

const suites = "experiment-suites";

export function listExperimentSuites() {
    return storageGet(suites);
}

export function getExperimentSuite(id) {
    return storageGet(`${suites}/${encodeURIComponent(id)}`);
}

export function createExperimentSuite(suite) {
    return storagePost(suites, suite);
}

export function saveExperimentSuite(id, suite, expectedRevision) {
    return storagePut(`${suites}/${encodeURIComponent(id)}`, { suite, expectedRevision });
}

export function duplicateExperimentSuite(id, input) {
    return storagePost(`${suites}/${encodeURIComponent(id)}/duplicate`, input);
}

export function deleteExperimentSuite(id, expectedRevision) {
    const revision = expectedRevision === undefined ? "" : `?expectedRevision=${encodeURIComponent(expectedRevision)}`;
    return storageDelete(`${suites}/${encodeURIComponent(id)}${revision}`);
}

export function validateExperimentSuiteOnServer(id, suite) {
    return storagePost(`${suites}/${encodeURIComponent(id)}/validate`, { suite });
}

export function resolveExperimentCase(suiteId, input) {
    return storagePost(`${suites}/${encodeURIComponent(suiteId)}/resolve-case`, input);
}

export function listExperimentResults() {
    return storageGet("experiment-results");
}

export function getExperimentResult(id) {
    return storageGet(`experiment-results/${encodeURIComponent(id)}`);
}

export function createExperimentResult(result) {
    return storagePost("experiment-results", result);
}

export function saveExperimentResult(id, result, expectedRevision) {
    return storagePut(`experiment-results/${encodeURIComponent(id)}`, { result, expectedRevision });
}

export function deleteExperimentResult(id, expectedRevision) {
    const revision = expectedRevision === undefined ? "" : `?expectedRevision=${encodeURIComponent(expectedRevision)}`;
    return storageDelete(`experiment-results/${encodeURIComponent(id)}${revision}`);
}

export function validateExperimentResultOnServer(id, result = null) {
    return storagePost(
        `experiment-results/${encodeURIComponent(id)}/validate`,
        result ? { result } : {},
    );
}

export function listExperimentBaselines(suiteId = null) {
    return storageGet(`experiment-baselines${suiteId ? `?suiteId=${encodeURIComponent(suiteId)}` : ""}`);
}

export function getExperimentBaseline(id) {
    return storageGet(`experiment-baselines/${encodeURIComponent(id)}`);
}

export function createExperimentBaseline(baseline) {
    return storagePost("experiment-baselines", baseline);
}

export function validateExperimentBaselineOnServer(id, baseline = null) {
    return storagePost(
        `experiment-baselines/${encodeURIComponent(id)}/validate`,
        baseline ? { baseline } : {},
    );
}

export function deleteExperimentBaseline(id) {
    return storageDelete(`experiment-baselines/${encodeURIComponent(id)}`);
}
