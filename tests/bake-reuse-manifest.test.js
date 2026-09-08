import assert from "node:assert/strict";
import test from "node:test";

import {
    BAKE_REUSE_MANIFEST_KIND,
    BAKE_REUSE_REPORT_KIND,
    bakeCaptureUnitId,
    bakeGeneratedRecordId,
    hashBakeReuseManifest,
    hashBakeReuseReport,
    isBakeGeneratedId,
    normalizeBakeReuseManifest,
    normalizeBakeReuseReport,
} from "../app/3d/environment/visual/BakeReuseContracts.js";

const DIGEST = "ab".repeat(32);
const UNIT = bakeCaptureUnitId("path-0", 0, "bake/view/main");

function fragment() {
    return {
        materialId: `bake-${"11".repeat(32)}`,
        instanceId: `bake-${"22".repeat(32)}`,
        chunkId: `bake-${"33".repeat(32)}`,
        texture: {
            sha256: "aa".repeat(32),
            mediaType: "image/png",
            sizeBytes: 8,
            useHash: "bb".repeat(32),
            role: "texture",
        },
        mesh: {
            sha256: "cc".repeat(32),
            mediaType: "model/gltf-binary",
            sizeBytes: 16,
            useHash: "dd".repeat(32),
            role: "mesh",
        },
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
}

function manifest(overrides = {}) {
    return {
        kind: BAKE_REUSE_MANIFEST_KIND,
        version: 1,
        sourceWorldHash: DIGEST,
        keyVersion: 1,
        globalKey: DIGEST,
        chunkKeys: [{ chunkKey: "0,0", dependencyKey: DIGEST }],
        units: [{
            unitId: UNIT,
            pathId: "path-0",
            sampleIndex: 0,
            viewId: "bake/view/main",
            dependencyKey: DIGEST,
            chunkKeys: ["0,0"],
            fragments: fragment(),
        }],
        writer: { id: "projected-captured-radiance", version: 1 },
        descriptorHash: DIGEST,
        accessHash: DIGEST,
        ...overrides,
    };
}

test("bake reuse manifests reject unknown fields and hash canonically", () => {
    const normalized = normalizeBakeReuseManifest(manifest());
    assert.equal(normalized.units[0].unitId, UNIT);
    assert.equal(hashBakeReuseManifest(normalized).length, 64);
    assert.equal(hashBakeReuseManifest(normalized), hashBakeReuseManifest({ ...normalized }));
    assert.throws(
        () => normalizeBakeReuseManifest(manifest({ extra: true })),
        (error) => error.code === "BAKE_REUSE_INVALID",
    );
    assert.throws(
        () => normalizeBakeReuseManifest(manifest({
            units: [{
                unitId: "capture-unit:other:0:bake/view/main",
                pathId: "path-0",
                sampleIndex: 0,
                viewId: "bake/view/main",
                dependencyKey: DIGEST,
                chunkKeys: [],
                fragments: fragment(),
            }],
        })),
        (error) => error.code === "BAKE_REUSE_INVALID",
    );
});

test("generated bake record IDs are digest-addressed and reports stay out of identity hashing", () => {
    const id = bakeGeneratedRecordId(UNIT, DIGEST, "material");
    assert.equal(isBakeGeneratedId(id), true);
    assert.equal(id, bakeGeneratedRecordId(UNIT, DIGEST, "material"));
    assert.notEqual(id, bakeGeneratedRecordId(UNIT, DIGEST, "mesh"));
    const report = normalizeBakeReuseReport({
        kind: BAKE_REUSE_REPORT_KIND,
        version: 1,
        sourceWorldHash: DIGEST,
        previousManifestHash: null,
        mode: "noop",
        reused: [{ unitId: UNIT, reason: "keys-unchanged" }],
        invalidated: [],
        removed: [],
        captured: [],
        uploaded: [],
        globalReasons: [],
    });
    assert.equal(hashBakeReuseReport(report).length, 64);
    assert.throws(
        () => normalizeBakeReuseReport({ ...report, mode: "skip" }),
        (error) => error.code === "BAKE_REUSE_INVALID",
    );
});

test("bake reuse manifest v2 binds contributions and chunk hashes", () => {
    const contribution = {
        sha256: "11".repeat(32),
        mediaType: "application/octet-stream",
        sizeBytes: 64,
        useHash: "22".repeat(32),
        role: "buffer",
    };
    const page = {
        pageIndex: 0,
        texture: {
            sha256: "33".repeat(32),
            mediaType: "image/png",
            sizeBytes: 8,
            useHash: "44".repeat(32),
            role: "texture",
        },
        mesh: {
            sha256: "55".repeat(32),
            mediaType: "model/gltf-binary",
            sizeBytes: 16,
            useHash: "66".repeat(32),
            role: "mesh",
        },
        confidence: {
            sha256: "77".repeat(32),
            mediaType: "image/png",
            sizeBytes: 8,
            useHash: "88".repeat(32),
            role: "texture",
        },
    };
    const v2 = normalizeBakeReuseManifest({
        kind: BAKE_REUSE_MANIFEST_KIND,
        version: 2,
        sourceWorldHash: DIGEST,
        keyVersion: 1,
        globalKey: DIGEST,
        chunkKeys: [{ chunkKey: "0,0", dependencyKey: DIGEST }],
        units: [{
            unitId: UNIT,
            pathId: "path-0",
            sampleIndex: 0,
            viewId: "bake/view/main",
            dependencyKey: DIGEST,
            chunkKeys: ["0,0"],
            contribution,
        }],
        chunks: [{
            chunkKey: "0,0",
            dependencyKey: DIGEST,
            chartHash: DIGEST,
            outputHash: DIGEST,
            pages: [page],
        }],
        writer: { id: "chunk-atlas", version: 1, constructionHash: DIGEST },
        descriptorHash: DIGEST,
        accessHash: DIGEST,
        constructionHash: DIGEST,
        atlasManifestDigest: DIGEST,
    });
    assert.equal(v2.version, 2);
    assert.equal(v2.units[0].contribution.sha256, contribution.sha256);
    assert.equal(hashBakeReuseManifest(v2), hashBakeReuseManifest({ ...v2 }));
    assert.throws(
        () => normalizeBakeReuseManifest({ ...v2, extra: true }),
        (error) => error.code === "BAKE_REUSE_INVALID",
    );
    assert.throws(
        () => normalizeBakeReuseManifest({ ...v2, units: [{ ...v2.units[0], fragments: fragment() }] }),
        (error) => error.code === "BAKE_REUSE_INVALID",
    );
});
