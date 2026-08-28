import {
    AUTHORITY_MODES,
    PRODUCER_NAMESPACES,
    getAutonomyContract,
} from "../autonomy/AutonomyContractCatalog.js";
import { extractHeaderCaptureTimeNs } from "../autonomy/CoordinateFrames.js";
import {
    activeTopicSignalPath,
    candidateTopicSignalPath,
    oracleTopicSignalPath,
    referenceTopicSignalPath,
    topicSignalPath,
} from "../scripting/runtime/SignalPaths.js";

function topicRosType(topic) {
    return topic?.schema?.type || topic?.type || null;
}

export class TopicContractRouter {
    constructor(manifest, options = {}) {
        this.manifest = manifest;
        this.telemetry = options.telemetry ?? null;
        this.byName = new Map((manifest?.topics || []).map((topic) => [topic.name, topic]));
        this.byId = new Map((manifest?.topics || []).map((topic) => [topic.id, topic]));
        this.byContractId = new Map((manifest?.topics || []).map((topic) => [topic.contractId || topic.id, topic]));
        this.sequence = 0;
        this.lastActive = new Map();
        this.lastProducer = new Map();
    }

    getTopic(nameOrId) {
        return this.byName.get(nameOrId) || this.byId.get(nameOrId) || this.byContractId.get(nameOrId) || null;
    }

    validateInbound(info) {
        const topic = this.getTopic(info?.name);
        if (!topic) {
            return { ok: false, code: "undeclared-topic", message: `Topic "${info?.name}" is not declared in the run manifest.` };
        }
        if (topic.direction !== "input") {
            return { ok: false, code: "output-only", message: `Topic "${info.name}" is output-only.` };
        }
        const expectedType = topicRosType(topic);
        if (info.typeStr && expectedType && info.typeStr !== expectedType) {
            return { ok: false, code: "schema-mismatch", message: `Topic "${info.name}" expected ${expectedType}, received ${info.typeStr}.` };
        }
        if (!PRODUCER_NAMESPACES.includes(topic.producer)) {
            return { ok: false, code: "invalid-producer", message: `Invalid producer "${topic.producer}" for "${info.name}".` };
        }
        return { ok: true, topic };
    }

    producerPath(topic, producer = topic.producer) {
        const contractId = topic.contractId || topic.id;
        switch (producer) {
            case "candidate":
                return candidateTopicSignalPath(contractId);
            case "reference":
                return referenceTopicSignalPath(contractId);
            case "oracle":
                return oracleTopicSignalPath(contractId);
            case "simulator":
                return topicSignalPath(topic.name);
            default:
                return `${producer}.topics.${contractId}`;
        }
    }

    activePath(topic) {
        const contractId = topic.contractId || topic.id;
        return activeTopicSignalPath(contractId);
    }

    isExpired(topic, arrivalTimeNs, applyTimeNs) {
        const timeoutNs = Number(topic.timeoutNs);
        if (!Number.isFinite(timeoutNs) || timeoutNs <= 0) return false;
        return applyTimeNs - arrivalTimeNs > timeoutNs;
    }

    isInvalid(topic, captureTimeNs, applyTimeNs) {
        const validityNs = Number(topic.validityNs);
        if (!Number.isFinite(validityNs) || validityNs <= 0 || !Number.isFinite(captureTimeNs)) return false;
        return applyTimeNs - captureTimeNs > validityNs;
    }

    routeInbound(info, { applyStep = 0, applyTimeNs = 0, arrivalTimeNs = applyTimeNs } = {}) {
        const validation = this.validateInbound(info);
        if (!validation.ok) {
            this._emitEvent("topic-rejected", "warning", {
                topic: info?.name,
                code: validation.code,
                message: validation.message,
            });
            return { ok: false, ...validation };
        }
        const topic = validation.topic;
        const captureTimeNs = info.captureTimeNs ?? extractHeaderCaptureTimeNs(info.value) ?? arrivalTimeNs;
        if (this.isInvalid(topic, captureTimeNs, applyTimeNs)) {
            this._emitEvent("topic-invalid", "warning", {
                topic: topic.name,
                contractId: topic.contractId,
                applyStep,
                captureTimeNs,
            });
            return { ok: false, code: "invalid", message: `Topic "${topic.name}" exceeded validity window.` };
        }
        if (this.isExpired(topic, arrivalTimeNs, applyTimeNs)) {
            this._emitEvent("topic-stale", "warning", {
                topic: topic.name,
                contractId: topic.contractId,
                applyStep,
            });
            if (topic.fallback?.contractId) {
                const fallbackTopic = this.getTopic(topic.fallback.contractId);
                if (fallbackTopic) {
                    return this._writeActive(fallbackTopic, info, { applyStep, applyTimeNs, arrivalTimeNs, usedFallback: true });
                }
            }
            return { ok: false, code: "stale", message: `Topic "${topic.name}" exceeded timeout.` };
        }
        return this._writeActive(topic, { ...info, captureTimeNs }, { applyStep, applyTimeNs, arrivalTimeNs });
    }

    routeOutbound(topicIdOrName, info, metadata = {}) {
        const topic = this.getTopic(topicIdOrName);
        if (!topic || topic.direction !== "output") return { ok: false };
        const producer = metadata.producer || topic.producer || "simulator";
        const producerPath = this.producerPath(topic, producer);
        this._publish(producerPath, info.value, {
            ...metadata,
            type: "json",
            source: producer,
            category: "topics",
            replayRole: producer === "oracle" ? "derived" : "state",
            logClass: metadata.logClass || "standard",
            descriptorMetadata: {
                rosType: topicRosType(topic),
                topic: topic.name,
                contractId: topic.contractId,
                producer,
                authority: topic.authority,
                captureTimeNs: metadata.captureTimeNs ?? null,
                scheduledDeliveryTimeNs: metadata.scheduledDeliveryTimeNs ?? null,
                deliveryTimeNs: metadata.deliveryTimeNs ?? null,
                captureStep: metadata.captureStep ?? null,
                scheduledDeliveryStep: metadata.scheduledDeliveryStep ?? null,
                actualDeliveryStep: metadata.actualDeliveryStep ?? metadata.cycle ?? null,
                syncGroupKey: metadata.syncGroupKey ?? null,
                calibrationHash: metadata.calibrationHash ?? null,
                sequenceId: metadata.sequenceId ?? null,
            },
        });
        if (AUTHORITY_MODES.includes(topic.authority)) {
            this._writeActive(topic, info, {
                applyTimeNs: metadata.deliveryTimeNs ?? metadata.captureTimeNs ?? 0,
                arrivalTimeNs: metadata.deliveryTimeNs ?? metadata.captureTimeNs ?? 0,
                applyStep: metadata.cycle ?? 0,
            });
        }
        return { ok: true, producerPath };
    }

    _writeActive(topic, info, { applyStep, applyTimeNs, arrivalTimeNs, usedFallback = false }) {
        const sequence = ++this.sequence;
        const envelope = {
            value: structuredClone(info.value),
            topic: topic.name,
            typeStr: info.typeStr ?? topicRosType(topic),
            contractId: topic.contractId,
            producer: topic.producer,
            authority: topic.authority,
            sequence,
            applyStep,
            captureTimeNs: info.captureTimeNs ?? null,
            arrivalTimeNs,
            applyTimeNs,
            usedFallback,
        };
        const producerPath = this.producerPath(topic, topic.producer);
        this._publish(producerPath, envelope.value, {
            timeUs: Math.round(applyTimeNs / 1000),
            cycle: applyStep,
            source: topic.producer,
            type: "json",
            category: "topics",
            replayRole: "input",
            logClass: "standard",
            descriptorMetadata: {
                rosType: envelope.typeStr,
                topic: topic.name,
                contractId: topic.contractId,
                producer: topic.producer,
                sequenceId: sequence,
                arrivalTimeNs,
                applyTimeNs,
            },
        });
        this.lastProducer.set(topic.contractId || topic.id, envelope);
        const activePath = this.activePath(topic);
        this._publish(activePath, envelope, {
            timeUs: Math.round(applyTimeNs / 1000),
            cycle: applyStep,
            source: "router",
            type: "json",
            category: "topics",
            replayRole: "derived",
            logClass: "standard",
            descriptorMetadata: {
                authority: topic.authority,
                contractId: topic.contractId,
                topic: topic.name,
                sequenceId: sequence,
            },
        });
        this.lastActive.set(topic.contractId || topic.id, envelope);
        this._emitEvent(usedFallback ? "topic-fallback-applied" : "topic-routed", "info", {
            topic: topic.name,
            contractId: topic.contractId,
            authority: topic.authority,
            sequence,
        });
        return { ok: true, topic, envelope, activePath, producerPath, usedFallback };
    }

    _publish(path, value, options) {
        this.telemetry?.publishSignal?.(path, value, options);
    }

    _emitEvent(name, severity, payload) {
        this.telemetry?.emitTelemetryEvent?.({
            timeUs: this.telemetry.getSimulationTimeUs?.() ?? 0,
            category: "topics",
            name,
            severity,
            payload,
        });
    }
}
