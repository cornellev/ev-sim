import { createHash } from "node:crypto";

import { canonicalStringify } from "../../app/simulation/RunManifest.js";

export const PARITY_REPORT_KIND = "cev-sim.headless.parity-report";
export const BENCHMARK_REPORT_KIND = "cev-sim.headless.benchmark-report";
export const SOAK_REPORT_KIND = "cev-sim.headless.soak-report";
export const RELEASE_MANIFEST_KIND = "cev-sim.headless.release-manifest";
export const RELEASE_REPORT_VERSION = 1;

export const PARITY_TOLERANCES = Object.freeze({
    float64: Object.freeze({ absolute: 1e-9, relative: 1e-9 }),
    float32: Object.freeze({ absolute: 1e-6, relative: 1e-6 }),
    lidarRange: Object.freeze({ absolute: 1e-4, relative: 1e-5, combination: "max" }),
    lidarIncidence: Object.freeze({ absolute: 1e-4, relative: 0 }),
});

export const BENCHMARK_REGRESSION_LIMITS = Object.freeze({
    minimumThroughputRatio: 0.8,
    maximumLatencyRatio: 1.5,
    minimumRssAllowanceBytes: 64 * 1024 * 1024,
    rssAllowanceRatio: 0.1,
});

export function reportSha256(value) {
    return createHash("sha256").update(
        typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalStringify(value),
    ).digest("hex");
}

export function percentile(values, quantile) {
    const sorted = [...values].map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
    return sorted[index];
}

function difference(expected, actual, tolerance) {
    const delta = Math.abs(actual - expected);
    const relative = tolerance.relative * Math.abs(expected);
    const allowed = tolerance.combination === "max"
        ? Math.max(tolerance.absolute, relative)
        : tolerance.absolute + relative;
    return { ok: delta <= allowed, delta, allowed };
}

export function compareNumericSeries(expected, actual, tolerance = PARITY_TOLERANCES.float64) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
        return { ok: false, mismatch: "length", expectedLength: expected?.length ?? null, actualLength: actual?.length ?? null };
    }
    for (let index = 0; index < expected.length; index += 1) {
        if (!Number.isFinite(expected[index]) || !Number.isFinite(actual[index])) {
            if (Object.is(expected[index], actual[index])) continue;
            return { ok: false, mismatch: "non-finite", index, expected: expected[index], actual: actual[index] };
        }
        const compared = difference(expected[index], actual[index], tolerance);
        if (!compared.ok) return { ok: false, mismatch: "tolerance", index, expected: expected[index], actual: actual[index], ...compared };
    }
    return { ok: true };
}

function compareProjection(expected, actual) {
    if (!expected || !actual) return { ok: false, reason: "missing projection" };
    for (const field of ["discrete", "hashes"]) {
        if (canonicalStringify(expected[field] ?? null) !== canonicalStringify(actual[field] ?? null)) {
            return { ok: false, reason: `${field} differs` };
        }
    }
    const expectedSeries = new Map((expected.numeric || []).map((entry) => [entry.path, entry]));
    const actualSeries = new Map((actual.numeric || []).map((entry) => [entry.path, entry]));
    if (expectedSeries.size !== actualSeries.size) return { ok: false, reason: "numeric series count differs" };
    for (const [path, left] of expectedSeries) {
        const right = actualSeries.get(path);
        if (!right || left.kind !== right.kind) return { ok: false, reason: `numeric series ${path} is missing or changed kind` };
        const tolerance = PARITY_TOLERANCES[left.kind] ?? PARITY_TOLERANCES.float64;
        const compared = compareNumericSeries(left.values, right.values, tolerance);
        if (!compared.ok) return { ok: false, reason: `numeric series ${path} differs`, detail: compared };
    }
    return { ok: true };
}

export function compareParityReports(expected, actual) {
    assertReport(expected, PARITY_REPORT_KIND);
    assertReport(actual, PARITY_REPORT_KIND);
    const actualCases = new Map(actual.cases.map((entry) => [entry.id, entry]));
    const comparisons = expected.cases.map((left) => {
        const right = actualCases.get(left.id);
        const result = compareProjection(left.semanticProjection, right?.semanticProjection);
        return { caseId: left.id, ...result };
    });
    return {
        ok: comparisons.length === actual.cases.length && comparisons.every((entry) => entry.ok),
        expectedPlatform: expected.provenance,
        actualPlatform: actual.provenance,
        comparisons,
    };
}

export function compareBenchmarkReports(baseline, candidate, limits = BENCHMARK_REGRESSION_LIMITS) {
    assertReport(baseline, BENCHMARK_REPORT_KIND);
    assertReport(candidate, BENCHMARK_REPORT_KIND);
    const baselineRunner = baseline.provenance?.runner;
    const candidateRunner = candidate.provenance?.runner;
    if (baselineRunner && candidateRunner && baselineRunner !== candidateRunner) {
        return { ok: false, reason: "runner identity differs", comparisons: [] };
    }
    const baselineRuns = new Map(baseline.runs.map((entry) => [entry.environmentCount, entry]));
    const comparisons = candidate.runs.map((current) => {
        const previous = baselineRuns.get(current.environmentCount);
        if (!previous) return { environmentCount: current.environmentCount, ok: false, failures: ["missing baseline"] };
        const rssAllowance = Math.max(limits.minimumRssAllowanceBytes, previous.memory.peakRssBytes * limits.rssAllowanceRatio);
        const checks = {
            throughput: current.throughput.fixedStepsPerSecond >= previous.throughput.fixedStepsPerSecond * limits.minimumThroughputRatio,
            policyLatency: current.policyLatencyMs.p95 <= previous.policyLatencyMs.p95 * limits.maximumLatencyRatio,
            resetLatency: current.resetLatencyMs.p95 <= previous.resetLatencyMs.p95 * limits.maximumLatencyRatio,
            rss: current.memory.peakRssBytes <= previous.memory.peakRssBytes + rssAllowance,
        };
        return {
            environmentCount: current.environmentCount,
            ok: Object.values(checks).every(Boolean),
            checks,
            failures: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
        };
    });
    return { ok: comparisons.length === baseline.runs.length && comparisons.every((entry) => entry.ok), comparisons };
}

export function assertReport(report, kind) {
    if (!report || report.kind !== kind || Number(report.version) !== RELEASE_REPORT_VERSION) {
        throw new TypeError(`Expected ${kind} version ${RELEASE_REPORT_VERSION}.`);
    }
    return report;
}

export function createReport(kind, body) {
    return {
        kind,
        version: RELEASE_REPORT_VERSION,
        createdAt: new Date().toISOString(),
        ...body,
    };
}
