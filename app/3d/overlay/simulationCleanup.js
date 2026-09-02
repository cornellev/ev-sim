function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

export function simulationHasStoppedClock(simState = {}) {
    return simState.status === "stopped" || simState.lifecycleState === "finalized";
}

export function simulationCleanupPendingBytes(recording = {}) {
    return Math.max(0, Number(recording.pendingBytes ?? recording.queuedBytes) || 0);
}

export function shouldShowSimulationCleanup(simState, recording) {
    if (!recording) return false;
    if (!simulationHasStoppedClock(simState)) return false;
    if (recording.status === "stopping") return true;
    if (!recording.active) return false;
    return simulationCleanupPendingBytes(recording) > 0;
}

export function simulationCleanupProgress(recording = {}, peakPendingBytes = 0) {
    if (typeof recording.flushProgress === "number" && Number.isFinite(recording.flushProgress)) {
        return clamp01(recording.flushProgress);
    }
    const pending = simulationCleanupPendingBytes(recording);
    const peak = Math.max(Number(recording.flushTotalBytes) || 0, peakPendingBytes, pending);
    if (peak <= 0) return recording.status === "stopping" ? 1 : 0;
    return clamp01(1 - pending / peak);
}
