import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";

import { createPersistentBakeRunConfig } from "../../app/3d/environment/visualization/BakeRunConfig.js";
import { runVersion1BakeJob } from "../../app/3d/environment/visual/BakeJobRunner.js";
import { BakeRunCatalog, BAKE_PRODUCT_RESULT_KEYS } from "../../app/3d/environment/visual/BakeRunCatalog.js";
import { uploadBakeArtifacts, writeBakeArtifacts } from "../../app/3d/environment/visual/BakeArtifactWriter.js";
import { VISUAL_PREVIEW_USERDATA } from "../../app/3d/environment/visual/VisualPreviewIsolation.js";
import { StorageService } from "../../server/storage/StorageService.js";
import { ownedGrant, writeRegistry } from "./visual-assets.js";

export const WIDTH = 20;
export const HEIGHT = 20;

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

export function planeBuffers(width, height, pose, { invalidatePixel = null } = {}) {
    const beauty = new Uint8Array(width * height * 4);
    const worldPosition = new Float32Array(width * height * 3);
    const validity = new Uint8Array(width * height);
    const planeZ = (pose?.position?.z ?? 0) - 2;
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
            validity[pixel] = 1;
        }
    }
    if (invalidatePixel) {
        const pixel = invalidatePixel.y * width + invalidatePixel.x;
        validity[pixel] = 0;
    }
    return { beauty, worldPosition, validity };
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
    });
    await uploadBakeArtifacts(storeAssetClient(service.visualAssets), written.uploads);
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
