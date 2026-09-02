import assert from "node:assert/strict";
import test from "node:test";

import { buildAnalysisFieldRows, groupAnalysisFieldRows } from "../app/analysis/analysisFieldRows.js";
import { downsampleMinMax } from "../app/analysis/downsample.js";
import { eventTypeKey, filterEvents } from "../app/analysis/eventFilters.js";
import { loadAutonomySnapshotForDataset, __testOnly_setAutonomySnapshotFetcher } from "../app/spatial/spatialLogQueries.js";
import { simulationTimeUsFromSnapshot } from "../app/telemetry/SimulationClock.js";

test("min/max downsampling is bounded and preserves endpoint values and spikes", () => {
    const samples = Array.from({ length: 10_000 }, (_value, index) => ({
        timeUs: index * 1000,
        value: index === 4321 ? 1000 : Math.sin(index / 50),
    }));
    const result = downsampleMinMax(samples, 500);
    assert.ok(result.length <= 500);
    assert.equal(result[0], samples[0]);
    assert.equal(result.at(-1), samples.at(-1));
    assert.ok(result.some((sample) => sample.value === 1000));
});

test("min/max downsampling leaves already-bounded series unchanged", () => {
    const samples = [{ timeUs: 0, value: 1 }, { timeUs: 1, value: 2 }];
    assert.equal(downsampleMinMax(samples, 20), samples);
});

test("analysis source time comes only from the published simulation counter", () => {
    assert.equal(simulationTimeUsFromSnapshot({}), null);
    assert.equal(simulationTimeUsFromSnapshot({
        "simulation.time": { value: 12.5, timeUs: 999_000_000 },
        "unrelated.wallClock": { value: 999 },
    }), 12_500_000);
    assert.equal(simulationTimeUsFromSnapshot({
        "simulation.time": { value: 12.5 },
        "simulation.timeNs": { value: 12_500_000_000 },
    }), 12_500_000);
});

test("event filters exclude every occurrence of a selected event type", () => {
    const events = [
        { category: "simulation", name: "started", severity: "info" },
        { category: "simulation", name: "started", severity: "warning" },
        { category: "logging", name: "started", severity: "info" },
    ];
    const excluded = [eventTypeKey(events[0])];

    assert.deepEqual(filterEvents(events, "", excluded), [events[2]]);
});

test("event text filtering is combined with event type exclusions", () => {
    const events = [
        { category: "simulation", name: "started", severity: "info" },
        { category: "simulation", name: "stopped", severity: "warning" },
        { category: "logging", name: "stopped", severity: "warning" },
    ];

    assert.deepEqual(filterEvents(events, "warning", [eventTypeKey(events[1])]), [events[2]]);
});

test("analysis field rows ignore cursor time and stay stable for the same snapshot", () => {
    const descriptors = [
        { path: "vehicles.ego.velocity", type: "vec3", unit: "m/s" },
        { path: "visualization.perception.candidate", type: "json" },
    ];
    const snapshot = {
        "vehicles.ego.velocity": { x: 1, y: 0, z: 0 },
        "visualization.perception.candidate": {
            detections3d: [{ box3d: { center: { x: 1, y: 2, z: 3 }, size: { x: 4, y: 5, z: 6 } } }],
        },
    };
    const first = buildAnalysisFieldRows(descriptors, snapshot, "");
    const second = buildAnalysisFieldRows(descriptors, snapshot, "");
    assert.deepEqual(first, second);
    assert.deepEqual(groupAnalysisFieldRows(first), groupAnalysisFieldRows(second));
    assert.ok(first.some((row) => row.path === "vehicles.ego.velocity" && row.field === "x"));
    assert.equal(first.filter((row) => row.path.startsWith("visualization.")).length, 1);
});

test("loadAutonomySnapshotForDataset coalesces identical in-flight requests", async () => {
    let calls = 0;
    __testOnly_setAutonomySnapshotFetcher(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { snapshot: { perception: { detections3d: [] } } };
    });
    try {
        const dataset = { id: "log-coalesce", lazy: true, series: new Map() };
        const [first, second] = await Promise.all([
            loadAutonomySnapshotForDataset(dataset, 1_000_000, { exactSync: false }),
            loadAutonomySnapshotForDataset(dataset, 1_000_000, { exactSync: false }),
        ]);
        assert.equal(calls, 1);
        assert.deepEqual(first, second);
    } finally {
        __testOnly_setAutonomySnapshotFetcher(null);
    }
});
