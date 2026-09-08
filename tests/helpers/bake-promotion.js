import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";

import { createPersistentBakeRunConfig } from "../../app/3d/environment/visualization/BakeRunConfig.js";
import { runVersion1BakeJob } from "../../app/3d/environment/visual/BakeJobRunner.js";
import { runIncrementalBake } from "../../app/3d/environment/visual/BakeIncrementalRunner.js";
import { BakeRunCatalog, BAKE_PRODUCT_RESULT_KEYS } from "../../app/3d/environment/visual/BakeRunCatalog.js";
import { uploadBakeArtifacts, writeBakeArtifacts } from "../../app/3d/environment/visual/BakeArtifactWriter.js";
import { BakeSpatialIndex } from "../../app/3d/environment/visualization/BakeSpatialIndex.js";
import { ChunkManager } from "../../app/3d/editor/chunks/ChunkManager.js";
import { VISUAL_PREVIEW_USERDATA } from "../../app/3d/environment/visual/VisualPreviewIsolation.js";
import { hashVisualLayer, hashVisualLayerAccess } from "../../app/simulation/visual/VisualLayer.js";
import { StorageService } from "../../server/storage/StorageService.js";
import { ownedGrant, writeRegistry } from "./visual-assets.js";

export const WIDTH = 20;
export const HEIGHT = 20;
export const WORLD_A = "a".repeat(64);
export const WORLD_B = "b".repeat(64);
export const SOURCE_IDS = Object.freeze(["owned-lab"]);

export function tinyPersistentConfig(overrides = {}) {
    return createPersistentBakeRunConfig({
        environmentId: "yard",
        seed: 11,
        paths: [{
            id: "path-0",
            vertices: [{
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            }],
        }],
        views: [{
            id: "bake/view/main",
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            camera: { width: WIDTH, height: HEIGHT, fov: 75, near: 0.1, far: 50 },
        }],
        sampling: { deltaDistance: 2, includeEndpoints: true, captureTimeNs: 5 },
        ...overrides,
    });
}

export function sourceScene() {
    const scene = new THREE.Scene();
    const building = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    );
    building.name = "alpha";
    building.userData.buildingId = "alpha";
    building.position.set(0, 1, -2);
    scene.add(building);
    return scene;
}

export function planeBuffers(width, height, pose, { invalidatePixel = null, planeZOffset = 1 } = {}) {
    const beauty = new Uint8Array(width * height * 4);
    const worldPosition = new Float32Array(width * height * 3);
    const geometricNormal = new Float32Array(width * height * 3);
    const confidence = new Float32Array(width * height);
    const validity = new Uint8Array(width * height);
    const planeZ = (pose?.position?.z ?? 0) - planeZOffset;
    const originX = pose?.position?.x ?? 0;
    const originY = pose?.position?.y ?? 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pixel = y * width + x;
            beauty[pixelOffset(pixel, 0)] = x === 0 && y === 0 ? 255 : 32;
            beauty[pixelOffset(pixel, 1)] = y;
            beauty[pixelOffset(pixel, 2)] = x;
            beauty[pixelOffset(pixel, 3)] = 255;
            worldPosition[pixel * 3] = originX + (x / Math.max(1, width - 1) - 0.5);
            worldPosition[pixel * 3 + 1] = originY + (0.5 - y / Math.max(1, height - 1));
            worldPosition[pixel * 3 + 2] = planeZ;
            geometricNormal[pixel * 3] = 0;
            geometricNormal[pixel * 3 + 1] = 0;
            geometricNormal[pixel * 3 + 2] = 1;
            confidence[pixel] = 1;
            validity[pixel] = 1;
        }
    }
    if (invalidatePixel) {
        const pixel = invalidatePixel.y * width + invalidatePixel.x;
        validity[pixel] = 0;
        confidence[pixel] = 0;
    }
    return { beauty, worldPosition, geometricNormal, confidence, validity };
}

function pixelOffset(pixel, channel) {
    return pixel * 4 + channel;
}

export function capturePlane(options = {}) {
    return async (_view, { products, sample }) => ({
        visual: {
            products: Object.fromEntries(products.map((role) => {
                const key = BAKE_PRODUCT_RESULT_KEYS[role] ?? role;
                const buffers = planeBuffers(WIDTH, HEIGHT, sample.pose, options);
                if (role === "beauty") return [key, buffers.beauty];
                if (role === "world-position") return [key, buffers.worldPosition];
                if (role === "geometric-normal") return [key, buffers.geometricNormal];
                if (role === "confidence") return [key, buffers.confidence];
                if (role === "validity") return [key, buffers.validity];
                throw new Error(`unsupported test role ${role}`);
            })),
            sampleId: sample?.sampleId,
        },
    });
}

export async function completePersistentJob(options = {}) {
    const catalog = options.catalog ?? new BakeRunCatalog();
    const config = options.config ?? tinyPersistentConfig().document();
    const scene = options.sourceScene ?? sourceScene();
    const job = await runVersion1BakeJob({ catalog }, {
        config,
        sourceScene: scene,
        worldHash: options.worldHash,
        environmentRevision: options.environmentRevision ?? 0,
        generation: options.generation ?? 1,
        visualDescriptorHash: options.visualDescriptorHash ?? null,
        visualAccessHash: options.visualAccessHash ?? null,
        sourceUseHashes: options.sourceUseHashes ?? [],
        captureAlignedProducts: options.captureAlignedProducts ?? capturePlane({
            invalidatePixel: { x: 5, y: 5 },
        }),
    });
    return { job, catalog, scene };
}

export function storeAssetClient(store) {
    return {
        async createUpload(body) {
            return store.createUpload(body);
        },
        async putUploadContent(id, bytes) {
            return store.writeUploadContent(id, bytes, { contentLength: bytes.length });
        },
        async getUseContent(useHash) {
            const opened = await store.openUseContent(useHash);
            try {
                const chunks = [];
                for await (const chunk of opened.stream) chunks.push(chunk);
                return { bytes: new Uint8Array(Buffer.concat(chunks)) };
            } finally {
                await opened.release();
            }
        },
    };
}

export async function writeAndUpload(service, reservation, job, options = {}) {
    const written = writeBakeArtifacts({
        job,
        buffers: job.productBuffers,
        sourceIds: reservation.outputSourceIds,
        currentDescriptor: options.currentDescriptor ?? null,
        currentAccess: options.currentAccess ?? null,
        worldHash: reservation.worldHash,
        scene: job.sceneHandle?.scene ?? options.sourceScene ?? null,
    });
    await uploadBakeArtifacts(storeAssetClient(service.visualAssets), [
        ...written.uploads,
        ...(written.contributionUploads ?? []),
    ]);
    return written;
}

export async function promotionService(options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-bake-promotion-"));
    const sources = options.sources ?? [ownedGrant()];
    await writeRegistry(dir, sources);
    const faults = options.faults ?? {};
    const service = new StorageService(dir, {
        visualAssets: {
            registryPath: path.join(dir, "visual-source-registry.json"),
            limits: options.limits,
            faults: options.assetFaults,
        },
        bakeOutputSourceIds: options.bakeOutputSourceIds ?? ["owned-lab"],
        faults,
    });
    const created = await service.createEnvironment({
        id: options.id ?? "yard",
        name: options.name ?? "Yard",
        templateId: "blank",
    });
    return { dir, service, created, faults };
}

export async function beginAndCapture(service, options = {}) {
    const environmentId = options.environmentId ?? "yard";
    const current = await service.getEnvironment(environmentId);
    const reservation = await service.beginBakePromotion(environmentId, {
        expectedRevision: options.expectedRevision ?? current.revision,
    });
    const { job } = await completePersistentJob({
        worldHash: reservation.worldHash,
        environmentRevision: reservation.environmentRevision,
        generation: reservation.generation,
        visualDescriptorHash: reservation.visualDescriptorHash,
        visualAccessHash: reservation.visualAccessHash,
        sourceUseHashes: reservation.sourceUseHashes,
        captureAlignedProducts: options.captureAlignedProducts,
        config: options.config,
    });
    const written = await writeAndUpload(service, reservation, job, options);
    return { reservation, job, written, current };
}

void VISUAL_PREVIEW_USERDATA;

export function twoSampleConfig(overrides = {}) {
    return tinyPersistentConfig({
        paths: [{
            id: "path-0",
            vertices: [
                { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
                { position: { x: 80, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
            ],
        }],
        sampling: { deltaDistance: 80, includeEndpoints: true, captureTimeNs: 5 },
        ...overrides,
    });
}

export function addTestBuilding(scene, id, {
    x = 0,
    y = 1,
    z = -2,
    color = 0xff0000,
    castShadow = false,
    entityId = null,
} = {}) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial({ color }),
    );
    mesh.name = id;
    mesh.userData.buildingId = id;
    if (entityId) mesh.userData.entityId = entityId;
    mesh.position.set(x, y, z);
    mesh.castShadow = castShadow;
    scene.add(mesh);
    return mesh;
}

export function twoPoleScene() {
    const scene = new THREE.Scene();
    addTestBuilding(scene, "alpha", { x: 0 });
    addTestBuilding(scene, "beta", { x: 80 });
    return scene;
}

export function chunkManagerForScene(scene) {
    const manager = new ChunkManager({ chunkSize: 20 });
    scene.updateMatrixWorld(true);
    scene.traverse((object) => {
        if (!object.isMesh) return;
        const box = new THREE.Box3().setFromObject(object);
        const id = object.userData.buildingId
            ? `building:${object.userData.buildingId}`
            : (object.userData.entityId ?? object.uuid);
        manager.assignEntity({
            id,
            bounds: {
                minX: box.min.x,
                minY: box.min.y,
                minZ: box.min.z,
                maxX: box.max.x,
                maxY: box.max.y,
                maxZ: box.max.z,
            },
        });
    });
    return manager;
}

export async function runReuseBake(options = {}) {
    const sourceScene = options.scene ?? twoPoleScene();
    const config = options.config ?? twoSampleConfig().document();
    const chunkManager = options.chunkManager ?? chunkManagerForScene(sourceScene);
    const spatialIndex = options.spatialIndex
        ?? BakeSpatialIndex.fromRegistry(null, chunkManager, { scene: sourceScene });
    const catalog = options.catalog ?? new BakeRunCatalog(options.catalogOptions ?? {});
    return runIncrementalBake({
        host: { catalog },
        options: {
            config,
            sourceScene,
            worldHash: options.worldHash ?? WORLD_A,
            generation: options.generation ?? 1,
            environmentRevision: options.environmentRevision ?? 0,
            spatialIndex,
            chunkManager,
            streamUnits: options.streamUnits === true,
            memoryLedger: options.memoryLedger,
            captureAlignedProducts: options.captureAlignedProducts ?? capturePlane(),
            signal: options.signal,
        },
        previousManifest: options.previousManifest ?? null,
        previousGraph: options.previousGraph ?? null,
        previousWritten: options.previousWritten ?? null,
        currentDescriptor: options.currentDescriptor ?? null,
        currentAccess: options.currentAccess ?? null,
        sourceIds: options.sourceIds ?? SOURCE_IDS,
        reuseDisabled: options.reuseDisabled === true,
        uploadClient: options.uploadClient ?? null,
        assetClient: options.assetClient ?? options.uploadClient ?? null,
        memoryLedger: options.memoryLedger ?? null,
    });
}

export function semanticBakeIdentity(written) {
    return {
        descriptorHash: hashVisualLayer(written.descriptor),
        accessHash: hashVisualLayerAccess(written.access),
        sourceWorldHash: written.descriptor.sourceWorldHash,
        ids: [
            ...written.descriptor.materials.map((entry) => entry.id),
            ...written.descriptor.instances.map((entry) => entry.id),
            ...written.descriptor.chunks.map((entry) => entry.id),
        ].sort(),
        assets: written.descriptor.assets.map((entry) => entry.sha256).sort(),
        uses: written.access.assets.map((entry) => entry.useHash).sort(),
    };
}

export function unitIds(entries = []) {
    return entries.map((entry) => entry.unitId).sort();
}
