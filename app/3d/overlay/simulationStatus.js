const TERMINAL_FAILURES = new Set(["assertion-failed", "error"]);
const TERMINAL_SUCCESS = new Set(["completed"]);

export function deriveSimulationStatus(runState = {}, simState = {}) {
    const hasManifest = Boolean(runState.activeResolved && runState.activeRunId);
    const runStatus = String(runState.status || "idle");
    const simulationStatus = String(simState.status || "stopped");

    if (runStatus === "preparing") {
        return { label: "Preparing run", detail: "Resolving and applying manifest", tone: "sky", source: "manifest" };
    }
    if (TERMINAL_FAILURES.has(runStatus) || runState.error && runStatus === "error") {
        return { label: runStatus === "assertion-failed" ? "Assertion failed" : "Run error", detail: runState.error || "The run stopped with an error", tone: "rose", source: hasManifest ? "manifest" : "scene" };
    }
    if (hasManifest) {
        if (runState.degraded && runStatus === "running") {
            return { label: "Running, degraded", detail: runState.error || "An optional run service is unavailable", tone: "amber", source: "manifest" };
        }
        if (runStatus === "running") {
            return { label: "Running", detail: "Deterministic manifest run", tone: "emerald", source: "manifest" };
        }
        if (runStatus === "ready") {
            return { label: "Ready", detail: "Manifest loaded at simulation time zero", tone: "sky", source: "manifest" };
        }
        if (runStatus === "paused") {
            return { label: "Paused", detail: "Manifest loaded, clock not advancing", tone: "amber", source: "manifest" };
        }
        if (TERMINAL_SUCCESS.has(runStatus)) {
            return { label: "Completed", detail: "Run finalized", tone: "emerald", source: "manifest" };
        }
        if (["stopped", "reset", "superseded"].includes(runStatus)) {
            return { label: "Stopped", detail: "Manifest run is not advancing", tone: "zinc", source: "manifest" };
        }
        if (simulationStatus === "playing") {
            return { label: "Running", detail: "Deterministic manifest run", tone: "emerald", source: "manifest" };
        }
        return { label: "Manifest loaded", detail: "Run is not advancing", tone: "sky", source: "manifest" };
    }

    if (simulationStatus === "playing") {
        return { label: "Scene running", detail: "Legacy scene runtime, no manifest", tone: "amber", source: "scene" };
    }
    if (simulationStatus === "paused") {
        return { label: "Scene paused", detail: "Legacy scene runtime, no manifest", tone: "zinc", source: "scene" };
    }
    return { label: "Scene loaded", detail: "No run manifest is active", tone: "zinc", source: "scene" };
}

export function formatSimulationTime(seconds = 0) {
    const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const wholeSeconds = Math.floor((totalMs % 60_000) / 1000);
    const milliseconds = totalMs % 1000;
    const clock = `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
    return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

export function formatClockMode(simState = {}) {
    const rate = simState.stepNs > 0 ? 1e9 / simState.stepNs : 0;
    const rateLabel = rate > 0 ? `${Number(rate.toFixed(rate >= 10 ? 0 : 2))} Hz` : "Fixed step";
    const pacing = simState.realtime ? "Realtime" : "Unbounded";
    return `${rateLabel}, ${pacing}, ${Number(simState.speed ?? 1)}x`;
}

export function summarizeAssertions(assertions = []) {
    if (!Array.isArray(assertions) || assertions.length === 0) return { label: "None", tone: "zinc" };
    const failed = assertions.filter((entry) => entry.status === "failed").length;
    if (failed > 0) return { label: `${failed} failed`, tone: "rose" };
    const passed = assertions.filter((entry) => entry.status === "passed").length;
    const pending = assertions.length - passed;
    if (pending > 0) return { label: `${pending} pending`, tone: "amber" };
    return { label: `${passed} passed`, tone: "emerald" };
}
