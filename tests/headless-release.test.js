import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { HeadlessSession } from "../server/headless/HeadlessSession.js";
import {
    BENCHMARK_REPORT_KIND,
    PARITY_REPORT_KIND,
    compareBenchmarkReports,
    compareNumericSeries,
    compareParityReports,
    createReport,
    percentile,
} from "../server/headless/ReleaseReports.js";

function benchmark(fixedStepsPerSecond = 100, p95 = 10, resetP95 = 20, rss = 100_000_000) {
    return createReport(BENCHMARK_REPORT_KIND, {
        runs: [{
            environmentCount: 8,
            throughput: { fixedStepsPerSecond },
            policyLatencyMs: { p95 },
            resetLatencyMs: { p95: resetP95 },
            memory: { peakRssBytes: rss },
        }],
    });
}

function parity(value = 1) {
    return createReport(PARITY_REPORT_KIND, {
        provenance: { platform: "test" },
        cases: [{
            id: "state",
            semanticProjection: {
                hashes: { episodeHash: "a" },
                discrete: { valid: true },
                numeric: [{ path: "state.x", kind: "float64", values: [value] }],
            },
        }],
    });
}

test("release report numeric tolerances and nearest-rank percentiles are stable", () => {
    assert.deepEqual(percentile([4, 1, 3, 2], 0.5), 2);
    assert.equal(compareNumericSeries([1], [1 + 1e-10]).ok, true);
    assert.equal(compareNumericSeries([1], [1 + 1e-6]).ok, false);
    assert.equal(compareNumericSeries([1], [1.00001], { absolute: 0, relative: 0.00002 }).ok, true);
    const lidarTolerance = { absolute: 1e-4, relative: 1e-5, combination: "max" };
    assert.equal(compareNumericSeries([100], [100.000999], lidarTolerance).ok, true);
    assert.equal(compareNumericSeries([100], [100.001001], lidarTolerance).ok, false);
});

test("cross-platform parity reports preserve exact fields and declared numeric tolerances", () => {
    assert.equal(compareParityReports(parity(1), parity(1 + 1e-10)).ok, true);
    assert.equal(compareParityReports(parity(1), parity(1 + 1e-6)).ok, false);
    const changed = parity(1);
    changed.cases[0].semanticProjection.discrete.valid = false;
    assert.equal(compareParityReports(parity(1), changed).ok, false);
});

test("benchmark regressions gate throughput, latency, reset, and RSS", () => {
    assert.equal(compareBenchmarkReports(benchmark(), benchmark(80, 15, 30, 160_000_000)).ok, true);
    assert.equal(compareBenchmarkReports(benchmark(), benchmark(79, 15, 30, 160_000_000)).ok, false);
    assert.equal(compareBenchmarkReports(benchmark(), benchmark(100, 15.1, 30, 160_000_000)).ok, false);
    assert.equal(compareBenchmarkReports(benchmark(), benchmark(100, 15, 30.1, 160_000_000)).ok, false);
    assert.equal(compareBenchmarkReports(benchmark(), benchmark(100, 15, 30, 168_000_000)).ok, false);
});

test("worker CPU counters stay internal and public HealthResponse remains unchanged", async () => {
    const health = new HeadlessSession().health();
    assert.ok(Number.isSafeInteger(health.cpuUserMicros));
    assert.ok(Number.isSafeInteger(health.cpuSystemMicros));
    assert.equal(health.queueBytes, 0);
    const proto = await readFile(new URL("../proto/cev_sim/headless/v1/headless.proto", import.meta.url), "utf8");
    const publicHealth = proto.slice(proto.indexOf("message HealthResponse"), proto.indexOf("message ErrorStatus"));
    assert.doesNotMatch(publicHealth, /cpu/i);
});
