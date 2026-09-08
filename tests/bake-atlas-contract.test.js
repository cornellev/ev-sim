import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_ATLAS_CONSTRUCTION,
    hashBakeConstruction,
    normalizeBakeConstruction,
} from "../app/3d/environment/visual/BakeConstructionPolicy.js";
import {
    decodeBakeAtlasContribution,
    encodeBakeAtlasContribution,
    hashBakeAtlasContribution,
} from "../app/3d/environment/visual/BakeAtlasContribution.js";
import {
    hashBakeAtlasManifest,
    normalizeBakeAtlasManifest,
    atlasManifestFromConstruction,
} from "../app/3d/environment/visual/BakeAtlasManifest.js";
import {
    hashBakeRunConfig,
    normalizeBakeRunConfig,
} from "../app/3d/environment/visual/BakeRunCatalog.js";
import {
    createDefaultBakeRunConfig,
    createPersistentBakeRunConfig,
} from "../app/3d/environment/visualization/BakeRunConfig.js";
import { normalizeBakeArtifactSet } from "../app/3d/environment/visual/BakeArtifactWriter.js";

const GOLDEN_CONSTRUCTION = "cc46e9d49c6ba0b251cabde37c86d324305c157713dfadba4201b9c852c72ec5";
const GOLDEN_CONTRIBUTION = "56847ad4f9d736310d3b8aa7ab2576eba505cb25698486a1bce69df710698cb0";
const GOLDEN_ATLAS_MANIFEST = "70706eeaea807072089413b5c041585032f382da249e0269e8c5f5cea3a8682b";
const GOLDEN_V1_CONFIG = "182c6e23a34c80387d6508b4bd346c79212287df8e80c09f891d5fed6ed8872d";
const GOLDEN_V2_CONFIG = "95383d0785f794201d273406820e69c1b2eaafe4f64aa5c0289c79ee780bab0d";
const DIGEST = "aa".repeat(32);

function contributionBytes() {
    return encodeBakeAtlasContribution({
        unitId: "capture-unit:path-0:0:bake/view/main",
        constructionHash: GOLDEN_CONSTRUCTION,
        records: [{
            chunkKey: "0,0",
            pageIndex: 0,
            texelX: 2,
            texelY: 3,
            rgba: [255, 16, 32, 255],
            confidence: 1,
            facing: 1,
            distance: 2.5,
            pixelIndex: 4,
            triangleIndex: 0,
        }],
    });
}

function atlasManifestFixture() {
    return atlasManifestFromConstruction(DEFAULT_ATLAS_CONSTRUCTION, [{
        chunkKey: "0,0",
        chartHash: DIGEST,
        outputHash: "bb".repeat(32),
        coverageCount: 1,
        conflictCount: 0,
        pages: [{
            pageIndex: 0,
            width: 512,
            height: 512,
            textureSha256: "cc".repeat(32),
            meshSha256: "dd".repeat(32),
            confidenceSha256: "ee".repeat(32),
            coverageCount: 1,
            conflictCount: 0,
            intrinsic: [],
        }],
    }]);
}

test("bake-contract v1/v2 dispatch preserves v1 bytes and hashes construction", () => {
    const v1 = normalizeBakeRunConfig({ environmentId: "yard", seed: 11, version: 1 });
    const v2 = normalizeBakeRunConfig({
        environmentId: "yard",
        seed: 11,
        version: 2,
        construction: DEFAULT_ATLAS_CONSTRUCTION,
    });
    assert.equal(v1.version, 1);
    assert.equal(v1.construction, undefined);
    assert.equal(v2.version, 2);
    assert.equal(v2.construction.outputMode, "chunk-atlas@1");
    assert.equal(hashBakeRunConfig(v1), GOLDEN_V1_CONFIG);
    assert.equal(hashBakeRunConfig(v2), GOLDEN_V2_CONFIG);
    assert.notEqual(GOLDEN_V1_CONFIG, GOLDEN_V2_CONFIG);
    const persistent = createPersistentBakeRunConfig({ environmentId: "yard", seed: 11 });
    assert.equal(persistent.version, 2);
    assert.equal(persistent.construction.outputMode, "chunk-atlas@1");
    assert.ok(persistent.document().outputRoles.includes("geometric-normal"));
    assert.equal(createDefaultBakeRunConfig({ environmentId: "yard", seed: 11 }).version, 1);
    const v1Doc = createDefaultBakeRunConfig({ environmentId: "yard", seed: 11 }).document();
    assert.throws(
        () => normalizeBakeRunConfig({ ...v1Doc, construction: DEFAULT_ATLAS_CONSTRUCTION }),
        (error) => error.code === "BAKE_CONTRACT_INVALID",
    );
});

test("construction, atlas manifest, and artifact-set v2 reject unknown fields", () => {
    assert.equal(hashBakeConstruction(DEFAULT_ATLAS_CONSTRUCTION), GOLDEN_CONSTRUCTION);
    assert.throws(
        () => normalizeBakeConstruction({ ...DEFAULT_ATLAS_CONSTRUCTION, extra: true }),
        (error) => error.code === "BAKE_CONTRACT_INVALID",
    );
    assert.throws(
        () => normalizeBakeConstruction({
            ...DEFAULT_ATLAS_CONSTRUCTION,
            appearanceMode: "captured-radiance-unlit",
            intrinsicChannels: [{
                name: "albedo",
                units: "srgb",
                encoding: "rgba8",
                confidenceEncoding: "unorm16",
                knownMaskEncoding: "u8",
                declaredDefault: null,
                absentPolicy: "unknown",
            }],
        }),
        (error) => error.code === "BAKE_CONTRACT_INVALID",
    );
    const manifest = atlasManifestFixture();
    assert.equal(hashBakeAtlasManifest(manifest), GOLDEN_ATLAS_MANIFEST);
    assert.throws(
        () => normalizeBakeAtlasManifest({ ...manifest, extra: true }),
        (error) => error.code === "BAKE_ATLAS_INVALID",
    );
    assert.throws(
        () => normalizeBakeArtifactSet({
            kind: "cev-sim.bake-artifact-set",
            version: 2,
            extra: true,
        }),
        (error) => error.code === "BAKE_ARTIFACT_INVALID",
    );
});

test("atlas contributions decode canonically, sort stably, and detect tampering", () => {
    const bytes = contributionBytes();
    assert.equal(hashBakeAtlasContribution(bytes), GOLDEN_CONTRIBUTION);
    const decoded = decodeBakeAtlasContribution(bytes);
    assert.equal(decoded.unitId, "capture-unit:path-0:0:bake/view/main");
    assert.equal(decoded.records.length, 1);
    assert.deepEqual(
        [...encodeBakeAtlasContribution({
            unitId: decoded.unitId,
            constructionHash: decoded.constructionHash,
            records: [...decoded.records].reverse(),
        })],
        [...bytes],
    );
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(
        () => decodeBakeAtlasContribution(tampered),
        (error) => error.code === "BAKE_CONTRIBUTION_INVALID",
    );
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    assert.throws(
        () => decodeBakeAtlasContribution(padded),
        (error) => error.code === "BAKE_CONTRIBUTION_INVALID",
    );
});
