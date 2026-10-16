import assert from "node:assert/strict";
import test from "node:test";

import { parseGitHubVehicleUrl } from "../app/vehicles/urdf/github/parseGitHubUrl.js";
import { GitHubUrdfClient } from "../server/vehicles/GitHubUrdfClient.js";
import { createGitHubFixture, GITHUB_COMMIT_SHA, GITHUB_TREE_SHA } from "./helpers/github-urdf-fixtures.js";

function parsed(url) {
    const result = parseGitHubVehicleUrl(url);
    assert.equal(result.ok, true, result.diagnostics[0]?.message);
    return result.url;
}

function urls(calls) {
    return calls.map((call) => call.url);
}

test("VEH-07b keeps the commit SHA distinct from the tree SHA", async () => {
    const fixture = createGitHubFixture({ files: { "urdf/robot.urdf": "<robot/>" } });
    const client = new GitHubUrdfClient({ fetchImpl: fixture.fetchImpl });
    const pin = await client.pin(parsed(`https://github.com/acme/robot/blob/${GITHUB_COMMIT_SHA}/urdf/robot.urdf`));
    assert.equal(pin.commitSha, GITHUB_COMMIT_SHA);
    assert.equal(pin.treeSha, GITHUB_TREE_SHA);
    assert.notEqual(pin.commitSha, pin.treeSha);
    assert.equal(pin.requestedRef, GITHUB_COMMIT_SHA);
    assert.equal(pin.path, "urdf/robot.urdf");
    assert.equal(urls(fixture.calls).some((url) => url.includes("/git/matching-refs/")), false);
    const call = fixture.calls[0];
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.init.headers.authorization, undefined);
    assert.equal(call.init.headers["User-Agent"], "cev-sim");
});

test("VEH-07b rejects redirects, private repositories, and credentials before reuse", async () => {
    const redirected = createGitHubFixture({ redirect: "https://evil.example/repo" });
    const redirectClient = new GitHubUrdfClient({ fetchImpl: redirected.fetchImpl });
    await assert.rejects(
        () => redirectClient.pin(parsed("https://github.com/acme/robot")),
        (error) => error.code === "vehicle.github.redirect",
    );

    const missing = createGitHubFixture({ isPrivate: true });
    const privateClient = new GitHubUrdfClient({ fetchImpl: missing.fetchImpl });
    await assert.rejects(
        () => privateClient.pin(parsed("https://github.com/acme/robot")),
        (error) => error.code === "vehicle.github.private" && error.message === "The repository is not a public GitHub repository." && !/exist/iu.test(error.message),
    );
});

test("VEH-07b rejects symlinks, submodules, LFS pointers, and oversized blobs", async () => {
    const lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n";
    const fixture = createGitHubFixture({
        files: {
            "link.stl": "elsewhere",
            "vendor/wheel.stl": "",
            "body.stl": lfs,
            "mismatch.stl": "abcd",
            "huge.stl": "x",
        },
        modes: { "link.stl": "120000", "vendor/wheel.stl": "160000" },
        types: { "vendor/wheel.stl": "commit" },
        sizes: { "mismatch.stl": 1, "huge.stl": (64 * 1024 * 1024) + 1 },
    });
    const client = new GitHubUrdfClient({ fetchImpl: fixture.fetchImpl });
    const pin = await client.pin(parsed("https://github.com/acme/robot"));
    const tree = await client.tree(pin);
    const blobCount = () => urls(fixture.calls).filter((url) => url.includes("/git/blobs/")).length;

    await assert.rejects(() => client.blob(pin, tree.entries.get("link.stl")), (error) => error.code === "vehicle.github.symlink");
    await assert.rejects(() => client.blob(pin, tree.entries.get("vendor/wheel.stl")), (error) => error.code === "vehicle.github.submodule");
    await assert.rejects(() => client.blob(pin, tree.entries.get("huge.stl")), (error) => error.code === "vehicle.github.file-bytes");
    assert.equal(blobCount(), 0);

    await assert.rejects(() => client.blob(pin, tree.entries.get("body.stl")), (error) => error.code === "vehicle.github.lfs");
    await assert.rejects(() => client.blob(pin, tree.entries.get("mismatch.stl")), (error) => error.code === "vehicle.github.size-mismatch");
});

test("VEH-07b stops on a rate limit and reuses a cached tree", async () => {
    const limited = createGitHubFixture({
        rateLimit: { limit: 60, remaining: 0, reset: 1_700_000_000, resource: "core" },
        repoStatus: 403,
    });
    const limitedClient = new GitHubUrdfClient({ fetchImpl: limited.fetchImpl });
    await assert.rejects(
        () => limitedClient.pin(parsed("https://github.com/acme/robot")),
        (error) => error.code === "vehicle.github.rate-limit" && error.message.includes("2023-11-14T22:13:20.000Z"),
    );

    const fixture = createGitHubFixture({ files: { "robot.urdf": "<robot/>" } });
    const client = new GitHubUrdfClient({ fetchImpl: fixture.fetchImpl });
    const pin = await client.pin(parsed("https://github.com/acme/robot"));
    await client.tree(pin);
    await client.tree(pin);
    assert.equal(urls(fixture.calls).filter((url) => url.includes("/git/trees/")).length, 1);

    const spent = createGitHubFixture({
        files: { "robot.urdf": "<robot/>" },
        rateLimit: { limit: 60, remaining: 0, reset: 1_700_000_000, resource: "core" },
    });
    const spentClient = new GitHubUrdfClient({ fetchImpl: spent.fetchImpl });
    await assert.rejects(
        () => spentClient.pin(parsed("https://github.com/acme/robot")),
        (error) => error.code === "vehicle.github.rate-limit",
    );
    assert.equal(spent.calls.length, 1);
});

test("VEH-07b cancels a request that is already aborted and enforces the deadline", async () => {
    const aborted = createGitHubFixture();
    const signal = AbortSignal.abort();
    const client = new GitHubUrdfClient({ fetchImpl: aborted.fetchImpl, signal });
    await assert.rejects(
        () => client.pin(parsed("https://github.com/acme/robot")),
        (error) => error.code === "vehicle.github.cancelled",
    );
    assert.equal(aborted.calls.length, 0);

    const expired = createGitHubFixture();
    const deadline = new GitHubUrdfClient({
        fetchImpl: expired.fetchImpl,
        limits: { deadlineMs: 0 },
    });
    await assert.rejects(
        () => deadline.pin(parsed("https://github.com/acme/robot")),
        (error) => error.code === "vehicle.github.deadline",
    );
    assert.equal(expired.calls.length, 0);
});

test("VEH-07b keeps at most four blob reads in flight", async () => {
    const files = Object.fromEntries([1, 2, 3, 4, 5].map((index) => [`part-${index}.stl`, `solid ${index}`]));
    let active = 0;
    let maxActive = 0;
    const fixture = createGitHubFixture({ files });
    const fetchImpl = async (url, init) => {
        if (url.includes("/git/blobs/")) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
        }
        return fixture.fetchImpl(url, init);
    };
    const client = new GitHubUrdfClient({ fetchImpl });
    const pin = await client.pin(parsed("https://github.com/acme/robot"));
    const tree = await client.tree(pin);
    await Promise.all([...tree.entries.values()].filter((entry) => entry.type === "blob").map((entry) => client.blob(pin, entry)));
    assert.equal(maxActive <= 4, true);
    assert.equal(maxActive >= 2, true);
});
