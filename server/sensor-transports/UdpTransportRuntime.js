import dgram from "node:dgram";
import { createHash } from "node:crypto";

import { compareHostPackets, logicalEgressTimeNs } from "./HostPacketOrdering.js";
import {
    UDP_RUNTIME_KIND,
    UDP_RUNTIME_VERSION,
    UDP_TIMING_KIND,
    UDP_TIMING_VERSION,
} from "./UdpTransportContract.js";
import { udpTransportError } from "./UdpTransportErrors.js";

export {
    UDP_RUNTIME_KIND,
    UDP_RUNTIME_VERSION,
    UDP_TIMING_KIND,
    UDP_TIMING_VERSION,
} from "./UdpTransportContract.js";

function copyBytes(value) {
    return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function bigintNs(value, fallback = 0n) {
    if (typeof value === "bigint") return value;
    if (value == null) return fallback;
    return BigInt(value);
}

function socketKey(source) {
    return `${source.address}:${source.port}`;
}

function defaultNowNs() {
    return process.hrtime.bigint();
}

function defaultSchedule(delayNs, callback) {
    const delay = bigintNs(delayNs, 0n);
    const delayMs = delay <= 0n ? 0 : Number(delay / 1_000_000n);
    const timer = setTimeout(callback, Number.isFinite(delayMs) ? delayMs : 0);
    return () => clearTimeout(timer);
}

function defaultSocketFactory(type = "udp4") {
    return dgram.createSocket(type);
}

function capability(message, details) {
    return udpTransportError("UNSUPPORTED_CAPABILITY", message, details);
}

function resource(message, details) {
    return udpTransportError("RESOURCE_LIMIT", message, details);
}

function artifact(message, details) {
    return udpTransportError("ARTIFACT_FAILURE", message, details);
}

function bindExclusive(socket, source) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            socket.off("error", onError);
            socket.off("listening", onListening);
            if (error) reject(error);
            else resolve(socket);
        };
        const onError = (error) => finish(error);
        const onListening = () => finish(null);
        socket.once("error", onError);
        socket.once("listening", onListening);
        try {
            socket.bind({
                address: source.address,
                port: source.port,
                exclusive: true,
            });
        } catch (error) {
            finish(error);
        }
    });
}

function sendDatagram(socket, payload, destination) {
    return new Promise((resolve, reject) => {
        try {
            socket.send(payload, destination.port, destination.address, (error, bytes) => {
                if (error) reject(error);
                else resolve(bytes);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function emptyStats(generation) {
    return {
        generation,
        packetCount: 0,
        payloadBytes: 0,
        sequenceDigest: createHash("sha256"),
        firstLogicalEgressTimeNs: null,
        lastLogicalEgressTimeNs: null,
        firstSubmitOffsetNs: null,
        lastSubmitOffsetNs: null,
        maxSubmitOffsetNs: null,
        firstAcceptOffsetNs: null,
        lastAcceptOffsetNs: null,
        maxAcceptOffsetNs: null,
        firstLatenessNs: null,
        lastLatenessNs: null,
        maxLatenessNs: null,
    };
}

function snapshotNs(current, candidate, { max = false } = {}) {
    if (candidate == null) return current;
    const value = bigintNs(candidate);
    if (current == null) return value.toString();
    const previous = bigintNs(current);
    if (max) return (value > previous ? value : previous).toString();
    return current;
}

export function createFakeMonotonicClock(startNs = 0n) {
    let now = bigintNs(startNs, 0n);
    let paused = false;
    const timers = [];
    async function fireDue() {
        if (paused) return;
        const due = timers
            .filter((timer) => !timer.cancelled && timer.due <= now)
            .sort((left, right) => (left.due < right.due ? -1 : left.due > right.due ? 1 : 0));
        for (const timer of due) {
            if (timer.cancelled || paused) continue;
            timer.cancelled = true;
            await timer.callback();
        }
    }
    return {
        nowNs() {
            return now;
        },
        pause() {
            paused = true;
        },
        resume() {
            paused = false;
        },
        schedule(delayNs, callback) {
            const timer = {
                due: now + bigintNs(delayNs, 0n),
                callback,
                cancelled: false,
            };
            timers.push(timer);
            return () => {
                timer.cancelled = true;
            };
        },
        async advance(ns) {
            now += bigintNs(ns, 0n);
            await fireDue();
        },
        async flush() {
            await fireDue();
        },
        get pendingCount() {
            return timers.filter((timer) => !timer.cancelled).length;
        },
        get paused() {
            return paused;
        },
    };
}

export class UdpTransportRuntime {
    constructor({
        socketFactory = defaultSocketFactory,
        nowNs = defaultNowNs,
        schedule = defaultSchedule,
        identity = null,
    } = {}) {
        this.socketFactory = socketFactory;
        this.nowNs = () => bigintNs(nowNs(), 0n);
        this.schedule = schedule;
        this.identity = identity ?? Object.freeze({
            kind: UDP_RUNTIME_KIND,
            version: UDP_RUNTIME_VERSION,
        });
        this.sockets = new Map();
        this.environments = new Map();
        this.closed = false;
    }

    queuedBytesFor(environmentKey) {
        return Number(this.environments.get(String(environmentKey))?.queuedBytes || 0);
    }

    _session(environmentKey, operation = "submit-batch") {
        const session = this.environments.get(String(environmentKey));
        if (!session) {
            throw udpTransportError("ENVIRONMENT_NOT_FOUND", `UDP environment "${environmentKey}" is not prepared.`, {
                operation,
            });
        }
        return session;
    }

    _fail(session, error, { uncertain = false, endpointId = null, operation = "submit-batch" } = {}) {
        const wrapped = error?.code
            ? error
            : artifact(error.message, {
                endpointId,
                generation: session.generation,
                operation,
                uncertainSubmission: uncertain,
            });
        wrapped.details = {
            ...(wrapped.details && typeof wrapped.details === "object" ? wrapped.details : {}),
            component: "udp-sidecar",
            endpointId: wrapped.details?.endpointId ?? endpointId,
            generation: wrapped.details?.generation ?? session.generation,
            operation: wrapped.details?.operation ?? operation,
            uncertainSubmission: wrapped.details?.uncertainSubmission === true || uncertain,
            requiresReset: true,
        };
        wrapped.requiresReset = true;
        session.failed = wrapped;
        session.uncertain = session.uncertain || uncertain;
        this._clearTimers(session);
        session.unsent = [];
        session.queuedBytes = 0;
        return wrapped;
    }

    _clearTimers(session) {
        for (const timer of session.timers) timer.cancel?.();
        session.timers.clear();
    }

    async _waitUntil(session, targetNs) {
        const delay = bigintNs(targetNs) - this.nowNs();
        if (delay <= 0n) return;
        await new Promise((resolve, reject) => {
            const entry = {
                cancel: null,
            };
            entry.cancel = this.schedule(delay, () => {
                session.timers.delete(entry);
                resolve();
            });
            const original = entry.cancel;
            entry.cancel = () => {
                original?.();
                session.timers.delete(entry);
                reject(udpTransportError("WORKER_CRASHED", "UDP generation was cancelled before datagram submission.", {
                    generation: session.generation,
                    operation: "cancel-generation",
                }));
            };
            session.timers.add(entry);
        });
    }

    async _acquireSocket(source, { endpointId, generation, operation }) {
        const key = socketKey(source);
        const existing = this.sockets.get(key);
        if (existing) {
            existing.refs += 1;
            return existing;
        }
        const socket = this.socketFactory("udp4");
        try {
            await bindExclusive(socket, source);
        } catch (error) {
            try { socket.close?.(); } catch { /* bind failed */ }
            const code = error?.code === "EADDRINUSE" || error?.code === "EACCES" || error?.code === "EADDRNOTAVAIL"
                ? "UNSUPPORTED_CAPABILITY"
                : "UNSUPPORTED_CAPABILITY";
            throw udpTransportError(code, `UDP bind failed for ${source.address}:${source.port}: ${error.message}`, {
                endpointId,
                generation,
                operation,
                extra: { bindError: error.code ?? null },
            });
        }
        const record = { key, source, socket, refs: 1 };
        this.sockets.set(key, record);
        return record;
    }

    _releaseSocket(record) {
        if (!record) return;
        record.refs -= 1;
        if (record.refs > 0) return;
        this.sockets.delete(record.key);
        try { record.socket.close?.(); } catch { /* already closed */ }
    }

    async prepareEnvironment({
        environmentKey,
        endpoints = [],
        bindings = [],
        maxQueueBytes = 0,
        stepNs = 1,
    } = {}) {
        if (this.closed) throw capability("UDP runtime has been shut down.", { operation: "prepare-environment" });
        const key = String(environmentKey || "");
        if (!key) throw capability("UDP environmentKey is required.", { operation: "prepare-environment" });
        if (this.environments.has(key)) {
            throw capability(`UDP environment "${key}" is already prepared.`, {
                operation: "prepare-environment",
            });
        }
        const resolvedEndpoints = new Map();
        const acquired = [];
        try {
            for (const endpoint of endpoints) {
                const record = await this._acquireSocket(endpoint.source, {
                    endpointId: endpoint.id,
                    generation: 0,
                    operation: "prepare-environment",
                });
                acquired.push(record);
                resolvedEndpoints.set(endpoint.id, Object.freeze({
                    ...endpoint,
                    socketKey: record.key,
                }));
            }
        } catch (error) {
            for (const record of acquired) this._releaseSocket(record);
            throw error;
        }
        const bindingMap = new Map();
        for (const binding of bindings) {
            bindingMap.set(`${binding.sensorId}\0${binding.productId}\0${binding.streamId}`, binding);
        }
        this.environments.set(key, {
            environmentKey: key,
            endpoints: resolvedEndpoints,
            bindings: bindingMap,
            sockets: acquired,
            maxQueueBytes: Math.max(0, Number(maxQueueBytes) || 0),
            stepNs: Math.max(1, Number(stepNs) || 1),
            generation: 0,
            active: false,
            anchorNs: null,
            queuedBytes: 0,
            unsent: [],
            timers: new Set(),
            failed: null,
            uncertain: false,
            stats: emptyStats(0),
            timing: [],
            chain: Promise.resolve(),
        });
        return { environmentKey: key, socketCount: new Set(acquired.map((entry) => entry.key)).size };
    }

    async beginGeneration({ environmentKey, generation } = {}) {
        const session = this._session(environmentKey, "begin-generation");
        this._clearTimers(session);
        session.unsent = [];
        session.queuedBytes = 0;
        session.failed = null;
        session.uncertain = false;
        session.generation = Number(generation);
        if (!Number.isSafeInteger(session.generation) || session.generation < 1) {
            throw capability("UDP generation must be a positive safe integer.", {
                generation,
                operation: "begin-generation",
            });
        }
        session.anchorNs = this.nowNs();
        session.active = true;
        session.stats = emptyStats(session.generation);
        session.timing = [];
        return {
            environmentKey: session.environmentKey,
            generation: session.generation,
            anchorNs: session.anchorNs.toString(),
            runtime: this.identity,
        };
    }

    _decoratePacket(session, batch, packet) {
        const binding = session.bindings.get(`${batch.sensorId}\0${packet.productId}\0${packet.streamId}`);
        if (!binding) {
            throw capability(
                `UDP batch references unbound stream ${batch.sensorId}/${packet.productId}/${packet.streamId}.`,
                { generation: session.generation, operation: "submit-batch" },
            );
        }
        const endpoint = session.endpoints.get(binding.endpointId);
        if (!endpoint) {
            throw capability(`UDP endpoint "${binding.endpointId}" is unavailable.`, {
                endpointId: binding.endpointId,
                generation: session.generation,
                operation: "submit-batch",
            });
        }
        const payload = copyBytes(packet.payload);
        if (payload.byteLength > Number(endpoint.maxPayloadBytes)) {
            throw capability(
                `UDP payload ${payload.byteLength} bytes exceeds endpoint "${endpoint.id}" capacity ${endpoint.maxPayloadBytes}.`,
                { endpointId: endpoint.id, generation: session.generation, operation: "submit-batch" },
            );
        }
        const payloadDigest = sha256Hex(payload);
        return {
            sensorId: String(batch.sensorId),
            productId: String(packet.productId),
            streamId: String(packet.streamId),
            sampleIndex: Number(batch.sampleIndex),
            packetIndex: Number(packet.packetIndex),
            offsetNs: Number(packet.offsetNs),
            actualDeliveryStep: Number(batch.actualDeliveryStep),
            captureTimeNs: Number(batch.captureTimeNs),
            scheduledDeliveryTimeNs: Number(batch.scheduledDeliveryTimeNs),
            deliveryTimeNs: Number(batch.deliveryTimeNs),
            payload,
            payloadDigest,
            endpointId: endpoint.id,
            endpoint,
            logicalEgressTimeNs: logicalEgressTimeNs(batch.actualDeliveryStep, session.stepNs, packet.offsetNs),
        };
    }

    async submitBatch(batch = {}) {
        const session = this._session(batch.environmentKey, "submit-batch");
        const run = session.chain.then(() => this._submitBatch(session, batch));
        session.chain = run.catch(() => {});
        return run;
    }

    async _submitBatch(session, batch) {
        if (session.failed) throw session.failed;
        if (!session.active || Number(batch.generation) !== session.generation) {
            throw artifact("UDP batch generation does not match the active generation.", {
                generation: session.generation,
                operation: "submit-batch",
                extra: { submittedGeneration: batch.generation ?? null },
            });
        }
        const packets = Array.isArray(batch.packets) ? batch.packets : [];
        const decorated = packets.map((packet) => this._decoratePacket(session, batch, packet));
        decorated.sort(compareHostPackets);
        const batchBytes = decorated.reduce((total, packet) => total + packet.payload.byteLength, 0);
        if (session.maxQueueBytes > 0 && session.queuedBytes + batchBytes > session.maxQueueBytes) {
            throw resource(
                `UDP queue used ${session.queuedBytes + batchBytes} bytes, exceeding the ${session.maxQueueBytes}-byte limit.`,
                {
                    generation: session.generation,
                    operation: "submit-batch",
                    extra: {
                        queuedBytes: session.queuedBytes + batchBytes,
                        maxQueueBytes: session.maxQueueBytes,
                    },
                },
            );
        }
        session.queuedBytes += batchBytes;
        session.unsent = decorated.slice();
        let sent = false;
        try {
            for (const packet of decorated) {
                if (session.failed) throw session.failed;
                await this._sendPacket(session, packet);
                sent = true;
                session.unsent = session.unsent.filter((entry) => entry !== packet);
                session.queuedBytes = Math.max(0, session.queuedBytes - packet.payload.byteLength);
            }
            return { accepted: decorated.length, payloadBytes: batchBytes };
        } catch (error) {
            throw this._fail(session, error, {
                uncertain: sent,
                endpointId: error?.details?.endpointId ?? null,
                operation: "submit-batch",
            });
        }
    }

    async _sendPacket(session, packet) {
        const endpoint = packet.endpoint;
        const targetNs = endpoint.pacing?.mode === "packet-offset"
            ? session.anchorNs
                + BigInt(packet.actualDeliveryStep) * BigInt(session.stepNs)
                + BigInt(packet.offsetNs)
            : null;
        if (targetNs != null) {
            await this._waitUntil(session, targetNs);
            if (session.failed) throw session.failed;
            if (!session.active) {
                throw udpTransportError("WORKER_CRASHED", "UDP generation was cancelled before datagram submission.", {
                    endpointId: endpoint.id,
                    generation: session.generation,
                    operation: "submit-batch",
                });
            }
        }
        const submitNs = this.nowNs();
        const latenessNs = targetNs == null ? 0n : submitNs - targetNs;
        if (targetNs != null && latenessNs > BigInt(endpoint.pacing.latenessBudgetNs)) {
            throw resource(
                `UDP packet-offset lateness ${latenessNs} ns exceeded budget ${endpoint.pacing.latenessBudgetNs} ns.`,
                {
                    endpointId: endpoint.id,
                    generation: session.generation,
                    operation: "submit-batch",
                    extra: {
                        latenessNs: latenessNs.toString(),
                        latenessBudgetNs: endpoint.pacing.latenessBudgetNs,
                    },
                },
            );
        }
        const socket = this.sockets.get(endpoint.socketKey)?.socket;
        if (!socket) {
            throw artifact(`UDP socket for endpoint "${endpoint.id}" is unavailable.`, {
                endpointId: endpoint.id,
                generation: session.generation,
                operation: "submit-batch",
            });
        }
        try {
            await sendDatagram(socket, packet.payload, endpoint.destination);
        } catch (error) {
            throw artifact(`UDP send failed for endpoint "${endpoint.id}": ${error.message}`, {
                endpointId: endpoint.id,
                generation: session.generation,
                operation: "submit-batch",
                uncertainSubmission: true,
                extra: { sendError: error.code ?? null },
            });
        }
        const acceptNs = this.nowNs();
        this._recordSuccess(session, packet, { submitNs, acceptNs, latenessNs, targetNs });
    }

    _recordSuccess(session, packet, { submitNs, acceptNs, latenessNs }) {
        const submitOffset = submitNs - session.anchorNs;
        const acceptOffset = acceptNs - session.anchorNs;
        const logical = packet.logicalEgressTimeNs.toString();
        const stats = session.stats;
        stats.packetCount += 1;
        stats.payloadBytes += packet.payload.byteLength;
        stats.sequenceDigest.update(packet.payload);
        if (stats.firstLogicalEgressTimeNs == null) stats.firstLogicalEgressTimeNs = logical;
        stats.lastLogicalEgressTimeNs = logical;
        if (stats.firstSubmitOffsetNs == null) stats.firstSubmitOffsetNs = submitOffset.toString();
        stats.lastSubmitOffsetNs = submitOffset.toString();
        stats.maxSubmitOffsetNs = snapshotNs(stats.maxSubmitOffsetNs, submitOffset, { max: true });
        if (stats.firstAcceptOffsetNs == null) stats.firstAcceptOffsetNs = acceptOffset.toString();
        stats.lastAcceptOffsetNs = acceptOffset.toString();
        stats.maxAcceptOffsetNs = snapshotNs(stats.maxAcceptOffsetNs, acceptOffset, { max: true });
        if (stats.firstLatenessNs == null) stats.firstLatenessNs = latenessNs.toString();
        stats.lastLatenessNs = latenessNs.toString();
        stats.maxLatenessNs = snapshotNs(stats.maxLatenessNs, latenessNs, { max: true });
        session.timing.push(Object.freeze({
            sensorId: packet.sensorId,
            productId: packet.productId,
            streamId: packet.streamId,
            sampleIndex: packet.sampleIndex,
            packetIndex: packet.packetIndex,
            endpointId: packet.endpointId,
            logicalEgressTimeNs: logical,
            submitOffsetNs: submitOffset.toString(),
            acceptOffsetNs: acceptOffset.toString(),
            latenessNs: latenessNs.toString(),
            payloadLength: packet.payload.byteLength,
            payloadDigest: packet.payloadDigest,
            generation: session.generation,
        }));
    }

    async cancelGeneration({ environmentKey, generation } = {}) {
        const session = this.environments.get(String(environmentKey));
        if (!session) return { cancelled: false };
        if (generation != null && Number(generation) !== session.generation) {
            return { cancelled: false, generation: session.generation };
        }
        this._clearTimers(session);
        session.active = false;
        session.unsent = [];
        session.queuedBytes = 0;
        return { cancelled: true, generation: session.generation };
    }

    evidenceFor(environmentKey) {
        const session = this.environments.get(String(environmentKey));
        if (!session) return null;
        const stats = session.stats;
        return Object.freeze({
            generation: session.generation,
            sidecar: this.identity,
            runtime: this.identity,
            endpoints: Object.freeze([...session.endpoints.values()].map((endpoint) => Object.freeze({
                id: endpoint.id,
                mtu: endpoint.mtu,
                maxPayloadBytes: endpoint.maxPayloadBytes,
                source: endpoint.source,
                destination: endpoint.destination,
                pacing: endpoint.pacing,
            }))),
            packetCount: stats.packetCount,
            payloadBytes: stats.payloadBytes,
            sequenceDigest: stats.packetCount > 0 ? stats.sequenceDigest.copy().digest("hex") : null,
            firstLogicalEgressTimeNs: stats.firstLogicalEgressTimeNs,
            lastLogicalEgressTimeNs: stats.lastLogicalEgressTimeNs,
            firstSubmitOffsetNs: stats.firstSubmitOffsetNs,
            lastSubmitOffsetNs: stats.lastSubmitOffsetNs,
            maxSubmitOffsetNs: stats.maxSubmitOffsetNs,
            firstAcceptOffsetNs: stats.firstAcceptOffsetNs,
            lastAcceptOffsetNs: stats.lastAcceptOffsetNs,
            maxAcceptOffsetNs: stats.maxAcceptOffsetNs,
            firstLatenessNs: stats.firstLatenessNs,
            lastLatenessNs: stats.lastLatenessNs,
            maxLatenessNs: stats.maxLatenessNs,
            uncertainSubmission: session.uncertain,
        });
    }

    timingRecords(environmentKey) {
        const session = this.environments.get(String(environmentKey));
        return Object.freeze([...(session?.timing ?? [])]);
    }

    async finalizeGeneration({ environmentKey, generation } = {}) {
        const session = this._session(environmentKey, "finalize-generation");
        if (session.failed) throw session.failed;
        if (generation != null && Number(generation) !== session.generation) {
            throw artifact("UDP finalize generation does not match the active generation.", {
                generation: session.generation,
                operation: "finalize-generation",
            });
        }
        await session.chain.catch(() => {});
        if (session.failed) throw session.failed;
        session.active = false;
        return {
            evidence: this.evidenceFor(environmentKey),
            timing: this.timingRecords(environmentKey),
        };
    }

    async releaseEnvironment({ environmentKey } = {}) {
        const session = this.environments.get(String(environmentKey));
        if (!session) return { released: false };
        this._clearTimers(session);
        session.active = false;
        for (const record of session.sockets) this._releaseSocket(record);
        this.environments.delete(String(environmentKey));
        return { released: true };
    }

    async shutdown() {
        this.closed = true;
        const keys = [...this.environments.keys()];
        await Promise.all(keys.map((environmentKey) => this.releaseEnvironment({ environmentKey })));
        for (const record of [...this.sockets.values()]) {
            record.refs = 0;
            this._releaseSocket(record);
        }
    }
}

export function createUdpTransportRuntime(options) {
    return new UdpTransportRuntime(options);
}
