import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { RemoteRevisionProbe } from "../server/revision/RemoteRevisionProbe.js";
import {
    assertGitName,
    classifyRevision,
    parseRemoteHeadSymref,
    revisionStatus,
} from "../server/revision/revisionStatus.js";

const execFileAsync = promisify(execFile);
const RUNNING = "a".repeat(40);
const REMOTE = "b".repeat(40);
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "Cev Test",
    GIT_AUTHOR_EMAIL: "cev-test@example.com",
    GIT_COMMITTER_NAME: "Cev Test",
    GIT_COMMITTER_EMAIL: "cev-test@example.com",
    GIT_TERMINAL_PROMPT: "0",
};

test("classifyRevision reports containment of the remote tip", () => {
    assert.equal(classifyRevision({ ahead: 0, behind: 0 }), "current");
    assert.equal(classifyRevision({ ahead: 0, behind: 2 }), "behind");
    assert.equal(classifyRevision({ ahead: 3, behind: 0 }), "ahead");
    assert.equal(classifyRevision({ ahead: 1, behind: 4 }), "diverged");
    assert.throws(() => classifyRevision({ ahead: -1, behind: 0 }), /non-negative integers/);
});

test("parseRemoteHeadSymref reads the remote default branch", () => {
    assert.equal(parseRemoteHeadSymref("ref: refs/heads/main\tHEAD\nabc\tHEAD\n"), "main");
    assert.equal(parseRemoteHeadSymref("ref: refs/heads/release/1.0\tHEAD\n"), "release/1.0");
    assert.equal(parseRemoteHeadSymref("abc\tHEAD\n"), null);
    assert.equal(parseRemoteHeadSymref(""), null);
});

test("assertGitName accepts refspec names and rejects traversal", () => {
    assert.equal(assertGitName("origin"), "origin");
    assert.equal(assertGitName("feature/foo"), "feature/foo");
    assert.throws(() => assertGitName("-main"), /Invalid git name/);
    assert.throws(() => assertGitName("foo..bar"), /Invalid git name/);
    assert.throws(() => assertGitName("a@{b"), /Invalid git name/);
});

test("revisionStatus defaults a versioned document", () => {
    assert.deepEqual(revisionStatus({ state: "behind", behind: 2 }), {
        kind: "cev-sim.revision-status",
        version: 1,
        state: "behind",
        runningCommit: null,
        remoteCommit: null,
        remoteName: null,
        remoteBranch: null,
        remoteRef: null,
        ahead: null,
        behind: 2,
        checkedAt: null,
        detail: null,
    });
});

test("status caches a fetch and shares one in-flight refresh", async () => {
    let now = 1_000;
    let fetches = 0;
    let releaseFetch;
    const fetchGate = new Promise((resolve) => {
        releaseFetch = resolve;
    });
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
        markFetchStarted = resolve;
    });
    const { runGit, calls } = scriptedGit({
        onFetch: async () => {
            fetches += 1;
            markFetchStarted();
            await fetchGate;
        },
    });
    const probe = new RemoteRevisionProbe({
        repoRoot: "/tmp/cev-revision",
        runGit,
        now: () => now,
        fetchIntervalMs: 5_000,
    });
    await probe.start();
    const first = probe.status();
    const second = probe.status();
    await fetchStarted;
    assert.equal(fetches, 1);
    releaseFetch();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left, right);
    assert.equal(left.state, "behind");
    assert.equal(left.behind, 2);
    assert.equal(left.ahead, 0);
    assert.equal(left.remoteRef, "origin/main");
    assert.deepEqual(calls.find((args) => args[0] === "fetch"), [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
    ]);
    assert.deepEqual(calls.filter((args) => args[0] === "rev-list"), [
        ["rev-list", "--count", `${RUNNING}..origin/main`],
        ["rev-list", "--count", `origin/main..${RUNNING}`],
    ]);

    await probe.status();
    assert.equal(fetches, 1);
    now += 5_000;
    await probe.status();
    assert.equal(fetches, 2);
});

test("refresh reports fetch failure without a remote commit", async () => {
    const { runGit } = scriptedGit({
        fetchResult: { ok: false, stdout: "", stderr: "could not read from remote", code: 1 },
    });
    const probe = new RemoteRevisionProbe({ repoRoot: "/tmp/cev-revision", runGit, now: () => 0 });
    await probe.start();
    const status = await probe.refresh();
    assert.equal(status.state, "unknown");
    assert.equal(status.detail, "fetch-failed");
    assert.equal(status.remoteCommit, null);
    assert.equal(status.runningCommit, RUNNING);
});

test("missing git and an absent repository do not throw", async () => {
    const missing = new RemoteRevisionProbe({
        repoRoot: "/tmp/cev-revision",
        runGit: async () => ({ ok: false, stdout: "", stderr: "", code: "ENOENT" }),
    });
    const unavailable = await missing.start();
    assert.equal(unavailable.detail, "git-unavailable");
    assert.equal((await missing.status()).detail, "git-unavailable");

    const absent = new RemoteRevisionProbe({
        repoRoot: "/tmp/cev-revision",
        runGit: async () => ({ ok: false, stdout: "", stderr: "fatal: not a git repository", code: 128 }),
    });
    assert.equal((await absent.start()).detail, "not-a-repository");
    assert.equal((await absent.status()).state, "unknown");
});

test("remote resolution failures stay unknown", async () => {
    const noRemote = await refreshWith({ remotes: "\n" });
    assert.equal(noRemote.detail, "no-remote");
    const ambiguous = await refreshWith({ remotes: "upstream\nfork\n" });
    assert.equal(ambiguous.detail, "ambiguous-remote");
    const noBranch = await refreshWith({ symref: `${REMOTE}\tHEAD\n` });
    assert.equal(noBranch.detail, "no-default-branch");
});

test("CEV_SIM_REVISION_CHECK=0 skips git", async () => {
    let called = false;
    const probe = new RemoteRevisionProbe({
        repoRoot: "/tmp/cev-revision",
        env: { CEV_SIM_REVISION_CHECK: "0" },
        runGit: () => {
            called = true;
            return { ok: false, stdout: "", stderr: "", code: 1 };
        },
    });
    assert.equal((await probe.start()).state, "disabled");
    assert.equal((await probe.status()).state, "disabled");
    assert.equal(called, false);
});

test("a real remote tip behind, ahead, and diverged from the startup commit", async (t) => {
    const fixture = await createRepoPair(t);
    const behindProbe = new RemoteRevisionProbe({ repoRoot: fixture.clone });
    const started = await behindProbe.start();
    assert.equal(started.runningCommit, fixture.base);

    await commit(fixture.seed, "b.txt", "b\n", "B");
    await git(fixture.seed, ["push", "origin", "main"]);
    const behind = await behindProbe.refresh();
    assert.equal(behind.state, "behind");
    assert.equal(behind.behind, 1);
    assert.equal(behind.ahead, 0);
    assert.equal(behind.runningCommit, fixture.base);
    assert.equal(behind.remoteRef, "origin/main");
    assert.notEqual(behind.remoteCommit, fixture.base);

    const aheadRoot = await createRepoPair(t);
    await commit(aheadRoot.seed, "b.txt", "b\n", "B");
    await git(aheadRoot.seed, ["push", "origin", "main"]);
    await git(aheadRoot.clone, ["pull", "--ff-only", "origin", "main"]);
    const aheadProbe = new RemoteRevisionProbe({ repoRoot: aheadRoot.clone });
    await aheadProbe.start();
    await git(aheadRoot.seed, ["push", "--force", "origin", `${aheadRoot.base}:refs/heads/main`]);
    const ahead = await aheadProbe.refresh();
    assert.equal(ahead.state, "ahead");
    assert.equal(ahead.ahead, 1);
    assert.equal(ahead.behind, 0);
    assert.equal(ahead.remoteCommit, aheadRoot.base);

    const divergedRoot = await createRepoPair(t);
    await commit(divergedRoot.clone, "c.txt", "c\n", "C");
    const divergedProbe = new RemoteRevisionProbe({ repoRoot: divergedRoot.clone });
    await divergedProbe.start();
    await commit(divergedRoot.seed, "b.txt", "b\n", "B");
    await git(divergedRoot.seed, ["push", "origin", "main"]);
    const diverged = await divergedProbe.refresh();
    assert.equal(diverged.state, "diverged");
    assert.equal(diverged.behind, 1);
    assert.equal(diverged.ahead, 1);
});

async function refreshWith(options) {
    const { runGit } = scriptedGit(options);
    const probe = new RemoteRevisionProbe({ repoRoot: "/tmp/cev-revision", runGit, now: () => 0 });
    await probe.start();
    return probe.refresh();
}

function scriptedGit({
    remotes = "origin\n",
    symref = `ref: refs/heads/main\tHEAD\n${REMOTE}\tHEAD\n`,
    behind = "2\n",
    ahead = "0\n",
    fetchResult,
    onFetch,
} = {}) {
    const calls = [];
    const runGit = async (args) => {
        calls.push(args);
        const [command] = args;
        if (command === "rev-parse" && args.includes("HEAD")) {
            return { ok: true, stdout: `${RUNNING}\n`, stderr: "", code: 0 };
        }
        if (command === "remote") return { ok: true, stdout: remotes, stderr: "", code: 0 };
        if (command === "ls-remote") return { ok: true, stdout: symref, stderr: "", code: 0 };
        if (command === "fetch") {
            await onFetch?.();
            return fetchResult ?? { ok: true, stdout: "", stderr: "", code: 0 };
        }
        if (command === "rev-parse") return { ok: true, stdout: `${REMOTE}\n`, stderr: "", code: 0 };
        if (command === "rev-list") {
            const range = args.at(-1);
            return { ok: true, stdout: range.startsWith(`${RUNNING}..`) ? behind : ahead, stderr: "", code: 0 };
        }
        return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}`, code: 1 };
    };
    return { calls, runGit };
}

async function createRepoPair(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-revision-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bare = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const clone = path.join(root, "clone");
    await git(root, ["init", "--bare", "-b", "main", bare]);
    await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(root, ["init", "-b", "main", seed]);
    await commit(seed, "a.txt", "a\n", "A");
    const base = (await git(seed, ["rev-parse", "HEAD"])).stdout.trim();
    await git(seed, ["remote", "add", "origin", bare]);
    await git(seed, ["push", "-u", "origin", "main"]);
    await git(root, ["clone", bare, clone]);
    return { root, bare, seed, clone, base };
}

async function commit(cwd, name, content, message) {
    await fs.writeFile(path.join(cwd, name), content);
    await git(cwd, ["add", name]);
    await git(cwd, ["commit", "-m", message]);
}

async function git(cwd, args) {
    try {
        return await execFileAsync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
    } catch (error) {
        const stderr = error.stderr?.toString?.() ?? "";
        throw new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`);
    }
}
