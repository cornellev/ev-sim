import { SeededRNG } from "../../util/SeededRNG.js";
import {
    resolveFixedStepSensorSchedule,
    resolveSensorDelivery,
} from "./FixedStepSensorSchedule.js";
import { buildDiagnosticArray } from "./SensorMessages.js";
import { simulationSha256 } from "../kernel/SimulationHashes.js";
import { encodeNativeSensorPacket, packetPayloadDigest } from "./NativeSensorPacket.js";
import { browserSimulationPerformance } from "../performance/BrowserSimulationPerformance.js";

const DEFAULT_MAX_QUEUE_BYTES = 64 * 1024 * 1024;

export function normalizeCaptureResult(captured, captureTimeNs, sampleIndex) {
    if (captured == null) {
        return { messages: [], nativePackets: [], captureTimeNs, sampleIndex };
    }
    if (Array.isArray(captured)) {
        return { messages: captured, nativePackets: [], captureTimeNs, sampleIndex };
    }
    const messages = Array.isArray(captured.messages) ? captured.messages : [];
    const nativePackets = Array.isArray(captured.nativePackets) ? captured.nativePackets : [];
    return {
        messages,
        nativePackets,
        captureTimeNs: Number.isFinite(captured.captureTimeNs) ? captured.captureTimeNs : captureTimeNs,
        sampleIndex: Number.isFinite(captured.sampleIndex) ? captured.sampleIndex : sampleIndex,
        rng: captured.rng,
        observation: captured.observation ?? null,
    };
}

function estimateFrameBytes(messages = [], estimateEncodeBytes) {
    let total = 0;
    for (const message of messages) {
        total += estimateEncodeBytes(message?.value) || 256;
    }
    return total;
}

function estimateObservationBytes(observation) {
    const value = observation?.value;
    return ArrayBuffer.isView(value)
        ? value.byteLength
        : Number(observation?.sharedMemory?.lengthBytes || 0);
}

export class SensorPublisher {
    constructor(device, config, {
        seed = "42",
        topics = [],
        topicRouter = null,
        calibrationHash = null,
        stepNs = null,
        monotonicClock = null,
        nowNs = null,
        runtimeData = null,
        encodeTopicValue,
        encodingPool = null,
        nativePacketSink = null,
        pluginStrict = false,
        pluginIdentity = null,
    } = {}) {
        if (typeof encodeTopicValue !== "function") {
            throw new TypeError("SensorPublisher requires an encodeTopicValue port.");
        }
        this.device = device;
        this.config = config;
        this.seed = seed;
        this.topics = new Map(topics.map((topic) => [topic.id, topic]));
        this.topicRouter = topicRouter;
        this.calibrationHash = calibrationHash;
        this.runtimeData = runtimeData;
        this.encodeTopicValue = encodeTopicValue;
        this.encodingPool = encodingPool;
        this.nativePacketSink = nativePacketSink;
        this.pluginStrict = pluginStrict === true;
        this.pluginIdentity = pluginIdentity;
        this.manifestStepNs = stepNs;
        this.nowNs = nowNs
            || monotonicClock?.nowNs?.bind(monotonicClock)
            || (() => Math.round((globalThis.performance?.now?.() ?? 0) * 1e6));
        this.periodNs = Math.max(1, Math.round(1e9 / config.rateHz));
        this.maxQueueFrames = Math.max(1, Number(config.maxQueueFrames || 8));
        this.maxQueueBytes = Math.max(1024, Number(config.maxQueueBytes || DEFAULT_MAX_QUEUE_BYTES));
        this.encodeOwnerId = `sensor:${config.id || device?.telemetryId || "unknown"}`;
        this.encodeGeneration = this.encodingPool?.bumpEncodeOwnerGeneration?.(this.encodeOwnerId) ?? 0;
        this.queue = [];
        this.queuedBytes = 0;
        this.sampleIndex = 0;
        this.droppedFrames = 0;
        this.errors = 0;
        this._lastTransportNoticeNs = 0;
        this._lastTransportNoticeName = null;
        this._lastPublishedHealth = null;
        this.reset();
    }

    reset({ resetSeed = null, seed = null } = {}) {
        const nextSeed = resetSeed ?? seed;
        if (nextSeed !== null && nextSeed !== undefined) this.seed = String(nextSeed);
        this.encodingPool?.cancelEncodeOwner?.(this.encodeOwnerId);
        this.encodeGeneration = this.encodingPool?.bumpEncodeOwnerGeneration?.(this.encodeOwnerId) ?? 0;
        for (const frame of this.queue) this.device.releaseObservation?.(frame.observation);
        this.queue = [];
        this.queuedBytes = 0;
        this.sampleIndex = 0;
        this.droppedFrames = 0;
        this.errors = 0;
        this._lastPublishedHealth = null;
        this.health = {
            captureAttempts: 0,
            capturedFrames: 0,
            deliveredFrames: 0,
            droppedFrames: 0,
            pointDrops: 0,
            missedDeadlines: 0,
            shaderBusyDrops: 0,
            queueDepth: 0,
            queueHighWaterMark: 0,
            queueBytes: 0,
            queueBytesHighWaterMark: 0,
            encodeRejected: 0,
            captureTimeNs: 0,
            captureTimeTotalNs: 0,
            encodeTimeNs: 0,
            encodeTimeTotalNs: 0,
            transportTimeNs: 0,
            transportTimeTotalNs: 0,
        };
        this.stepNs = null;
        this.periodSteps = null;
        this.nextCaptureStep = null;
    }

    getDeterministicState() {
        return {
            seed: String(this.seed),
            sampleIndex: this.sampleIndex,
            stepNs: this.stepNs,
            periodSteps: this.periodSteps,
            nextCaptureStep: this.nextCaptureStep,
            droppedFrames: this.droppedFrames,
            errors: this.errors,
            queuedBytes: this.queuedBytes,
            queue: this.queue.map((frame) => ({
                captureTimeNs: frame.captureTimeNs,
                scheduledDeliveryTimeNs: frame.scheduledDeliveryTimeNs,
                deliveryTimeNs: frame.deliveryTimeNs,
                captureStep: frame.captureStep,
                scheduledDeliveryStep: frame.scheduledDeliveryStep,
                sampleIndex: frame.sampleIndex,
                sequence: frame.sequence,
                syncGroupKey: frame.syncGroupKey,
                messages: (frame.messages || []).map((message) => ({
                    topicId: message.topicId,
                    signal: message.signal,
                    frameId: message.frameId,
                    digest: message.digest
                        ?? (message.value == null ? null : simulationSha256(message.value)),
                })),
                nativePackets: (frame.nativePackets || []).map((packet) => ({
                    productId: packet.productId,
                    streamId: packet.streamId,
                    offsetNs: packet.offsetNs,
                    packetIndex: packet.packetIndex,
                    payloadLength: packet.payload.byteLength,
                    payloadDigest: packetPayloadDigest(packet.payload),
                })),
                ...(frame.observation ? {
                    observation: {
                        dtype: frame.observation.dtype,
                        shape: frame.observation.shape,
                        digest: frame.observation.digest
                            || (frame.observation.value == null
                                ? null
                                : simulationSha256(frame.observation.value)),
                    },
                } : {}),
            })),
            health: {
                captureAttempts: this.health.captureAttempts,
                capturedFrames: this.health.capturedFrames,
                deliveredFrames: this.health.deliveredFrames,
                droppedFrames: this.health.droppedFrames,
                pointDrops: this.health.pointDrops,
                missedDeadlines: this.health.missedDeadlines,
                shaderBusyDrops: this.health.shaderBusyDrops,
                encodeRejected: this.health.encodeRejected,
            },
        };
    }

    dispose() {
        this.encodingPool?.cancelEncodeOwner?.(this.encodeOwnerId);
        this.encodeGeneration = this.encodingPool?.bumpEncodeOwnerGeneration?.(this.encodeOwnerId) ?? 0;
        for (const frame of this.queue) this.device.releaseObservation?.(frame.observation);
        this.queue = [];
        this.queuedBytes = 0;
    }

    _initializeSchedule(clock) {
        if (!this.stepNs) {
            const schedule = resolveFixedStepSensorSchedule(this.config, clock, this.manifestStepNs);
            this.stepNs = schedule.stepNs;
            this.periodSteps = schedule.periodSteps;
            this.nextCaptureStep = schedule.nextCaptureStep;
        }
    }

    dueSyncGroupKeys(clock) {
        if (!this.config.syncGroupId) return [];
        this._initializeSchedule(clock);
        const keys = [];
        for (let step = this.nextCaptureStep; step <= clock.step; step += this.periodSteps) {
            keys.push(`${this.config.syncGroupId}:${step}`);
        }
        return keys;
    }

    queueCheckpoint() {
        return this.queue.length;
    }

    discardEnqueued(checkpoint, { syncGroupKey = null } = {}) {
        const keep = [];
        for (const [index, frame] of this.queue.entries()) {
            const discard = index >= checkpoint
                && (syncGroupKey === null || frame.syncGroupKey === syncGroupKey);
            if (!discard) {
                keep.push(frame);
                continue;
            }
            frame.encodeCancelled = true;
            this.device.releaseObservation?.(frame.observation);
            frame.messages = null;
            frame.nativePackets = null;
            frame.observation = null;
            frame.encodedByTopic = null;
        }
        this.queue = keep;
        this.queuedBytes = this.queue.reduce((sum, frame) => sum + (Number(frame.bytes) || 0), 0);
        this.health.queueDepth = this.queue.length;
        this.health.queueBytes = this.queuedBytes;
    }

    _captureContext(clock) {
        const captureTimeNs = this.nextCaptureStep * this.stepNs;
        const sampleIndex = this.sampleIndex++;
        const scope = `${this.seed}:sensor:${this.config.id}:sample:${sampleIndex}`;
        return {
            captureTimeNs,
            sampleIndex,
            scanDurationNs: this.periodSteps * this.stepNs,
            skip: false,
            rng: new SeededRNG(scope),
            measurementRng: new SeededRNG(`${scope}:measurement`),
            pluginRng: new SeededRNG(`${scope}:plugin`),
            deliveryRng: new SeededRNG(`${scope}:delivery`),
            clock,
        };
    }

    _acceptCapture(captured, context, captureStartNs, { allowOwnershipTransfer = false } = {}) {
        const result = normalizeCaptureResult(captured, context.captureTimeNs, context.sampleIndex);
        const captureDurationNs = Math.max(0, this._time() - captureStartNs);
        this.health.captureTimeNs = captureDurationNs;
        this.health.captureTimeTotalNs += captureDurationNs;
        if (result.messages.length > 0 || result.nativePackets.length > 0 || result.observation) {
            this.health.capturedFrames += 1;
            return this.enqueue(
                result.messages,
                result.captureTimeNs,
                result.sampleIndex,
                result.rng || context.rng,
                result.observation,
                result.nativePackets,
                { allowOwnershipTransfer },
            );
        }
        return null;
    }

    update(clock) {
        this._initializeSchedule(clock);
        while (clock.step >= this.nextCaptureStep) {
            const context = this._captureContext(clock);
            if (context.skip) {
                this.nextCaptureStep += this.periodSteps;
                continue;
            }
            try {
                this.health.captureAttempts += 1;
                const captureStartNs = this._time();
                const captured = this.device.captureAt?.(context);
                if (captured?.then) throw new Error(`Sensor ${this.config.id} requires updateAsync().`);
                this._acceptCapture(captured, context, captureStartNs);
            } catch (error) {
                if (error?.infrastructureFailure || this.pluginStrict) throw error;
                this._event("capture-failed", "error", { sampleIndex: context.sampleIndex, reason: error.message });
            }
            this.nextCaptureStep += this.periodSteps;
        }
        browserSimulationPerformance.recordSensorState(this.config.id, this.health);
    }

    async updateAsync(clock) {
        this._initializeSchedule(clock);
        try {
            while (clock.step >= this.nextCaptureStep) {
                const context = this._captureContext(clock);
                if (!context.skip) {
                    try {
                        this.health.captureAttempts += 1;
                        const captureStartNs = this._time();
                        const captured = await this.device.captureAt?.(context);
                        const frame = this._acceptCapture(captured, context, captureStartNs, {
                            allowOwnershipTransfer: true,
                        });
                        if (frame?.zeroLatency && frame.encodePromise) await frame.encodePromise;
                    } catch (error) {
                        if (error?.infrastructureFailure || this.pluginStrict) throw error;
                        this._event("capture-failed", "error", {
                            sampleIndex: context.sampleIndex,
                            reason: error.message,
                        });
                    }
                }
                this.nextCaptureStep += this.periodSteps;
            }
        } finally {
            browserSimulationPerformance.recordSensorState(this.config.id, this.health);
        }
    }

    enqueue(messages, captureTimeNs, sampleIndex, rng, observation = null, nativePackets = [], {
        allowOwnershipTransfer = false,
    } = {}) {
        const stepNs = this.stepNs || this.manifestStepNs || 16_666_667;
        const delivery = resolveSensorDelivery(this.config, captureTimeNs, rng, stepNs);
        const {
            scheduledDeliveryTimeNs,
            deliveryTimeNs,
            captureStep,
            scheduledDeliveryStep,
        } = delivery;
        const frameMessages = [...messages];
        const diagnosticsTopicId = this.config.outputs?.diagnosticsTopicId;
        const diagnosticsEnabled = this.config.calibration?.products?.diagnostics === true;
        if (diagnosticsEnabled && diagnosticsTopicId && !frameMessages.some((message) => message.topicId === diagnosticsTopicId)) {
            frameMessages.push({
                topicId: diagnosticsTopicId,
                signal: "diagnostics",
                frameId: this.config.measurementFrameId || this.config.frameId,
                value: buildDiagnosticArray({
                    timeNs: captureTimeNs,
                    frameId: this.config.measurementFrameId || this.config.frameId,
                    sensorId: this.config.id,
                    metrics: this.getHealthSnapshot(),
                    level: this.health.missedDeadlines > 0 || this.health.droppedFrames > 0 ? 1 : 0,
                    message: this.health.missedDeadlines > 0 || this.health.droppedFrames > 0 ? "Degraded" : "OK",
                }),
            });
        }
        const frameBytes = estimateFrameBytes(
            frameMessages,
            this.encodingPool?.estimateEncodeBytes ?? (() => 0),
        ) + estimateObservationBytes(observation)
            + nativePackets.reduce((total, packet) => total + packet.payload.byteLength, 0);
        if (this.queue.length >= this.maxQueueFrames || this.queuedBytes + frameBytes > this.maxQueueBytes) {
            this.device.releaseObservation?.(observation);
            this._incrementFrameDrop();
            this._event("frame-dropped", "warning", {
                sampleIndex,
                reason: this.queue.length >= this.maxQueueFrames ? "delivery-queue-full" : "delivery-queue-bytes",
                queueBytes: this.queuedBytes,
                frameBytes,
            });
            if (this.pluginStrict) {
                const error = new Error(`Plugin sensor "${this.config.id}" delivery queue exceeded its admitted limit.`);
                error.code = "PLUGIN_RESOURCE";
                error.pluginId = this.pluginIdentity?.pluginId ?? null;
                error.contributionId = this.config.type;
                error.unitId = this.config.id;
                error.hook = "enqueue";
                error.requiresReset = true;
                error.infrastructureFailure = true;
                throw error;
            }
            return null;
        }
        this.queue.push({
            captureTimeNs,
            scheduledDeliveryTimeNs,
            deliveryTimeNs,
            captureStep,
            scheduledDeliveryStep,
            sampleIndex,
            sequence: sampleIndex,
            syncGroupKey: this.config.syncGroupId ? `${this.config.syncGroupId}:${captureStep}` : null,
            messages: frameMessages,
            nativePackets: nativePackets.map((packet) => ({ ...packet, payload: new Uint8Array(packet.payload) })),
            observation,
            encodedByTopic: new Map(),
            encodeReady: false,
            encodeFailed: false,
            encodeCancelled: false,
            bytes: frameBytes,
            zeroLatency: delivery.fixedLatencyNs <= 0 && delivery.jitterNs <= 0,
            allowOwnershipTransfer,
        });
        const frame = this.queue[this.queue.length - 1];
        this.queuedBytes += frameBytes;
        frame.encodePromise = this._beginEncode(frame);
        this.health.queueDepth = this.queue.length;
        this.health.queueBytes = this.queuedBytes;
        this.health.queueHighWaterMark = Math.max(this.health.queueHighWaterMark, this.queue.length);
        this.health.queueBytesHighWaterMark = Math.max(this.health.queueBytesHighWaterMark, this.queuedBytes);
        browserSimulationPerformance.recordQueue(
            this.config.id,
            this.health.queueDepth,
            this.health.queueBytes,
        );
        return frame;
    }

    _beginEncode(frame) {
        const heavy = frame.messages.filter((message) => {
            const topic = this.topics.get(message.topicId);
            return topic && this.encodingPool?.isHeavySensorValue?.(message.value);
        });
        if (heavy.length === 0) {
            frame.encodeReady = true;
            return null;
        }
        const bytesNeeded = estimateFrameBytes(
            heavy,
            this.encodingPool?.estimateEncodeBytes ?? (() => 0),
        );
        if (!this.encodingPool?.encodePoolHasCapacity?.(bytesNeeded)) {
            this.health.encodeRejected += 1;
            if (frame.zeroLatency) {
                const error = new Error("encode-pool-full");
                error.code = "SENSOR_ENCODE_CAPACITY";
                error.infrastructureFailure = true;
                return Promise.reject(error);
            }
            frame.encodeReady = true;
            return null;
        }
        const generation = this.encodeGeneration;
        const encodeStartMs = browserSimulationPerformance.now();
        const jobs = heavy.map(async (message) => {
            const topic = this.topics.get(message.topicId);
            const encode = this.encodingPool.encodePublishedTopicAsync
                ? this.encodingPool.encodePublishedTopicAsync.bind(this.encodingPool, topic.name)
                : this.encodingPool.encodeTopicValueAsync.bind(this.encodingPool);
            const encoded = await encode(topic.schema?.type || topic.type, message.value, {
                ownerId: this.encodeOwnerId,
                ownerGeneration: generation,
                transferOwnership: frame.zeroLatency
                    && frame.allowOwnershipTransfer
                    && topic.routeDownstream === false
                    && !frame.observation
                    && frame.nativePackets.length === 0,
            });
            if (generation !== this.encodeGeneration || frame.encodeCancelled) {
                throw new Error("encode cancelled");
            }
            frame.encodedByTopic.set(message.topicId, encoded);
        });
        const pending = Promise.all(jobs).then(() => {
            if (generation !== this.encodeGeneration || frame.encodeCancelled) return;
            frame.encodeReady = true;
        }).catch((error) => {
            // Worker/timeout/cancel are best-effort. Deliver falls through to sync encode.
            const reason = String(error?.message || error);
            frame.encodeReady = true;
            if (frame.zeroLatency) {
                error.code ||= "SENSOR_ENCODE_FAILED";
                error.infrastructureFailure = true;
                frame.encodeFailed = true;
                throw error;
            }
            if (reason.includes("cancelled")
                || reason.includes("encode-pool-full")
                || reason.includes("timeout")
                || reason.includes("encode worker")) {
                return;
            }
            this._event("publish-failed", "warning", {
                sampleIndex: frame.sampleIndex,
                reason,
            });
        }).finally(() => {
            browserSimulationPerformance.recordTiming(
                "sensorEncode",
                browserSimulationPerformance.now() - encodeStartMs,
            );
        });
        return pending;
    }

    deliver(clock) {
        const ready = this.queue.filter((frame) => frame.deliveryTimeNs <= clock.timeNs);
        this.queue = this.queue.filter((frame) => frame.deliveryTimeNs > clock.timeNs);
        this.queuedBytes = this.queue.reduce((sum, frame) => sum + (Number(frame.bytes) || 0), 0);
        this.health.queueDepth = this.queue.length;
        this.health.queueBytes = this.queuedBytes;
        for (const frame of ready) {
            if (frame.encodeFailed) {
                this.device.releaseObservation?.(frame.observation);
                frame.messages = null;
                frame.nativePackets = null;
                frame.observation = null;
                frame.encodedByTopic = null;
                continue;
            }
            const deadlineNs = Number(this.config.health?.deadlineNs);
            if (Number.isFinite(deadlineNs) && deadlineNs > 0 && clock.timeNs - frame.captureTimeNs > deadlineNs) {
                this.health.missedDeadlines += 1;
                frame.encodeCancelled = true;
                this._event("deadline-missed", "warning", {
                    sampleIndex: frame.sampleIndex,
                    deadlineNs,
                    elapsedNs: clock.timeNs - frame.captureTimeNs,
                });
            }
            const transportStartNs = this._time();
            for (const message of frame.messages || []) this._deliverMessage(message, frame, clock);
            this._deliverNativePackets(frame, clock);
            const transportDurationNs = Math.max(0, this._time() - transportStartNs);
            this.health.transportTimeNs = transportDurationNs;
            this.health.transportTimeTotalNs += transportDurationNs;
            this.health.deliveredFrames += 1;
            if (frame.observation) {
                this.device.onDeliveredObservation?.(frame.observation, {
                    captureTimeNs: frame.captureTimeNs,
                    captureStep: frame.captureStep,
                    deliveryTimeNs: frame.deliveryTimeNs,
                    deliveryStep: clock.step,
                    sequence: frame.sequence,
                });
            }
            // Drop frame references immediately after delivery so Image/PointCloud buffers can GC.
            frame.messages = null;
            frame.nativePackets = null;
            frame.observation = null;
            frame.encodedByTopic?.clear?.();
            frame.encodedByTopic = null;
        }
        this._publishHealth(clock);
        browserSimulationPerformance.recordSensorState(this.config.id, this.health);
        browserSimulationPerformance.recordTiming(
            "sensorDelivery",
            Number(this.health.transportTimeNs || 0) / 1e6,
        );
    }

    _deliverMessage(message, frame, clock) {
        const topic = this.topics.get(message.topicId);
        if (!topic) {
            this._event("publish-failed", "error", { sampleIndex: frame.sampleIndex, reason: `unknown-topic:${message.topicId}` });
            if (this.pluginStrict) throw this._strictPublishError(`Unknown topic "${message.topicId}".`, frame, "publish");
            return;
        }
        let encoded;
        try {
            const encodeStartNs = this._time();
            const prepared = frame.encodedByTopic?.get(message.topicId);
            encoded = prepared?.encoded || prepared
                || this.encodeTopicValue(topic.schema?.type || topic.type, message.value);
            const encodeDurationNs = Math.max(0, this._time() - encodeStartNs);
            this.health.encodeTimeNs = encodeDurationNs;
            this.health.encodeTimeTotalNs += encodeDurationNs;
        } catch (error) {
            this._event("publish-failed", "error", { sampleIndex: frame.sampleIndex, topic: topic.name, reason: error.message });
            if (this.pluginStrict) throw this._strictPublishError(error.message, frame, "encode", error);
            return;
        }
        const data = this._data();
        const telemetry = data?.bindings?.()?.signalStore;
        const path = `devices.${this.device.telemetryId}.${message.signal}`;
        const metadata = {
            rosType: topic.type,
            topic: topic.name,
            frameId: message.frameId || this.config.measurementFrameId || this.config.frameId,
            mountFrameId: this.config.mountFrameId || null,
            measurementFrameId: message.frameId || this.config.measurementFrameId || this.config.frameId,
            captureTimeNs: frame.captureTimeNs,
            scheduledDeliveryTimeNs: frame.scheduledDeliveryTimeNs,
            deliveryTimeNs: frame.deliveryTimeNs,
            captureStep: frame.captureStep,
            scheduledDeliveryStep: frame.scheduledDeliveryStep,
            actualDeliveryStep: clock.step,
            sequenceId: frame.sequence,
            syncGroupKey: frame.syncGroupKey,
            calibrationHash: this.calibrationHash,
            calibration: this.config.calibration,
            canonicalSignalPath: path,
        };
        telemetry?.publishSignal?.(path, encoded, {
            timeUs: Math.round(frame.deliveryTimeNs / 1000),
            cycle: clock.step,
            source: "sensors",
            type: "bytes",
            category: "devices",
            replayRole: "derived",
            logClass: "heavy",
            retention: "latest",
            descriptorMetadata: metadata,
        });
        // Lightweight summary only — do not duplicate the full PointCloud2/Image bytes.
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.output`, {
            signal: message.signal,
            topic: topic.name,
            rosType: topic.type,
            byteLength: encoded?.byteLength ?? 0,
            width: Number(message.value?.width) || null,
            height: Number(message.value?.height) || null,
            pointCount: Number(message.value?.width) || null,
        }, {
            timeUs: Math.round(frame.deliveryTimeNs / 1000),
            cycle: clock.step,
            source: "sensors",
            type: "json",
            category: "devices",
            replayRole: "derived",
            logClass: "standard",
            history: false,
            retention: "none",
        });
        const client = data?.client?.()?.get?.();
        if (!client?.isOpen?.()) {
            if (topic.required) {
                this._noteTransportIssue("required-topic-unavailable", {
                    topic: topic.name,
                    sampleIndex: frame.sampleIndex,
                    reason: "orchestrator-disconnected",
                });
            }
        } else {
            const prepared = frame.encodedByTopic?.get(message.topicId);
            const publishing = prepared?.packet && typeof client.publishPrepared === "function"
                ? client.publishPrepared(prepared.packet, { required: topic.required === true })
                : client.publishEncoded(topic.name, encoded, { required: topic.required === true });
            publishing.catch((error) => {
                const reason = error?.message || String(error);
                if (reason.includes("websocket-backpressure")) {
                    this._incrementFrameDrop();
                    this._noteTransportIssue("frame-dropped", {
                        topic: topic.name,
                        sampleIndex: frame.sampleIndex,
                        reason: "websocket-backpressure",
                    });
                    return;
                }
                this._event("publish-failed", topic.required ? "error" : "warning", {
                    topic: topic.name,
                    sampleIndex: frame.sampleIndex,
                    reason,
                });
            });
        }
        this.topicRouter?.routeOutbound(topic.id, {
            value: message.value,
            retainedValue: encoded,
            typeStr: topic.schema?.type || topic.type,
        }, {
            producer: topic.producer || "simulator",
            observationalOracle: topic.producer === "oracle" && this.config.health?.observationalOracle !== false,
            captureTimeNs: frame.captureTimeNs,
            scheduledDeliveryTimeNs: frame.scheduledDeliveryTimeNs,
            deliveryTimeNs: frame.deliveryTimeNs,
            captureStep: frame.captureStep,
            scheduledDeliveryStep: frame.scheduledDeliveryStep,
            actualDeliveryStep: clock.step,
            cycle: clock.step,
            logClass: "heavy",
            frameId: message.frameId || this.config.measurementFrameId || this.config.frameId,
            sequenceId: frame.sequence,
            syncGroupKey: frame.syncGroupKey,
            calibrationHash: this.calibrationHash,
            canonicalSignalPath: path,
        });
    }

    _deliverNativePackets(frame, clock) {
        const packets = [];
        for (const packet of frame.nativePackets || []) {
            try {
                const payload = new Uint8Array(packet.payload);
                const encoded = encodeNativeSensorPacket({ ...packet, payload }, {
                    sensorId: this.config.id,
                    sampleIndex: frame.sampleIndex,
                    captureTimeNs: frame.captureTimeNs,
                    scheduledDeliveryTimeNs: frame.scheduledDeliveryTimeNs,
                    deliveryTimeNs: frame.deliveryTimeNs,
                    actualDeliveryStep: clock.step,
                });
                const data = this._data();
                const telemetry = data?.bindings?.()?.signalStore;
                const path = `devices.${this.device.telemetryId}.packets.${packet.productId}.${packet.streamId}`;
                telemetry?.publishSignal?.(path, encoded.bytes, {
                    timeUs: Math.round(frame.deliveryTimeNs / 1000),
                    cycle: clock.step,
                    source: "sensors",
                    type: "bytes",
                    category: "devices",
                    replayRole: "derived",
                    logClass: "heavy",
                    retention: "none",
                    descriptorMetadata: {
                        kind: "cev-sim.native-sensor-packet",
                        version: 1,
                        sensorId: this.config.id,
                        productId: packet.productId,
                        streamId: packet.streamId,
                    },
                });
                packets.push(Object.freeze({
                    productId: packet.productId,
                    streamId: packet.streamId,
                    packetIndex: packet.packetIndex,
                    offsetNs: packet.offsetNs,
                    payload,
                    envelope: new Uint8Array(encoded.bytes),
                    payloadDigest: encoded.description.payloadDigest ?? packetPayloadDigest(payload),
                }));
            } catch (error) {
                this._event("publish-failed", "error", {
                    sampleIndex: frame.sampleIndex,
                    productId: packet.productId,
                    streamId: packet.streamId,
                    reason: error.message,
                });
                if (this.pluginStrict) throw this._strictPublishError(error.message, frame, "native-packet", error);
            }
        }
        if (packets.length > 0) {
            this.nativePacketSink?.enqueueBatch?.({
                sensorId: this.config.id,
                sampleIndex: frame.sampleIndex,
                captureTimeNs: frame.captureTimeNs,
                scheduledDeliveryTimeNs: frame.scheduledDeliveryTimeNs,
                deliveryTimeNs: frame.deliveryTimeNs,
                actualDeliveryStep: clock.step,
                packets: Object.freeze(packets),
            });
        }
    }

    _strictPublishError(message, frame, hook, cause = null) {
        const error = new Error(`Plugin sensor "${this.config.id}" ${hook} failed: ${message}`, cause ? { cause } : undefined);
        error.code = "PLUGIN_EXECUTION";
        error.pluginId = this.pluginIdentity?.pluginId ?? null;
        error.contributionId = this.config.type;
        error.unitId = this.config.id;
        error.hook = hook;
        error.sampleIndex = frame?.sampleIndex ?? null;
        error.requiresReset = true;
        error.infrastructureFailure = true;
        return error;
    }

    _time() {
        const value = Number(this.nowNs?.());
        return Number.isFinite(value) ? value : 0;
    }

    _data() {
        return this.runtimeData ?? this.device.getParent?.()?.getParent?.();
    }

    _incrementFrameDrop() {
        this.droppedFrames += 1;
        this.health.droppedFrames += 1;
    }

    _noteTransportIssue(name, payload) {
        const now = this._time();
        if (this._lastTransportNoticeName === name && now - this._lastTransportNoticeNs < 1e9) return;
        this._lastTransportNoticeNs = now;
        this._lastTransportNoticeName = name;
        this._event(name, "warning", payload);
    }

    recordFrameDrop(reason = "sensor-dropout", sampleIndex = this.sampleIndex) {
        this._incrementFrameDrop();
        this._event("frame-dropped", "warning", { sampleIndex, reason });
    }

    recordPointDrops(count = 1) {
        const normalized = Math.max(0, Math.floor(Number(count) || 0));
        this.health.pointDrops += normalized;
    }

    recordShaderBusy(sampleIndex = this.sampleIndex) {
        this._incrementFrameDrop();
        this.health.shaderBusyDrops += 1;
        this.health.missedDeadlines += 1;
        this._event("shader-busy", "warning", { sampleIndex, reason: "previous-readback-in-flight" });
    }

    getHealthSnapshot() {
        return {
            ...this.health,
            queueDepth: this.queue.length,
            queueBytes: this.queuedBytes,
            queueHighWaterMark: this.health.queueHighWaterMark,
            queueBytesHighWaterMark: this.health.queueBytesHighWaterMark,
            errors: this.errors,
        };
    }

    _publishHealth(clock = null) {
        const data = this._data();
        const telemetry = data?.bindings?.()?.signalStore;
        if (!telemetry) return;
        const timeUs = Math.round(Number(clock?.timeNs || data?.simulation?.()?.timeNs || 0) / 1000);
        const cycle = Number(clock?.step || data?.simulation?.()?.steps || 0);
        const options = {
            timeUs,
            cycle,
            source: "sensors",
            category: "devices",
            replayRole: "state",
            logClass: "standard",
            history: false,
            retention: "none",
        };
        const snapshot = this.getHealthSnapshot();
        const last = this._lastPublishedHealth;
        for (const [suffix, value] of Object.entries(snapshot)) {
            if (last && Object.is(last[suffix], value)) continue;
            telemetry.publishSignal?.(
                `devices.${this.device.telemetryId}.${suffix}`,
                value,
                { ...options, type: "uint64" },
            );
        }
        this._lastPublishedHealth = { ...snapshot };
    }

    _event(name, severity, payload) {
        const data = this._data();
        const simulation = data?.simulation?.();
        const telemetry = data?.bindings?.()?.signalStore;
        if (severity === "error") this.errors += 1;
        const timeUs = Math.round(Number(simulation?.timeNs || 0) / 1000);
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.droppedFrames`, this.droppedFrames, { timeUs, cycle: simulation?.steps || 0, source: "sensors", type: "uint64", category: "devices", replayRole: "state", logClass: "standard", history: false, retention: "none" });
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.errors`, this.errors, { timeUs, cycle: simulation?.steps || 0, source: "sensors", type: "uint64", category: "devices", replayRole: "state", logClass: "standard", history: false, retention: "none" });
        telemetry?.emitTelemetryEvent?.({
            timeUs,
            category: "sensors",
            name,
            severity,
            payload: { sensorId: this.config.id, ...payload },
        });
        const halt = severity === "error" && (name === "capture-failed" || name === "frame-invalid");
        if (halt) simulation?.pause?.();
    }
}
