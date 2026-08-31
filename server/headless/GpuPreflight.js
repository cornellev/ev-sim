import os from "node:os";

import { PooledGpuRenderer } from "./PooledGpuRenderer.js";
import {
    SharedTensorArena,
    validateSharedTensorReference,
} from "./SharedTensorArena.js";

export async function runGpuPreflight(rendererConfig = {}, options = {}) {
    const pool = options.rendererPool ?? new PooledGpuRenderer(rendererConfig, {
        adapterFactory: options.adapterFactory,
    });
    let sharedMemory;
    try {
        const arena = await SharedTensorArena.create({
            environmentToken: "preflight",
            sizeBytes: 12 * 1024,
            rootDirectory: os.tmpdir(),
        });
        try {
            const spec = { dtype: 4, shape: [4], byteOrder: 1 };
            const first = await arena.publishTensor(Uint8Array.of(1, 2, 3, 4), spec, {
                generation: 1,
                sequence: 1,
            });
            const roundTrip = await validateSharedTensorReference(first, {
                environmentToken: first.regionName.split(/[\\/]/).at(-1),
                spec,
            });
            await arena.publishTensor(Uint8Array.of(5, 6, 7, 8), spec, {
                generation: 4,
                sequence: 4,
            });
            let staleRejected = false;
            try {
                await validateSharedTensorReference(first, {
                    environmentToken: first.regionName.split(/[\\/]/).at(-1),
                    spec,
                });
            } catch {
                staleRejected = true;
            }
            sharedMemory = {
                available: true,
                roundTrip: [...roundTrip],
                staleGenerationRejected: staleRejected,
                cleanup: true,
            };
        } finally {
            await arena.close();
        }
        const probe = await pool.probe();
        let renderReadback = null;
        if (probe.available) {
            const values = await pool.captureGroup({
                environmentKey: "preflight",
                scene: {
                    hash: "0".repeat(64),
                    description: { materials: [{ colorRgba: [64, 96, 128, 255] }] },
                },
                requests: [
                    { id: "camera", type: "camera", width: 2, height: 2, clearColor: [0.25, 0.5, 0.75, 1] },
                    { id: "lidar", type: "lidar3d", width: 2, height: 2, clearColor: [0, 0, 0, 0] },
                ],
                maxGpuBytes: 1024 * 1024,
            });
            renderReadback = {
                cameraBytes: values.find((entry) => entry.id === "camera")?.data?.byteLength || 0,
                lidarBytes: values.find((entry) => entry.id === "lidar")?.data?.byteLength || 0,
            };
        }
        return {
            kind: "cev-sim.gpu-preflight",
            version: 1,
            available: probe.available && sharedMemory.staleGenerationRejected,
            reason: probe.reason,
            production: probe.production === true,
            renderer: probe.provenance || null,
            renderReadback,
            sharedMemory,
        };
    } finally {
        await pool.close();
    }
}
