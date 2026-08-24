import assert from "node:assert/strict";
import test from "node:test";

import { downsampleMinMax } from "../app/analysis/downsample.js";
import { eventTypeKey, filterEvents } from "../app/analysis/eventFilters.js";
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
