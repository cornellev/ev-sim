import { CpuLidarScene } from "./CpuLidarScene.js";
import { simulationSha256 } from "../kernel/SimulationHashes.js";

export function lidarCaptureDigest(capture) {
    return simulationSha256({
        messages: capture.messages,
        nativePackets: capture.nativePackets.map((packet) => ({ ...packet, payload: packet.payload })),
        observation: capture.observation,
    });
}

export function lidarTransferables(value, buffers = new Set()) {
    if (value instanceof ArrayBuffer) buffers.add(value);
    else if (ArrayBuffer.isView(value)) {
        if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    } else if (value && typeof value === "object") {
        for (const child of Object.values(value)) lidarTransferables(child, buffers);
    }
    return [...buffers];
}

/** The same request handler runs in the browser worker and worker parity tests. */
export class CpuLidarWorkerService {
    constructor() {
        this.scene = null;
        this.configs = new Map();
        this.generation = -1;
    }

    handle(method, payload) {
        const start = performance.now();
        if (method === "prepare") {
            this.dispose();
            this.scene = new CpuLidarScene(payload.resolvedRun.lidarGeometry);
            this.configs = new Map(payload.sensors.map((config) => [config.id, config]));
            this.generation = payload.generation;
            return { preparationMs: performance.now() - start, ...this.scene.preparationTimings };
        }
        if (!this.scene) throw new Error("CPU LiDAR worker is not prepared.");
        if (payload.generation < this.generation) throw new Error("Stale CPU LiDAR generation.");
        if (method === "capture") {
            if (payload.generation !== this.generation) {
                this.scene.setEpisodePrimitives(payload.episodePrimitives ?? []);
                this.generation = payload.generation;
            }
            const config = this.configs.get(payload.sensorId);
            if (!config) throw new Error(`Unknown CPU LiDAR sensor "${payload.sensorId}".`);
            this.scene.setRigidBodyPoses(payload.rigidBodyPoses);
            const buffer = this.scene.capture(config, payload.vehicles);
            return { buffer, captureMs: performance.now() - start };
        }
        if (method === "digest") {
            if (payload.generation !== this.generation) throw new Error("Stale CPU LiDAR digest.");
            return {
                capture: payload.capture,
                digest: lidarCaptureDigest(payload.capture),
                digestMs: performance.now() - start,
            };
        }
        throw new Error(`Unknown CPU LiDAR worker method "${method}".`);
    }

    dispose() {
        this.scene?.dispose();
        this.scene = null;
        this.configs.clear();
        this.generation = -1;
    }
}
