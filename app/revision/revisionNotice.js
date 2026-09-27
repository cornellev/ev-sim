export const REVISION_STATUS_KIND = "cev-sim.revision-status";
export const DISMISS_STORAGE_KEY = "cev-sim.revision-notice";

export function shouldShowRevisionNotice(status, dismissedRemoteCommit) {
    if (!status || status.kind !== REVISION_STATUS_KIND || status.version !== 1) return false;
    if (status.state !== "behind" && status.state !== "diverged") return false;
    if (!status.runningCommit || !status.remoteCommit) return false;
    if (dismissedRemoteCommit === status.remoteCommit) return false;
    return true;
}

export function shortCommit(sha) {
    return String(sha ?? "").slice(0, 12);
}

export function reduceRevisionNotice(previous, next) {
    const current = previous ?? { status: null, held: null };
    if (!next || typeof next !== "object") return current;
    if (next.state === "current" || next.state === "ahead") {
        return { status: next, held: null };
    }
    if (next.state === "behind" || next.state === "diverged") {
        return { status: next, held: next };
    }
    return { status: next, held: current.held };
}

export function displayedRevisionNotice(state) {
    if (state?.status?.state === "behind" || state?.status?.state === "diverged") return state.status;
    return state?.held ?? null;
}
