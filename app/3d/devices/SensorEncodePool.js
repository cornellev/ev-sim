/**
 * Bounded main-thread facade for sensorEncode.worker.js.
 * Falls back to synchronous encodeTopicValue when Workers are unavailable.
 */

import { encodeTopicValue } from "../../client/Client.js";
import { catalogSchemas } from "../../autonomy/AutonomyContractCatalog.js";

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_MAX_PENDING_JOBS = 4;
const DEFAULT_MAX_PENDING_BYTES = 48 * 1024 * 1024;
const DEFAULT_JOB_TIMEOUT_MS = 5000;

let sharedSeq = 0;
let pool = null;

function estimateEncodeBytes(value) {
    if (!value) return 0;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value.data)) return value.data.byteLength;
    if (value.data instanceof ArrayBuffer) return value.data.byteLength;
    return 0;
}

function createWorker() {
    if (typeof Worker === "undefined") return null;
    try {
        return new Worker(new URL("./sensorEncode.worker.js", import.meta.url), { type: "module" });
    } catch (error) {
        console.warn("Sensor encode worker unavailable:", error?.message || error);
        return null;
    }
}

class SensorEncodePool {
    constructor({
        workerCount = DEFAULT_WORKER_COUNT,
        maxPendingJobs = DEFAULT_MAX_PENDING_JOBS,
        maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
        jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    } = {}) {
        this.workerCount = Math.max(1, workerCount);
        this.maxPendingJobs = Math.max(1, maxPendingJobs);
        this.maxPendingBytes = Math.max(1024, maxPendingBytes);
        this.jobTimeoutMs = Math.max(100, jobTimeoutMs);
        this.workers = [];
        this.pending = new Map();
        this.pendingBytes = 0;
        this.ownerGenerations = new Map();
        this.rejectedJobs = 0;
        this.cancelledJobs = 0;
        this.timedOutJobs = 0;
        this.restartCount = 0;
        this._init();
    }

    _init() {
        for (let index = 0; index < this.workerCount; index += 1) {
            const worker = createWorker();
            if (!worker) break;
            this._bindWorker(worker, index);
            this.workers.push(worker);
        }
        for (const worker of this.workers) {
            worker.postMessage({
                id: "init-kernels",
                init: true,
                schemas: catalogSchemas(),
            });
        }
    }

    _bindWorker(worker, index) {
        worker.onmessage = (event) => {
            const { id, ok, bytes, error, kind } = event.data || {};
            if (kind === "init") return;
            const entry = this.pending.get(id);
            if (!entry) return;
            this._finish(id, entry, ok
                ? (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []))
                : null,
            ok ? null : new Error(error || "encode worker failed"));
        };
        worker.onerror = (event) => {
            const message = event?.message || "encode worker error";
            this._restartWorker(index, message);
        };
        worker.onmessageerror = () => {
            this._restartWorker(index, "encode worker message error");
        };
    }

    _disableWorkers(reason) {
        console.warn("Sensor encode worker disabled; using synchronous encode.", reason);
        for (const [id, entry] of [...this.pending.entries()]) {
            this.cancelledJobs += 1;
            this._finish(id, entry, null, new Error("encode cancelled"));
        }
        for (const worker of this.workers) {
            try {
                worker?.terminate?.();
            } catch {
                /* ignore */
            }
        }
        this.workers = [];
    }

    _restartWorker(index, reason) {
        this.restartCount += 1;
        if (this.restartCount > 2) {
            this._disableWorkers(reason);
            return;
        }
        const stale = [...this.pending.entries()].filter(([, entry]) => entry.workerIndex === index);
        for (const [id, entry] of stale) {
            this._finish(id, entry, null, new Error("encode cancelled"));
        }
        try {
            this.workers[index]?.terminate?.();
        } catch {
            /* ignore */
        }
        const worker = createWorker();
        if (!worker) {
            this.workers[index] = null;
            this._disableWorkers(reason);
            return;
        }
        this._bindWorker(worker, index);
        worker.postMessage({
            id: "init-kernels",
            init: true,
            schemas: catalogSchemas(),
        });
        this.workers[index] = worker;
    }

    _finish(id, entry, bytes, error) {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.pendingBytes = Math.max(0, this.pendingBytes - (entry.bytes || 0));
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        if (error) entry.reject(error);
        else entry.resolve(bytes);
    }

    getStats() {
        return {
            workers: this.workers.filter(Boolean).length,
            pendingJobs: this.pending.size,
            pendingBytes: this.pendingBytes,
            maxPendingJobs: this.maxPendingJobs,
            maxPendingBytes: this.maxPendingBytes,
            rejectedJobs: this.rejectedJobs,
            cancelledJobs: this.cancelledJobs,
            timedOutJobs: this.timedOutJobs,
        };
    }

    hasCapacity(bytes = 0) {
        if (this.workers.length === 0) return true;
        return this.pending.size < this.maxPendingJobs
            && this.pendingBytes + Math.max(0, bytes) <= this.maxPendingBytes;
    }

    bumpOwnerGeneration(ownerId) {
        if (!ownerId) return 0;
        const next = (this.ownerGenerations.get(ownerId) || 0) + 1;
        this.ownerGenerations.set(ownerId, next);
        return next;
    }

    cancelOwner(ownerId) {
        if (!ownerId) return 0;
        const generation = this.bumpOwnerGeneration(ownerId);
        let cancelled = 0;
        for (const [id, entry] of [...this.pending.entries()]) {
            if (entry.ownerId !== ownerId) continue;
            this.cancelledJobs += 1;
            cancelled += 1;
            this._finish(id, entry, null, new Error("encode cancelled"));
        }
        return { cancelled, generation };
    }

    encode(typeStr, value, {
        forceSync = false,
        ownerId = null,
        ownerGeneration = null,
    } = {}) {
        if (forceSync || !isHeavySensorValue(value) || this.workers.length === 0) {
            return Promise.resolve(encodeTopicValue(typeStr, value));
        }
        const bytes = estimateEncodeBytes(value);
        if (!this.hasCapacity(bytes)) {
            this.rejectedJobs += 1;
            return Promise.reject(new Error("encode-pool-full"));
        }
        const generation = ownerGeneration ?? this.ownerGenerations.get(ownerId) ?? 0;
        if (ownerId && (this.ownerGenerations.get(ownerId) || 0) !== generation) {
            this.cancelledJobs += 1;
            return Promise.reject(new Error("encode cancelled"));
        }
        const id = `enc-${++sharedSeq}`;
        const workerIndex = this.pending.size % this.workers.length;
        const worker = this.workers[workerIndex];
        if (!worker) {
            return Promise.resolve(encodeTopicValue(typeStr, value));
        }
        return new Promise((resolve, reject) => {
            const entry = {
                resolve: (result) => {
                    if (ownerId && (this.ownerGenerations.get(ownerId) || 0) !== generation) {
                        this.cancelledJobs += 1;
                        reject(new Error("encode cancelled"));
                        return;
                    }
                    resolve(result);
                },
                reject,
                bytes,
                ownerId,
                ownerGeneration: generation,
                workerIndex,
                timeoutId: null,
            };
            entry.timeoutId = setTimeout(() => {
                this.timedOutJobs += 1;
                this._finish(id, entry, null, new Error("encode timeout"));
                this._restartWorker(workerIndex, "encode timeout");
            }, this.jobTimeoutMs);
            this.pending.set(id, entry);
            this.pendingBytes += bytes;
            if (value?.data?.buffer instanceof ArrayBuffer) {
                // Copy before transfer so the main-thread message value stays valid for SignalStore.
                const copy = value.data.slice();
                const payload = { ...value, data: copy };
                worker.postMessage({ id, typeStr, value: payload }, [copy.buffer]);
                return;
            }
            worker.postMessage({ id, typeStr, value });
        });
    }

    dispose() {
        for (const [id, entry] of [...this.pending.entries()]) {
            this._finish(id, entry, null, new Error("encode pool disposed"));
        }
        for (const worker of this.workers) {
            try {
                worker?.terminate?.();
            } catch {
                /* ignore */
            }
        }
        this.workers = [];
        this.ownerGenerations.clear();
    }
}

function getPool() {
    if (!pool) pool = new SensorEncodePool();
    return pool;
}

export function isHeavySensorValue(value) {
    if (!value || typeof value !== "object") return false;
    if (ArrayBuffer.isView(value)) return value.byteLength >= 1024;
    if (ArrayBuffer.isView(value.data)) {
        if (value.encoding != null && Number.isFinite(Number(value.width))) return true;
        if (Array.isArray(value.fields) && Number.isFinite(Number(value.point_step))) return true;
    }
    return false;
}

/**
 * Encode a ROS message, preferring the worker for heavy payloads.
 * @returns {Promise<Uint8Array>}
 */
export function encodeTopicValueAsync(typeStr, value, options = {}) {
    return getPool().encode(typeStr, value, options);
}

export function encodePoolHasCapacity(bytes = 0) {
    return getPool().hasCapacity(bytes);
}

export function encodePoolStats() {
    return getPool().getStats();
}

export function cancelEncodeOwner(ownerId) {
    return getPool().cancelOwner(ownerId);
}

export function bumpEncodeOwnerGeneration(ownerId) {
    return getPool().bumpOwnerGeneration(ownerId);
}

export function resetEncodePoolForTests(options = {}) {
    pool?.dispose?.();
    pool = new SensorEncodePool(options);
    return pool;
}

export { SensorEncodePool, estimateEncodeBytes };
