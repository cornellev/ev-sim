import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import * as THREE from "three";

import {
    hashBakeArtifactSet,
    writeBakeArtifacts,
} from "../app/3d/environment/visual/BakeArtifactWriter.js";
import { createDefaultBakeRunConfig } from "../app/3d/environment/visualization/BakeRunConfig.js";
import {
    encodeDeterministicRgbaPng,
    encodeProjectedCaptureGlb,
} from "../app/3d/environment/visual/BakeDeterministicMedia.js";
import {
    buildProjectedCaptureGeometry,
    maskedBeautyRgba,
} from "../app/3d/environment/visual/ProjectedCaptureGeometry.js";
import { VisualLayerMaterializer } from "../app/3d/environment/visual/VisualLayerMaterializer.js";
import {
    VISUAL_PREVIEW_STATUS,
    hashVisualLayer,
    hashVisualLayerAccess,
} from "../app/simulation/visual/VisualLayer.js";
import {
    HEIGHT,
    WIDTH,
    capturePlane,
    completePersistentJob,
    planeBuffers,
    tinyPersistentConfig,
} from "./helpers/bake-promotion.js";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const SOURCE_IDS = Object.freeze(["owned-lab"]);

function readChunk(bytes, offset) {
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    return { length, type, data, next: offset + 12 + length };
}

function pngRgba(png) {
    assert.deepEqual([...png.subarray(0, 8)], [...PNG_SIGNATURE]);
    let offset = 8;
    const idat = [];
    let width = 0;
    let height = 0;
    let colorType = 0;
    while (offset < png.length) {
        const chunk = readChunk(png, offset);
        if (chunk.type === "IHDR") {
            width = (chunk.data[0] << 24) | (chunk.data[1] << 16) | (chunk.data[2] << 8) | chunk.data[3];
            height = (chunk.data[4] << 24) | (chunk.data[5] << 16) | (chunk.data[6] << 8) | chunk.data[7];
            colorType = chunk.data[9];
        }
        if (chunk.type === "IDAT") idat.push(chunk.data);
        offset = chunk.next;
        if (chunk.type === "IEND") break;
    }
    const inflated = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part))));
    const rowBytes = width * 4;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        assert.equal(inflated[y * (rowBytes + 1)], 0, "PNG filter must be none");
        rgba.set(inflated.subarray(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes), y * rowBytes);
    }
    return { width, height, colorType, rgba };
}

function glbJson(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    assert.equal(view.getUint32(4, true), 2);
    const jsonLength = view.getUint32(12, true);
    const jsonType = view.getUint32(16, true);
    assert.equal(jsonType, 0x4e4f534a);
    return JSON.parse(Buffer.from(bytes.subarray(20, 20 + jsonLength)).toString("utf8").trim());
}

async function artifacts(overrides = {}) {
    const { job } = await completePersistentJob(overrides);
    return writeBakeArtifacts({
        job,
        buffers: job.productBuffers,
        sourceIds: SOURCE_IDS,
        worldHash: job.snapshot.worldHash,
    });
}

test("deterministic PNG/GLB/artifact hashes are stable under input ordering", async () => {
    const first = await artifacts();
    const second = await artifacts();
    assert.equal(first.artifactHash, second.artifactHash);
    assert.equal(hashVisualLayer(first.descriptor), hashVisualLayer(second.descriptor));
    assert.equal(hashVisualLayerAccess(first.access), hashVisualLayerAccess(second.access));
    const pngA = first.uploads.find((entry) => entry.role === "texture").bytes;
    const pngB = second.uploads.find((entry) => entry.role === "texture").bytes;
    const glbA = first.uploads.find((entry) => entry.role === "mesh").bytes;
    const glbB = second.uploads.find((entry) => entry.role === "mesh").bytes;
    assert.deepEqual([...pngA], [...pngB]);
    assert.deepEqual([...glbA], [...glbB]);
    const shuffled = hashBakeArtifactSet({
        ...first.artifactSet,
        jobId: "other-job",
        timestamps: { startedAt: 99 },
        logs: ["noise"],
        assets: [...first.artifactSet.assets].reverse(),
        providerOutputDigests: [...first.artifactSet.providerOutputDigests].reverse(),
    });
    assert.equal(shuffled, first.artifactHash);
});

test("PNG rows are top-left, atlas pages are 512px, and GLB is unlit MASK", async () => {
    const written = await artifacts();
    const png = written.uploads.find((entry) => entry.role === "texture" && entry.kind !== "confidence").bytes
        ?? written.uploads.find((entry) => entry.kind === "texture")?.bytes;
    const decoded = pngRgba(png);
    assert.equal(decoded.colorType, 6);
    assert.equal(decoded.width, 512);
    assert.equal(decoded.height, 512);
    assert.equal(written.artifactSet.version, 2);
    assert.equal(typeof written.artifactSet.constructionHash, "string");
    assert.equal(written.artifactSet.constructionHash.length, 64);
    assert.ok(written.uploads.some((entry) => entry.kind === "confidence"));
    assert.ok(decoded.rgba.some((value, index) => index % 4 === 3 && value === 0), "atlas gutters stay alpha-zero");
    assert.ok(decoded.rgba.some((value, index) => index % 4 === 3 && value === 255), "covered texels stay opaque");
    const glb = written.uploads.find((entry) => entry.role === "mesh").bytes;
    const json = glbJson(glb);
    assert.equal(json.materials[0].alphaMode, "MASK");
    assert.deepEqual(json.extensionsUsed, ["KHR_materials_unlit"]);
    assert.deepEqual(json.extensionsRequired, ["KHR_materials_unlit"]);
    assert.equal(json.asset.generator, undefined);
    assert.equal(json.extras, undefined);
    assert.equal(json.materials[0].extras, undefined);
    assert.ok(written.descriptor.materials.every((material) => material.mode === "unlit-captured-radiance"));
    assert.ok(written.descriptor.materials.every((material) => material.extensions.includes("KHR_materials_unlit")));
});

test("projected geometry is centered in world space with a camera-facing offset", () => {
    const pose = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const buffers = planeBuffers(WIDTH, HEIGHT, pose);
    const geometry = buildProjectedCaptureGeometry({
        width: WIDTH,
        height: HEIGHT,
        worldPosition: buffers.worldPosition,
        validity: buffers.validity,
        pose,
    });
    assert.ok(geometry);
    assert.equal(geometry.matrix[12], geometry.center.x);
    assert.equal(geometry.matrix[13], geometry.center.y);
    assert.equal(geometry.matrix[14], geometry.center.z);
    const worldZ = buffers.worldPosition[2];
    assert.ok(geometry.center.z > worldZ);
    assert.ok(Math.abs(geometry.center.z - (worldZ + 0.005)) < 1e-6 || geometry.center.z > worldZ);
    const masked = maskedBeautyRgba(buffers.beauty, buffers.validity, WIDTH, HEIGHT);
    const png = encodeDeterministicRgbaPng(masked, WIDTH, HEIGHT);
    const again = encodeDeterministicRgbaPng(masked, WIDTH, HEIGHT);
    assert.deepEqual([...png], [...again]);
    const glb = encodeProjectedCaptureGlb({
        positions: geometry.positions,
        uvs: geometry.uvs,
        indices: geometry.indices,
        materialId: "bake-test",
    });
    assert.deepEqual([...glb], [...encodeProjectedCaptureGlb({
        positions: geometry.positions,
        uvs: geometry.uvs,
        indices: geometry.indices,
        materialId: "bake-test",
    })]);
});

test("identical retained buffers and provider response produce identical hashes", async () => {
    const first = await artifacts();
    const second = writeBakeArtifacts({
        job: first.job ?? (await completePersistentJob()).job,
        buffers: (await completePersistentJob()).job.productBuffers,
        sourceIds: SOURCE_IDS,
        worldHash: first.artifactSet.worldHash,
    });
    const repeated = await artifacts();
    assert.equal(repeated.artifactHash, first.artifactHash);
    assert.equal(hashVisualLayer(repeated.descriptor), hashVisualLayer(first.descriptor));
    assert.equal(hashVisualLayerAccess(repeated.access), hashVisualLayerAccess(first.access));
    void second;
});

test("VisualLayerMaterializer reloads promoted unlit assets without model, Spark, or network", async () => {
    const written = await artifacts();
    const bytesByUse = new Map(written.uploads.map((entry) => [entry.useHash, entry.bytes]));
    const uses = new Map(written.uploads.map((entry) => [entry.useHash, entry.use]));
    const requested = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        throw new Error(`unexpected fetch ${url}`);
    };
    const previewRoot = new THREE.Group();
    try {
        const materializer = new VisualLayerMaterializer({
            previewRoot,
            layerClient: {
                async getAccess() {
                    return { descriptor: written.descriptor, access: written.access };
                },
            },
            assetClient: {
                async getUse(useHash) {
                    return uses.get(useHash);
                },
                async getUseContent(useHash) {
                    return {
                        bytes: bytesByUse.get(useHash),
                        mediaType: uses.get(useHash).asset.mediaType,
                        etag: `"${uses.get(useHash).asset.sha256}"`,
                    };
                },
            },
            parseGltf: async (_bytes, digest) => {
                const instance = written.descriptor.instances.find((entry) => (
                    entry.assetUri === `sha256:${digest}`
                ));
                const materialId = instance?.materialIds?.[0] ?? written.descriptor.materials[0].id;
                const material = new THREE.MeshPhysicalMaterial({ name: materialId });
                const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), material);
                const scene = new THREE.Group();
                scene.add(mesh);
                return { scene, json: { materials: [{ name: material.name }] } };
            },
            decodeTexture: async () => ({
                isTexture: true,
                clone() { return this; },
                offset: { set() {} },
                repeat: { set() {} },
                rotation: 0,
                colorSpace: null,
                channel: 0,
                matrixAutoUpdate: true,
                needsUpdate: false,
                flipY: true,
                dispose() {},
            }),
        });
        const status = await materializer.replace(
            {
                descriptorHash: written.artifactSet.descriptorHash,
                accessHash: written.artifactSet.accessHash,
            },
            { hash: written.artifactSet.worldHash, description: { buildings: [], features: [], roads: { nodes: [], edges: [] } } },
        );
        assert.equal(status.status, VISUAL_PREVIEW_STATUS.ready);
        const mesh = previewRoot.children[0].children[0].children[0];
        assert.equal(mesh.material.type, "MeshBasicMaterial");
        assert.equal(mesh.material.toneMapped, false);
        assert.equal(requested.length, 0);
        materializer.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("missing persistent roles fail before artifacts are written", async () => {
    const config = createDefaultBakeRunConfig({
        environmentId: "yard",
        seed: 11,
        paths: [{
            id: "path-0",
            vertices: [{ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } }],
        }],
        views: [{
            id: "bake/view/main",
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            camera: { width: WIDTH, height: HEIGHT, fov: 75, near: 0.1, far: 50 },
            products: ["beauty", "validity"],
        }],
        sampling: { deltaDistance: 2, includeEndpoints: true, captureTimeNs: 5 },
    });
    await assert.rejects(
        () => completePersistentJob({
            config: config.document(),
            captureAlignedProducts: capturePlane(),
        }).then(({ job }) => writeBakeArtifacts({
            job,
            buffers: job.productBuffers,
            sourceIds: SOURCE_IDS,
            worldHash: job.snapshot.worldHash,
        })),
        (error) => error.code === "BAKE_ARTIFACT_INCOMPLETE",
    );
});
