import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { VisualBudgetError } from "../app/3d/environment/visual/VisualMemoryLedger.js";
import { VisualLayerMaterializer } from "../app/3d/environment/visual/VisualLayerMaterializer.js";
import { VisualResourceCache } from "../app/3d/environment/visual/VisualResourceCache.js";
import { VisualChunkResidencyController } from "../app/3d/environment/visual/VisualChunkResidencyController.js";
import {
    VISUAL_PREVIEW_ERROR_CODES,
    VISUAL_PREVIEW_STATUS,
    defaultVisualLodPolicy,
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    hashVisualLodPolicy,
    normalizeVisualAssetUse,
    normalizeVisualLayer,
    normalizeVisualLayerAccess,
    selectVisualLodIndex,
    sha256ExactBytes,
} from "../app/simulation/visual/VisualLayer.js";
import {
    VISUAL_SCALE_PROFILE_IDS,
    getVisualScaleProfile,
} from "../app/simulation/visual/VisualScaleProfile.js";

const WORLD_HASH = "c".repeat(64);

function recordedUse(asset, bytes) {
    const use = normalizeVisualAssetUse({
        kind: "cev-sim.visual-asset-use",
        version: 1,
        asset,
        sourceIds: ["owned-lab"],
        dependencies: {},
    });
    return { use, useHash: hashVisualAssetUse(use), bytes };
}

function multiChunkDocuments() {
    const instances = [];
    const chunks = [];
    const assets = [];
    const uses = new Map();
    const bytesByUse = new Map();
    const placements = [
        { id: 0, x: 0, lod: 0 },
        { id: 1, x: 90, lod: 1 },
        { id: 2, x: 250, lod: 2 },
        { id: 3, x: 5_000, lod: 2 },
    ];
    for (const placement of placements) {
        const lodBytes = [0, 1, 2].map((level) => (
            Uint8Array.from({ length: 48 }, (_, byte) => (byte + placement.id + level) % 251)
        ));
        const lodDigests = lodBytes.map((payload) => sha256ExactBytes(payload));
        for (const [level, payload] of lodBytes.entries()) {
            const asset = {
                sha256: lodDigests[level],
                mediaType: "model/gltf-binary",
                sizeBytes: payload.byteLength,
                role: "mesh",
            };
            if (!assets.some((entry) => entry.sha256 === asset.sha256)) assets.push(asset);
            const record = recordedUse(asset, payload);
            uses.set(record.useHash, record.use);
            bytesByUse.set(record.useHash, record.bytes);
        }
        const instanceId = `building-${placement.id}`;
        const chunkId = `chunk-${placement.id}`;
        chunks.push({
            id: chunkId,
            instanceIds: [instanceId],
            dependencyUris: lodDigests.map((digest) => `sha256:${digest}`),
        });
        instances.push({
            id: instanceId,
            assetUri: `sha256:${lodDigests[0]}`,
            lodLevels: lodDigests.map((digest) => `sha256:${digest}`),
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, placement.x, 0, 0, 1],
            chunkIds: [chunkId],
            materialIds: ["brick"],
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
            mode: "metallic-roughness",
            parameters: {},
            textures: [],
            extensions: [],
        }],
        chunks,
        instances,
        bindings: instances.map((instance) => ({
            id: `binding-${instance.id}`,
            instanceId: instance.id,
            truthEntityId: instance.id,
        })),
        appearanceDependencies: [],
    });
    const access = normalizeVisualLayerAccess({
        kind: "cev-sim.visual-layer-access",
        version: 1,
        descriptorHash: hashVisualLayer(descriptor),
        assets: descriptor.assets.map((asset) => ({
            sha256: asset.sha256,
            useHash: [...uses.entries()].find(([, use]) => use.asset.sha256 === asset.sha256)[0],
        })),
    });
    return { descriptor, access, uses, bytesByUse };
}

function clientsFor(documents) {
    const fetched = [];
    return {
        fetched,
        layerClient: {
            async getAccess() {
                return { descriptor: documents.descriptor, access: documents.access };
            },
        },
        assetClient: {
            async getUse(useHash) {
                return documents.uses.get(useHash);
            },
            async getUseContent(useHash) {
                fetched.push(useHash);
                const use = documents.uses.get(useHash);
                return {
                    bytes: documents.bytesByUse.get(useHash),
                    mediaType: use.asset.mediaType,
                    etag: `"${use.asset.sha256}"`,
                };
            },
        },
    };
}

function parseGltf() {
    return async (_bytes, digest) => {
        const scene = new THREE.Group();
        scene.add(new THREE.Mesh(
            new THREE.BoxGeometry(0.2, 0.2, 0.2),
            new THREE.MeshPhysicalMaterial({ name: "brick" }),
        ));
        return {
            scene,
            json: { materials: [{ name: "brick" }], meshes: [{ primitives: [{ material: 0 }] }] },
            digest,
        };
    };
}

function createMaterializer(documents, options = {}) {
    const previewRoot = new THREE.Group();
    const clients = clientsFor(documents);
    const profile = options.profile ?? getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.hostedQuickV1);
    const materializer = new VisualLayerMaterializer({
        previewRoot,
        THREE,
        profile,
        lodPolicy: defaultVisualLodPolicy(),
        parseGltf: options.parseGltf ?? parseGltf(),
        decodeTexture: async () => ({ isTexture: true, clone() { return { isTexture: true, dispose() {} }; }, dispose() {} }),
        cache: options.cache ?? new VisualResourceCache({ profile }),
        ...clients,
    });
    return { materializer, previewRoot, fetched: clients.fetched };
}

function worldResource() {
    return {
        hash: WORLD_HASH,
        description: {
            buildings: [
                { id: "building-0" },
                { id: "building-1" },
                { id: "building-2" },
                { id: "building-3" },
            ],
            features: [],
            roads: { nodes: [], edges: [] },
        },
    };
}

function referenceFor(documents) {
    return {
        descriptorHash: hashVisualLayer(documents.descriptor),
        accessHash: hashVisualLayerAccess(documents.access),
    };
}

test("LOD policy decisions are identical across advertised hardware profiles", () => {
    const policy = defaultVisualLodPolicy();
    const hashes = [
        VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1,
        VISUAL_SCALE_PROFILE_IDS.jetsonAgxOrinV1,
        VISUAL_SCALE_PROFILE_IDS.jetsonAgxThorV1,
    ].map((id) => hashVisualLodPolicy(getVisualScaleProfile(id).lodPolicy));
    assert.equal(new Set(hashes).size, 1);
    assert.equal(hashVisualLodPolicy(policy), hashes[0]);
    assert.equal(selectVisualLodIndex(90, policy), 1);
});

test("residency controller selects required AOI chunks and sheds optional prefetch", () => {
    const documents = multiChunkDocuments();
    const controller = new VisualChunkResidencyController({
        maxResidentChunks: 2,
        requiredRadiusMeters: 100,
        prefetchRadiusMeters: 120,
    });
    const near = controller.plan(documents.descriptor, { position: { x: 0, y: 0, z: 0 } });
    assert.equal(near.required.some((chunk) => chunk.id === "chunk-0"), true);
    assert.equal(near.required.some((chunk) => chunk.id === "chunk-3"), false);
    assert.equal(near.selectedLods["building-0"].index, 0);
    assert.equal(near.selectedLods["building-1"].index, 1);
    assert.equal(near.selectedLods["building-2"].index, 2);
    const crowded = new VisualChunkResidencyController({
        maxResidentChunks: 1,
        requiredRadiusMeters: 50,
        prefetchRadiusMeters: 6_000,
    });
    const plan = crowded.plan(documents.descriptor, { position: { x: 0, y: 0, z: 0 } });
    assert.equal(plan.required.length, 1);
    assert.ok(plan.shedPrefetch.length > 0);
    assert.equal(crowded.prefetchShed, plan.shedPrefetch.length);
});

test("materializer loads selected LODs for the AOI and does not fetch the whole layer", async () => {
    const documents = multiChunkDocuments();
    const { materializer, previewRoot, fetched } = createMaterializer(documents);
    const status = await materializer.replace(referenceFor(documents), worldResource(), {
        interest: { position: { x: 0, y: 0, z: 0 } },
    });
    assert.equal(status.status, VISUAL_PREVIEW_STATUS.ready);
    assert.ok(status.residency.residentChunks >= 1);
    assert.ok(status.residency.residentChunks < documents.descriptor.chunks.length);
    const uniqueFetched = new Set(fetched);
    assert.ok(uniqueFetched.size < documents.access.assets.length);
    assert.equal(previewRoot.children.length, status.residency.residentChunks);

    const snapshot = materializer.residencySnapshot();
    assert.equal(snapshot.selectedLods["building-0"].includes(documents.descriptor.instances[0].lodLevels[0]), true);

    const x64 = createMaterializer(documents, {
        profile: getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1),
    });
    const orin = createMaterializer(documents, {
        profile: getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.jetsonAgxOrinV1),
    });
    await x64.materializer.replace(referenceFor(documents), worldResource(), {
        interest: { position: { x: 90, y: 0, z: 0 } },
    });
    await orin.materializer.replace(referenceFor(documents), worldResource(), {
        interest: { position: { x: 90, y: 0, z: 0 } },
    });
    assert.deepEqual(
        x64.materializer.residencySnapshot().selectedLods,
        orin.materializer.residencySnapshot().selectedLods,
    );
    x64.materializer.dispose();
    orin.materializer.dispose();
    materializer.dispose();
});

test("required LOD failure empties an initial preview and retains the last AOI on movement pressure", async () => {
    const documents = multiChunkDocuments();
    const failDigest = documents.descriptor.instances[0].lodLevels[0].slice("sha256:".length);
    const { materializer, previewRoot } = createMaterializer(documents, {
        parseGltf: async (payload, digest) => {
            if (digest === failDigest) throw new Error("required lod missing");
            return parseGltf()(payload, digest);
        },
    });
    const failed = await materializer.replace(referenceFor(documents), worldResource(), {
        interest: { position: { x: 0, y: 0, z: 0 } },
    });
    assert.equal(failed.status, VISUAL_PREVIEW_STATUS.error);
    assert.equal(previewRoot.children.length, 0);

    const healthy = createMaterializer(documents);
    await healthy.materializer.replace(referenceFor(documents), worldResource(), {
        interest: { position: { x: 0, y: 0, z: 0 } },
    });
    const committed = healthy.previewRoot.children.length;
    assert.ok(committed > 0);
    const original = healthy.materializer._loadChunk.bind(healthy.materializer);
    healthy.materializer._loadChunk = async function loadChunk(chunk, plan, generation, signal) {
        if (chunk.id === "chunk-2") {
            throw new VisualBudgetError("required movement exceeded budget", {
                kind: "encodedCpu",
                requestedBytes: 1,
                usedBytes: 0,
                ceilingBytes: 0,
            });
        }
        return original(chunk, plan, generation, signal);
    };
    const moved = await healthy.materializer.updateInterest({ position: { x: 250, y: 0, z: 0 } });
    assert.equal(moved.status, VISUAL_PREVIEW_STATUS.error);
    assert.equal(moved.error.code, VISUAL_PREVIEW_ERROR_CODES.BUDGET_EXCEEDED);
    assert.equal(moved.residency.retainCommittedAoi, true);
    assert.equal(healthy.previewRoot.children.length, committed);
    healthy.materializer.dispose();
    materializer.dispose();
});

test("materializer commits chunks atomically, isolates caches, and recovers from context loss", async () => {
    const documents = multiChunkDocuments();
    const { materializer, previewRoot } = createMaterializer(documents);
    await materializer.replace(referenceFor(documents), worldResource());
    const firstIds = previewRoot.children.map((child) => child.name).sort();
    await materializer.updateInterest({ position: { x: 0, y: 0, z: 0 } });
    assert.deepEqual(previewRoot.children.map((child) => child.name).sort(), firstIds);

    const left = createMaterializer(documents);
    const right = createMaterializer(documents);
    await left.materializer.replace(referenceFor(documents), worldResource());
    await right.materializer.replace(referenceFor(documents), worldResource());
    left.materializer.dispose();
    assert.ok(right.previewRoot.children.length > 0);
    assert.equal(right.materializer.cache.dead, false);

    const lost = createMaterializer(documents);
    await lost.materializer.replace(referenceFor(documents), worldResource());
    lost.materializer.handleContextLost("webglcontextlost");
    assert.equal(lost.materializer.status.error.code, VISUAL_PREVIEW_ERROR_CODES.CONTEXT_LOST);
    assert.equal(lost.previewRoot.children.length, 0);
    const retried = await lost.materializer.retry();
    assert.equal(retried.status, VISUAL_PREVIEW_STATUS.ready);
    lost.materializer.dispose();
    right.materializer.dispose();
    materializer.dispose();
});
