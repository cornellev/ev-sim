import { planProtobufRouteAdmission, bindProtobufRunKeys } from "./ProtobufRunBinding.js";
import { compileMapping, applyMapping } from "./ProtobufMapping.js";
import { encodeMessage, decodeMessage } from "./ProtobufSchema.js";
import { TopicInputQueue } from "../simulation/TopicInputQueue.js";
import { normalizeControlCommand } from "../autonomy/ControlCommand.js";
import { validateNativeTopicValue } from "../simulation/NativeTopicContracts.js";
const MAX_PUBLICATION_BYTES = 64 * 1024 * 1024;

function clockValues(clock) {
    if (!Number.isSafeInteger(clock?.timeNs) || clock.timeNs < 0 || !Number.isSafeInteger(clock?.step) || clock.step < 0 || clock.step === Number.MAX_SAFE_INTEGER) throw new Error("Routing requires an integer simulation clock.");
    return clock;
}

export class ProtobufRouteRuntime {
    constructor({ publicationPort, inputQueue } = {}) {
        this.publicationPort = publicationPort ?? (() => false);
        this.inputQueue = inputQueue ?? null;
        this.generation = 0;
        this.disposed = true;
    }

    configure({ resolvedRun, runId = resolvedRun?.manifest?.id, publicationPort = this.publicationPort, inputQueue = this.inputQueue } = {}) {
        if (resolvedRun?.version !== 13) throw new Error("Native routing requires a v13 run bundle.");
        if (typeof publicationPort !== "function") throw new Error("Routing requires a synchronous publication port.");
        const admitted = planProtobufRouteAdmission({ manifest: resolvedRun.manifest, interfaceResource: resolvedRun.protobufInterface, resolvedRun });
        const keys = resolvedRun.protobufInterface ? bindProtobufRunKeys(resolvedRun.protobufInterface, runId) : new Map();
        const entries = admitted.routes.map((entry) => ({ ...entry, key: keys.get(entry.route.id), compiled: compileMapping(entry, { resolvedRun, runId }) }));
        const selectors = new Set();
        for (const entry of entries.filter((entry) => entry.route.direction === "subscribe")) for (const selector of new Set([entry.route.id, entry.key])) {
            if (selectors.has(selector)) throw new Error("Subscription key collides with a route identifier.");
            selectors.add(selector);
        }
        this.runId = runId;
        this.frameId = resolvedRun.manifest.sensorRig?.rootFrameId ?? "base_link";
        this.publicationPort = publicationPort;
        this.inputQueue = inputQueue ?? new TopicInputQueue(resolvedRun.manifest.topics);
        this.publishers = new Map();
        this.topics = new Map(resolvedRun.manifest.topics.map((topic) => [topic.id, topic]));
        this.subscribers = new Map();
        this.bootstrap = [];
        for (const entry of entries) {
            if (entry.route.direction === "subscribe") {
                this.subscribers.set(entry.route.id, entry);
                this.subscribers.set(entry.key, entry);
            } else if (entry.route.source.bootstrapId) {
                const value = resolvedRun.protobufInterface.document.bootstrap.find((item) => item.id === entry.route.source.bootstrapId);
                this.bootstrap.push({ entry, value: value.value, intervalNs: value.repeatMs * 1_000_000, nextTimeNs: 0 });
            } else {
                const id = entry.route.source.topicId;
                if (!this.publishers.has(id)) this.publishers.set(id, []);
                this.publishers.get(id).push(entry);
            }
        }
        this.disposed = false;
        this.reset();
        return { ok: true, generation: this.generation, routes: entries.length };
    }

    _encode(entry, value, metadata) {
        const mapped = applyMapping(entry.compiled, { value, metadata: { ...metadata, runId: this.runId } });
        const bytes = encodeMessage(entry.messageType, mapped);
        return { key: entry.key, bytes, routeId: entry.route.id, generation: this.generation };
    }

    _publish(entry, value, metadata) { return this._acceptPublication(this._encode(entry, value, metadata)); }

    _acceptPublication(packet) {
        const result = this.publicationPort(packet);
        if (result?.then) throw new Error("Publication must return synchronous acceptance, not a Promise.");
        if (result !== true && result?.ok !== true) { this.stats.publishRejected++; return { ok: false, code: "transport-rejected", routeId: packet.routeId }; }
        this.stats.published++;
        return { ok: true, routeId: packet.routeId };
    }

    publishTopic(envelope) {
        if (this.disposed) return { ok: false, code: "disposed" };
        try {
            const topic = this.topics.get(envelope.topicId);
            if (!topic || topic.direction !== "output" || envelope.valueContract?.id !== topic.valueContract.id || envelope.valueContract?.version !== topic.valueContract.version) throw new Error("Publication topic/contract mismatch.");
            const validation = validateNativeTopicValue(topic.valueContract, envelope.value);
            if (!validation.ok) throw new Error(validation.message);
            const entries = this.publishers.get(envelope.topicId) ?? [];
            let bytes = 0;
            const packets = entries.map((entry) => {
                if (envelope.valueContract?.id !== entry.topicContract.valueContract.id || envelope.valueContract?.version !== entry.topicContract.valueContract.version) throw new Error("Publication contract mismatch.");
                const packet = this._encode(entry, envelope.value, envelope.metadata);
                bytes += packet.bytes.byteLength;
                if (bytes > MAX_PUBLICATION_BYTES) throw new Error("Mapped publication batch exceeds 64 MiB.");
                return packet;
            });
            const results = packets.map((packet) => this._acceptPublication(packet));
            return { ok: results.every((result) => result.ok), results };
        } catch (error) { this.stats.publishRejected++; return { ok: false, code: "mapping-invalid", message: error.message }; }
    }

    acceptInbound(routeIdOrKey, bytes, { clock, generation = this.generation } = {}) {
        if (this.disposed || generation !== this.generation) return { ok: false, code: "stale-generation" };
        try {
            clockValues(clock);
            const entry = this.subscribers.get(routeIdOrKey);
            if (!entry) throw new Error("Unknown subscription.");
            const value = applyMapping(entry.compiled, { value: decodeMessage(entry.messageType, bytes), metadata: { runId: this.runId, simTimeNs: clock.timeNs, deliveryTimeNs: clock.timeNs } });
            if (entry.topicContract.valueContract.id === "cev.control-command") {
                const check = normalizeControlCommand(value, { runId: this.runId, frameId: this.frameId, applyTimeNs: clock.timeNs });
                if (!check.ok) { this.stats.inboundRejected++; return { ...check, accepted: false }; }
            }
            const info = { name: entry.topicContract.name, topicId: entry.topicContract.id, valueContract: entry.topicContract.valueContract, value, producer: entry.topicContract.producer,
                captureTimeNs: value.captureTimeNs ?? clock.timeNs, arrivalTimeNs: clock.timeNs, runId: this.runId };
            const queued = this.inputQueue.enqueue(info, clock.step + 1, { arrivalTimeNs: clock.timeNs, rejectNewest: true });
            if (!queued || queued.rejected) { this.stats.inboundRejected++; return { ok: false, accepted: false, code: queued?.reason ?? "queue-rejected" }; }
            this.stats.inboundAccepted++;
            return { ok: true, accepted: true, applied: false, applyStep: queued.applyStep, generation: this.generation };
        } catch (error) { this.stats.inboundRejected++; return { ok: false, accepted: false, code: "inbound-invalid", message: error.message }; }
    }

    deliver(clock) {
        if (this.disposed) return { ok: false, code: "disposed" };
        clockValues(clock);
        const results = [];
        for (const bootstrap of this.bootstrap) {
            if (clock.timeNs < bootstrap.nextTimeNs) continue;
            const result = this._publish(bootstrap.entry, bootstrap.value, { simTimeNs: clock.timeNs, captureTimeNs: clock.timeNs, deliveryTimeNs: clock.timeNs, captureStep: clock.step, actualDeliveryStep: clock.step, sequenceId: this.stats.published });
            results.push(result);
            if (bootstrap.intervalNs) {
                const interval = BigInt(bootstrap.intervalNs);
                const next = (BigInt(clock.timeNs) / interval + 1n) * interval;
                bootstrap.nextTimeNs = next <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(next) : Infinity;
            } else bootstrap.nextTimeNs = Infinity;
        }
        return { ok: results.every((result) => result.ok), results };
    }

    reset() {
        this.generation++;
        this.inputQueue?.reset();
        for (const bootstrap of this.bootstrap ?? []) bootstrap.nextTimeNs = 0;
        this.stats = { published: 0, publishRejected: 0, inboundAccepted: 0, inboundRejected: 0 };
        return this.generation;
    }

    dispose() {
        this.reset();
        this.disposed = true;
        this.publishers?.clear();
        this.topics?.clear();
        this.subscribers?.clear();
        this.bootstrap = [];
    }
}
