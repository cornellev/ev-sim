import assert from "node:assert/strict";
import test from "node:test";

import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { browserSimulationPerformance } from "../app/simulation/performance/BrowserSimulationPerformance.js";

test("both simulation advancement paths report completed steps exactly once", async () => {
    const originalNow = browserSimulationPerformance.now;
    let wallMs = 1000;
    const engine = Object.create(SimulationEngine.prototype);
    Object.assign(engine, {
        realtime: false,
        deterministic: false,
        speed: 1,
        _advanceGeneration: 1,
        _pacingAdvancedNs: 0,
        _pacingWallMs: 0,
        kernel: { timeNs: 0, steps: 0 },
        _nowMs: () => wallMs,
    });
    engine._fixedStep = (duration) => {
        engine.kernel.timeNs += Math.round(duration * 1e9);
        engine.kernel.steps += 1;
        wallMs += 5;
    };
    engine._fixedStepAsync = async (duration) => engine._fixedStep(duration);
    for (const key of ["timeNs", "steps"]) Object.defineProperty(engine, key, { get: () => engine.kernel[key] });
    try {
        browserSimulationPerformance.now = () => wallMs;
        browserSimulationPerformance.start();
        engine._advanceSimulation(0.02);
        await engine._advanceSimulationAsync(0.02);
        const report = browserSimulationPerformance.stop();
        assert.equal(report.simulation.advancedNs, 40_000_000);
        assert.equal(report.simulation.stepsPerSecond, 200);
        assert.equal(report.timings.simulationAdvance.count, 2);
        assert.equal(report.timings.simulationAdvance.totalMs, 10);
    } finally {
        browserSimulationPerformance.stop();
        browserSimulationPerformance.reset();
        browserSimulationPerformance.now = originalNow;
    }
});
