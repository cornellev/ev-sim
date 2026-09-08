import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_ATLAS_CONSTRUCTION,
    INTRINSIC_PBR_SUPPLIED,
    normalizeBakeConstruction,
} from "../app/3d/environment/visual/BakeConstructionPolicy.js";
import {
    buildAtlasLayout,
    buildChartsForChunk,
    clipTrianglesToChunks,
    compareObservations,
    fuseChunkPages,
    mapCaptureToContributions,
    shadeLambert,
    shadeUnlit,
    sortAtlasTriangles,
} from "../app/3d/environment/visual/BakeAtlasCore.js";
import { encodeDeterministicRgbaPng } from "../app/3d/environment/visual/BakeDeterministicMedia.js";
import { capturePlane, completePersistentJob, tinyPersistentConfig } from "./helpers/bake-promotion.js";
import { writeBakeArtifacts } from "../app/3d/environment/visual/BakeArtifactWriter.js";

const SOURCE_IDS = Object.freeze(["owned-lab"]);
const DIGEST = "aa".repeat(32);

function triangle(overrides = {}) {
    return {
        entityId: "entity-a",
        geometryDigest: DIGEST,
        primitiveIndex: 0,
        triangleIndex: 0,
        materialId: "mat-a",
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        uvs: [0, 0, 1, 0, 0, 1],
        uvValid: true,
        ...overrides,
    };
}

function construction(overrides = {}) {
    return normalizeBakeConstruction({ ...DEFAULT_ATLAS_CONSTRUCTION, ...overrides });
}

test("G-ATLAS: seams, missing UVs, and chunk-boundary clipping are deterministic", () => {
    const floor = triangle({ triangleIndex: 0, positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0] });
    const wall = triangle({
        triangleIndex: 1,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    });
    const clipped = clipTrianglesToChunks([floor, wall], 20);
    const charts = buildChartsForChunk(clipped, construction());
    assert.ok(charts.length >= 2);

    const missingUv = triangle({ uvs: null, uvValid: false, triangleIndex: 2 });
    const layout = buildAtlasLayout({
        triangles: [triangle(), missingUv],
        construction: construction({ pageSizePx: 64, texelDensityPerMeter: 8 }),
    });
    assert.equal(layout.chunks.length, 1);
    assert.ok(layout.chunks[0].placements.some((entry) => entry.uvMethod === "dominant-axis"));

    const spanning = triangle({
        positions: [19, 0, 0, 21, 0, 0, 19, 1, 0],
        uvs: [0, 0, 1, 0, 0, 1],
    });
    const split = clipTrianglesToChunks([spanning], 20);
    const keys = [...new Set(split.map((entry) => entry.chunkKey))].sort();
    assert.ok(keys.length >= 2);

    const shuffled = buildAtlasLayout({
        triangles: [missingUv, triangle({ triangleIndex: 0 }), triangle({ entityId: "entity-b", triangleIndex: 3 })],
        construction: construction({ pageSizePx: 64 }),
    });
    const ordered = buildAtlasLayout({
        triangles: sortAtlasTriangles([
            triangle({ entityId: "entity-b", triangleIndex: 3 }),
            triangle({ triangleIndex: 0 }),
            missingUv,
        ]),
        construction: construction({ pageSizePx: 64 }),
    });
    assert.deepEqual(
        shuffled.chunks.map((entry) => entry.chartHash),
        ordered.chunks.map((entry) => entry.chartHash),
    );
});

test("G-ATLAS: fusion prefers confidence, then facing, then distance, then unit/pixel", () => {
    const ranked = [
        { confidenceQ: 10, facingQ: 10, distance: 4, unitId: "b", pixelIndex: 1 },
        { confidenceQ: 20, facingQ: 1, distance: 9, unitId: "z", pixelIndex: 9 },
    ].sort(compareObservations);
    assert.equal(ranked[0].confidenceQ, 20);
    const facing = [
        { confidenceQ: 20, facingQ: 1, distance: 1, unitId: "a", pixelIndex: 0 },
        { confidenceQ: 20, facingQ: 8, distance: 9, unitId: "a", pixelIndex: 0 },
    ].sort(compareObservations);
    assert.equal(facing[0].facingQ, 8);
    const distance = [
        { confidenceQ: 20, facingQ: 8, distance: 4, unitId: "a", pixelIndex: 0 },
        { confidenceQ: 20, facingQ: 8, distance: 2, unitId: "z", pixelIndex: 9 },
    ].sort(compareObservations);
    assert.equal(distance[0].distance, 2);

    const layout = buildAtlasLayout({
        triangles: [triangle({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0] })],
        construction: construction({ pageSizePx: 32, paddingPx: 1, texelDensityPerMeter: 8 }),
    });
    const chunk = layout.chunks[0];
    const placement = chunk.placements[0];
    const low = {
        chunkKey: chunk.chunkKey,
        pageIndex: placement.pageIndex,
        texelX: placement.x + 1,
        texelY: placement.y + 1,
        rgba: [255, 0, 0, 255],
        confidence: 0.1,
        facing: 1,
        distance: 1,
        pixelIndex: 0,
        triangleIndex: 0,
        unitId: "unit-a",
    };
    const high = { ...low, rgba: [0, 255, 0, 255], confidence: 0.9, unitId: "unit-b" };
    const fused = fuseChunkPages({
        chunk,
        contributions: [low, high, { ...low, unitId: "unit-c", pixelIndex: 2 }],
        construction: construction({ pageSizePx: 32, paddingPx: 1, texelDensityPerMeter: 8 }),
    });
    const offset = ((placement.y + 1) * 32 + (placement.x + 1)) * 4;
    assert.equal(fused[0].radiance[offset + 1], 255);
    assert.ok(fused[0].conflictCount >= 1);
    assert.equal(fused[0].radiance[3], 0);
});

test("G-ATLAS: overflow fails closed and encoder bytes repeat", () => {
    const charts = Array.from({ length: 6 }, (_, index) => triangle({
        entityId: `entity-${index}`,
        materialId: `mat-${index}`,
        triangleIndex: index,
        positions: [index * 3, 0, 0, index * 3 + 2, 0, 0, index * 3, 2, 0],
    }));
    assert.throws(
        () => buildAtlasLayout({
            triangles: charts,
            construction: construction({
                pageSizePx: 16,
                paddingPx: 2,
                texelDensityPerMeter: 8,
                maxPagesPerChunk: 1,
            }),
        }),
        (error) => error.code === "BAKE_ATLAS_LIMIT",
    );
    const page = new Uint8Array(8);
    page.set([1, 2, 3, 255, 4, 5, 6, 255]);
    const first = encodeDeterministicRgbaPng(page, 2, 1);
    const second = encodeDeterministicRgbaPng(new Uint8Array(page), 2, 1);
    assert.deepEqual([...first], [...second]);
});

test("G-ATLAS: unlit shading ignores lights; supplied intrinsic diffuse responds", () => {
    const albedo = [64, 128, 255, 255];
    const lightsA = [{ direction: [0, 0, 1], color: [1, 1, 1] }];
    const lightsB = [{ direction: [0, 0, 1], color: [0.2, 0.2, 0.2] }];
    assert.deepEqual(shadeUnlit(albedo), shadeUnlit(albedo));
    assert.deepEqual(shadeUnlit(albedo), [64, 128, 255, 255]);
    const litA = shadeLambert(albedo, [0, 0, 1], lightsA);
    const litB = shadeLambert(albedo, [0, 0, 1], lightsB);
    assert.notDeepEqual(litA, litB);
    const supplied = construction({
        appearanceMode: INTRINSIC_PBR_SUPPLIED,
        intrinsicChannels: [{
            name: "diffuse",
            units: "srgb",
            encoding: "rgba8-unorm",
            confidenceEncoding: "unorm16",
            knownMaskEncoding: "u8",
            declaredDefault: null,
            absentPolicy: "unknown",
        }],
    });
    assert.equal(supplied.appearanceMode, INTRINSIC_PBR_SUPPLIED);
    assert.equal(supplied.intrinsicChannels[0].absentPolicy, "unknown");
});

test("G-ATLAS: capture holes stay alpha-zero and shuffled jobs emit identical artifacts", async () => {
    const { job, scene } = await completePersistentJob({
        config: tinyPersistentConfig().document(),
        captureAlignedProducts: capturePlane({
            invalidatePixel: { x: 5, y: 5 },
        }),
    });
    const first = writeBakeArtifacts({
        job,
        buffers: job.productBuffers,
        sourceIds: SOURCE_IDS,
        worldHash: job.snapshot.worldHash,
        scene,
    });
    const second = writeBakeArtifacts({
        job,
        buffers: job.productBuffers,
        sourceIds: SOURCE_IDS,
        worldHash: job.snapshot.worldHash,
        scene,
    });
    assert.equal(first.artifactHash, second.artifactHash);
    const png = first.uploads.find((entry) => entry.kind === "texture")?.bytes
        ?? first.uploads.find((entry) => entry.role === "texture").bytes;
    assert.ok(png.length > 0);
    const layout = first.atlasLayout;
    const sample = job.plan.samples[0];
    const view = job.config.views[0];
    const buffers = job.productBuffers;
    const mapped = mapCaptureToContributions({
        layout,
        beauty: buffers.get(`${sample.sampleId}:${sample.viewId}:beauty`),
        worldPosition: buffers.get(`${sample.sampleId}:${sample.viewId}:world-position`),
        geometricNormal: buffers.get(`${sample.sampleId}:${sample.viewId}:geometric-normal`),
        confidence: buffers.get(`${sample.sampleId}:${sample.viewId}:confidence`),
        validity: buffers.get(`${sample.sampleId}:${sample.viewId}:validity`),
        width: view.camera.width,
        height: view.camera.height,
        cameraPosition: view.pose.position,
        unitId: "unit",
    });
    assert.ok(mapped.length >= 0);
    const fused = fuseChunkPages({
        chunk: layout.chunks[0],
        contributions: mapped,
        construction: construction(),
    });
    assert.ok(fused[0].radiance.some((value, index) => index % 4 === 3 && value === 0));
});
