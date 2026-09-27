export const REVISION_STATUS_KIND = "cev-sim.revision-status";

const GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * @param {{ ahead: number, behind: number }} counts
 * @returns {"current" | "behind" | "ahead" | "diverged"}
 */
export function classifyRevision({ ahead, behind }) {
    if (!isCount(ahead) || !isCount(behind)) {
        throw new Error("ahead and behind must be non-negative integers.");
    }
    if (ahead === 0 && behind === 0) return "current";
    if (behind > 0 && ahead === 0) return "behind";
    if (ahead > 0 && behind === 0) return "ahead";
    return "diverged";
}

/**
 * Reads the `ref: refs/heads/<branch> HEAD` line from `git ls-remote --symref`.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseRemoteHeadSymref(stdout) {
    const lines = String(stdout ?? "").split(/\r?\n/);
    for (const line of lines) {
        const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/.exec(line.trim());
        if (match) return match[1];
    }
    return null;
}

/**
 * Remote and branch names that are safe to place in a git refspec.
 * @param {unknown} value
 * @returns {string}
 */
export function assertGitName(value) {
    const name = String(value ?? "");
    if (!GIT_NAME.test(name) || name.includes("..") || name.includes("@{") || name.includes("//") || name.endsWith("/") || name.endsWith(".lock")) {
        throw new Error("Invalid git name.");
    }
    return name;
}

/**
 * @param {object} [fields]
 */
export function revisionStatus(fields = {}) {
    return {
        kind: REVISION_STATUS_KIND,
        version: 1,
        state: fields.state ?? "unknown",
        runningCommit: fields.runningCommit ?? null,
        remoteCommit: fields.remoteCommit ?? null,
        remoteName: fields.remoteName ?? null,
        remoteBranch: fields.remoteBranch ?? null,
        remoteRef: fields.remoteRef ?? null,
        ahead: fields.ahead ?? null,
        behind: fields.behind ?? null,
        checkedAt: fields.checkedAt ?? null,
        detail: fields.detail ?? null,
    };
}

function isCount(value) {
    return Number.isInteger(value) && value >= 0;
}
