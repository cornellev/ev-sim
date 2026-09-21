import { promises as fs } from "node:fs";
import path from "node:path";

import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { compareHostPackets, logicalEgressTimeNs } from "../sensor-transports/HostPacketOrdering.js";
import { UDP_TIMING_KIND, UDP_TIMING_VERSION } from "../sensor-transports/UdpTransportContract.js";
import { udpTransportError } from "../sensor-transports/UdpTransportErrors.js";

function copyBytes(value) {
    return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

export class WorkerPacketTransportSink {
    constructor({
        request,
        maxQueueBytes = 0,
        stepNs = 1,
    } = {}) {
        if (typeof request !== "function") {
            throw new HeadlessRunnerError("INTERNAL", "UDP packet IPC request function is required.");
        }
        this.request = request;
        this.maxQueueBytes = Math.max(0, Number(maxQueueBytes) || 0);
        this.stepNs = Math.max(1, Number(stepNs) || 1);
        this.bindings = [];
        this.pending = [];
        this.inFlight = Promise.resolve();
        this.generation = 0;
        this.active = false;
        this.queued = 0;
        this.stagingDirectory = null;
        this.failed = null;
        this.configured = false;
        this.evidence = null;
    }

    get queuedBytes() {
        return this.queued;
    }

    _fail(error) {
        this.failed = error instanceof HeadlessRunnerError
            ? error
            : udpTransportError("ARTIFACT_FAILURE", error.message, { operation: "submit-batch" });
        return this.failed;
    }

    _guard() {
        if (this.failed) throw this.failed;
    }

    configure({ bindings = [], stepNs, maxQueueBytes } = {}) {
        this._guard();
        this.bindings = (bindings ?? []).filter((entry) => entry.adapter === "udp").map((entry) => Object.freeze({
            sensorId: entry.sensorId,
            productId: entry.productId,
            streamId: entry.streamId,
            adapter: "udp",
            endpointId: entry.endpointId,
        }));
        if (stepNs != null) this.stepNs = Math.max(1, Number(stepNs) || 1);
        if (maxQueueBytes != null) this.maxQueueBytes = Math.max(0, Number(maxQueueBytes) || 0);
        this.configured = true;
        return this;
    }

    bindingFor(sensorId, productId, streamId) {
        return this.bindings.find((entry) => (
            entry.sensorId === sensorId
            && entry.productId === productId
            && entry.streamId === streamId
        )) ?? null;
    }

    attachArtifactRoot(stagingDirectory) {
        this.stagingDirectory = stagingDirectory ?? null;
        return this;
    }

    async beginEpisode() {
        this.failed = null;
        this.pending = [];
        this.queued = 0;
        this.evidence = null;
        if (this.active || this.generation > 0) {
            try {
                await this.request("cancel-generation", { generation: this.generation });
            } catch {
                // The replacement generation is the recovery path.
            }
        }
        this.active = false;
        return this;
    }

    async beginGeneration() {
        this._guard();
        const result = await this.request("begin-generation", {});
        this.generation = Number(result?.generation || 0);
        this.active = true;
        this.pending = [];
        this.queued = 0;
        return result;
    }

    enqueueBatch(batch) {
        this._guard();
        if (!this.configured || this.bindings.length === 0) return;
        const packets = [];
        for (const packet of Array.isArray(batch?.packets) ? batch.packets : []) {
            const binding = this.bindingFor(batch.sensorId, packet.productId, packet.streamId);
            if (!binding) continue;
            const payload = copyBytes(packet.payload);
            packets.push({
                productId: String(packet.productId),
                streamId: String(packet.streamId),
                packetIndex: Number(packet.packetIndex),
                offsetNs: Number(packet.offsetNs),
                payload,
                payloadDigest: packet.payloadDigest ?? null,
                endpointId: binding.endpointId,
            });
        }
        if (packets.length === 0) return;
        const bytes = packets.reduce((total, packet) => total + packet.payload.byteLength, 0);
        if (this.maxQueueBytes > 0 && this.queued + bytes > this.maxQueueBytes) {
            throw this._fail(udpTransportError(
                "RESOURCE_LIMIT",
                `UDP IPC queue used ${this.queued + bytes} bytes, exceeding the ${this.maxQueueBytes}-byte limit.`,
                {
                    operation: "submit-batch",
                    generation: this.generation,
                    extra: { queuedBytes: this.queued + bytes, maxQueueBytes: this.maxQueueBytes },
                },
            ));
        }
        this.queued += bytes;
        this.pending.push({
            sensorId: String(batch.sensorId),
            sampleIndex: Number(batch.sampleIndex),
            actualDeliveryStep: Number(batch.actualDeliveryStep),
            captureTimeNs: Number(batch.captureTimeNs),
            scheduledDeliveryTimeNs: Number(batch.scheduledDeliveryTimeNs),
            deliveryTimeNs: Number(batch.deliveryTimeNs),
            packets,
            bytes,
        });
    }

    endDeliveryStep(_clock) {
        this._guard();
        if (this.pending.length === 0) return;
        const pending = this.pending;
        this.pending = [];
        const work = this.inFlight.then(() => this._submitPending(pending));
        this.inFlight = work.catch((error) => {
            this._fail(error);
        });
        return work;
    }

    async _submitPending(pending) {
        const packets = [];
        for (const batch of pending) {
            for (const packet of batch.packets) {
                packets.push({
                    ...packet,
                    sensorId: batch.sensorId,
                    sampleIndex: batch.sampleIndex,
                    actualDeliveryStep: batch.actualDeliveryStep,
                    captureTimeNs: batch.captureTimeNs,
                    scheduledDeliveryTimeNs: batch.scheduledDeliveryTimeNs,
                    deliveryTimeNs: batch.deliveryTimeNs,
                    logicalEgressTimeNs: logicalEgressTimeNs(
                        batch.actualDeliveryStep,
                        this.stepNs,
                        packet.offsetNs,
                    ),
                });
            }
        }
        packets.sort(compareHostPackets);
        // Sidecar validates and sends one worker batch at a time. Group by original
        // sensor sample so capture metadata stays intact.
        const groups = new Map();
        for (const packet of packets) {
            const key = `${packet.sensorId}\0${packet.sampleIndex}\0${packet.actualDeliveryStep}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    sensorId: packet.sensorId,
                    sampleIndex: packet.sampleIndex,
                    actualDeliveryStep: packet.actualDeliveryStep,
                    captureTimeNs: packet.captureTimeNs,
                    scheduledDeliveryTimeNs: packet.scheduledDeliveryTimeNs,
                    deliveryTimeNs: packet.deliveryTimeNs,
                    packets: [],
                });
            }
            groups.get(key).packets.push({
                productId: packet.productId,
                streamId: packet.streamId,
                packetIndex: packet.packetIndex,
                offsetNs: packet.offsetNs,
                payload: packet.payload,
                payloadDigest: packet.payloadDigest,
            });
        }
        try {
            for (const group of groups.values()) {
                await this.request("submit-batch", {
                    generation: this.generation,
                    ...group,
                });
            }
        } finally {
            this.queued = Math.max(0, this.queued - pending.reduce((total, entry) => total + entry.bytes, 0));
        }
    }

    async drain() {
        if (this.failed) throw this.failed;
        if (this.pending.length > 0) {
            const pending = this.endDeliveryStep();
            if (pending) await pending;
        }
        await this.inFlight;
        if (this.failed) throw this.failed;
    }

    async finalize() {
        await this.drain();
        if (!this.active && this.bindings.length === 0) return null;
        const result = await this.request("finalize-generation", { generation: this.generation });
        this.active = false;
        this.evidence = result?.evidence ?? null;
        if (this.stagingDirectory && Array.isArray(result?.timing)) {
            try {
                const lines = [
                    JSON.stringify({ kind: UDP_TIMING_KIND, version: UDP_TIMING_VERSION }),
                    ...result.timing.map((entry) => JSON.stringify(entry)),
                ];
                await fs.writeFile(
                    path.join(this.stagingDirectory, "sensor-udp-timing.ndjson"),
                    `${lines.join("\n")}\n`,
                    { flag: "wx" },
                );
            } catch (error) {
                throw this._fail(udpTransportError(
                    "ARTIFACT_FAILURE",
                    `Could not write UDP timing evidence: ${error.message}`,
                    { operation: "finalize-generation", generation: this.generation },
                ));
            }
        }
        return this.evidence;
    }

    async abort() {
        this.pending = [];
        this.queued = 0;
        this.active = false;
        try {
            await this.request("cancel-generation", { generation: this.generation });
        } catch {
            // Abort is best-effort.
        }
    }
}

export function createWorkerPacketTransportSink(options) {
    return new WorkerPacketTransportSink(options);
}
