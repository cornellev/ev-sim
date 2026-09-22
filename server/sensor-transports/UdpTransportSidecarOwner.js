import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { reviveUdpError, udpTransportError } from "./UdpTransportErrors.js";

const SIDECAR_PATH = fileURLToPath(new URL("./UdpTransportSidecar.js", import.meta.url));

function crashed(message, details = {}) {
    return udpTransportError("WORKER_CRASHED", message, {
        operation: details.operation ?? "sidecar",
        extra: details,
    });
}

export class UdpTransportSidecarOwner {
    constructor({
        shutdownGraceMs = 5_000,
        killGraceMs = 5_000,
        forkImpl = fork,
        onExit = null,
    } = {}) {
        this.shutdownGraceMs = shutdownGraceMs;
        this.killGraceMs = killGraceMs;
        this.forkImpl = forkImpl;
        this.onExit = onExit;
        this.child = null;
        this.pid = null;
        this.nextRequestId = 1;
        this.pending = new Map();
        this.environments = new Set();
        this.queuedBytes = new Map();
        this.exited = true;
        this.starting = null;
        this.exitPromise = Promise.resolve();
        this._resolveExit = () => {};
        this.identity = null;
    }

    get started() {
        return Boolean(this.child) && !this.exited;
    }

    queuedBytesFor(environmentKey) {
        return Number(this.queuedBytes.get(String(environmentKey)) || 0);
    }

    registeredEnvironments() {
        return [...this.environments];
    }

    _start() {
        if (this.started) return;
        this.exited = false;
        this.identity = null;
        this.child = this.forkImpl(SIDECAR_PATH, [], {
            detached: false,
            serialization: "advanced",
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            execArgv: ["--experimental-default-type=module"],
            env: { ...process.env },
        });
        this.pid = this.child.pid;
        this.identity = Object.freeze({
            kind: "cev-sim.udp-transport-sidecar",
            version: 1,
            pid: this.pid,
        });
        this.exitPromise = new Promise((resolve) => { this._resolveExit = resolve; });
        this.child.on("message", (message) => this._message(message));
        this.child.on("error", (error) => this._failAll(crashed(`UDP sidecar IPC failed: ${error.message}`, {
            pid: this.pid,
        })));
        this.child.on("exit", (code, signal) => {
            this.exited = true;
            const error = crashed(`UDP sidecar ${this.pid} exited (${signal || code}).`, {
                pid: this.pid,
                code,
                signal,
            });
            this._failAll(error);
            this.child = null;
            this._resolveExit({ code, signal, error });
            this.onExit?.({ code, signal, error, environments: [...this.environments] }, this);
            this.environments.clear();
            this.queuedBytes.clear();
        });
    }

    async ensureStarted() {
        if (this.started) return this;
        if (this.starting) return this.starting;
        this.starting = Promise.resolve().then(() => {
            this._start();
            return this;
        }).finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    _message(message) {
        if (message?.kind !== "cev-sim.udp-sidecar-response") return;
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        if (message.error) pending.reject(reviveUdpError(message.error));
        else pending.resolve(message.result);
    }

    _failAll(error) {
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending) entry.reject(error);
    }

    dispatch(command, payload = {}, { timeoutMs = 0 } = {}) {
        if (!this.started || !this.child?.connected) {
            return Promise.reject(crashed("UDP sidecar is unavailable.", { operation: command }));
        }
        const requestId = this.nextRequestId++;
        const request = {
            kind: "cev-sim.udp-sidecar-request",
            requestId,
            command,
            payload,
        };
        return new Promise((resolve, reject) => {
            let timer = null;
            const fail = (error) => {
                if (!this.pending.has(requestId)) return;
                this.pending.delete(requestId);
                clearTimeout(timer);
                reject(error);
            };
            if (timeoutMs > 0) {
                timer = setTimeout(() => fail(crashed(`UDP sidecar ${command} exceeded ${timeoutMs} ms.`, {
                    operation: command,
                    timeoutMs,
                })), timeoutMs);
            }
            this.pending.set(requestId, {
                resolve: (result) => {
                    clearTimeout(timer);
                    resolve(result);
                },
                reject: (error) => fail(error),
            });
            try {
                const accepted = this.child.send(request, (error) => {
                    if (error) fail(crashed(`UDP sidecar dispatch failed: ${error.message}`, { operation: command }));
                });
                // Node's IPC writable high-water mark is 16 KiB. A Helios scan
                // is one submit-batch well above that, so send() returns false
                // while the message remains queued. The callback reports a real
                // write failure; the sidecar response resolves this request.
                if (!accepted && !this.child.connected) {
                    fail(crashed("UDP sidecar is unavailable.", { operation: command }));
                }
            } catch (error) {
                fail(crashed(`UDP sidecar dispatch failed: ${error.message}`, { operation: command }));
            }
        });
    }

    async prepareEnvironment(payload) {
        await this.ensureStarted();
        const result = await this.dispatch("prepare-environment", payload);
        this.environments.add(String(payload.environmentKey));
        this.queuedBytes.set(String(payload.environmentKey), 0);
        return result;
    }

    async beginGeneration(payload) {
        return this.dispatch("begin-generation", payload);
    }

    async submitBatch(payload) {
        const key = String(payload.environmentKey);
        try {
            const result = await this.dispatch("submit-batch", payload);
            const queued = await this.dispatch("queued-bytes", { environmentKey: key }).catch(() => ({ queuedBytes: 0 }));
            this.queuedBytes.set(key, Number(queued.queuedBytes || 0));
            return result;
        } catch (error) {
            const queued = await this.dispatch("queued-bytes", { environmentKey: key }).catch(() => ({ queuedBytes: 0 }));
            this.queuedBytes.set(key, Number(queued.queuedBytes || 0));
            throw error;
        }
    }

    async finalizeGeneration(payload) {
        const result = await this.dispatch("finalize-generation", payload);
        this.queuedBytes.set(String(payload.environmentKey), 0);
        return result;
    }

    async cancelGeneration(payload) {
        if (!this.started) return { cancelled: false };
        const result = await this.dispatch("cancel-generation", payload);
        this.queuedBytes.set(String(payload.environmentKey), 0);
        return result;
    }

    async releaseEnvironment(payload) {
        const key = String(payload.environmentKey);
        if (this.started) {
            await this.dispatch("release-environment", payload).catch(() => {});
        }
        this.environments.delete(key);
        this.queuedBytes.delete(key);
        return { released: true };
    }

    terminate(signal = "SIGTERM") {
        if (this.started) this.child.kill(signal);
    }

    async close() {
        if (this.exited && !this.child) return this.exitPromise;
        if (this.started && this.child.connected && this.pending.size === 0) {
            try {
                await this.dispatch("shutdown", {}, { timeoutMs: this.shutdownGraceMs });
            } catch {
                // Escalate below.
            }
        }
        if (!this.exited) this.child?.kill("SIGTERM");
        const terminated = await Promise.race([
            this.exitPromise.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), this.killGraceMs)),
        ]);
        if (!terminated && !this.exited) this.child?.kill("SIGKILL");
        return this.exitPromise;
    }
}

export function createUdpTransportSidecarOwner(options) {
    return new UdpTransportSidecarOwner(options);
}
