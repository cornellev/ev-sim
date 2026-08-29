import { encodeTopicValue } from "../../client/Client.js";
import { SeededRNG } from "../../util/SeededRNG.js";
import { buildDiagnosticArray } from "./SensorMessages.js";
import { encodeTopicValueAsync, isHeavySensorValue } from "./SensorEncodePool.js";

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
    };
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
    } = {}) {
        this.device = device;
        this.config = config;
        this.seed = seed;
        this.topics = new Map(topics.map((topic) => [topic.id, topic]));
        this.topicRouter = topicRouter;
        this.calibrationHash = calibrationHash;
        this.manifestStepNs = stepNs;
        this.nowNs = nowNs
            || monotonicClock?.nowNs?.bind(monotonicClock)
            || (() => Math.round((globalThis.performance?.now?.() ?? 0) * 1e6));
        this.periodNs = Math.max(1, Math.round(1e9 / config.rateHz));
        this.queue = [];
        this.sampleIndex = 0;
        this.droppedFrames = 0;
        this.errors = 0;
        this.reset();
    }

    reset() {
        this.queue = [];
        this.sampleIndex = 0;
        this.droppedFrames = 0;
        this.errors = 0;
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

    update(clock) {
        if (!this.stepNs) {
            this.stepNs = Math.max(1, Math.round(clock.timeNs / Math.max(1, clock.step)));
            this.periodSteps = Math.max(1, Math.round(this.periodNs / this.stepNs));
            const phaseSteps = Math.max(0, Math.round(Number(this.config.phaseNs || 0) / this.stepNs));
            this.nextCaptureStep = phaseSteps > 0 ? phaseSteps : this.periodSteps;
        }
        while (clock.step >= this.nextCaptureStep) {
            const captureTimeNs = this.nextCaptureStep * this.stepNs;
            const index = this.sampleIndex++;
            const skipGpu = this.device.gpuCapture
                && this.device.getParent?.()?.getParent?.()?.simulation?.()?.gpuCaptureEnabled === false;
            if (skipGpu) {
                this.nextCaptureStep += this.periodSteps;
                continue;
            }
            const rng = new SeededRNG(`${this.seed}:sensor:${this.config.id}:sample:${index}`);
            try {
                this.health.captureAttempts += 1;
                const captureStartNs = this._time();
                const captured = this.device.captureAt?.({ captureTimeNs, sampleIndex: index, rng });
                const result = normalizeCaptureResult(captured, captureTimeNs, index);
                const captureDurationNs = Math.max(0, this._time() - captureStartNs);
                this.health.captureTimeNs = captureDurationNs;
                this.health.captureTimeTotalNs += captureDurationNs;
                if (result.messages.length > 0) {
                    this.health.capturedFrames += 1;
                    this.enqueue(result.messages, result.captureTimeNs, result.sampleIndex, result.rng || rng);
                }
            } catch (error) {
                this._event("capture-failed", "error", { sampleIndex: index, reason: error.message });
            }
            this.nextCaptureStep += this.periodSteps;
        }
        this._publishHealth(clock);
    }

    enqueue(messages, captureTimeNs, sampleIndex, rng) {
        const jitter = Number(this.config.latency?.jitterNs || 0);
        const signedJitter = jitter > 0 ? Math.round((rng.next() * 2 - 1) * jitter) : 0;
        const fixedLatency = Number(this.config.latency?.fixedNs || 0);
        const scheduledDeliveryTimeNs = captureTimeNs + fixedLatency;
        const deliveryTimeNs = Math.max(captureTimeNs, scheduledDeliveryTimeNs + signedJitter);
        const stepNs = this.stepNs || this.manifestStepNs || 16_666_667;
        const captureStep = Math.round(captureTimeNs / stepNs);
        const scheduledDeliveryStep = Math.round(scheduledDeliveryTimeNs / stepNs);
        if (this.queue.length >= this.config.maxQueueFrames) {
            this._incrementFrameDrop();
            this._event("frame-dropped", "warning", { sampleIndex, reason: "delivery-queue-full" });
            return;
        }
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
            encodedByTopic: new Map(),
            encodeReady: false,
            encodeFailed: false,
        });
        const frame = this.queue[this.queue.length - 1];
        this._beginEncode(frame);
        this.health.queueDepth = this.queue.length;
        this.health.queueHighWaterMark = Math.max(this.health.queueHighWaterMark, this.queue.length);
    }

    _beginEncode(frame) {
        const heavy = frame.messages.filter((message) => {
            const topic = this.topics.get(message.topicId);
            return topic && isHeavySensorValue(message.value);
        });
        if (heavy.length === 0) {
            frame.encodeReady = true;
            return;
        }
        const jobs = heavy.map(async (message) => {
            const topic = this.topics.get(message.topicId);
            const encoded = await encodeTopicValueAsync(topic.schema?.type || topic.type, message.value);
            frame.encodedByTopic.set(message.topicId, encoded);
        });
        Promise.all(jobs).then(() => {
            frame.encodeReady = true;
        }).catch((error) => {
            frame.encodeFailed = true;
            frame.encodeReady = true;
            this._event("publish-failed", "error", {
                sampleIndex: frame.sampleIndex,
                reason: error?.message || String(error),
            });
        });
    }

    deliver(clock) {
        const ready = this.queue.filter((frame) => frame.deliveryTimeNs <= clock.timeNs);
        this.queue = this.queue.filter((frame) => frame.deliveryTimeNs > clock.timeNs);
        this.health.queueDepth = this.queue.length;
        for (const frame of ready) {
            if (frame.encodeFailed) continue;
            // Worker encode is best-effort. If it is not ready by delivery (common when
            // latency is 0 and delivery is same-tick), fall through to sync encode in
            // _deliverMessage instead of dropping the frame.
            const deadlineNs = Number(this.config.health?.deadlineNs);
            if (Number.isFinite(deadlineNs) && deadlineNs > 0 && clock.timeNs - frame.captureTimeNs > deadlineNs) {
                this.health.missedDeadlines += 1;
                this._event("deadline-missed", "warning", {
                    sampleIndex: frame.sampleIndex,
                    deadlineNs,
                    elapsedNs: clock.timeNs - frame.captureTimeNs,
                });
            }
            const transportStartNs = this._time();
            for (const message of frame.messages) this._deliverMessage(message, frame, clock);
            const transportDurationNs = Math.max(0, this._time() - transportStartNs);
            this.health.transportTimeNs = transportDurationNs;
            this.health.transportTimeTotalNs += transportDurationNs;
            this.health.deliveredFrames += 1;
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
        const data = this.device.getParent?.()?.getParent?.();
        const telemetry = data?.bindings?.()?.signalStore;
        const timeUs = Math.round(clock.timeNs / 1000);
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
        };
        telemetry?.publishSignal?.(path, encoded, {
            timeUs: Math.round(frame.deliveryTimeNs / 1000),
            cycle: clock.step,
            source: "sensors",
            type: "bytes",
            category: "devices",
            replayRole: "derived",
            logClass: "heavy",
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
        });
        const client = data?.client?.()?.get?.();
        if (!client?.isOpen?.()) {
            if (topic.required) this._event("required-topic-unavailable", "error", { topic: topic.name, sampleIndex: frame.sampleIndex });
            return;
        }
        client.publishEncoded(topic.name, encoded).catch((error) => {
            this._event("publish-failed", topic.required ? "error" : "warning", { topic: topic.name, sampleIndex: frame.sampleIndex, reason: error.message });
        });
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
        });
    }

    _time() {
        const value = Number(this.nowNs?.());
        return Number.isFinite(value) ? value : 0;
    }

    _incrementFrameDrop() {
        this.droppedFrames += 1;
        this.health.droppedFrames += 1;
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
            queueHighWaterMark: this.health.queueHighWaterMark,
            errors: this.errors,
        };
    }

    _publishHealth(clock = null) {
        const data = this.device.getParent?.()?.getParent?.();
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
        };
        for (const [suffix, value] of Object.entries(this.getHealthSnapshot())) {
            telemetry.publishSignal?.(
                `devices.${this.device.telemetryId}.${suffix}`,
                value,
                { ...options, type: "uint64" },
            );
        }
    }

    _event(name, severity, payload) {
        const data = this.device.getParent?.()?.getParent?.();
        const simulation = data?.simulation?.();
        const telemetry = data?.bindings?.()?.signalStore;
        if (severity === "error") this.errors += 1;
        const timeUs = Math.round(Number(simulation?.timeNs || 0) / 1000);
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.droppedFrames`, this.droppedFrames, { timeUs, cycle: simulation?.steps || 0, source: "sensors", type: "uint64", category: "devices", replayRole: "state", logClass: "standard", history: false });
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.errors`, this.errors, { timeUs, cycle: simulation?.steps || 0, source: "sensors", type: "uint64", category: "devices", replayRole: "state", logClass: "standard", history: false });
        telemetry?.emitTelemetryEvent?.({
            timeUs,
            category: "sensors",
            name,
            severity,
            payload: { sensorId: this.config.id, ...payload },
        });
        if (severity === "error") simulation?.pause?.();
    }
}
