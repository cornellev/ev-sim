import assert from "node:assert/strict";
import test from "node:test";

import { resolveDependencyDag } from "../server/marketplace/client/MarketplaceDependencyResolver.js";

const digest = (value) => value.repeat(64).slice(0, 64);

function release(itemId, dependencies = [], sha256 = digest(itemId.slice(-1))) {
    return {
        itemId,
        releaseVersion: "1.0.0",
        artifact: { sha256 },
        dependencies,
    };
}

function reference(value) {
    return { itemId: value.itemId, releaseVersion: value.releaseVersion, artifactSha256: value.artifact.sha256 };
}

test("MKT-07 dependency resolution is exact, deduplicated, dependency-first, and UTF-8 stable", () => {
    const leafA = release("a", [], digest("a"));
    const leafB = release("b", [], digest("b"));
    const middle = release("middle", [reference(leafB), reference(leafA)], digest("c"));
    const root = release("root", [reference(middle), reference(leafA)], digest("d"));
    const result = resolveDependencyDag({
        rootRelease: reference(root),
        catalog: { yanks: [{ release: reference(leafB) }] },
        releases: [root, middle, leafB, leafA],
    });
    assert.deepEqual(result.releases.map((entry) => entry.itemId), ["a", "b", "middle", "root"]);
    assert.deepEqual(result.warnings, ["Exact release b@1.0.0 is yanked."]);

    const aLeaf = release("a-leaf", [], digest("e"));
    const yLeaf = release("y-leaf", [], digest("f"));
    const bParent = release("b-parent", [reference(yLeaf)], digest("1"));
    const zParent = release("z-parent", [reference(aLeaf)], digest("2"));
    const globalRoot = release("global-root", [reference(zParent), reference(bParent)], digest("3"));
    const globallyOrdered = resolveDependencyDag({
        rootRelease: reference(globalRoot),
        catalog: { yanks: [] },
        releases: [globalRoot, zParent, bParent, yLeaf, aLeaf],
    });
    assert.deepEqual(
        globallyOrdered.releases.map((entry) => entry.itemId),
        ["a-leaf", "y-leaf", "b-parent", "z-parent", "global-root"],
    );
});

test("MKT-07 dependency resolution rejects mismatches, deterministic cycles, and policy blocks before download", () => {
    const leaf = release("leaf", [], digest("a"));
    const root = release("root", [{ ...reference(leaf), artifactSha256: digest("f") }], digest("b"));
    assert.throws(() => resolveDependencyDag({
        rootRelease: reference(root), catalog: { yanks: [] }, releases: [root, leaf],
    }), /missing or has a different artifact digest/u);

    const first = release("first", [], digest("c"));
    const second = release("second", [reference(first)], digest("d"));
    first.dependencies = [reference(second)];
    assert.throws(() => resolveDependencyDag({
        rootRelease: reference(first), catalog: { yanks: [] }, releases: [first, second],
    }), /first@1\.0\.0 -> second@1\.0\.0 -> first@1\.0\.0/u);

    assert.throws(() => resolveDependencyDag({
        rootRelease: reference(leaf),
        catalog: { yanks: [] },
        releases: [leaf],
        releasePolicy: () => ({ blocked: true, warnings: [] }),
    }), (error) => error.code === "RELEASE_BLOCKED");
});
