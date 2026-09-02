import { encodeTopicValue } from "../../client/Client.js";
import { SeededRNG } from "../../util/SeededRNG.js";
import {
    resolveFixedStepSensorSchedule,
    resolveSensorDelivery,
} from "../../simulation/sensors/FixedStepSensorSchedule.js";
import { buildDiagnosticArray } from "./SensorMessages.js";
import {
    bumpEncodeOwnerGeneration,
    cancelEncodeOwner,
    encodePoolHasCapacity,
    encodeTopicValueAsync,
    estimateEncodeBytes,
    isHeavySensorValue,
} from "./SensorEncodePool.js";
import { simulationSha256 } from "../../simulation/kernel/SimulationHashes.js";

const DEFAULT_MAX_QUEUE_BYTES = 64 * 1024 * 1024;

export function normalizeCaptureResult(captured, captureTimeNs, sampleIndex) {
    if (captured == null) {
        return { messages: [], captureTimeNs, sampleIndex };
    }
    if (Array.isArray(captured)) {
        return { messages: captured, captureTimeNs, sampleIndex };
    }
    const messages = Array.isArray(captured.messages) ? captured.messages : [];
    return {
        messages,
        captureTimeNs: Number.isFinite(captured.captureTimeNs) ? captured.captureTimeNs : captureTimeNs,
        sampleIndex: Number.isFinite(captured.sampleIndex) ? captured.sampleIndex : sampleIndex,
        rng: captured.rng,
        observation: captured.observation ?? null,
    };
}

function estimateFrameBytes(messages = []) {
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
    } = {}) {
        this.device = device;
        this.config = config;
        this.seed = seed;
        this.topics = new Map(topics.map((topic) => [topic.id, topic]));
        this.topicRouter = topicRouter;
        this.calibrationHash = calibrationHash;
        this.runtimeData = runtimeData;
        this.manifestStepNs = stepNs;
        this.nowNs = nowNs
            || monotonicClock?.nowNs?.bind(monotonicClock)
            || (() => Math.round((globalThis.performance?.now?.() ?? 0) * 1e6));
        this.periodNs = Math.max(1, Math.round(1e9 / config.rateHz));
        this.maxQueueFrames = Math.max(1, Number(config.maxQueueFrames || 8));
        this.maxQueueBytes = Math.max(1024, Number(config.maxQueueBytes || DEFAULT_MAX_QUEUE_BYTES));
        this.encodeOwnerId = `sensor:${config.id || device?.telemetryId || "unknown"}`;
        this.encodeGeneration = bumpEncodeOwnerGeneration(this.encodeOwnerId);
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
        cancelEncodeOwner(this.encodeOwnerId);
        this.encodeGeneration = bumpEncodeOwnerGeneration(this.encodeOwnerId);
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
        cancelEncodeOwner(this.encodeOwnerId);
        this.encodeGeneration = bumpEncodeOwnerGeneration(this.encodeOwnerId);
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

    _captureContext(clock) {
        const captureTimeNs = this.nextCaptureStep * this.stepNs;
        const sampleIndex = this.sampleIndex++;
        const skip = this.device.gpuCapture
            && this.device.getParent?.()?.getParent?.()?.simulation?.()?.gpuCaptureEnabled === false;
        return {
            captureTimeNs,
            sampleIndex,
            skip,
            rng: new SeededRNG(`${this.seed}:sensor:${this.config.id}:sample:${sampleIndex}`),
            clock,
        };
    }

    _acceptCapture(captured, context, captureStartNs) {
        const result = normalizeCaptureResult(captured, context.captureTimeNs, context.sampleIndex);
        const captureDurationNs = Math.max(0, this._time() - captureStartNs);
        this.health.captureTimeNs = captureDurationNs;
        this.health.captureTimeTotalNs += captureDurationNs;
        if (result.messages.length > 0 || result.observation) {
            this.health.capturedFrames += 1;
            this.enqueue(
                result.messages,
                result.captureTimeNs,
                result.sampleIndex,
                result.rng || context.rng,
                result.observation,
            );
        }
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
                if (error?.infrastructureFailure) throw error;
                this._event("capture-failed", "error", { sampleIndex: context.sampleIndex, reason: error.message });
            }
            this.nextCaptureStep += this.periodSteps;
        }
    }

    async updateAsync(clock) {
        this._initializeSchedule(clock);
        while (clock.step >= this.nextCaptureStep) {
            const context = this._captureContext(clock);
            if (!context.skip) {
                try {
                    this.health.captureAttempts += 1;
                    const captureStartNs = this._time();
                    const captured = await this.device.captureAt?.(context);
                    this._acceptCapture(captured, context, captureStartNs);
                } catch (error) {
                    if (error?.infrastructureFailure) throw error;
                    this._event("capture-failed", "error", {
                        sampleIndex: context.sampleIndex,
                        reason: error.message,
                    });
                }
            }
            this.nextCaptureStep += this.periodSteps;
        }
    }

    enqueue(messages, captureTimeNs, sampleIndex, rng, observation = null) {
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
        const frameBytes = estimateFrameBytes(frameMessages) + estimateObservationBytes(observation);
        if (this.queue.length >= this.maxQueueFrames || this.queuedBytes + frameBytes > this.maxQueueBytes) {
            this.device.releaseObservation?.(observation);
            this._incrementFrameDrop();
            this._event("frame-dropped", "warning", {
                sampleIndex,
                reason: this.queue.length >= this.maxQueueFrames ? "delivery-queue-full" : "delivery-queue-bytes",
                queueBytes: this.queuedBytes,
                frameBytes,
            });
            return;
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
            observation,
            encodedByTopic: new Map(),
            encodeReady: false,
            encodeFailed: false,
            encodeCancelled: false,
            bytes: frameBytes,
            zeroLatency: delivery.fixedLatencyNs <= 0 && delivery.jitterNs <= 0,
        });
        const frame = this.queue[this.queue.length - 1];
        this.queuedBytes += frameBytes;
        this._beginEncode(frame);
        this.health.queueDepth = this.queue.length;
        this.health.queueBytes = this.queuedBytes;
        this.health.queueHighWaterMark = Math.max(this.health.queueHighWaterMark, this.queue.length);
        this.health.queueBytesHighWaterMark = Math.max(this.health.queueBytesHighWaterMark, this.queuedBytes);
    }

    _beginEncode(frame) {
        const heavy = frame.messages.filter((message) => {
            const topic = this.topics.get(message.topicId);
            return topic && isHeavySensorValue(message.value);
        });
        if (heavy.length === 0 || frame.zeroLatency) {
            // Zero-latency frames deliver same-tick; skip speculative async encode.
            frame.encodeReady = true;
            return;
        }
        const bytesNeeded = estimateFrameBytes(heavy);
        if (!encodePoolHasCapacity(bytesNeeded)) {
            this.health.encodeRejected += 1;
            frame.encodeReady = true;
            return;
        }
        const generation = this.encodeGeneration;
        const jobs = heavy.map(async (message) => {
            const topic = this.topics.get(message.topicId);
            const encoded = await encodeTopicValueAsync(topic.schema?.type || topic.type, message.value, {
                ownerId: this.encodeOwnerId,
                ownerGeneration: generation,
            });
            if (generation !== this.encodeGeneration || frame.encodeCancelled) {
                throw new Error("encode cancelled");
            }
            frame.encodedByTopic.set(message.topicId, encoded);
        });
        Promise.all(jobs).then(() => {
            if (generation !== this.encodeGeneration || frame.encodeCancelled) return;
            frame.encodeReady = true;
        }).catch((error) => {
            // Worker/timeout/cancel are best-effort. Deliver falls through to sync encode.
            const reason = String(error?.message || error);
            frame.encodeReady = true;
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
        });
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
            frame.observation = null;
            frame.encodedByTopic?.clear?.();
            frame.encodedByTopic = null;
        }
        this._publishHealth(clock);
    }

    _deliverMessage(message, frame, clock) {
        const topic = this.topics.get(message.topicId);
        if (!topic) {
            this._event("publish-failed", "error", { sampleIndex: frame.sampleIndex, reason: `unknown-topic:${message.topicId}` });
            return;
        }
        let encoded;
        try {
            const encodeStartNs = this._time();
            encoded = frame.encodedByTopic?.get(message.topicId)
                || encodeTopicValue(topic.schema?.type || topic.type, message.value);
            const encodeDurationNs = Math.max(0, this._time() - encodeStartNs);
            this.health.encodeTimeNs = encodeDurationNs;
            this.health.encodeTimeTotalNs += encodeDurationNs;
        } catch (error) {
            this._event("publish-failed", "error", { sampleIndex: frame.sampleIndex, topic: topic.name, reason: error.message });
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
            client.publishEncoded(topic.name, encoded, { required: topic.required === true }).catch((error) => {
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
        this.topicRouter?.routeOutbound(topic.id, { value: message.value, typeStr: topic.schema?.type || topic.type }, {
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
