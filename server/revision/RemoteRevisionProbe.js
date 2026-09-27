import { execFile } from "node:child_process";

import { assertGitName, classifyRevision, parseRemoteHeadSymref, revisionStatus } from "./revisionStatus.js";

export const DEFAULT_FETCH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

const COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Pins the commit this process started on and compares it with the remote
 * default-branch tip. Later movement of the working tree HEAD does not
 * change `runningCommit`.
 */
export class RemoteRevisionProbe {
    constructor({
        repoRoot,
        runGit = defaultRunGit,
        now = Date.now,
        fetchIntervalMs = DEFAULT_FETCH_INTERVAL_MS,
        commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
        enabled,
        env = process.env,
    } = {}) {
        this.repoRoot = repoRoot;
        this.runGit = runGit;
        this.now = now;
        this.fetchIntervalMs = fetchIntervalMs;
        this.commandTimeoutMs = commandTimeoutMs;
        this.enabled = enabled ?? env.CEV_SIM_REVISION_CHECK !== "0";
        this.runningCommit = null;
        this.startupDetail = null;
        this.cached = null;
        this.cachedAt = 0;
        this.inflight = null;
    }

    async start() {
        if (!this.enabled) return revisionStatus({ state: "disabled", checkedAt: this.stamp() });
        const result = await this.run(["rev-parse", "--verify", "HEAD"]);
        if (!result.ok) {
            this.startupDetail = failureDetail(result) ?? "unreadable-history";
            this.logGitFailure(["rev-parse", "--verify", "HEAD"], result);
            return revisionStatus({
                state: "unknown",
                detail: this.startupDetail,
                checkedAt: this.stamp(),
            });
        }
        const sha = normalizeCommit(result.stdout);
        if (!sha) {
            this.startupDetail = "unreadable-history";
            return revisionStatus({
                state: "unknown",
                detail: this.startupDetail,
                checkedAt: this.stamp(),
            });
        }
        this.runningCommit = sha;
        this.startupDetail = null;
        return revisionStatus({
            state: "unknown",
            runningCommit: sha,
            checkedAt: this.stamp(),
        });
    }

    async status() {
        if (!this.enabled) return revisionStatus({ state: "disabled", checkedAt: this.stamp() });
        if (!this.runningCommit) {
            return revisionStatus({
                state: "unknown",
                detail: this.startupDetail ?? "git-unavailable",
                checkedAt: this.stamp(),
            });
        }
        if (this.cached && this.now() - this.cachedAt < this.fetchIntervalMs) return this.cached;
        if (!this.inflight) {
            this.inflight = this.refresh().finally(() => {
                this.inflight = null;
            });
        }
        return this.inflight;
    }

    async refresh() {
        if (!this.enabled) return revisionStatus({ state: "disabled", checkedAt: this.stamp() });
        if (!this.runningCommit) {
            return this.remember(revisionStatus({
                state: "unknown",
                detail: this.startupDetail ?? "git-unavailable",
            }));
        }

        const remote = await this.resolveRemote();
        if (remote.detail) return this.remember(this.unknown(remote.detail));

        const branch = await this.resolveDefaultBranch(remote.name);
        if (branch.detail) {
            return this.remember(this.unknown(branch.detail, { remoteName: remote.name }));
        }

        const remoteName = remote.name;
        const remoteBranch = branch.branch;
        const remoteRef = `${remoteName}/${remoteBranch}`;
        const refspec = `+refs/heads/${remoteBranch}:refs/remotes/${remoteName}/${remoteBranch}`;
        const fetched = await this.run([
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            remoteName,
            refspec,
        ]);
        if (!fetched.ok) {
            this.logGitFailure(["fetch", remoteName, remoteBranch], fetched);
            return this.remember(this.unknown("fetch-failed", { remoteName, remoteBranch, remoteRef }));
        }

        const tip = await this.run(["rev-parse", "--verify", remoteRef]);
        const remoteCommit = tip.ok ? normalizeCommit(tip.stdout) : null;
        if (!remoteCommit) {
            this.logGitFailure(["rev-parse", "--verify", remoteRef], tip);
            return this.remember(this.unknown("unreadable-history", { remoteName, remoteBranch, remoteRef }));
        }

        const behindResult = await this.run(["rev-list", "--count", `${this.runningCommit}..${remoteRef}`]);
        const aheadResult = await this.run(["rev-list", "--count", `${remoteRef}..${this.runningCommit}`]);
        const behind = behindResult.ok ? parseCount(behindResult.stdout) : null;
        const ahead = aheadResult.ok ? parseCount(aheadResult.stdout) : null;
        if (behind === null || ahead === null) {
            this.logGitFailure(["rev-list", "--count", remoteRef], behind === null ? behindResult : aheadResult);
            return this.remember(this.unknown("unreadable-history", {
                remoteName,
                remoteBranch,
                remoteRef,
                remoteCommit,
            }));
        }

        return this.remember(revisionStatus({
            state: classifyRevision({ ahead, behind }),
            runningCommit: this.runningCommit,
            remoteCommit,
            remoteName,
            remoteBranch,
            remoteRef,
            ahead,
            behind,
        }));
    }

    async resolveRemote() {
        const result = await this.run(["remote"]);
        if (!result.ok) {
            this.logGitFailure(["remote"], result);
            return { detail: failureDetail(result) ?? "no-remote" };
        }
        const names = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (names.length === 0) return { detail: "no-remote" };
        const selected = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : null;
        if (!selected) return { detail: "ambiguous-remote" };
        try {
            return { name: assertGitName(selected) };
        } catch {
            return { detail: "ambiguous-remote" };
        }
    }

    async resolveDefaultBranch(remote) {
        const result = await this.run(["ls-remote", "--symref", remote, "HEAD"]);
        if (!result.ok) {
            this.logGitFailure(["ls-remote", "--symref", remote, "HEAD"], result);
            return { detail: "fetch-failed" };
        }
        const branch = parseRemoteHeadSymref(result.stdout);
        if (!branch) return { detail: "no-default-branch" };
        try {
            return { branch: assertGitName(branch) };
        } catch {
            return { detail: "no-default-branch" };
        }
    }

    async run(args) {
        try {
            return await this.runGit(args, {
                cwd: this.repoRoot,
                timeoutMs: this.commandTimeoutMs,
                env: gitCommandEnv(),
            });
        } catch (error) {
            return {
                ok: false,
                stdout: "",
                stderr: String(error?.message ?? error),
                code: error?.code ?? 1,
            };
        }
    }

    unknown(detail, extra = {}) {
        return revisionStatus({
            state: "unknown",
            detail,
            runningCommit: this.runningCommit,
            ...extra,
        });
    }

    remember(document) {
        const checkedAtMs = this.now();
        const stamped = { ...document, checkedAt: new Date(checkedAtMs).toISOString() };
        this.cached = stamped;
        this.cachedAt = checkedAtMs;
        return stamped;
    }

    stamp() {
        return new Date(this.now()).toISOString();
    }

    logGitFailure(args, result) {
        const stderr = String(result?.stderr ?? "").trim();
        if (!stderr) return;
        console.error(`[revision] git ${args.join(" ")} failed: ${stderr}`);
    }
}

export function gitCommandEnv(base = process.env) {
    return {
        ...base,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
    };
}

export function defaultRunGit(args, { cwd, timeoutMs, env } = {}) {
    return new Promise((resolve) => {
        execFile("git", args, {
            cwd,
            env,
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (!error) {
                resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
                return;
            }
            if (error.code === "ENOENT") {
                resolve({ ok: false, stdout: "", stderr: "", code: "ENOENT" });
                return;
            }
            resolve({
                ok: false,
                stdout: String(stdout ?? error.stdout ?? ""),
                stderr: String(stderr ?? error.stderr ?? ""),
                code: error.code ?? error.status ?? 1,
            });
        });
    });
}

function failureDetail(result) {
    if (result?.code === "ENOENT") return "git-unavailable";
    const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
    if (/not a git repository/i.test(text)) return "not-a-repository";
    return null;
}

function normalizeCommit(stdout) {
    const sha = String(stdout ?? "").trim().toLowerCase();
    return COMMIT_SHA.test(sha) ? sha : null;
}

function parseCount(stdout) {
    const text = String(stdout ?? "").trim();
    if (!/^\d+$/.test(text)) return null;
    return Number(text);
}
