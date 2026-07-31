import {
    asObject,
    cloneValue,
    isPlainObject,
    nonNegativeInteger,
    trimmedText,
} from "./ExperimentUtils.js";
import { experimentCaseKey } from "./ExperimentSuite.js";
import {
    normalizeMetricDefinitions,
    normalizeMetricValues,
    validateMetricDefinition,
} from "./MetricReducers.js";

export const EXPERIMENT_RESULT_KIND = "cev-sim.experiment-result";
export const EXPERIMENT_RESULT_VERSION = 1;

export const EXPERIMENT_RESULT_STATUSES = Object.freeze([
    "pending",
    "running",
    "paused",
    "completed",
    "cancelled",
    "interrupted",
    "error",
]);

export const EXPERIMENT_CASE_STATUSES = Object.freeze([
    "pending",
    "running",
    "completed",
    "failed",
    "error",
    "cancelled",
    "interrupted",
]);

const TERMINAL_CASE_STATUSES = new Set(["completed", "failed", "error", "cancelled", "interrupted"]);

function optionalText(value) {
    return trimmedText(value) || null;
}

function structuredOrText(value) {
    if (value === null || value === undefined || value === "") return null;
    return isPlainObject(value) || Array.isArray(value) ? cloneValue(value) : optionalText(value);
}

function normalizeOutcome(value = {}, index = 0) {
    const source = asObject(value);
    const passed = typeof source.passed === "boolean" ? source.passed : null;
    const requestedStatus = trimmedText(source.status);
    const status = ["pending", "passed", "failed", "error"].includes(requestedStatus)
        ? requestedStatus
        : (passed === null ? "pending" : passed ? "passed" : "failed");
    return {
        id: trimmedText(source.id, `outcome-${index + 1}`),
        name: trimmedText(source.name, source.id || `Outcome ${index + 1}`),
        status,
        passed: status === "passed" ? true : status === "failed" ? false : passed,
        message: optionalText(source.message ?? source.detail),
        detail: structuredOrText(source.detail ?? source.message),
    };
}

export function normalizeExperimentCaseResult(value = {}, index = 0) {
    const source = asObject(value);
    const requestedStatus = trimmedText(source.status, "pending");
    const status = EXPERIMENT_CASE_STATUSES.includes(requestedStatus) ? requestedStatus : "pending";
    const identity = {
        scenarioId: trimmedText(source.scenarioId),
        manifestId: trimmedText(source.manifestId),
        seed: source.seed ?? "42",
        parameters: isPlainObject(source.parameters ?? source.parameterValues)
            ? cloneValue(source.parameters ?? source.parameterValues)
            : {},
    };
    const completed = typeof source.completed === "boolean"
        ? source.completed
        : ["completed", "failed"].includes(status);
    const passed = typeof source.passed === "boolean"
        ? source.passed
        : (status === "completed" ? null : false);
    return {
        id: trimmedText(source.id, `case-${index + 1}`),
        key: experimentCaseKey(identity),
        ordinal: nonNegativeInteger(source.ordinal, index),
        ...identity,
        status,
        completed,
        passed,
        terminationReason: optionalText(source.terminationReason),
        latestTrigger: structuredOrText(source.latestTrigger),
        terminalEvent: structuredOrText(source.terminalEvent),
        assertions: Array.isArray(source.assertions ?? source.assertionResults)
            ? cloneValue(source.assertions ?? source.assertionResults)
            : [],
        outcomes: (Array.isArray(source.outcomes ?? source.outcomeResults)
            ? (source.outcomes ?? source.outcomeResults)
            : []).map(normalizeOutcome),
        metrics: normalizeMetricValues(source.metrics),
        dependencyHashes: isPlainObject(source.dependencyHashes) ? cloneValue(source.dependencyHashes) : {},
        resolvedHash: optionalText(source.resolvedHash),
        logId: optionalText(source.logId),
        startedAt: optionalText(source.startedAt),
        finishedAt: optionalText(source.finishedAt),
        failureReason: optionalText(source.failureReason || source.error?.message || source.error),
    };
}

function summarizeCases(cases) {
    const summary = {
        total: cases.length,
        pending: 0,
        running: 0,
        completed: 0,
        passed: 0,
        failed: 0,
        error: 0,
        cancelled: 0,
        interrupted: 0,
    };
    for (const entry of cases) {
        if (["pending", "running", "error", "cancelled", "interrupted"].includes(entry.status)) {
            summary[entry.status] += 1;
        }
        if (entry.completed) summary.completed += 1;
        if (entry.passed === true) summary.passed += 1;
        if (entry.status === "failed" || (entry.completed && entry.passed === false)) summary.failed += 1;
    }
    return summary;
}

export function normalizeExperimentResult(value = {}, { allowMissingKind = false } = {}) {
    const source = asObject(value);
    if (!allowMissingKind && source.kind !== undefined && source.kind !== EXPERIMENT_RESULT_KIND) {
        throw new Error(`Unsupported experiment result kind: ${JSON.stringify(source.kind)}.`);
    }
    if (source.version !== undefined && Number(source.version) !== EXPERIMENT_RESULT_VERSION) {
        throw new Error(`Unsupported experiment result version ${source.version}; expected ${EXPERIMENT_RESULT_VERSION}.`);
    }
    const cases = (Array.isArray(source.cases) ? source.cases : []).map(normalizeExperimentCaseResult);
    const requestedStatus = trimmedText(source.status, "pending");
    return {
        kind: EXPERIMENT_RESULT_KIND,
        version: EXPERIMENT_RESULT_VERSION,
        id: trimmedText(source.id, "untitled-experiment-result"),
        suiteId: trimmedText(source.suiteId),
        suiteRevision: source.suiteRevision === null || source.suiteRevision === undefined
            ? null
            : nonNegativeInteger(source.suiteRevision),
        suiteHash: optionalText(source.suiteHash),
        status: EXPERIMENT_RESULT_STATUSES.includes(requestedStatus) ? requestedStatus : "pending",
        createdAt: optionalText(source.createdAt),
        startedAt: optionalText(source.startedAt),
        finishedAt: optionalText(source.finishedAt),
        metricDefinitions: normalizeMetricDefinitions(source.metricDefinitions ?? source.metrics),
        cases,
        summary: summarizeCases(cases),
    };
}

export function createExperimentResult(suite, cases = [], overrides = {}) {
    const sourceSuite = asObject(suite);
    return normalizeExperimentResult({
        kind: EXPERIMENT_RESULT_KIND,
        version: EXPERIMENT_RESULT_VERSION,
        id: `${trimmedText(sourceSuite.id, "experiment")}-result`,
        suiteId: trimmedText(sourceSuite.id),
        suiteRevision: sourceSuite.revision ?? null,
        suiteHash: sourceSuite.definitionHash ?? sourceSuite.resolvedHash ?? null,
        status: "pending",
        metricDefinitions: sourceSuite.metrics,
        cases: cases.map((entry) => ({ ...entry, status: "pending" })),
        ...overrides,
    }, { allowMissingKind: true });
}

export function validateExperimentResult(value) {
    let result;
    try {
        result = normalizeExperimentResult(value);
    } catch (error) {
        return { ok: false, result: null, issues: [{ path: "", message: error.message }] };
    }
    const issues = [];
    if (!result.suiteId) issues.push({ path: "suiteId", message: "A suite id is required." });
    const metricIds = new Set();
    for (const [index, metric] of result.metricDefinitions.entries()) {
        issues.push(...validateMetricDefinition(metric, `metricDefinitions.${index}`).issues);
        if (metricIds.has(metric.id)) {
            issues.push({ path: `metricDefinitions.${index}.id`, message: `Duplicate metric id "${metric.id}".` });
        }
        metricIds.add(metric.id);
    }
    const ids = new Set();
    const keys = new Set();
    for (const [index, entry] of result.cases.entries()) {
        if (!entry.scenarioId) issues.push({ path: `cases.${index}.scenarioId`, message: "A scenario id is required." });
        if (!entry.manifestId) issues.push({ path: `cases.${index}.manifestId`, message: "A run manifest id is required." });
        if (ids.has(entry.id)) issues.push({ path: `cases.${index}.id`, message: `Duplicate case id "${entry.id}".` });
        if (keys.has(entry.key)) issues.push({ path: `cases.${index}`, message: "Duplicate scenario/manifest/seed/parameter case." });
        ids.add(entry.id);
        keys.add(entry.key);
        if (entry.passed === true && entry.completed !== true) {
            issues.push({ path: `cases.${index}.passed`, message: "A passing case must have completed." });
        }
        if (TERMINAL_CASE_STATUSES.has(entry.status) && !entry.finishedAt && result.status === "completed") {
            issues.push({ path: `cases.${index}.finishedAt`, message: "Completed experiment results require terminal case timestamps." });
        }
    }
    if (result.status === "completed") {
        const active = result.cases.findIndex((entry) => !TERMINAL_CASE_STATUSES.has(entry.status));
        if (active >= 0) issues.push({ path: `cases.${active}.status`, message: "A completed experiment cannot contain active cases." });
    }
    return { ok: issues.length === 0, result, issues };
}

export function interruptActiveExperimentCases(value, finishedAt = new Date().toISOString()) {
    const result = normalizeExperimentResult(value);
    result.cases = result.cases.map((entry) => entry.status === "running"
        ? { ...entry, status: "interrupted", passed: false, finishedAt }
        : entry);
    result.status = result.status === "completed" ? "completed" : "interrupted";
    result.finishedAt = result.finishedAt || finishedAt;
    result.summary = summarizeCases(result.cases);
    return result;
}
