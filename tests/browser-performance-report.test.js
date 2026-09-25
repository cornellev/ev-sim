import assert from "node:assert/strict";
import test from "node:test";

import { browserSimulationPerformance } from "../app/simulation/performance/BrowserSimulationPerformance.js";

test("browser performance report records cadence, sensor loss, queues, bytes, and timings", () => {
    const originalNow = browserSimulationPerformance.now;
    let now = 1_000;
    browserSimulationPerformance.now = () => now;
    try {
        browserSimulationPerformance.recordRenderRuntime({
            implementation: "inline",
            fallbackReason: { code: "PBR_WORKER_UNSUPPORTED", message: "unsupported" },
        });
        browserSimulationPerformance.start({ warmupMs: 0, workload: { fixedStepHz: 60 } });
        for (let frame = 0; frame < 61; frame += 1) {
            now = 1_000 + frame * (1000 / 60);
            browserSimulationPerformance.recordRaf(now);
            browserSimulationPerformance.recordPresentation(now);
        }
        browserSimulationPerformance.recordPresentationDeferred(now);
        browserSimulationPerformance.recordRendererBlocked(1.5, now);
        browserSimulationPerformance.recordSimulation(1_000_000_000, 8, 60, now);
        browserSimulationPerformance.recordTiming("cameraCapture", 4, now);
        browserSimulationPerformance.recordTiming("sensorEncode", 2, now);
        browserSimulationPerformance.recordSensorState("camera", {
            captureAttempts: 30,
            capturedFrames: 30,
            deliveredFrames: 29,
            queueDepth: 1,
            queueBytes: 1024,
        }, now);
        browserSimulationPerformance.recordWebSocketBytes(4096, now);
        now = 2_000;
        const report = browserSimulationPerformance.stop();
        assert.equal(report.kind, "cev-sim.browser-performance-report");
        assert.equal(report.version, 1);
        assert.equal(report.display.frames, 60);
        assert.ok(report.display.fps >= 59.9);
        assert.equal(report.display.deferredPresentations, 1);
        assert.equal(report.rendering.implementation, "inline");
        assert.equal(report.rendering.fallbackReason.code, "PBR_WORKER_UNSUPPORTED");
        assert.equal(report.rendering.blockedCount, 1);
        assert.equal(report.simulation.stepsPerSecond, 60);
        assert.equal(report.sensors.due, 30);
        assert.equal(report.sensors.captured, 30);
        assert.equal(report.sensors.delivered, 29);
        assert.equal(report.sensors.skipped, 0);
        assert.equal(report.sensors.undelivered, 1);
        assert.equal(report.queues.maxDepth, 1);
        assert.equal(report.websocket.bytes, 4096);
        assert.equal(report.timings.cameraCapture.count, 1);
        assert.equal(report.gates.scheduledSensors, false);
        assert.equal(report.passed, false);
    } finally {
        browserSimulationPerformance.now = originalNow;
        browserSimulationPerformance.reset();
    }
});
