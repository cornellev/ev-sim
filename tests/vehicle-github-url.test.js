import assert from "node:assert/strict";
import test from "node:test";

import { githubCredentialIssue, parseGitHubVehicleUrl, splitGitHubRef } from "../app/vehicles/urdf/github/parseGitHubUrl.js";
import { rankUrdfCandidates, selectUrdfCandidate } from "../app/vehicles/urdf/github/rankUrdfCandidates.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function codes(result) {
    return (result.diagnostics ?? []).map((entry) => entry.code);
}

test("VEH-07a accepts repository, tree, blob, and raw GitHub URLs", () => {
    const repository = parseGitHubVehicleUrl("https://github.com/acme/robot.git");
    assert.equal(repository.ok, true);
    assert.equal(repository.url.kind, "repository");
    assert.equal(repository.url.owner, "acme");
    assert.equal(repository.url.repo, "robot");
    assert.equal(repository.url.ref, null);
    assert.equal(repository.url.canonicalUrl, "https://github.com/acme/robot");

    const tree = parseGitHubVehicleUrl("https://www.github.com/acme/robot/tree/main/urdf");
    assert.equal(tree.url.kind, "tree");
    assert.equal(tree.url.refPath, "main/urdf");

    const blob = parseGitHubVehicleUrl("https://github.com/acme/robot/blob/main/urdf/robot.urdf");
    assert.equal(blob.url.kind, "blob");
    assert.equal(blob.url.refPath, "main/urdf/robot.urdf");

    const rawPath = parseGitHubVehicleUrl("https://github.com/acme/robot/raw/main/urdf/robot.urdf");
    assert.equal(rawPath.url.kind, "raw");
    const rawHost = parseGitHubVehicleUrl("https://raw.githubusercontent.com/acme/robot/main/urdf/robot.urdf");
    assert.equal(rawHost.url.kind, "raw");
    assert.equal(rawHost.url.refPath, "main/urdf/robot.urdf");
    assert.equal(rawHost.url.canonicalUrl, "https://raw.githubusercontent.com/acme/robot/main/urdf/robot.urdf");
});

test("VEH-07a rejects credentials, queries, and non-GitHub URLs", () => {
    assert.deepEqual(codes(parseGitHubVehicleUrl("https://user:token@github.com/acme/robot")), ["vehicle.github.credentials"]);
    assert.deepEqual(codes(parseGitHubVehicleUrl("https://github.com/acme/robot?access_token=secret")), ["vehicle.github.credentials"]);
    assert.deepEqual(codes(parseGitHubVehicleUrl("https://github.com/acme/robot#token")), ["vehicle.github.credentials"]);
    assert.deepEqual(codes(parseGitHubVehicleUrl("http://github.com/acme/robot")), ["vehicle.github.unsupported-url"]);
    assert.deepEqual(codes(parseGitHubVehicleUrl("https://gist.github.com/acme/robot")), ["vehicle.github.unsupported-url"]);
    assert.deepEqual(codes(parseGitHubVehicleUrl("https://github.com/acme/robot/issues/1")), ["vehicle.github.unsupported-url"]);
    assert.deepEqual(codes(parseGitHubVehicleUrl("https://github.com/acme/robot/tree/../secret")), ["vehicle.github.unsupported-url"]);
    assert.equal(githubCredentialIssue({ url: "https://github.com/acme/robot", token: "secret" }).code, "vehicle.github.credentials");
});

test("VEH-07a splits the longest ref and prefers a branch over a tag", () => {
    const refs = [
        { name: "main", commitRef: "refs/heads/main" },
        { name: "main", commitRef: "refs/tags/main" },
        { name: "main/feature", commitRef: "refs/heads/main/feature" },
    ];
    const nested = splitGitHubRef("main/feature/urdf/robot.urdf", refs);
    assert.equal(nested.ref, "main/feature");
    assert.equal(nested.commitRef, "refs/heads/main/feature");
    assert.equal(nested.path, "urdf/robot.urdf");

    const sameName = splitGitHubRef("main/robot.urdf", refs);
    assert.equal(sameName.commitRef, "refs/heads/main");
    assert.equal(sameName.path, "robot.urdf");

    const commit = splitGitHubRef(`${COMMIT}/urdf/robot.urdf`, []);
    assert.equal(commit.ref, COMMIT);
    assert.equal(commit.path, "urdf/robot.urdf");
    assert.equal(splitGitHubRef("missing/robot.urdf", refs).error.code, "vehicle.github.unknown-ref");
});

test("VEH-07a ranks conventional URDF paths and requires a selection on a tie", () => {
    const ranked = rankUrdfCandidates([
        "readme.md",
        "robot.xacro",
        "body.urdf",
        "urdf/car.urdf",
        "urdf/van.urdf",
        "robots/other.urdf",
        "nested/description/extra.urdf",
        "pkg/urdf/deep.urdf",
    ]);
    assert.deepEqual(ranked.candidates.map((candidate) => [candidate.path, candidate.reason]), [
        ["pkg/urdf/deep.urdf", "urdf-directory"],
        ["urdf/car.urdf", "urdf-directory"],
        ["urdf/van.urdf", "urdf-directory"],
        ["robots/other.urdf", "robots-directory"],
        ["body.urdf", "prefix-root"],
        ["nested/description/extra.urdf", "other"],
    ]);
    assert.equal(ranked.selectionRequired, true);
    assert.equal(ranked.selected, null);
    assert.equal(selectUrdfCandidate(ranked).diagnostics[0].code, "vehicle.github.selection-required");

    const chosen = selectUrdfCandidate(ranked, "robots/other.urdf");
    assert.equal(chosen.selected, "robots/other.urdf");
    assert.equal(selectUrdfCandidate(ranked, "missing.urdf").diagnostics[0].code, "vehicle.github.unknown-entry");
});

test("VEH-07a names a blob URL instead of searching the repository", () => {
    const entries = ["urdf/better.urdf", "models/body.stl"];
    const named = rankUrdfCandidates(entries, { namedPath: "models/body.urdf" });
    assert.equal(named.selected, "models/body.urdf");
    assert.equal(named.candidates[0].reason, "named");

    const rejected = rankUrdfCandidates(entries, { namedPath: "models/body.stl" });
    assert.equal(rejected.diagnostics[0].code, "vehicle.github.not-urdf");
    assert.equal(rejected.candidates.length, 0);

    const prefixed = rankUrdfCandidates([
        { path: "fleet/urdf/car.urdf", type: "blob" },
        { path: "other/urdf/van.urdf", type: "blob" },
        { path: "fleet/notes.urdf", type: "blob" },
    ], { prefix: "fleet" });
    assert.deepEqual(prefixed.candidates.map((candidate) => candidate.path), ["fleet/urdf/car.urdf", "fleet/notes.urdf"]);
    assert.equal(prefixed.selected, "fleet/urdf/car.urdf");
    assert.equal(prefixed.selectionRequired, false);
});
