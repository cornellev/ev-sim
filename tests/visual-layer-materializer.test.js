import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { StorageRequestError } from "../app/client/storageClient.js";
import { VisualLayerMaterializer } from "../app/3d/environment/visual/VisualLayerMaterializer.js";
import { createDigestUrlModifier } from "../app/3d/environment/visual/VisualGltfUriGuard.js";
import {
    VISUAL_PREVIEW_ERROR_CODES,
    VISUAL_PREVIEW_STATUS,
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualAssetUse,
    normalizeVisualLayer,
    normalizeVisualLayerAccess,
    sha256ExactBytes,
} from "../app/simulation/visual/VisualLayer.js";
import {
    makeJpeg,
    makeKtx2,
    makeNamedMaterialGlb,
    makePng,
    makeTriangleGltfWithBuffer,
    sha256Hex,
} from "./helpers/visual-assets.js";

const WORLD_HASH = "c".repeat(64);
const MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10.123456789, 0, -2.5, 1]);

function worldResource(hash = WORLD_HASH) {
    return {
        hash,
        description: {
            buildings: [{ id: "building-0" }],
            features: [],
            roads: { nodes: [{ id: "n0" }, { id: "n1" }], edges: [{ id: "e0" }] },
        },
    };
}

function recordedUse(asset, bytes, dependencies = {}) {
    const use = normalizeVisualAssetUse({
        kind: "cev-sim.visual-asset-use",
        version: 1,
        asset,
        sourceIds: ["owned-lab"],
        dependencies,
    });
    return { use, useHash: hashVisualAssetUse(use), bytes };
}

function layerDocuments({
    meshBytes,
    meshType = "model/gltf-binary",
    textures = [],
    lodBytes = null,
    materialMode = "metallic-roughness",
    extensions = ["KHR_materials_clearcoat"],
} = {}) {
    const meshDigest = sha256Hex(meshBytes);
    const assets = [
        { sha256: meshDigest, mediaType: meshType, sizeBytes: meshBytes.length, role: "mesh" },
        ...textures.map((texture) => texture.asset),
    ];
    const lodDigest = lodBytes ? sha256Hex(lodBytes) : null;
    if (lodDigest) {
        assets.push({
            sha256: lodDigest,
            mediaType: "model/gltf-binary",
            sizeBytes: lodBytes.length,
            role: "mesh",
        });
    }
    const descriptor = normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: WORLD_HASH,
        assetProfile: { id: "static-gltf-surface", version: 1 },
        assets,
        materials: [{
            id: "brick",
            mode: materialMode,
            parameters: { baseColorFactor: [0.2, 0.4, 0.6, 1], clearcoatFactor: 0.25 },
            textures: textures.map((texture) => ({
                slot: texture.slot,
                assetUri: `sha256:${texture.asset.sha256}`,
                transform: texture.transform ?? { offset: [0.125, 0], scale: [2, 2], rotation: 0.5 },
            })),
            extensions,
        }],
        chunks: [{
            id: "chunk-0",
            instanceIds: ["building-0"],
            dependencyUris: [`sha256:${meshDigest}`],
        }],
        instances: [{
            id: "building-0",
            assetUri: `sha256:${meshDigest}`,
            lodLevels: lodDigest ? [`sha256:${meshDigest}`, `sha256:${lodDigest}`] : [`sha256:${meshDigest}`],
            matrix: [...MATRIX],
            chunkIds: ["chunk-0"],
            materialIds: ["brick"],
        }],
        bindings: [{ id: "binding-0", instanceId: "building-0", truthEntityId: "building-0" }],
        appearanceDependencies: [],
    });
    const uses = new Map();
    const bytesByUse = new Map();
    const meshDependencies = {};
    for (const texture of textures) {
        uses.set(texture.useHash, texture.use);
        bytesByUse.set(texture.useHash, texture.bytes);
        meshDependencies[`sha256:${texture.asset.sha256}`] = texture.useHash;
    }
    const meshRecord = recordedUse(
        descriptor.assets.find((entry) => entry.sha256 === meshDigest),
        meshBytes,
        meshDependencies,
    );
    uses.set(meshRecord.useHash, meshRecord.use);
    bytesByUse.set(meshRecord.useHash, meshRecord.bytes);
    if (lodDigest) {
        const lodRecord = recordedUse(
            descriptor.assets.find((entry) => entry.sha256 === lodDigest),
            lodBytes,
        );
        uses.set(lodRecord.useHash, lodRecord.use);
        bytesByUse.set(lodRecord.useHash, lodRecord.bytes);
    }
    const access = normalizeVisualLayerAccess({
        kind: "cev-sim.visual-layer-access",
        version: 1,
        descriptorHash: hashVisualLayer(descriptor),
        assets: descriptor.assets.map((asset) => ({
            sha256: asset.sha256,
            useHash: [...uses.entries()].find(([, use]) => use.asset.sha256 === asset.sha256)[0],
        })),
    });
    return { descriptor, access, uses, bytesByUse, meshDigest, lodDigest };
}

function clientsFor(documents, faults = {}) {
    let accessCalls = 0;
    return {
        layerClient: {
            async getAccess() {
                accessCalls += 1;
                if (faults.access) throw faults.access;
                if (accessCalls === 1 && faults.firstAccess) await faults.firstAccess();
                return {
                    descriptor: faults.descriptor ?? documents.descriptor,
                    access: faults.accessDoc ?? documents.access,
                };
            },
        },
        assetClient: {
            async getUse(useHash) {
                const use = documents.uses.get(useHash);
                if (!use) {
                    throw new StorageRequestError("missing use", {
                        status: 404,
                        code: "VISUAL_ASSET_USE_NOT_FOUND",
                    });
                }
                return use;
            },
            async getUseContent(useHash) {
                if (faults.content) throw faults.content;
                const use = documents.uses.get(useHash);
                const bytes = faults.bytes?.[useHash] ?? documents.bytesByUse.get(useHash);
                return {
                    bytes,
                    mediaType: faults.mediaType ?? use.asset.mediaType,
                    etag: `"${faults.etag ?? use.asset.sha256}"`,
                };
            },
        },
    };
}

function fakeTexture() {
    return {
        isTexture: true,
        clone() { return fakeTexture(); },
        offset: { set() {} },
        repeat: { set() {} },
        rotation: 0,
        colorSpace: null,
        channel: 0,
        matrixAutoUpdate: true,
        needsUpdate: false,
        dispose() { this.disposed = true; },
    };
}

function parseNamedScene(materialName = "brick") {
    const parsed = [];
    return {
        parsed,
        parseGltf: async (_bytes, digest) => {
            parsed.push(digest);
            const material = new THREE.MeshPhysicalMaterial({ name: materialName });
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), material);
            mesh.userData = {
                buildingId: "forged-building",
                perceptionSourceId: "forged",
                extras: { nested: true },
            };
            const scene = new THREE.Group();
            scene.add(mesh);
            return {
                scene,
                json: {
                    materials: [{ name: materialName }],
                    meshes: [{ primitives: [{ material: 0 }] }],
                },
            };
        },
    };
}

function createMaterializer(documents, options = {}) {
    const previewRoot = new THREE.Group();
    const parser = options.parseGltf ? { parsed: [], parseGltf: options.parseGltf } : parseNamedScene();
    const materializer = new VisualLayerMaterializer({
        previewRoot,
        THREE,
        KTX2Loader: null,
        parseGltf: parser.parseGltf,
        decodeTexture: options.decodeTexture ?? (async () => fakeTexture()),
        ...clientsFor(documents, options.faults),
    });
    return { materializer, previewRoot, parsed: parser.parsed };
}

function referenceFor(documents) {
    return {
        descriptorHash: hashVisualLayer(documents.descriptor),
        accessHash: hashVisualLayerAccess(documents.access),
    };
}

function textureRecord(bytes, mediaType, slot = "baseColor") {
    const asset = {
        sha256: sha256Hex(bytes),
        mediaType,
        sizeBytes: bytes.length,
        role: "texture",
    };
    return { ...recordedUse(asset, bytes), asset, slot };
}

test("glTF URI guard rejects relative, network, file, and unknown URIs before a request", () => {
    const requested = [];
    const modifier = createDigestUrlModifier(new Map([
        ["a".repeat(64), { objectUrl: "blob:allowed" }],
    ]));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        throw new Error("network");
    };
    try {
        for (const uri of ["http://evil.example/mesh.bin", "file:///tmp/mesh.bin", "../mesh.bin", "mesh.bin", "C:\\mesh.bin"]) {
            assert.throws(() => modifier(uri), (error) => error.code === VISUAL_PREVIEW_ERROR_CODES.URI_REJECTED);
        }
        assert.equal(modifier("blob:allowed"), "blob:allowed");
        assert.equal(modifier(`sha256:${"a".repeat(64)}`), "blob:allowed");
        assert.equal(requested.length, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("materializer applies descriptor materials, exact matrices, unlit output, and top LOD only", async () => {
    const meshBytes = makeNamedMaterialGlb("brick");
    const lodBytes = makeNamedMaterialGlb("brick", { extras: { lod: true } });
    const decoded = [];
    const documents = layerDocuments({
        meshBytes,
        lodBytes,
        textures: [textureRecord(makePng(), "image/png")],
        materialMode: "unlit-captured-radiance",
        extensions: ["KHR_materials_unlit", "KHR_texture_transform"],
    });
    const { materializer, previewRoot, parsed } = createMaterializer(documents, {
        decodeTexture: async (bytes, mediaType, slot) => {
            decoded.push({ mediaType, slot, digest: sha256ExactBytes(bytes) });
            return fakeTexture();
        },
    });
    const status = await materializer.replace(referenceFor(documents), worldResource());
    assert.equal(status.status, VISUAL_PREVIEW_STATUS.ready);
    assert.equal(previewRoot.children.length, 1);
    assert.deepEqual(parsed, [documents.meshDigest]);
    const root = previewRoot.children[0].children[0];
    assert.deepEqual(
        [...root.matrix.elements],
        [...new THREE.Matrix4().fromArray(MATRIX).elements],
    );
    const mesh = root.children[0];
    assert.equal(mesh.material.type, "MeshBasicMaterial");
    assert.equal(mesh.userData.buildingId, undefined);
    assert.equal(mesh.userData.perceptionSourceId, undefined);
    assert.equal(mesh.userData.truthEntityId, undefined);
    assert.equal(mesh.userData.cevSimVisualPreviewOnly, true);
    assert.equal(mesh.userData.cevSimVisualInstanceId, "building-0");
    assert.equal(materializer.visualBindings().get("building-0").truthEntityId, "building-0");
    assert.deepEqual(decoded.map((entry) => entry.mediaType), ["image/png"]);
    materializer.dispose();
    materializer.dispose();
});

test("PNG, JPEG, and KTX2 textures decode through selected use hashes", async () => {
    const meshBytes = makeNamedMaterialGlb("brick");
    for (const [bytes, mediaType] of [
        [makePng(), "image/png"],
        [makeJpeg(), "image/jpeg"],
        [makeKtx2(), "image/ktx2"],
    ]) {
        const documents = layerDocuments({
            meshBytes,
            textures: [textureRecord(bytes, mediaType)],
            extensions: mediaType === "image/ktx2"
                ? ["KHR_texture_basisu", "KHR_texture_transform"]
                : ["KHR_texture_transform"],
        });
        const decoded = [];
        const { materializer } = createMaterializer(documents, {
            decodeTexture: async (_bytes, type) => {
                decoded.push(type);
                return fakeTexture();
            },
        });
        const status = await materializer.replace(referenceFor(documents), worldResource());
        assert.equal(status.status, VISUAL_PREVIEW_STATUS.ready, mediaType);
        assert.deepEqual(decoded, [mediaType]);
        materializer.dispose();
    }
});

test("external digest-addressed buffers are fetched through selected use hashes", async () => {
    const positions = Buffer.alloc(42);
    const bufferDigest = sha256Hex(positions);
    const gltf = makeTriangleGltfWithBuffer(bufferDigest);
    const buffer = recordedUse({
        sha256: bufferDigest,
        mediaType: "application/octet-stream",
        sizeBytes: positions.length,
        role: "buffer",
    }, positions);
    const meshDigest = sha256Hex(gltf);
    const meshRecord = recordedUse({
        sha256: meshDigest,
        mediaType: "model/gltf+json",
        sizeBytes: gltf.length,
        role: "mesh",
    }, gltf, { [`sha256:${bufferDigest}`]: buffer.useHash });
    const descriptor = normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: WORLD_HASH,
        assetProfile: { id: "static-gltf-surface", version: 1 },
        assets: [meshRecord.use.asset, buffer.use.asset],
        materials: [{
            id: "brick",
            mode: "metallic-roughness",
            parameters: {},
            textures: [],
            extensions: [],
        }],
        chunks: [{
            id: "chunk-0",
            instanceIds: ["building-0"],
            dependencyUris: [`sha256:${meshDigest}`],
        }],
        instances: [{
            id: "building-0",
            assetUri: `sha256:${meshDigest}`,
            lodLevels: [`sha256:${meshDigest}`],
            matrix: [...MATRIX],
            chunkIds: ["chunk-0"],
            materialIds: ["brick"],
        }],
        bindings: [{ id: "binding-0", instanceId: "building-0", truthEntityId: "building-0" }],
        appearanceDependencies: [],
    });
    const uses = new Map([[meshRecord.useHash, meshRecord.use], [buffer.useHash, buffer.use]]);
    const bytesByUse = new Map([[meshRecord.useHash, meshRecord.bytes], [buffer.useHash, buffer.bytes]]);
    const access = normalizeVisualLayerAccess({
        kind: "cev-sim.visual-layer-access",
        version: 1,
        descriptorHash: hashVisualLayer(descriptor),
        assets: descriptor.assets.map((asset) => ({
            sha256: asset.sha256,
            useHash: [...uses.entries()].find(([, use]) => use.asset.sha256 === asset.sha256)[0],
        })),
    });
    const documents = { descriptor, access, uses, bytesByUse, meshDigest };
    const fetched = [];
    const { materializer, parsed } = createMaterializer(documents);
    const original = materializer.assetClient.getUseContent.bind(materializer.assetClient);
    materializer.assetClient.getUseContent = async (useHash) => {
        fetched.push(useHash);
        return original(useHash);
    };
    const status = await materializer.replace(referenceFor(documents), worldResource());
    assert.equal(status.status, VISUAL_PREVIEW_STATUS.ready);
    assert.ok(fetched.includes(buffer.useHash));
    assert.deepEqual(parsed, [meshDigest]);
    materializer.dispose();
});

test("materializer rejects unauthorized, mismatched, and decoder failures without committing", async () => {
    const documents = layerDocuments({ meshBytes: makeNamedMaterialGlb("brick") });
    const reference = referenceFor(documents);

    const missingAccess = createMaterializer(documents);
    let status = await missingAccess.materializer.replace(
        { descriptorHash: reference.descriptorHash },
        worldResource(),
    );
    assert.equal(status.error.code, VISUAL_PREVIEW_ERROR_CODES.ACCESS_MISSING);
    assert.equal(missingAccess.previewRoot.children.length, 0);

    const denied = createMaterializer(documents, {
        faults: { access: new StorageRequestError("denied", { status: 403, code: "VISUAL_LAYER_RIGHTS_DENIED" }) },
    });
    status = await denied.materializer.replace(reference, worldResource());
    assert.equal(status.error.code, VISUAL_PREVIEW_ERROR_CODES.RIGHTS_DENIED);
    assert.equal(denied.previewRoot.children.length, 0);

    const revoked = createMaterializer(documents, {
        faults: { content: new StorageRequestError("revoked", { status: 403, code: "VISUAL_ASSET_RIGHTS_DENIED" }) },
    });
    status = await revoked.materializer.replace(reference, worldResource());
    assert.equal(status.error.code, VISUAL_PREVIEW_ERROR_CODES.RIGHTS_DENIED);

    const digest = createMaterializer(documents, {
        faults: { bytes: Object.fromEntries([...documents.bytesByUse.keys()].map((hash) => [hash, Buffer.from("nope")])) },
    });
    status = await digest.materializer.replace(reference, worldResource());
    assert.equal(status.error.code, VISUAL_PREVIEW_ERROR_CODES.SIZE_MISMATCH);

    const media = createMaterializer(documents, { faults: { mediaType: "text/plain" } });
    status = await media.materializer.replace(reference, worldResource());
    assert.equal(status.error.code, VISUAL_PREVIEW_ERROR_CODES.MEDIA_MISMATCH);

    const named = createMaterializer(documents, { parseGltf: parseNamedScene("other").parseGltf });
    status = await named.materializer.replace(reference, worldResource());
    assert.equal(status.error.code, VISUAL_PREVIEW_ERROR_CODES.MATERIAL_MISMATCH);
    assert.equal(named.previewRoot.children.length, 0);

    const decoder = createMaterializer(documents, {
        parseGltf: async () => { throw new Error("ktx boom"); },
    });
    status = await decoder.materializer.replace(reference, worldResource());
    assert.equal(status.error.code, VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED);
    assert.equal(decoder.previewRoot.children.length, 0);
});

test("supersession, environment switch, cancellation, and retry leave no partial geometry", async () => {
    const documents = layerDocuments({ meshBytes: makeNamedMaterialGlb("brick") });
    const reference = referenceFor(documents);
    let releaseAccess;
    const accessGate = new Promise((resolve) => { releaseAccess = resolve; });
    let accessStarted;
    const started = new Promise((resolve) => { accessStarted = resolve; });
    const first = createMaterializer(documents, {
        faults: {
            firstAccess: async () => {
                accessStarted();
                await accessGate;
            },
        },
    });
    const pending = first.materializer.replace(reference, worldResource());
    await started;
    const secondStatus = await first.materializer.replace(reference, worldResource());
    releaseAccess();
    await pending;
    assert.equal(secondStatus.status, VISUAL_PREVIEW_STATUS.ready);
    assert.equal(first.previewRoot.children.length, 1);

    let releaseDecode;
    const decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
    const cancelled = createMaterializer(documents, {
        parseGltf: async () => {
            await decodeGate;
            return parseNamedScene().parseGltf(null, documents.meshDigest);
        },
    });
    const decodePending = cancelled.materializer.replace(reference, worldResource());
    cancelled.materializer.dispose();
    releaseDecode();
    await decodePending;
    assert.equal(cancelled.previewRoot.children.length, 0);

    const failed = createMaterializer(documents, {
        faults: { access: new StorageRequestError("missing", { status: 404, code: "VISUAL_LAYER_DESCRIPTOR_NOT_FOUND" }) },
    });
    await failed.materializer.replace(reference, worldResource());
    assert.equal(failed.materializer.status.status, VISUAL_PREVIEW_STATUS.error);
    failed.materializer.layerClient.getAccess = async () => ({
        descriptor: documents.descriptor,
        access: documents.access,
    });
    const retried = await failed.materializer.retry();
    assert.equal(retried.status, VISUAL_PREVIEW_STATUS.ready);
    assert.equal(failed.previewRoot.children.length, 1);

    const switched = createMaterializer(documents);
    await switched.materializer.replace(reference, worldResource());
    assert.equal(switched.previewRoot.children.length, 1);
    const otherWorld = await switched.materializer.replace(reference, worldResource("d".repeat(64)));
    assert.equal(otherWorld.error.code, VISUAL_PREVIEW_ERROR_CODES.WORLD_MISMATCH);
    assert.equal(switched.previewRoot.children.length, 0);
    switched.materializer.dispose();
    switched.materializer.dispose();
});
