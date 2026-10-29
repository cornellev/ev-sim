export const BROWSER_SIM_HEARTBEAT_MS = 5_000;
export const BROWSER_SIM_TIMEOUT_MS = 15_000;
export const BROWSER_SIM_ACTIONS = ["start", "pause", "resume", "stop", "reset"];

export function browserSimError(code, message, statusCode = 409) {
    return Object.assign(new Error(message), { code, statusCode });
}

/** Shared admission checks; the browser repeats them against its live state. */
export function assertBrowserSimCommand(command, snapshot) {
    if (snapshot.experimentActive) {
        throw browserSimError("EXPERIMENT_ACTIVE", "An experiment owns this simulator tab.");
    }
    if (snapshot.transitioning || snapshot.status === "preparing") {
        throw browserSimError("BUSY", "The simulator is preparing or finalizing a run.");
    }
    if (command.action === "start") {
        if (snapshot.status === "running" || (snapshot.runId && ["ready", "paused"].includes(snapshot.status))) {
            throw browserSimError("RUN_ACTIVE", "Stop the current run before starting another manifest.");
        }
    } else {
        if (!snapshot.runId || snapshot.runId !== command.runId) {
            throw browserSimError("RUN_ID_MISMATCH", "The requested run is not the current run in this tab.");
        }
        if (["pause", "resume"].includes(command.action) && !["ready", "running", "paused"].includes(snapshot.status)) {
            throw browserSimError("RUN_TERMINAL", "This run has ended; start or reset it first.");
        }
    }
    if (["start", "reset", "resume"].includes(command.action) && snapshot.navigationBlocked) {
        throw browserSimError("NAVIGATION_BLOCKED", "Save or discard workspace edits before controlling this run.");
    }
}

/** Operational metadata only: never serialize the resolved run or oracle state. */
export function browserSimSnapshot(controller, experiment, navigationBlocked = false) {
    const run = controller.getSnapshot();
    const simulation = controller.data?.simulation?.();
    const resolved = run.pendingResolved ?? run.activeResolved;
    const preparing = run.status === "preparing";
    const result = run.runResult;
    return {
        status: !run.activeRunId && simulation?.status === "playing" ? "running" : run.status,
        runId: preparing ? null : run.activeRunId ?? null,
        manifestId: resolved?.manifest?.id ?? null,
        manifestRevision: run.manifestRevision ?? resolved?.manifest?.revision ?? null,
        resolvedHash: resolved?.resolvedHash ?? null,
        step: preparing ? 0 : simulation?.steps ?? 0,
        timeNs: String(preparing ? 0 : simulation?.timeNs ?? 0),
        stepNs: String(resolved?.manifest?.clock?.stepNs ?? simulation?.stepNs ?? 0),
        degraded: run.degraded === true,
        error: run.error == null ? null : String(run.error).slice(0, 4096),
        transitioning: !simulation || run.transitioning === true,
        experimentActive: ["running", "paused"].includes(experiment?.getSnapshot()?.status),
        navigationBlocked,
        runResult: result ? {
            runId: result.runId,
            status: result.status,
            completed: result.completed,
            passed: result.passed,
            logId: result.logId ?? null,
            terminationReason: result.terminationReason ?? null,
            step: result.step,
            timeNs: String(result.timeNs),
        } : null,
    };
}
