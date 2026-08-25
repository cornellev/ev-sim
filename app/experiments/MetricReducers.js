import {
    asObject,
    cloneValue,
    finiteNumber,
    isPlainObject,
    trimmedText,
} from "./ExperimentUtils.js";

export const METRIC_REDUCER_KINDS = Object.freeze([
    "count",
    "sum",
    "minimum",
    "maximum",
    "mean",
    "first",
    "last",
]);

export const METRIC_DIRECTIONS = Object.freeze(["higher", "lower", "target", "informational"]);

export const BUILT_IN_METRIC_IDS = Object.freeze([
    "completed",
    "passed",
    "duration",
    "collision-count",
    "final-waypoint-distance",
    "assertion-failures",
    "expected-outcome-failures",
    "route-progress",
    "route-progress-ratio",
    "off-road",
    "wrong-way",
    "kinematic-infeasibility",
    "acceleration",
    "jerk",
    "log-divergence",
    "failure",
]);

const BUILT_IN_DEFAULTS = Object.freeze({
    completed: { name: "Completed", unit: "boolean", direction: "higher" },
    passed: { name: "Passed", unit: "boolean", direction: "higher" },
    duration: { name: "Duration", unit: "s", direction: "lower" },
    "collision-count": { name: "Collision count", unit: "count", direction: "lower" },
    "final-waypoint-distance": { name: "Final waypoint distance", unit: "m", direction: "lower" },
    "assertion-failures": { name: "Assertion failures", unit: "count", direction: "lower" },
    "expected-outcome-failures": { name: "Expected outcome failures", unit: "count", direction: "lower" },
    "route-progress": { name: "Route progress", unit: "m", direction: "higher" },
    "route-progress-ratio": { name: "Route progress ratio", unit: "ratio", direction: "higher" },
    "off-road": { name: "Off road", unit: "boolean", direction: "lower" },
    "wrong-way": { name: "Wrong way", unit: "boolean", direction: "lower" },
    "kinematic-infeasibility": { name: "Kinematic infeasibility", unit: "boolean", direction: "lower" },
    acceleration: { name: "Peak acceleration", unit: "m/s^2", direction: "lower" },
    jerk: { name: "Peak jerk", unit: "m/s^3", direction: "lower" },
    "log-divergence": { name: "Log divergence", unit: "m", direction: "lower" },
    failure: { name: "Failure", unit: "boolean", direction: "lower" },
});

export function builtInMetricDefaults(metricId) {
    return BUILT_IN_DEFAULTS[metricId] ? { ...BUILT_IN_DEFAULTS[metricId] } : null;
}

function toMetricNumber(value) {
    if (typeof value === "boolean") return value ? 1 : 0;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createStreamingReducer(kind = "last") {
    if (!METRIC_REDUCER_KINDS.includes(kind)) {
        throw new Error(`Unsupported metric reducer ${JSON.stringify(kind)}.`);
    }

    let sampleCount = 0;
    let numericCount = 0;
    let sum = 0;
    let minimum = null;
    let maximum = null;
    let first;
    let last;

    const reset = () => {
        sampleCount = 0;
        numericCount = 0;
        sum = 0;
        minimum = null;
        maximum = null;
        first = undefined;
        last = undefined;
    };

    const push = (value) => {
        if (value === undefined) return false;
        if (kind === "count") {
            sampleCount += 1;
            return true;
        }
        if (kind === "first" || kind === "last") {
            if (sampleCount === 0) first = cloneValue(value);
            last = cloneValue(value);
            sampleCount += 1;
            return true;
        }
        const number = toMetricNumber(value);
        if (number === null) return false;
        sampleCount += 1;
        numericCount += 1;
        sum += number;
        minimum = minimum === null ? number : Math.min(minimum, number);
        maximum = maximum === null ? number : Math.max(maximum, number);
        return true;
    };

    const value = () => {
        switch (kind) {
            case "count": return sampleCount;
            case "sum": return numericCount ? sum : null;
            case "minimum": return minimum;
            case "maximum": return maximum;
            case "mean": return numericCount ? sum / numericCount : null;
            case "first": return sampleCount ? cloneValue(first) : null;
            case "last": return sampleCount ? cloneValue(last) : null;
            default: return null;
        }
    };

    return {
        kind,
        push,
        reset,
        value,
        get count() { return sampleCount; },
        snapshot() {
            return {
                kind,
                count: sampleCount,
                numericCount,
                sum,
                minimum,
                maximum,
                first: sampleCount ? cloneValue(first) : null,
                last: sampleCount ? cloneValue(last) : null,
                value: value(),
            };
        },
    };
}

export function reduceMetricSamples(kind, values = []) {
    const reducer = createStreamingReducer(kind);
    for (const value of values) reducer.push(value);
    return reducer.value();
}

function normalizeSource(source, fallbackMetric = "") {
    if (typeof source === "string") {
        if (source === "builtin") return { kind: "builtin", metric: fallbackMetric };
        return { kind: source };
    }
    const input = asObject(source);
    const kind = ["builtin", "signal", "event"].includes(input.kind) ? input.kind : "builtin";
    if (kind === "builtin") {
        return { kind, metric: trimmedText(input.metric, fallbackMetric) };
    }
    if (kind === "signal") {
        return {
            kind,
            path: trimmedText(input.path),
            selector: trimmedText(input.selector),
        };
    }
    return {
        kind,
        category: trimmedText(input.category),
        name: trimmedText(input.name || input.event),
        severity: trimmedText(input.severity),
        selector: trimmedText(input.selector),
        filter: isPlainObject(input.filter) ? cloneValue(input.filter) : {},
    };
}

export function normalizeMetricDefinition(value = {}, index = 0) {
    const input = asObject(value);
    const requestedMetric = trimmedText(input.metric || input.builtin);
    const source = normalizeSource(input.source, requestedMetric || trimmedText(input.id));
    const builtinDefaults = source.kind === "builtin" ? BUILT_IN_DEFAULTS[source.metric] : null;
    const direction = METRIC_DIRECTIONS.includes(input.direction)
        ? input.direction
        : (builtinDefaults?.direction || "informational");
    const reducer = METRIC_REDUCER_KINDS.includes(input.reducer)
        ? input.reducer
        : (source.kind === "event" ? "count" : "last");
    const targetValue = toMetricNumber(input.target);
    return {
        id: trimmedText(input.id, source.kind === "builtin" ? source.metric : `metric-${index + 1}`),
        name: trimmedText(input.name, builtinDefaults?.name || `Metric ${index + 1}`),
        source,
        reducer,
        unit: trimmedText(input.unit, builtinDefaults?.unit || ""),
        direction,
        target: direction === "target" ? targetValue : null,
        tolerance: {
            absolute: Math.max(0, finiteNumber(input.tolerance?.absolute ?? input.absoluteTolerance, 0)),
            relative: Math.max(0, finiteNumber(input.tolerance?.relative ?? input.relativeTolerance, 0)),
        },
        gated: input.gated !== false && input.gate !== false,
    };
}

export function normalizeMetricDefinitions(values = []) {
    return (Array.isArray(values) ? values : []).map(normalizeMetricDefinition);
}

export function validateMetricDefinition(value, path = "metrics.0") {
    const metric = normalizeMetricDefinition(value);
    const issues = [];
    if (!metric.id) issues.push({ path: `${path}.id`, message: "A metric id is required." });
    if (metric.source.kind === "builtin" && !BUILT_IN_METRIC_IDS.includes(metric.source.metric)) {
        issues.push({ path: `${path}.source.metric`, message: `Unknown built-in metric "${metric.source.metric}".` });
    }
    if (metric.source.kind === "signal" && !metric.source.path) {
        issues.push({ path: `${path}.source.path`, message: "Signal metrics require a signal path." });
    }
    if (metric.source.kind === "event" && !metric.source.category && !metric.source.name) {
        issues.push({ path: `${path}.source`, message: "Event metrics require a category or event name." });
    }
    if (metric.direction === "target" && metric.target === null) {
        issues.push({ path: `${path}.target`, message: "Target metrics require a finite target value." });
    }
    return { ok: issues.length === 0, metric, issues };
}

function select(value, selector) {
    if (!selector) return value;
    return selector.split(".").filter(Boolean).reduce((current, part) => current?.[part], value);
}

function matchesFilter(value, filter) {
    return Object.entries(filter).every(([path, expected]) => Object.is(select(value, path), expected));
}

function durationSeconds(result) {
    const direct = toMetricNumber(
        result.durationSeconds
        ?? result.duration
        ?? result.metrics?.duration,
    );
    if (direct !== null) return direct;
    const milliseconds = toMetricNumber(result.durationMs);
    if (milliseconds !== null) return milliseconds / 1_000;
    const microseconds = toMetricNumber(result.durationUs);
    if (microseconds !== null) return microseconds / 1_000_000;
    const nanoseconds = toMetricNumber(result.durationNs);
    if (nanoseconds !== null) return nanoseconds / 1_000_000_000;
    const simulationNanoseconds = toMetricNumber(result.timeNs);
    if (simulationNanoseconds !== null) return simulationNanoseconds / 1_000_000_000;
    const startedAt = Date.parse(result.startedAt);
    const finishedAt = Date.parse(result.finishedAt);
    return Number.isFinite(startedAt) && Number.isFinite(finishedAt)
        ? Math.max(0, (finishedAt - startedAt) / 1_000)
        : null;
}

function collisionCount(result) {
    const direct = toMetricNumber(result.collisionCount ?? result.metrics?.["collision-count"]);
    if (direct !== null) return direct;
    if (Array.isArray(result.collisions)) return result.collisions.length;
    if (!Array.isArray(result.events)) return 0;
    return result.events.filter((event) => {
        const category = trimmedText(event?.category).toLowerCase();
        const name = trimmedText(event?.name).toLowerCase();
        return category === "collision" || category === "collisions" || name === "collision" || name === "collision-detected";
    }).length;
}

function failureCount(entries) {
    return (Array.isArray(entries) ? entries : []).filter((entry) => (
        entry?.status === "failed" || entry?.status === "error" || entry?.passed === false
    )).length;
}

function optionalMetric(result, metricId, aliases = []) {
    const metrics = asObject(result.metrics);
    const direct = toMetricNumber(metrics[metricId]);
    if (direct !== null) return direct;
    for (const alias of aliases) {
        const value = toMetricNumber(result[alias] ?? metrics[alias]);
        if (value !== null) return value;
    }
    // Absent scenario metrics stay unavailable (null), never coerced to zero.
    return null;
}

export function extractBuiltInMetrics(value = {}) {
    const result = asObject(value);
    const explicitCompleted = typeof result.completed === "boolean" ? result.completed : null;
    const explicitPassed = typeof result.passed === "boolean" ? result.passed : null;
    const status = trimmedText(result.status);
    const completed = explicitCompleted ?? ["completed", "passed", "failed"].includes(status);
    const passed = explicitPassed ?? status === "passed";
    const route = asObject(result.route);
    const finalWaypointDistance = toMetricNumber(
        result.finalWaypointDistance
        ?? result.metrics?.["final-waypoint-distance"]
        ?? route.finalWaypointDistance
        ?? result.summary?.finalWaypointDistance,
    );
    const assertionFailures = toMetricNumber(result.metrics?.["assertion-failures"]);
    const outcomeFailures = toMetricNumber(result.metrics?.["expected-outcome-failures"]);
    return {
        completed: completed ? 1 : 0,
        passed: passed ? 1 : 0,
        duration: durationSeconds(result),
        "collision-count": collisionCount(result),
        "final-waypoint-distance": finalWaypointDistance,
        "assertion-failures": assertionFailures ?? failureCount(result.assertionResults ?? result.assertions),
        "expected-outcome-failures": outcomeFailures ?? failureCount(result.outcomeResults ?? result.outcomes),
        "route-progress": optionalMetric(result, "route-progress", ["routeProgress"]),
        "route-progress-ratio": optionalMetric(result, "route-progress-ratio", ["routeProgressRatio"]),
        "off-road": optionalMetric(result, "off-road", ["offRoad"]),
        "wrong-way": optionalMetric(result, "wrong-way", ["wrongWay"]),
        "kinematic-infeasibility": optionalMetric(result, "kinematic-infeasibility", ["kinematicInfeasibility"]),
        acceleration: optionalMetric(result, "acceleration", ["peakAcceleration"]),
        jerk: optionalMetric(result, "jerk", ["peakJerk"]),
        "log-divergence": optionalMetric(result, "log-divergence", ["logDivergence"]),
        failure: optionalMetric(result, "failure"),
    };
}

export function extractBuiltInMetric(metricId, result = {}) {
    if (!BUILT_IN_METRIC_IDS.includes(metricId)) return null;
    return extractBuiltInMetrics(result)[metricId];
}

export function normalizeMetricValues(value) {
    if (Array.isArray(value)) {
        return Object.fromEntries(value
            .map((entry) => [trimmedText(entry?.id), entry?.value])
            .filter(([id]) => id));
    }
    return isPlainObject(value) ? cloneValue(value) : {};
}

export class MetricAccumulator {
    constructor(definitions = []) {
        this.definitions = normalizeMetricDefinitions(definitions);
        this.reducers = new Map(this.definitions
            .filter((metric) => metric.source.kind !== "builtin")
            .map((metric) => [metric.id, createStreamingReducer(metric.reducer)]));
    }

    reset() {
        for (const reducer of this.reducers.values()) reducer.reset();
    }

    pushSignal(path, value) {
        let accepted = 0;
        for (const metric of this.definitions) {
            if (metric.source.kind !== "signal" || metric.source.path !== path) continue;
            if (this.reducers.get(metric.id).push(select(value, metric.source.selector))) accepted += 1;
        }
        return accepted;
    }

    pushEvent(value = {}) {
        const event = asObject(value);
        let accepted = 0;
        for (const metric of this.definitions) {
            const source = metric.source;
            if (source.kind !== "event") continue;
            if (source.category && source.category !== event.category) continue;
            if (source.name && source.name !== event.name) continue;
            if (source.severity && source.severity !== event.severity) continue;
            if (!matchesFilter(event, source.filter)) continue;
            const sampled = metric.reducer === "count"
                ? 1
                : select(event, source.selector || "payload.value");
            if (this.reducers.get(metric.id).push(sampled)) accepted += 1;
        }
        return accepted;
    }

    finalize(runResult = {}) {
        const builtIns = extractBuiltInMetrics(runResult);
        return Object.fromEntries(this.definitions.map((metric) => [
            metric.id,
            metric.source.kind === "builtin"
                ? builtIns[metric.source.metric]
                : this.reducers.get(metric.id).value(),
        ]));
    }

    snapshot() {
        return Object.fromEntries([...this.reducers].map(([id, reducer]) => [id, reducer.snapshot()]));
    }
}
