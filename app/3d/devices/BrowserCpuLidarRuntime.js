import { CpuLidarScene } from "../../simulation/sensors/CpuLidarScene.js";
import { lidarCaptureDigest, lidarTransferables } from "../../simulation/sensors/CpuLidarWorkerService.js";
import { browserSimulationPerformance } from "../../simulation/performance/BrowserSimulationPerformance.js";

function failure(message, code = "CPU_LIDAR_WORKER_FAILED") {
    return Object.assign(new Error(message), { code, infrastructureFailure: true });
}

export function serializeLidarVehicles(vehicles) {
    return vehicles.map((vehicle) => ({
        id: vehicle.telemetryId || vehicle.id,
        position: { x: vehicle.position.x, y: vehicle.position.y, z: vehicle.position.z },
        rotation: {
            x: vehicle.rotation?.x ?? 0,
            y: vehicle.rotation?.y ?? 0,
            z: vehicle.rotation?.z ?? 0,
            order: vehicle.rotation?.order || "XYZ",
        },
    }));
}

/** Browser transport only; intersection and canonical hashing remain shared. */
export class BrowserCpuLidarRuntime {
    constructor({ workerFactory = () => new Worker(new URL("./cpuLidarCapture.worker.js", import.meta.url), {
        type: "module",
    }), requestTimeoutMs = 30_000 } = {}) {
        this.workerFactory = workerFactory;
        this.requestTimeoutMs = requestTimeoutMs;
        this.worker = null;
        this.inline = null;
        this.pending = new Map();
        this.transport = null;
        this.generation = 0;
        this.requestId = 0;
        this.workerGeneration = 0;
        this.rigidBodyPoses = [];
        this.episodePrimitives = [];
        this.status = { implementation: null, fallbackReason: null };
        this.error = null;
        this.disposed = false;
    }

    get requiresAsyncCapture() { return this.status.implementation === "worker"; }

    async prepare(resolvedRun, sensors) {
        try {
            this.worker = this.workerFactory();
            if (!this.worker) throw new Error("Module workers are unavailable.");
            const onMessage = ({ data }) => {
                if (this.transport?.id === data.id) this._releaseTransport();
                const request = this.pending.get(data.id);
                if (!request) return;
                this.pending.delete(data.id);
                clearTimeout(request.timer);
                if (data.ok) request.resolve(data.result);
                else this._fail(failure(data.error.message, data.error.code));
                if (!data.ok) request.reject(this.error);
            };
            const onError = (event) => this._fail(failure(event.message || "CPU LiDAR worker terminated."));
            this.worker.addEventListener("message", onMessage);
            this.worker.addEventListener("error", onError);
            this.worker.addEventListener("messageerror", onError);
            const result = await this._call("prepare", { resolvedRun, sensors });
            this.status = { implementation: "worker", fallbackReason: null, ...result };
        } catch (error) {
            if (this.disposed || error.code === "CPU_LIDAR_CANCELLED") throw error;
            this.worker?.terminate();
            this.worker = null;
            this.error = null;
            const start = performance.now();
            this.inline = new CpuLidarScene(resolvedRun.lidarGeometry);
            this.status = {
                implementation: "inline",
                fallbackReason: { code: error.code || "CPU_LIDAR_WORKER_UNAVAILABLE", message: error.message },
                preparationMs: performance.now() - start,
                ...this.inline.preparationTimings,
            };
        }
        browserSimulationPerformance.recordCpuLidarRuntime(this.status);
        return this;
    }

    _call(method, payload, transfers = []) {
        if (this.error || this.disposed) return Promise.reject(this.error || failure("CPU LiDAR runtime is disposed."));
        if (this.pending.size >= 1) return Promise.reject(failure("CPU LiDAR request queue is full.", "CPU_LIDAR_CAPACITY"));
        const id = ++this.requestId;
        const generation = this.generation;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this._fail(failure("CPU LiDAR worker timed out.", "CPU_LIDAR_TIMEOUT")), this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const post = () => {
                if (!this.pending.has(id)) return;
                let release;
                const done = new Promise((resolve) => { release = resolve; });
                this.transport = { id, done, release };
                try {
                    this.worker.postMessage({ id, method, payload: { ...payload, generation } }, transfers);
                } catch (error) { this._fail(failure(error.message)); }
            };
            // Cancellation fences results immediately, but the old synchronous
            // worker job must drain before another physical request is posted.
            if (this.transport) this.transport.done.then(post);
            else post();
        }).then((result) => {
            if (generation !== this.generation || this.disposed) {
                throw failure("Stale CPU LiDAR reply.", "CPU_LIDAR_CANCELLED");
            }
            return result;
        });
    }

    _rejectPending(error) {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }

    _releaseTransport() {
        const previous = this.transport;
        this.transport = null;
        previous?.release();
    }

    _fail(error) {
        this.error = error;
        this._rejectPending(error);
        this._releaseTransport();
        this.worker?.terminate();
        this.worker = null;
        this.status = { ...this.status, error: { code: error.code, message: error.message } };
        browserSimulationPerformance.recordCpuLidarRuntime(this.status);
    }

    capture(config, vehicles) {
        if (this.inline) return this.inline.capture(config, vehicles);
        const start = performance.now();
        const generation = this.generation;
        return this._call("capture", {
            sensorId: config.id,
            vehicles: serializeLidarVehicles(vehicles),
            rigidBodyPoses: this.rigidBodyPoses,
            ...(generation !== this.workerGeneration ? { episodePrimitives: this.episodePrimitives } : {}),
        }).then((result) => {
            this.workerGeneration = generation;
            browserSimulationPerformance.recordTiming("cpuLidarCapture", result.captureMs);
            browserSimulationPerformance.recordTiming("cpuLidarRoundTrip", performance.now() - start);
            return result.buffer;
        });
    }

    digestCapture(capture) {
        if (this.inline) return { capture, digest: lidarCaptureDigest(capture) };
        return this._call("digest", { capture }, lidarTransferables(capture)).then((result) => {
            browserSimulationPerformance.recordTiming("cpuLidarDigest", result.digestMs);
            return result;
        });
    }

    setRigidBodyPoses(poses = []) {
        this.rigidBodyPoses = poses;
        this.inline?.setRigidBodyPoses(poses);
    }

    reset() {
        this.generation += 1;
        this._rejectPending(failure("CPU LiDAR capture cancelled by reset.", "CPU_LIDAR_CANCELLED"));
    }

    setEpisodePrimitives(primitives = []) {
        this.reset();
        this.episodePrimitives = primitives;
        this.rigidBodyPoses = [];
        this.inline?.setEpisodePrimitives(primitives);
    }

    dispose() {
        this.disposed = true;
        this.generation += 1;
        this._rejectPending(failure("CPU LiDAR runtime disposed.", "CPU_LIDAR_CANCELLED"));
        this._releaseTransport();
        this.worker?.terminate();
        this.worker = null;
        this.inline?.dispose();
        this.inline = null;
    }
}
