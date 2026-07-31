import {
    asObject,
    canonicalStringify,
    cloneValue,
    deepFreeze,
    isPlainObject,
    stableHash,
    trimmedText,
} from "./ExperimentUtils.js";
import { experimentCaseKey } from "./ExperimentSuite.js";
import {
    normalizeMetricDefinition,
    normalizeMetricDefinitions,
    normalizeMetricValues,
    validateMetricDefinition,
} from "./MetricReducers.js";
import { normalizeExperimentResult } from "./ExperimentResult.js";

export const EXPERIMENT_BASELINE_KIND = "cev-sim.experiment-baseline";
export const EXPERIMENT_BASELINE_VERSION = 1;

function optionalText(value) {
    return trimmedText(value) || null;
}

function normalizeBaselineCase(value = {}, index = 0) {
    const source = asObject(value);
    const identity = {
        scenarioId: trimmedText(source.scenarioId),
        manifestId: trimmedText(source.manifestId),
        seed: source.seed ?? "42",
        parameters: isPlainObject(source.parameters ?? source.parameterValues)
            ? cloneValue(source.parameters ?? source.parameterValues)
            : {},
    };
    return {
        id: trimmedText(source.id, `case-${index + 1}`),
        key: experimentCaseKey(identity),
        ...identity,
        status: trimmedText(source.status, "completed"),
        completed: source.completed === true,
        passed: source.passed === true,
        terminationReason: optionalText(source.terminationReason),
        metrics: normalizeMetricValues(source.metrics),
        dependencyHashes: isPlainObject(source.dependencyHashes) ? cloneValue(source.dependencyHashes) : {},
        resolvedHash: optionalText(source.resolvedHash),
        logId: optionalText(source.logId),
    };
}

function normalizeProvenance(value = {}) {
    const source = asObject(value);
    return {
        appVersion: optionalText(source.appVersion),
        gitCommit: optionalText(source.gitCommit || source.commit),
        dependencies: isPlainObject(source.dependencies) ? cloneValue(source.dependencies) : {},
    };
}

export function normalizeExperimentBaseline(value = {}, { allowMissingKind = false } = {}) {
    const source = asObject(value);
    if (!allowMissingKind && source.kind !== undefined && source.kind !== EXPERIMENT_BASELINE_KIND) {
        throw new Error(`Unsupported experiment baseline kind: ${JSON.stringify(source.kind)}.`);
    }
    if (source.version !== undefined && Number(source.version) !== EXPERIMENT_BASELINE_VERSION) {
        throw new Error(`Unsupported experiment baseline version ${source.version}; expected ${EXPERIMENT_BASELINE_VERSION}.`);
    }
    return {
        kind: EXPERIMENT_BASELINE_KIND,
        version: EXPERIMENT_BASELINE_VERSION,
        id: trimmedText(source.id, "untitled-baseline"),
        name: trimmedText(source.name, "Untitled Baseline"),
        description: trimmedText(source.description),
        suiteId: trimmedText(source.suiteId),
        sourceResultId: trimmedText(source.sourceResultId),
        createdAt: optionalText(source.createdAt),
        metricDefinitions: normalizeMetricDefinitions(source.metricDefinitions),
        cases: (Array.isArray(source.cases) ? source.cases : []).map(normalizeBaselineCase),
        provenance: normalizeProvenance(source.provenance),
    };
}

function slug(value) {
    return trimmedText(value, "baseline")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "baseline";
}

export function createExperimentBaseline(resultValue, options = {}) {
    const result = normalizeExperimentResult(resultValue);
    const name = trimmedText(options.name, "Baseline");
    const createdAt = trimmedText(options.createdAt, new Date().toISOString());
    const baseline = normalizeExperimentBaseline({
        kind: EXPERIMENT_BASELINE_KIND,
        version: EXPERIMENT_BASELINE_VERSION,
        id: trimmedText(options.id, `${slug(name)}-${stableHash(`${result.id}:${createdAt}`).slice(0, 8)}`),
        name,
        description: trimmedText(options.description),
        suiteId: result.suiteId,
        sourceResultId: result.id,
        createdAt,
        metricDefinitions: options.metricDefinitions ?? options.suite?.metrics ?? result.metricDefinitions,
        cases: result.cases,
        provenance: options.provenance,
    }, { allowMissingKind: true });
    return deepFreeze(baseline);
}

export function validateExperimentBaseline(value) {
    let baseline;
    try {
        baseline = normalizeExperimentBaseline(value);
    } catch (error) {
        return { ok: false, baseline: null, issues: [{ path: "", message: error.message }] };
    }
    const issues = [];
    if (!baseline.suiteId) issues.push({ path: "suiteId", message: "A suite id is required." });
    if (!baseline.sourceResultId) issues.push({ path: "sourceResultId", message: "A source result id is required." });
    if (!baseline.createdAt) issues.push({ path: "createdAt", message: "A baseline creation timestamp is required." });
    if (baseline.cases.length === 0) issues.push({ path: "cases", message: "A baseline requires at least one case." });
    const metricIds = new Set();
    for (const [index, metric] of baseline.metricDefinitions.entries()) {
        issues.push(...validateMetricDefinition(metric, `metricDefinitions.${index}`).issues);
        if (metricIds.has(metric.id)) {
            issues.push({ path: `metricDefinitions.${index}.id`, message: `Duplicate metric id "${metric.id}".` });
        }
        metricIds.add(metric.id);
    }
    const keys = new Set();
    for (const [index, entry] of baseline.cases.entries()) {
        if (!entry.scenarioId) issues.push({ path: `cases.${index}.scenarioId`, message: "A scenario id is required." });
        if (!entry.manifestId) issues.push({ path: `cases.${index}.manifestId`, message: "A run manifest id is required." });
        if (keys.has(entry.key)) issues.push({ path: `cases.${index}`, message: "Duplicate scenario/manifest/seed/parameter case." });
        keys.add(entry.key);
    }
    return { ok: issues.length === 0, baseline, issues };
}

function numeric(value) {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === null || value === undefined || value === "") return null;
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
}

function compareMetricValues(metric, currentValue, baselineValue) {
    const current = numeric(currentValue);
    const baseline = numeric(baselineValue);
    if (current === null || baseline === null) {
        return {
            current: currentValue ?? null,
            baseline: baselineValue ?? null,
            delta: null,
            tolerance: null,
            classification: "unavailable",
            gated: metric.gated,
        };
    }
    const delta = current - baseline;
    const tolerance = Math.max(
        metric.tolerance.absolute,
        Math.abs(baseline) * metric.tolerance.relative,
    );
    let comparisonDelta = delta;
    if (metric.direction === "target") {
        comparisonDelta = Math.abs(current - metric.target) - Math.abs(baseline - metric.target);
    }
    let classification = "unchanged";
    if (metric.direction !== "informational" && Math.abs(comparisonDelta) > tolerance) {
        const better = metric.direction === "higher" ? comparisonDelta > 0 : comparisonDelta < 0;
        classification = better ? "improved" : "regressed";
    }
    return { current, baseline, delta, tolerance, classification, gated: metric.gated };
}

function identitySnapshot(entry) {
    return {
        id: entry.id,
        key: entry.key || experimentCaseKey(entry),
        scenarioId: entry.scenarioId,
        manifestId: entry.manifestId,
        seed: cloneValue(entry.seed),
        parameters: cloneValue(entry.parameters),
    };
}

function inferredDefinitions(current, baseline) {
    const metricIds = new Set();
    for (const entry of [...current.cases, ...baseline.cases]) {
        for (const id of Object.keys(entry.metrics)) metricIds.add(id);
    }
    return [...metricIds].sort().map((id) => normalizeMetricDefinition({
        id,
        name: id,
        source: { kind: "signal", path: `comparison.${id}` },
        direction: "informational",
        gated: false,
    }));
}

export function compareExperimentToBaseline(resultValue, baselineValue, options = {}) {
    const current = normalizeExperimentResult(resultValue);
    const baseline = normalizeExperimentBaseline(baselineValue);
    const requestedDefinitions = Array.isArray(options.metricDefinitions)
        ? options.metricDefinitions
        : current.metricDefinitions.length > 0
            ? current.metricDefinitions
            : baseline.metricDefinitions;
    const definitions = normalizeMetricDefinitions(requestedDefinitions);
    const metricDefinitions = definitions.length > 0 ? definitions : inferredDefinitions(current, baseline);
    const definitionById = new Map(metricDefinitions.map((metric) => [metric.id, metric]));
    const baselineByKey = new Map(baseline.cases.map((entry) => [entry.key, entry]));
    const currentByKey = new Map(current.cases.map((entry) => [entry.key, entry]));
    const cases = [];
    const unmatchedCurrent = [];
    const unmatchedBaseline = [];
    let missingMetric = false;
    let gatedRegression = false;
    let anyImprovement = false;

    for (const currentCase of current.cases) {
        const baselineCase = baselineByKey.get(currentCase.key);
        if (!baselineCase) {
            unmatchedCurrent.push(identitySnapshot(currentCase));
            continue;
        }
        const metricIds = new Set([
            ...definitionById.keys(),
            ...Object.keys(currentCase.metrics),
            ...Object.keys(baselineCase.metrics),
        ]);
        const metrics = [...metricIds].sort().map((id) => {
            const definition = definitionById.get(id) || normalizeMetricDefinition({
                id,
                name: id,
                source: { kind: "signal", path: `comparison.${id}` },
                direction: "informational",
                gated: false,
            });
            const comparison = compareMetricValues(definition, currentCase.metrics[id], baselineCase.metrics[id]);
            if (comparison.classification === "unavailable") missingMetric = true;
            if (comparison.classification === "regressed" && comparison.gated) gatedRegression = true;
            if (comparison.classification === "improved") anyImprovement = true;
            return { id, name: definition.name, unit: definition.unit, direction: definition.direction, ...comparison };
        });
        const hasRegression = metrics.some((metric) => metric.classification === "regressed");
        const hasUnavailable = metrics.some((metric) => metric.classification === "unavailable");
        const hasImprovement = metrics.some((metric) => metric.classification === "improved");
        cases.push({
            ...identitySnapshot(currentCase),
            classification: hasRegression ? "regressed" : hasUnavailable ? "incomplete" : hasImprovement ? "improved" : "unchanged",
            dependencyChanged: canonicalStringify(currentCase.dependencyHashes) !== canonicalStringify(baselineCase.dependencyHashes)
                || currentCase.resolvedHash !== baselineCase.resolvedHash,
            currentDependencyHashes: cloneValue(currentCase.dependencyHashes),
            baselineDependencyHashes: cloneValue(baselineCase.dependencyHashes),
            metrics,
        });
    }

    for (const baselineCase of baseline.cases) {
        if (!currentByKey.has(baselineCase.key)) unmatchedBaseline.push(identitySnapshot(baselineCase));
    }
    const suiteMismatch = Boolean(current.suiteId && baseline.suiteId && current.suiteId !== baseline.suiteId);
    const incomplete = suiteMismatch || missingMetric || unmatchedCurrent.length > 0 || unmatchedBaseline.length > 0;
    const status = gatedRegression ? "regressed" : incomplete ? "incomplete" : anyImprovement ? "improved" : "unchanged";
    return {
        status,
        regressed: gatedRegression,
        incomplete,
        suiteMismatch,
        matchedCaseCount: cases.length,
        cases,
        unmatchedCurrent,
        unmatchedBaseline,
    };
}

export const compareExperimentResultToBaseline = compareExperimentToBaseline;
