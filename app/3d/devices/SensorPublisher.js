import { encodeTopicValue } from "../../client/Client.js";
import { SeededRNG } from "../../util/SeededRNG.js";

export class SensorPublisher {
    constructor(device, config, { seed = "42", topics = [] } = {}) {
        this.device = device;
        this.config = config;
        this.seed = seed;
        this.topics = new Map(topics.map((topic) => [topic.id, topic]));
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
            const rng = new SeededRNG(`${this.seed}:sensor:${this.config.id}:sample:${index}`);
            try {
                const messages = this.device.captureAt?.({ captureTimeNs, sampleIndex: index, rng }) || [];
                if (messages.length > 0) this.enqueue(messages, captureTimeNs, index, rng);
            } catch (error) {
                this._event("capture-failed", "error", { sampleIndex: index, reason: error.message });
            }
            this.nextCaptureStep += this.periodSteps;
        }
    }

    enqueue(messages, captureTimeNs, sampleIndex, rng) {
        const jitter = Number(this.config.latency?.jitterNs || 0);
        const signedJitter = jitter > 0 ? Math.round((rng.next() * 2 - 1) * jitter) : 0;
        const deliveryTimeNs = Math.max(captureTimeNs, captureTimeNs + Number(this.config.latency?.fixedNs || 0) + signedJitter);
        if (this.queue.length >= this.config.maxQueueFrames) {
            this.droppedFrames += 1;
            this._event("frame-dropped", "warning", { sampleIndex, reason: "delivery-queue-full" });
            return;
        }
        this.queue.push({ captureTimeNs, deliveryTimeNs, sampleIndex, messages });
    }

    deliver(clock) {
        const ready = this.queue.filter((frame) => frame.deliveryTimeNs <= clock.timeNs);
        this.queue = this.queue.filter((frame) => frame.deliveryTimeNs > clock.timeNs);
        for (const frame of ready) {
            for (const message of frame.messages) this._deliverMessage(message, frame, clock);
        }
    }

    _deliverMessage(message, frame, clock) {
        const topic = this.topics.get(message.topicId);
        if (!topic) {
            this._event("publish-failed", "error", { sampleIndex: frame.sampleIndex, reason: `unknown-topic:${message.topicId}` });
            return;
        }
        let encoded;
        try {
            encoded = encodeTopicValue(topic.type, message.value);
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
            frameId: this.config.frameId,
            captureTimeNs: frame.captureTimeNs,
            deliveryTimeNs: frame.deliveryTimeNs,
            calibration: this.config.calibration,
        };
        telemetry?.publishSignal?.(path, encoded, {
            timeUs,
            cycle: clock.step,
            source: "sensors",
            type: "bytes",
            category: "devices",
            replayRole: "derived",
            logClass: "heavy",
            descriptorMetadata: metadata,
        });
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.output`, encoded, {
            timeUs, cycle: clock.step, source: "sensors", type: "bytes", category: "devices", replayRole: "derived", logClass: "heavy",
        });
        const client = data?.client?.()?.get?.();
        if (!client?.isOpen?.()) {
            if (topic.required) this._event("required-topic-unavailable", "error", { topic: topic.name, sampleIndex: frame.sampleIndex });
            return;
        }
        client.publishEncoded(topic.name, encoded).catch((error) => {
            this._event("publish-failed", topic.required ? "error" : "warning", { topic: topic.name, sampleIndex: frame.sampleIndex, reason: error.message });
        });
    }

    _event(name, severity, payload) {
        const data = this.device.getParent?.()?.getParent?.();
        const simulation = data?.simulation?.();
        const telemetry = data?.bindings?.()?.signalStore;
        if (severity === "error") this.errors += 1;
        const timeUs = Math.round(Number(simulation?.timeNs || 0) / 1000);
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.droppedFrames`, this.droppedFrames, { timeUs, cycle: simulation?.steps || 0, source: "sensors", type: "uint64", category: "devices", replayRole: "state", logClass: "standard" });
        telemetry?.publishSignal?.(`devices.${this.device.telemetryId}.errors`, this.errors, { timeUs, cycle: simulation?.steps || 0, source: "sensors", type: "uint64", category: "devices", replayRole: "state", logClass: "standard" });
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
