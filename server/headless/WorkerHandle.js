import { fork } from "node:child_process";
import { serialize } from "node:v8";
import { fileURLToPath } from "node:url";

import { supervisorError } from "./HeadlessProtocol.js";

const WORKER_PATH = fileURLToPath(new URL("./HeadlessWorker.js", import.meta.url));
const MiB = 1024 * 1024;

function workerError(value, fallback = "INTERNAL") {
    const error = new Error(value?.message || "Worker command failed.");
    error.name = value?.name || "WorkerError";
    error.code = value?.code || fallback;
    error.details = value?.details ?? null;
    if (value?.stack) error.stack = value.stack;
    return error;
}

export class WorkerHandle {
    constructor({
        limits,
        memoryPollIntervalMs = 250,
        shutdownGraceMs = 5_000,
        killGraceMs = 5_000,
        onHealth = null,
        onExit = null,
    } = {}) {
        this.limits = limits;
        this.shutdownGraceMs = shutdownGraceMs;
        this.killGraceMs = killGraceMs;
        this.onHealth = onHealth;
        this.onExit = onExit;
        this.nextRequestId = 1;
        this.pending = null;
        this.pendingBytes = 0;
        this.health = null;
        this.exited = false;
        const heapMb = Math.max(16, Math.floor(Number(limits.maxHeapBytesPerEnvironment) / MiB));
        this.child = fork(WORKER_PATH, [], {
            detached: false,
            serialization: "advanced",
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            execArgv: ["--experimental-default-type=module", `--max-old-space-size=${heapMb}`],
            env: { ...process.env, CEV_SIM_WORKER_HEALTH_MS: String(memoryPollIntervalMs) },
        });
        this.pid = this.child.pid;
        this.exitPromise = new Promise((resolve) => { this._resolveExit = resolve; });
        this.child.on("message", (message) => this._message(message));
        this.child.on("error", (error) => this._failPending(workerError(error, "WORKER_CRASHED")));
        this.child.on("exit", (code, signal) => {
            this.exited = true;
            const error = supervisorError("WORKER_CRASHED", `Worker ${this.pid} exited (${signal || code}).`, { pid: this.pid, code, signal });
            this._failPending(error);
            this._resolveExit({ code, signal });
            this.onExit?.({ code, signal, error }, this);
        });
    }

    _message(message) {
        if (message?.health) {
            this.health = message.health;
            this.onHealth?.(message.health, this);
        }
        if (message?.kind !== "cev-sim.worker-response") return;
        if (!this.pending || message.requestId !== this.pending.requestId) return;
        const pending = this.pending;
        this.pending = null;
        this.pendingBytes = 0;
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        if (message.error) pending.reject(workerError(message.error));
        else pending.resolve(message.result);
    }

    _failPending(error) {
        if (!this.pending) return;
        const pending = this.pending;
        this.pending = null;
        this.pendingBytes = 0;
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        pending.reject(error);
    }

    dispatch(command, payload = {}, { timeoutMs = 0, signal = null } = {}) {
        if (this.exited || !this.child.connected) return Promise.reject(supervisorError("WORKER_CRASHED", `Worker ${this.pid} is unavailable.`));
        if (this.pending) return Promise.reject(supervisorError("INTERNAL", `Worker ${this.pid} already has a command in flight.`));
        if (signal?.aborted) return Promise.reject(supervisorError("WORKER_CRASHED", `Worker ${this.pid} dispatch was cancelled before it began.`, { pid: this.pid, command, cancelled: true }));
        const requestId = this.nextRequestId++;
        const request = { kind: "cev-sim.worker-request", requestId, command, payload };
        const bytes = serialize(request).byteLength;
        if (bytes > this.limits.maxQueueBytes) {
            return Promise.reject(supervisorError("RESOURCE_LIMIT", `Worker IPC request used ${bytes} bytes, exceeding the ${this.limits.maxQueueBytes}-byte queue limit.`, {
                ipcBytes: bytes,
                maxQueueBytes: this.limits.maxQueueBytes,
            }));
        }
        return new Promise((resolve, reject) => {
            let timer = null;
            let removeAbort = null;
            const failUncertain = (error) => {
                if (!this.pending || this.pending.requestId !== requestId) return;
                this._failPending(error);
                this.terminate();
            };
            if (timeoutMs > 0) {
                timer = setTimeout(() => failUncertain(supervisorError(
                    command === "step" ? "STEP_TIMEOUT" : "WORKER_CRASHED",
                    `Worker ${this.pid} ${command} exceeded ${timeoutMs} ms.`,
                    { pid: this.pid, command, timeoutMs },
                )), timeoutMs);
            }
            if (signal) {
                const onAbort = () => failUncertain(supervisorError("WORKER_CRASHED", `Worker ${this.pid} dispatch was cancelled and its outcome is uncertain.`, { pid: this.pid, command, cancelled: true }));
                signal.addEventListener("abort", onAbort, { once: true });
                removeAbort = () => signal.removeEventListener("abort", onAbort);
            }
            this.pending = { requestId, resolve, reject, timer, removeAbort };
            this.pendingBytes = bytes;
            let accepted;
            try {
                accepted = this.child.send(request, (error) => {
                    if (error) failUncertain(supervisorError("WORKER_CRASHED", `Worker ${this.pid} IPC dispatch failed: ${error.message}`, { pid: this.pid, command }));
                });
            } catch (error) {
                failUncertain(supervisorError("WORKER_CRASHED", `Worker ${this.pid} IPC dispatch failed: ${error.message}`, { pid: this.pid, command }));
                return;
            }
            if (!accepted) {
                failUncertain(supervisorError("RESOURCE_LIMIT", `Worker ${this.pid} IPC backpressure made ${command} dispatch uncertain.`, { pid: this.pid, command, ipcBytes: bytes }));
            }
        });
    }

    terminate(signal = "SIGTERM") {
        if (!this.exited) this.child.kill(signal);
    }

    async close() {
        if (this.exited) return this.exitPromise;
        if (!this.pending && this.child.connected) {
            try {
                await this.dispatch("close", {}, { timeoutMs: this.shutdownGraceMs });
            } catch {
                // Escalate below.
            }
        }
        if (!this.exited) this.child.kill("SIGTERM");
        const terminated = await Promise.race([
            this.exitPromise.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), this.killGraceMs)),
        ]);
        if (!terminated && !this.exited) this.child.kill("SIGKILL");
        return this.exitPromise;
    }
}
