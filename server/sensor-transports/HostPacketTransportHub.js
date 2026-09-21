import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { HeadlessRunnerError } from "../headless/HeadlessRunnerErrors.js";
import {
    encodePcapRecord,
    pcapTimestampUs,
} from "./PcapEncoder.js";
import { compareHostPackets, logicalEgressTimeNs } from "./HostPacketOrdering.js";
import { PcapWriter } from "./PcapWriter.js";
import {
    SENSOR_TRANSPORT_HOST_CONFIG_KIND,
    hostDescriptorFromConfig,
    resolveSensorTransportHostConfig,
} from "./SensorTransportConfig.js";

const EVIDENCE_KIND = "cev-sim.sensor-transport-evidence";
const EVIDENCE_VERSION = 1;

function capabilityError(message, details = null) {
    return new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", message, details);
}

function copyBytes(value) {
    return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

export class HostPacketTransportHub {
    constructor({ udpDelegate = null } = {}) {
        this.udpDelegate = udpDelegate;
        this.bindings = [];
        this.udpBindings = [];
        this.hostConfig = null;
        this.stepNs = 1;
        this.maxQueueBytes = 0;
        this.writers = new Map();
        this.stats = new Map();
        this.pending = [];
        this.recordIds = new Map();
        this.stagingDirectory = null;
        this.configured = false;
        this.failed = null;
        this.finalized = false;
        this.aborted = false;
        this.udpEvidence = null;
    }

    get queuedBytes() {
        let total = Number(this.udpDelegate?.queuedBytes || 0);
        for (const writer of this.writers.values()) total += writer.queuedBytes;
        return total;
    }

    _fail(error) {
        this.failed = error instanceof HeadlessRunnerError
            ? error
            : new HeadlessRunnerError("ARTIFACT_FAILURE", error.message, null, { cause: error });
        return this.failed;
    }

    _guard() {
        if (this.failed) throw this.failed;
        if (this.aborted) throw new HeadlessRunnerError("ARTIFACT_FAILURE", "Packet transport hub has been aborted.");
        if (this.finalized) throw new HeadlessRunnerError("ARTIFACT_FAILURE", "Packet transport hub has already been finalized.");
    }

    configure({
        bindings = [],
        hostConfig = null,
        stepNs,
        maxQueueBytes = 0,
        udpDelegate = undefined,
        udpMaxQueueBytes = null,
    } = {}) {
        this._guard();
        if (udpDelegate !== undefined) this.udpDelegate = udpDelegate;
        const requested = Array.isArray(bindings) ? bindings : [];
        const pcapBindings = requested.filter((entry) => entry.adapter === "pcap");
        const udpBindings = requested.filter((entry) => entry.adapter === "udp");
        if (udpBindings.length > 0 && !this.udpDelegate) {
            throw this._fail(capabilityError("Sensor transport adapter \"udp\" is unavailable."));
        }
        const resolved = hostConfig
            ? (hostConfig.kind === SENSOR_TRANSPORT_HOST_CONFIG_KIND
                ? hostConfig
                : resolveSensorTransportHostConfig(hostConfig))
            : null;
        if (pcapBindings.length > 0) {
            if (!resolved?.pcap) {
                throw this._fail(capabilityError("Requested PCAP bindings require a sensor-transport host configuration."));
            }
            const endpoints = new Map(resolved.pcap.endpoints.map((entry) => [entry.id, entry]));
            const artifacts = new Map(resolved.pcap.artifacts.map((entry) => [entry.id, entry]));
            this.bindings = pcapBindings.map((binding) => {
                const endpoint = endpoints.get(binding.endpointId);
                if (!endpoint) {
                    throw this._fail(capabilityError(
                        `Sensor transport endpoint "${binding.endpointId}" is unavailable for adapter "pcap".`,
                    ));
                }
                const artifact = artifacts.get(endpoint.artifactId);
                if (!artifact) {
                    throw this._fail(capabilityError(
                        `PCAP artifact "${endpoint.artifactId}" is unavailable.`,
                    ));
                }
                return Object.freeze({
                    sensorId: binding.sensorId,
                    productId: binding.productId,
                    streamId: binding.streamId,
                    adapter: "pcap",
                    endpointId: binding.endpointId,
                    endpoint,
                    artifact,
                });
            });
            this.stats = new Map(resolved.pcap.artifacts.map((artifact) => [artifact.id, {
                id: artifact.id,
                fileName: artifact.fileName,
                recordCount: 0,
                payloadBytes: 0,
                firstLogicalEgressTimeNs: null,
                lastLogicalEgressTimeNs: null,
                sizeBytes: 0,
                sha256: null,
            }]));
        } else {
            this.bindings = [];
            this.stats = new Map();
        }
        this.udpBindings = udpBindings.map((binding) => Object.freeze({
            sensorId: binding.sensorId,
            productId: binding.productId,
            streamId: binding.streamId,
            adapter: "udp",
            endpointId: binding.endpointId,
        }));
        this.hostConfig = resolved;
        this.stepNs = Math.max(1, Number(stepNs) || 1);
        this.maxQueueBytes = Math.max(0, Number(maxQueueBytes) || 0);
        this.configured = true;
        this.udpDelegate?.configure?.({
            bindings: this.udpBindings,
            stepNs: this.stepNs,
            maxQueueBytes: udpMaxQueueBytes ?? this.maxQueueBytes,
        });
        return this;
    }

    hostDescriptor() {
        return hostDescriptorFromConfig(this.hostConfig);
    }

    hasPcapBindings() {
        return this.bindings.some((entry) => entry.adapter === "pcap");
    }

    hasUdpBindings() {
        return this.udpBindings.length > 0;
    }

    hasPacketBindings() {
        return this.hasPcapBindings() || this.hasUdpBindings();
    }

    bindingFor(sensorId, productId, streamId) {
        return this.bindings.find((entry) => (
            entry.sensorId === sensorId
            && entry.productId === productId
            && entry.streamId === streamId
            && entry.adapter === "pcap"
        )) ?? null;
    }

    _resetCaptureState() {
        this.failed = null;
        this.aborted = false;
        this.finalized = false;
        this.pending = [];
        this.writers = new Map();
        this.recordIds = new Map();
        this.stagingDirectory = null;
        this.udpEvidence = null;
        if (this.hostConfig?.pcap) {
            this.stats = new Map(this.hostConfig.pcap.artifacts.map((artifact) => [artifact.id, {
                id: artifact.id,
                fileName: artifact.fileName,
                recordCount: 0,
                payloadBytes: 0,
                firstLogicalEgressTimeNs: null,
                lastLogicalEgressTimeNs: null,
                sizeBytes: 0,
                sha256: null,
            }]));
        } else {
            this.stats = new Map();
        }
    }

    async beginEpisode() {
        const previous = [...this.writers.values()];
        this._resetCaptureState();
        await Promise.all(previous.map((writer) => writer.abort()));
        await this.udpDelegate?.beginEpisode?.();
        return this;
    }

    async attachArtifactRoot(stagingDirectory) {
        const previous = [...this.writers.values()];
        this._resetCaptureState();
        await Promise.all(previous.map((writer) => writer.abort()));
        this._guard();
        if (!this.configured) throw this._fail(new HeadlessRunnerError("ARTIFACT_FAILURE", "Packet transport hub is not configured."));
        if (!this.hasPacketBindings()) {
            this.stagingDirectory = stagingDirectory;
            return this;
        }
        if (!stagingDirectory) {
            throw this._fail(capabilityError("Requested packet transport bindings require artifact output."));
        }
        this.stagingDirectory = stagingDirectory;
        this.udpDelegate?.attachArtifactRoot?.(stagingDirectory);
        if (!this.hasPcapBindings()) return this;
        for (const artifact of this.hostConfig.pcap.artifacts) {
            if (![...this.bindings].some((binding) => binding.artifact.id === artifact.id)) continue;
            const writer = new PcapWriter({
                filePath: path.join(stagingDirectory, artifact.fileName),
                maxQueueBytes: 0,
            });
            await writer.open();
            this.writers.set(artifact.id, writer);
            this.recordIds.set(artifact.id, 0);
        }
        return this;
    }

    async activateGeneration() {
        if (!this.hasUdpBindings()) return null;
        this._guard();
        return this.udpDelegate?.beginGeneration?.() ?? null;
    }

    enqueueBatch(batch) {
        if (this.failed) throw this.failed;
        if (!this.configured) return;
        this._guard();
        const packets = Array.isArray(batch?.packets) ? batch.packets : [];
        if (this.hasPcapBindings()) {
            for (const packet of packets) {
                const binding = this.bindingFor(batch.sensorId, packet.productId, packet.streamId);
                if (!binding) continue;
                const offsetNs = Number(packet.offsetNs);
                const logicalNs = logicalEgressTimeNs(batch.actualDeliveryStep, this.stepNs, offsetNs);
                this.pending.push({
                    sensorId: String(batch.sensorId),
                    productId: String(packet.productId),
                    streamId: String(packet.streamId),
                    sampleIndex: Number(batch.sampleIndex),
                    packetIndex: Number(packet.packetIndex),
                    offsetNs,
                    logicalEgressTimeNs: logicalNs,
                    payload: copyBytes(packet.payload),
                    binding,
                });
            }
        }
        if (this.hasUdpBindings()) {
            this.udpDelegate?.enqueueBatch?.({
                sensorId: batch.sensorId,
                sampleIndex: batch.sampleIndex,
                actualDeliveryStep: batch.actualDeliveryStep,
                captureTimeNs: batch.captureTimeNs,
                scheduledDeliveryTimeNs: batch.scheduledDeliveryTimeNs,
                deliveryTimeNs: batch.deliveryTimeNs,
                packets: packets.map((packet) => ({
                    productId: packet.productId,
                    streamId: packet.streamId,
                    packetIndex: packet.packetIndex,
                    offsetNs: packet.offsetNs,
                    payload: copyBytes(packet.payload),
                    payloadDigest: packet.payloadDigest ?? null,
                })),
            });
        }
    }

    endDeliveryStep(_clock) {
        if (this.failed) throw this.failed;
        if (!this.configured) return;
        this._guard();
        if (this.hasPcapBindings() && this.pending.length > 0) {
            if (this.writers.size === 0) {
                throw this._fail(new HeadlessRunnerError("ARTIFACT_FAILURE", "PCAP writers are not attached."));
            }
            const ordered = this.pending.slice().sort(compareHostPackets);
            this.pending = [];
            for (const packet of ordered) {
                const artifactId = packet.binding.artifact.id;
                const writer = this.writers.get(artifactId);
                const identification = this.recordIds.get(artifactId) || 0;
                this.recordIds.set(artifactId, (identification + 1) & 0xffff);
                const record = encodePcapRecord({
                    timestampUs: pcapTimestampUs(packet.logicalEgressTimeNs),
                    identification,
                    ethernet: packet.binding.endpoint.ethernet,
                    ipv4: packet.binding.endpoint.ipv4,
                    udp: packet.binding.endpoint.udp,
                    payload: packet.payload,
                });
                if (this.maxQueueBytes > 0 && this.queuedBytes + record.byteLength > this.maxQueueBytes) {
                    throw this._fail(new HeadlessRunnerError(
                        "RESOURCE_LIMIT",
                        `PCAP queue used ${this.queuedBytes + record.byteLength} bytes, exceeding the ${this.maxQueueBytes}-byte limit.`,
                        { queuedBytes: this.queuedBytes + record.byteLength, maxQueueBytes: this.maxQueueBytes },
                    ));
                }
                writer.enqueue(record);
                const stats = this.stats.get(artifactId);
                stats.recordCount += 1;
                stats.payloadBytes += packet.payload.byteLength;
                const ns = packet.logicalEgressTimeNs.toString();
                if (stats.firstLogicalEgressTimeNs == null) stats.firstLogicalEgressTimeNs = ns;
                stats.lastLogicalEgressTimeNs = ns;
            }
        } else {
            this.pending = [];
        }
        const udpStep = this.udpDelegate?.endDeliveryStep?.(_clock);
        if (udpStep && typeof udpStep.then === "function") {
            udpStep.catch((error) => this._fail(error));
        }
    }

    async drain() {
        if (this.failed) throw this.failed;
        if (this.aborted || this.finalized) return;
        for (const writer of this.writers.values()) await writer.drain();
        await this.udpDelegate?.drain?.();
        if (this.failed) throw this.failed;
    }

    getEvidence() {
        const artifacts = [...(this.stats?.values?.() ?? [])].map((entry) => {
            const writer = this.writers.get(entry.id);
            return Object.freeze({
                id: entry.id,
                fileName: entry.fileName,
                recordCount: entry.recordCount,
                payloadBytes: entry.payloadBytes,
                firstLogicalEgressTimeNs: entry.firstLogicalEgressTimeNs,
                lastLogicalEgressTimeNs: entry.lastLogicalEgressTimeNs,
                sizeBytes: writer?.writtenBytes ?? entry.sizeBytes,
                sha256: writer?.sha256 ?? entry.sha256,
            });
        });
        const evidence = {
            kind: EVIDENCE_KIND,
            version: EVIDENCE_VERSION,
            bindings: Object.freeze([
                ...this.bindings.map((entry) => Object.freeze({
                    sensorId: entry.sensorId,
                    productId: entry.productId,
                    streamId: entry.streamId,
                    adapter: entry.adapter,
                    endpointId: entry.endpointId,
                })),
                ...this.udpBindings.map((entry) => Object.freeze({ ...entry })),
            ]),
            wrappers: Object.freeze(this.bindings.map((entry) => Object.freeze({
                endpointId: entry.endpointId,
                artifactId: entry.artifact.id,
                mtu: entry.endpoint.mtu,
                ethernet: entry.endpoint.ethernet,
                ipv4: entry.endpoint.ipv4,
                udp: entry.endpoint.udp,
            }))),
            artifacts: Object.freeze(artifacts),
        };
        if (this.udpEvidence) evidence.udp = this.udpEvidence;
        return Object.freeze(evidence);
    }

    async finalize() {
        if (this.failed) throw this.failed;
        if (this.aborted) throw new HeadlessRunnerError("ARTIFACT_FAILURE", "Packet transport hub has been aborted.");
        if (this.finalized) return this.getEvidence();
        this._guard();
        try {
            if (this.pending.length > 0) this.endDeliveryStep();
            await this.drain();
            for (const [artifactId, writer] of this.writers) {
                const snapshot = await writer.finalize();
                const stats = this.stats.get(artifactId);
                stats.sizeBytes = snapshot.sizeBytes;
                stats.sha256 = snapshot.sha256;
            }
            if (this.hasUdpBindings()) {
                this.udpEvidence = await this.udpDelegate?.finalize?.() ?? null;
            }
            if (this.stagingDirectory && this.hasPacketBindings()) {
                const evidence = this.getEvidence();
                await fs.writeFile(
                    path.join(this.stagingDirectory, "sensor-transport-evidence.json"),
                    `${JSON.stringify(evidence, null, 2)}\n`,
                    { flag: "wx" },
                );
            }
            this.finalized = true;
            return this.getEvidence();
        } catch (error) {
            if (this.failed) throw this.failed;
            throw this._fail(error);
        }
    }

    async abort() {
        this.aborted = true;
        this.pending = [];
        const writers = [...this.writers.values()];
        this.writers.clear();
        await Promise.all([
            ...writers.map((writer) => writer.abort()),
            Promise.resolve(this.udpDelegate?.abort?.()),
        ]);
    }
}

export function createHostPacketTransportHub(options) {
    return new HostPacketTransportHub(options);
}

export function sha256Bytes(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
