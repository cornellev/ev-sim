import assert from "node:assert/strict";
import test from "node:test";

import {
    MetricAccumulator,
    compareExperimentResultToBaseline,
    createDefaultExperimentSuite,
    createExperimentBaseline,
    createExperimentResult,
    createStreamingReducer,
    expandExperimentCases,
    expandSweepValues,
    experimentCaseKey,
    extractBuiltInMetrics,
    interruptActiveExperimentCases,
    normalizeExperimentBaseline,
    normalizeExperimentResult,
    normalizeExperimentSuite,
    normalizeMetricDefinition,
    planExperimentCases,
    reduceMetricSamples,
    validateExperimentBaseline,
    validateExperimentResult,
    validateExperimentSuite,
    validateMetricDefinition,
    validateParameterDeclaration,
    validateParameterValue,
} from "../app/experiments/index.js";

function parameter(id, type, target, extra = {}) {
    return { id, type, target, ...extra };
}

function suite(overrides = {}) {
    return createDefaultExperimentSuite({
        id: "regression-suite",
        scenarioIds: ["city-loop"],
        manifestIds: ["ekf"],
        seeds: [7],
        metrics: [],
        ...overrides,
    });
}

function resultCase(overrides = {}) {
    return {
        id: "case-a",
        scenarioId: "city-loop",
        manifestId: "ekf",
        seed: 7,
        parameters: { gain: 0.5 },
        status: "completed",
        completed: true,
        passed: true,
        startedAt: "2026-07-30T10:00:00.000Z",
        finishedAt: "2026-07-30T10:00:10.000Z",
        metrics: { duration: 10, passed: 1 },
        dependencyHashes: { scenario: "aaa", manifest: "bbb" },
        resolvedHash: "resolved-a",
        ...overrides,
    };
}

function resultDocument(cases, overrides = {}) {
    return {
        kind: "cev-sim.experiment-result",
        version: 1,
        id: "result-a",
        suiteId: "regression-suite",
        status: "completed",
        createdAt: "2026-07-30T09:59:00.000Z",
        startedAt: "2026-07-30T10:00:00.000Z",
        finishedAt: "2026-07-30T10:01:00.000Z",
        cases,
        ...overrides,
    };
}

test("experiment suite documents normalize aliases and reject unsupported formats", () => {
    const normalized = normalizeExperimentSuite({
        kind: "cev-sim.experiment-suite",
        version: 1,
        id: " nightly ",
        selection: { scenarioIds: ["route-a"], manifestIds: ["controller-a"] },
        matrix: { exclusions: [{ scenarioId: "route-a", manifestId: "controller-a" }] },
        seeds: [42, " repeatable "],
        execution: { failFast: true },
    });
    assert.equal(normalized.id, "nightly");
    assert.deepEqual(normalized.scenarioIds, ["route-a"]);
    assert.deepEqual(normalized.manifestIds, ["controller-a"]);
    assert.deepEqual(normalized.seeds, [42, "repeatable"]);
    assert.equal(normalized.execution.failurePolicy, "fail-fast");
    assert.equal(normalized.execution.continueOnFailure, false);
    assert.throws(
        () => normalizeExperimentSuite({ kind: "other", version: 1 }),
        /Unsupported experiment suite kind/,
    );
    assert.throws(
        () => normalizeExperimentSuite({ kind: "cev-sim.experiment-suite", version: 2 }),
        /version 2/,
    );
});

test("suite validation catches empty selections, duplicates, and invalid exclusions", () => {
    const empty = validateExperimentSuite(createDefaultExperimentSuite());
    assert.equal(empty.ok, false);
    assert.match(empty.issues.map((issue) => issue.message).join(" "), /scenario.*run manifest/i);

    const invalid = validateExperimentSuite(suite({
        scenarioIds: ["city-loop", "city-loop"],
        seeds: [7, 7],
        exclusions: [{ scenarioId: "missing", manifestId: "ekf" }],
    }));
    assert.equal(invalid.ok, false);
    assert.match(invalid.issues.map((issue) => issue.message).join(" "), /Duplicate value.*not selected/);
});

test("parameter declarations validate target bindings, types, bounds, and allowed values", () => {
    const gain = parameter("gain", "float64", { kind: "script-input", scriptId: "controller", input: "gain" }, {
        default: 0.5,
        min: 0,
        max: 1,
    });
    assert.equal(validateParameterDeclaration(gain).ok, true);
    assert.equal(validateParameterValue(0.75, gain).ok, true);
    assert.match(validateParameterValue(2, gain).message, /at most 1/);
    assert.match(validateParameterValue("0.5", gain).message, /float64/);

    const flag = parameter("mode", "boolean", { kind: "scenario-signal", path: "scenario.aggressive" }, {
        allowedValues: [true],
    });
    assert.equal(validateParameterValue(true, flag).ok, true);
    assert.match(validateParameterValue(false, flag).message, /allowed values/);

    const broken = validateParameterDeclaration(parameter("bad", "vector", { kind: "script-input" }));
    assert.equal(broken.ok, false);
    assert.match(broken.issues.map((issue) => issue.message).join(" "), /Unsupported parameter type.*scriptId and input/);
});

test("range sweeps are inclusive, stable for decimals, and reject unsafe definitions", () => {
    assert.deepEqual(expandSweepValues({ parameterId: "gain", range: { start: 0, stop: 0.3, step: 0.1 } }), [0, 0.1, 0.2, 0.3]);
    assert.deepEqual(expandSweepValues({ parameterId: "gain", range: { start: 2, stop: 0, step: -1 } }), [2, 1, 0]);
    assert.throws(() => expandSweepValues({ range: { start: 0, stop: 1, step: 0 } }), /must not be zero/);
    assert.throws(() => expandSweepValues({ range: { start: 0, stop: 1, step: -1 } }), /must advance/);
    assert.throws(
        () => expandSweepValues({ range: { start: 0, stop: 100, step: 1 } }, { maximumValues: 3 }),
        /exceeds the 3 value limit/,
    );
});

test("case expansion is deterministic across selected cells, seeds, and declared parameter products", () => {
    const definitionOptions = {
        scenarios: [
            { id: "s1", parameters: [parameter("speed", "float64", { kind: "scalar-field", path: "routes.ego.speed" })] },
            { id: "s2", parameters: [parameter("speed", "float64", { kind: "scalar-field", path: "routes.ego.speed" })] },
        ],
        manifests: [
            { id: "m1", parameters: [parameter("noise", "boolean", { kind: "scenario-signal", path: "scenario.noise" })] },
            { id: "m2", parameters: [parameter("noise", "boolean", { kind: "scenario-signal", path: "scenario.noise" })] },
        ],
    };
    const definition = suite({
        scenarioIds: ["s1", "s2"],
        manifestIds: ["m1", "m2"],
        exclusions: [{ scenarioId: "s2", manifestId: "m1", reason: "Known incompatible" }],
        seeds: [11, 12],
        sweeps: [
            { parameterId: "speed", values: [1, 2] },
            { parameterId: "noise", values: [false, true] },
        ],
    });
    const first = expandExperimentCases(definition, definitionOptions);
    const second = expandExperimentCases(definition, definitionOptions);
    assert.equal(first.length, 24);
    assert.deepEqual(first, second);
    assert.deepEqual(first[0], {
        id: first[0].id,
        key: first[0].key,
        ordinal: 0,
        scenarioId: "s1",
        manifestId: "m1",
        seed: 11,
        parameters: { speed: 1, noise: false },
    });
    assert.deepEqual(first[1].parameters, { speed: 1, noise: true });
    assert.deepEqual(first[4].seed, 12);
    assert.equal(new Set(first.map((entry) => entry.id)).size, first.length);

    const plan = planExperimentCases(definition, {
        ...definitionOptions,
        isCompatible: ({ scenarioId, manifestId }) => (
            scenarioId === "s1" && manifestId === "m2" ? "ROS-only manifest" : true
        ),
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.cases.length, 16);
    assert.deepEqual(plan.excluded, [{ scenarioId: "s2", manifestId: "m1", reason: "Known incompatible" }]);
    assert.deepEqual(plan.incompatible, [{ scenarioId: "s1", manifestId: "m2", reason: "ROS-only manifest" }]);
});

test("sweeps never patch undeclared or incorrectly typed parameters", () => {
    const definition = suite({ sweeps: [{ parameterId: "secret.path", values: [1] }] });
    const missing = planExperimentCases(definition, {
        scenarios: [{ id: "city-loop", parameters: [] }],
        manifests: [{ id: "ekf", parameters: [] }],
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.cases.length, 0);
    assert.match(missing.incompatible[0].reason, /not declared/);
    assert.match(missing.issues[0].message, /at least one compatible case/);

    const wrongType = planExperimentCases(suite({ sweeps: [{ parameterId: "iterations", values: [2.5] }] }), {
        scenarios: [{
            id: "city-loop",
            parameters: [parameter("iterations", "int32", { kind: "scalar-field", path: "controller.iterations" })],
        }],
        manifests: [{ id: "ekf" }],
    });
    assert.equal(wrongType.ok, false);
    assert.match(wrongType.incompatible[0].reason, /int32/);
});

test("case matching keys ignore parameter property insertion order but preserve value types", () => {
    const left = experimentCaseKey({ scenarioId: "s", manifestId: "m", seed: 1, parameters: { b: 2, a: 1 } });
    const right = experimentCaseKey({ scenarioId: "s", manifestId: "m", seed: 1, parameters: { a: 1, b: 2 } });
    const stringValue = experimentCaseKey({ scenarioId: "s", manifestId: "m", seed: 1, parameters: { a: "1", b: 2 } });
    assert.equal(left, right);
    assert.notEqual(left, stringValue);
});

test("streaming metric reducers retain exact values and explicit empty states", () => {
    assert.equal(reduceMetricSamples("sum", [1, 2, 3]), 6);
    assert.equal(reduceMetricSamples("mean", [1, 2, 6]), 3);
    assert.equal(reduceMetricSamples("minimum", [3, -1, 7]), -1);
    assert.equal(reduceMetricSamples("maximum", [3, -1, 7]), 7);
    assert.equal(reduceMetricSamples("count", [{}, {}, undefined]), 2);
    assert.equal(reduceMetricSamples("last", []), null);
    assert.equal(reduceMetricSamples("sum", []), null);

    const original = { nested: { value: 1 } };
    const first = createStreamingReducer("first");
    first.push(original);
    original.nested.value = 9;
    first.push({ nested: { value: 2 } });
    assert.deepEqual(first.value(), { nested: { value: 1 } });
    assert.equal(first.snapshot().count, 2);
    assert.throws(() => createStreamingReducer("median"), /Unsupported metric reducer/);
});

test("metric definitions and accumulators handle built-ins, selected signals, and filtered events", () => {
    const definitions = [
        { id: "duration", source: "builtin", metric: "duration" },
        { id: "average-speed", source: { kind: "signal", path: "vehicle.speed", selector: "mps" }, reducer: "mean", unit: "m/s" },
        { id: "ego-collisions", source: { kind: "event", category: "collision", filter: { "payload.actor": "ego" } }, reducer: "count" },
    ];
    const accumulator = new MetricAccumulator(definitions);
    assert.equal(accumulator.pushSignal("other", 50), 0);
    accumulator.pushSignal("vehicle.speed", { mps: 2 });
    accumulator.pushSignal("vehicle.speed", { mps: 4 });
    accumulator.pushEvent({ category: "collision", payload: { actor: "npc" } });
    accumulator.pushEvent({ category: "collision", payload: { actor: "ego" } });
    accumulator.pushEvent({ category: "collision", payload: { actor: "ego" } });
    const values = accumulator.finalize({ durationUs: 2_500_000 });
    assert.deepEqual(values, { duration: 2.5, "average-speed": 3, "ego-collisions": 2 });
    assert.equal(accumulator.snapshot()["average-speed"].count, 2);
    accumulator.reset();
    assert.equal(accumulator.finalize({ durationSeconds: 1 })["average-speed"], null);

    assert.equal(validateMetricDefinition({ source: { kind: "signal" } }).ok, false);
    assert.equal(validateMetricDefinition({ source: { kind: "builtin", metric: "unknown" } }).ok, false);
    assert.equal(validateMetricDefinition({ direction: "target", source: { kind: "signal", path: "x" } }).ok, false);
    assert.equal(normalizeMetricDefinition({ id: "collisions", source: { kind: "event", name: "hit" } }).reducer, "count");
});

test("built-in metric extraction supports run summaries, timestamps, events, assertions, and outcomes", () => {
    const metrics = extractBuiltInMetrics({
        status: "failed",
        completed: true,
        passed: false,
        startedAt: "2026-07-30T10:00:00.000Z",
        finishedAt: "2026-07-30T10:00:03.250Z",
        events: [
            { category: "collision", name: "collision-detected" },
            { category: "diagnostic", name: "other" },
        ],
        route: { finalWaypointDistance: 1.25 },
        assertions: [{ status: "failed" }, { status: "passed" }],
        outcomes: [{ passed: false }, { passed: true }, { status: "error" }],
    });
    assert.deepEqual(metrics, {
        completed: 1,
        passed: 0,
        duration: 3.25,
        "collision-count": 1,
        "final-waypoint-distance": 1.25,
        "assertion-failures": 1,
        "expected-outcome-failures": 2,
        "route-progress": null,
        "route-progress-ratio": null,
        "off-road": null,
        "wrong-way": null,
        "kinematic-infeasibility": null,
        acceleration: null,
        jerk: null,
        "log-divergence": null,
        failure: null,
    });

    assert.equal(validateMetricDefinition({ source: { kind: "builtin", metric: "route-progress" } }).ok, true);
    assert.equal(normalizeMetricDefinition({ source: { kind: "builtin", metric: "log-divergence" } }).unit, "m");
    assert.equal(normalizeMetricDefinition({ source: { kind: "builtin", metric: "failure" } }).direction, "lower");
    assert.equal(extractBuiltInMetrics({ metrics: { "route-progress": 4.5, failure: 1 } })["route-progress"], 4.5);
    assert.equal(extractBuiltInMetrics({ metrics: { failure: 1 } }).failure, 1);
});

test("experiment result documents normalize terminal records and interrupt only an active case", () => {
    const definition = suite({ metrics: [{ id: "passed", source: "builtin", metric: "passed" }] });
    const created = createExperimentResult(definition, [
        { scenarioId: "city-loop", manifestId: "ekf", seed: 7, parameters: {} },
        { scenarioId: "city-loop", manifestId: "ekf", seed: 8, parameters: {} },
    ], {
        id: "run-1",
        status: "running",
        cases: [
            { ...resultCase({ id: "active", seed: 7, status: "running", completed: false, passed: false, finishedAt: null }) },
            { ...resultCase({ id: "queued", seed: 8, status: "pending", completed: false, passed: false, finishedAt: null }) },
        ],
    });
    assert.equal(created.kind, "cev-sim.experiment-result");
    assert.equal(created.version, 1);
    assert.equal(created.execution, null);
    assert.equal(created.metricDefinitions[0].id, "passed");
    const interrupted = interruptActiveExperimentCases(created, "2026-07-30T10:02:00.000Z");
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.cases[0].status, "interrupted");
    assert.equal(interrupted.cases[1].status, "pending");
    assert.equal(created.cases[0].status, "running");

    const valid = validateExperimentResult(resultDocument([resultCase()]));
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.result.summary, {
        total: 1,
        pending: 0,
        running: 0,
        completed: 1,
        passed: 1,
        failed: 0,
        error: 0,
        cancelled: 0,
        interrupted: 0,
    });
    const duplicate = validateExperimentResult(resultDocument([resultCase(), resultCase({ id: "case-b" })]));
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.issues.map((issue) => issue.message).join(" "), /Duplicate scenario\/manifest\/seed\/parameter case/);
});

test("baseline creation takes an immutable value snapshot with provenance", () => {
    const source = resultDocument([resultCase()], {
        metricDefinitions: [
            { id: "duration", source: { kind: "builtin", metric: "duration" }, direction: "lower" },
            { id: "passed", source: { kind: "builtin", metric: "passed" }, direction: "higher" },
        ],
    });
    const baseline = createExperimentBaseline(source, {
        id: "known-good",
        name: "Known Good",
        createdAt: "2026-07-30T11:00:00.000Z",
        provenance: { appVersion: "1.2.3", gitCommit: "abc123", dependencies: { three: "0.182.0" } },
    });
    source.cases[0].metrics.duration = 999;
    assert.equal(baseline.kind, "cev-sim.experiment-baseline");
    assert.equal(baseline.cases[0].metrics.duration, 10);
    assert.equal(baseline.provenance.gitCommit, "abc123");
    assert.equal(Object.isFrozen(baseline), true);
    assert.equal(Object.isFrozen(baseline.cases[0].metrics), true);
    assert.equal(validateExperimentBaseline(baseline).ok, true);
    assert.deepEqual(normalizeExperimentBaseline(baseline), baseline);
    assert.throws(() => normalizeExperimentBaseline({ kind: "cev-sim.experiment-baseline", version: 2 }), /version 2/);
});

test("baseline comparison classifies tolerances, targets, improvements, and gated regressions", () => {
    const metricDefinitions = [
        { id: "duration", source: { kind: "builtin", metric: "duration" }, direction: "lower", tolerance: { absolute: 0.25 } },
        { id: "passed", source: { kind: "builtin", metric: "passed" }, direction: "higher" },
        { id: "tracking-error", source: { kind: "signal", path: "metrics.error" }, direction: "target", target: 0, tolerance: { relative: 0.1 } },
        { id: "diagnostic-score", source: { kind: "signal", path: "metrics.score" }, direction: "higher", gated: false },
    ];
    const baselineSource = resultDocument([resultCase({
        metrics: { duration: 10, passed: 1, "tracking-error": 2, "diagnostic-score": 8 },
    })], { metricDefinitions });
    const baseline = createExperimentBaseline(baselineSource, {
        id: "baseline",
        name: "Baseline",
        createdAt: "2026-07-30T11:00:00.000Z",
    });

    const regressed = compareExperimentResultToBaseline(resultDocument([resultCase({
        parameters: { gain: 0.5 },
        metrics: { duration: 10.5, passed: 1, "tracking-error": 1, "diagnostic-score": 7 },
        dependencyHashes: { scenario: "changed", manifest: "bbb" },
    })], { metricDefinitions }), baseline);
    assert.equal(regressed.status, "regressed");
    assert.equal(regressed.regressed, true);
    assert.equal(regressed.incomplete, false);
    assert.equal(regressed.matchedCaseCount, 1);
    assert.equal(regressed.cases[0].dependencyChanged, true);
    assert.equal(regressed.cases[0].metrics.find((metric) => metric.id === "duration").classification, "regressed");
    assert.equal(regressed.cases[0].metrics.find((metric) => metric.id === "tracking-error").classification, "improved");
    assert.equal(regressed.cases[0].metrics.find((metric) => metric.id === "diagnostic-score").gated, false);

    const withinTolerance = compareExperimentResultToBaseline(resultDocument([resultCase({
        metrics: { duration: 10.2, passed: 1, "tracking-error": 2.1, "diagnostic-score": 9 },
    })], { metricDefinitions }), baseline);
    assert.equal(withinTolerance.status, "improved");
    assert.equal(withinTolerance.cases[0].metrics.find((metric) => metric.id === "duration").classification, "unchanged");
    assert.equal(withinTolerance.cases[0].metrics.find((metric) => metric.id === "tracking-error").classification, "unchanged");
});

test("baseline comparison reports unmatched cases and absent metric values as incomplete", () => {
    const metricDefinitions = [
        { id: "duration", source: { kind: "builtin", metric: "duration" }, direction: "lower" },
        { id: "passed", source: { kind: "builtin", metric: "passed" }, direction: "higher" },
    ];
    const baseline = createExperimentBaseline(resultDocument([
        resultCase(),
        resultCase({ id: "case-b", seed: 8, parameters: {} }),
    ], { metricDefinitions }), {
        name: "Baseline",
        createdAt: "2026-07-30T11:00:00.000Z",
    });
    const comparison = compareExperimentResultToBaseline(resultDocument([resultCase({
        metrics: { duration: 10 },
    })], { metricDefinitions }), baseline);
    assert.equal(comparison.status, "incomplete");
    assert.equal(comparison.incomplete, true);
    assert.equal(comparison.unmatchedBaseline.length, 1);
    assert.equal(comparison.unmatchedCurrent.length, 0);
    assert.equal(comparison.cases[0].metrics.find((metric) => metric.id === "passed").classification, "unavailable");
});

test("result and baseline validators reject future versions and incomplete identities", () => {
    assert.throws(() => normalizeExperimentResult({ kind: "cev-sim.experiment-result", version: 2 }), /version 2/);
    const resultValidation = validateExperimentResult(resultDocument([resultCase({ scenarioId: "" })]));
    assert.equal(resultValidation.ok, false);
    assert.match(resultValidation.issues[0].message, /scenario id/);

    const baselineValidation = validateExperimentBaseline({
        kind: "cev-sim.experiment-baseline",
        version: 1,
        id: "empty",
        name: "Empty",
    });
    assert.equal(baselineValidation.ok, false);
    assert.match(baselineValidation.issues.map((issue) => issue.message).join(" "), /suite id.*source result.*timestamp.*at least one case/i);
});
