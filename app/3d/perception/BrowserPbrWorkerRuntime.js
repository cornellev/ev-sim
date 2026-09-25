import * as THREE from "three";

import { createOwnedCaptureScene } from "../environment/visual/VisualCapturePipeline.js";
import { browserSimulationPerformance } from "../../simulation/performance/BrowserSimulationPerformance.js";

const PROVIDER = Object.freeze({ id: "pbr-mesh", version: 1 });

function infrastructureError(error, fallbackCode = "PBR_WORKER_FAILED") {
    const result = error instanceof Error ? error : new Error(String(error || "PBR capture worker failed."));
    result.code ||= fallbackCode;
    result.infrastructureFailure = true;
    return result;
}

function reviveError(record, fallbackCode) {
    const error = new Error(record?.message || "PBR capture worker failed.");
    error.name = record?.name || "Error";
    error.code = record?.code || fallbackCode;
    error.infrastructureFailure = true;
    return error;
}

function actorId(vehicle, index) {
    return String(vehicle?.telemetryId || vehicle?.id || `vehicle-${index + 1}`);
}

export function serializePbrActors(vehicles = []) {
    return vehicles.map((vehicle, index) => {
        vehicle?.sceneObject?.updateMatrixWorld?.(true);
        const elements = vehicle?.sceneObject?.matrixWorld?.elements;
        if (elements?.length === 16) {
            return { telemetryId: actorId(vehicle, index), matrixWorld: Array.from(elements) };
        }
        const position = vehicle?.position ?? {};
        const rotation = vehicle?.rotation ?? {};
        const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(
                Number(position.x) || 0,
                Number(position.y) || 0,
                Number(position.z) || 0,
            ),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(
                Number(rotation.x) || 0,
                Number(rotation.y) || 0,
                Number(rotation.z) || 0,
                rotation.order || "XYZ",
            )),
            new THREE.Vector3(1, 1, 1),
        );
        return { telemetryId: actorId(vehicle, index), matrixWorld: matrix.toArray() };
    });
}

function capturePosition(device) {
    const position = device?.getPosition?.() ?? {};
    return {
        x: Number(position.x) || 0,
        y: Number(position.y) || 0,
        z: Number(position.z) || 0,
    };
}

function defaultWorkerFactory() {
    if (typeof globalThis.Worker !== "function") return null;
    return new globalThis.Worker(new URL("./browserPbrCapture.worker.js", import.meta.url), { type: "module" });
}

/** Main-thread RPC facade for the dedicated OffscreenCanvas PBR renderer. */
export class BrowserPbrWorkerRuntime {
    constructor({ workerFactory = defaultWorkerFactory, vehicles = () => [] } = {}) {
        this.workerFactory = workerFactory;
        this.implementation = "worker";
        this.vehicleSource = vehicles;
        this.worker = null;
        this.requestId = 0;
        this.generation = 0;
        this.pending = new Map();
        this.listeners = new Set();
        this.status = this._snapshot("idle");
        this.captureSceneHandle = null;
        this.analyticSceneHandle = null;
        this.renderPolicy = null;
        this.runtimeOwnsProducts = true;
        this._operationTail = Promise.resolve();
        this._failure = null;
        this._prepared = false;
        this._disposeTimer = null;
    }

    static supported() {
        return typeof globalThis.Worker === "function" && typeof globalThis.OffscreenCanvas === "function";
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.status);
        return () => this.listeners.delete(listener);
    }

    get ready() {
        return this._prepared && ["ready", "streaming", "degraded"].includes(this.status.state);
    }

    get presentationBlocked() {
        return false;
    }

    subscribePresentationAvailability(listener) {
        listener(true);
        return () => {};
    }

    _vehicles() {
        return typeof this.vehicleSource === "function"
            ? (this.vehicleSource() ?? [])
            : (this.vehicleSource ?? []);
    }

    _snapshot(state, source = null, error = null) {
        return {
            provider: { ...PROVIDER },
            productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
            state,
            residency: source?.residency ?? null,
            diagnostic: error ? { code: error.code, message: error.message } : source?.diagnostic ?? null,
            error: error ? { code: error.code, message: error.message } : source?.error ?? null,
        };
    }

    _setStatus(state, source = null, error = null) {
        this.status = this._snapshot(state, source, error);
        for (const listener of this.listeners) listener(this.status);
    }

    _ensureWorker() {
        if (this.worker) return this.worker;
        const worker = this.workerFactory?.();
        if (!worker) {
            throw infrastructureError(new Error("Dedicated browser PBR workers are unavailable."), "PBR_WORKER_UNAVAILABLE");
        }
        this.worker = worker;
        const onMessage = (event) => this._handleMessage(event?.data ?? event);
        const onError = (event) => this._handleWorkerFailure(event?.error || new Error(event?.message || "PBR worker terminated."));
        if (typeof worker.addEventListener === "function") {
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", onError);
            worker.addEventListener("messageerror", onError);
        } else {
            worker.onmessage = onMessage;
            worker.onerror = onError;
        }
        return worker;
    }

    _handleMessage(message) {
        const pending = this.pending.get(message?.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(reviveError(message.error, "PBR_WORKER_REQUEST_FAILED"));
    }

    _handleWorkerFailure(cause) {
        const code = this._prepared ? "PBR_WORKER_RUNTIME_FAILED" : "PBR_WORKER_UNAVAILABLE";
        const error = infrastructureError(cause, code);
        this._failure = error;
        this._prepared = false;
        this._setStatus("error", null, error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    _call(method, payload = {}) {
        if (this._failure) return Promise.reject(this._failure);
        let worker;
        try {
            worker = this._ensureWorker();
        } catch (error) {
            return Promise.reject(error);
        }
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                worker.postMessage({ id, method, payload });
            } catch (error) {
                this.pending.delete(id);
                reject(infrastructureError(error, "PBR_WORKER_REQUEST_FAILED"));
            }
        });
    }

    _enqueue(method, payload) {
        const operation = this._operationTail.then(() => this._call(method, payload)).catch((error) => {
            const failure = infrastructureError(error);
            this._failure = failure;
            this._prepared = false;
            this._setStatus("error", null, failure);
            throw failure;
        });
        this._operationTail = operation.catch((error) => {
            this._failure = infrastructureError(error);
        });
        return operation;
    }

    async prepare(resolved, { sensorRig = null, vehicles = null } = {}) {
        this.dispose({ preserveListeners: true, immediate: true });
        this._failure = null;
        this._operationTail = Promise.resolve();
        this._setStatus("preparing");
        const generation = ++this.generation;
        try {
            await this._call("probe");
            const result = await this._call("prepare", {
                generation,
                resolved,
                sensorRig,
                vehicles: serializePbrActors(vehicles ?? this._vehicles()),
            });
            if (generation !== this.generation) {
                throw infrastructureError(new Error("PBR worker preparation was superseded."), "PBR_WORKER_GENERATION_STALE");
            }
            this.captureSceneHandle = createOwnedCaptureScene({
                ...result.appearance,
                scene: new THREE.Scene(),
            });
            this.analyticSceneHandle = createOwnedCaptureScene({
                ...result.analytic,
                scene: new THREE.Scene(),
            });
            this.renderPolicy = result.renderPolicy;
            this._prepared = true;
            this._setStatus(result.status?.state || "ready", result.status);
            return this.status;
        } catch (error) {
            const failure = infrastructureError(error, "PBR_WORKER_UNAVAILABLE");
            failure.workerCauseCode = failure.code;
            failure.code = "PBR_WORKER_UNAVAILABLE";
            this._failure = failure;
            this._prepared = false;
            this._setStatus("error", null, failure);
            this._terminateWorker();
            throw failure;
        }
    }

    cameraOptions() {
        if (!this.ready) throw infrastructureError(new Error("PBR capture worker is not ready."));
        return {
            renderRuntime: this,
            captureMode: "calibrated-projection@1",
            captureSceneHandle: this.captureSceneHandle,
            analyticSceneHandle: this.analyticSceneHandle,
            authorizeSourceUse: async () => ({ allowed: true }),
            renderPolicy: this.renderPolicy,
            runtimeOwnsProducts: true,
        };
    }

    async prepareCapture({ devices = [], vehicles = this._vehicles() } = {}) {
        if (!this.ready) throw this._failure || infrastructureError(new Error("PBR capture worker is not ready."));
        const result = await this._enqueue("prepareCapture", {
            generation: this.generation,
            positions: devices
                .filter((device) => device?.renderRuntime === this)
                .map(capturePosition),
            vehicles: serializePbrActors(vehicles),
        });
        if (result.status) this._setStatus(result.status.state || "streaming", result.status);
    }

    async captureCamera({ captureInput, enabled, cameraId = "camera" } = {}) {
        if (!this.ready) throw this._failure || infrastructureError(new Error("PBR capture worker is not ready."));
        const result = await this._enqueue("capture", {
            generation: this.generation,
            request: {
                id: String(cameraId),
                captureInput,
                products: { ...enabled },
            },
        });
        for (const [name, durationMs] of Object.entries(result.timings ?? {})) {
            browserSimulationPerformance.recordTiming(`capture.${name}`, durationMs);
        }
        if (result.status) this._setStatus(result.status.state || "streaming", result.status);
        return {
            aligned: result.aligned === true,
            rgb: result.rgb ?? null,
            depth: result.depth ?? null,
            semantic: result.semantic ?? null,
            instance: result.instance ?? null,
        };
    }

    reset() {
        if (!this.ready) return;
        this._enqueue("reset", { generation: this.generation }).catch(() => {});
    }

    _terminateWorker() {
        clearTimeout(this._disposeTimer);
        this._disposeTimer = null;
        this.worker?.terminate?.();
        this.worker = null;
        const pendingRequests = [...this.pending.values()];
        this.pending.clear();
        for (const pending of pendingRequests) {
            pending.reject(infrastructureError(new Error("PBR capture worker was disposed."), "PBR_WORKER_DISPOSED"));
        }
    }

    dispose({ preserveListeners = false, immediate = false } = {}) {
        const worker = this.worker;
        const generation = this.generation;
        this.generation += 1;
        this._prepared = false;
        this.captureSceneHandle = null;
        this.analyticSceneHandle = null;
        this.renderPolicy = null;
        this._failure = null;
        this._operationTail = Promise.resolve();
        if (worker && immediate) {
            this._terminateWorker();
        } else if (worker) {
            const id = ++this.requestId;
            const finished = () => this._terminateWorker();
            this.pending.set(id, { resolve: finished, reject: finished });
            try {
                worker.postMessage({ id, method: "dispose", payload: { generation } });
                this._disposeTimer = setTimeout(finished, 250);
            } catch {
                finished();
            }
        }
        this.status = this._snapshot("idle");
        if (!preserveListeners) this.listeners.clear();
    }
}
