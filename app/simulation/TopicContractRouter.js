import {
    AUTHORITY_MODES,
    PRODUCER_NAMESPACES,
} from "../autonomy/AutonomyContractCatalog.js";
import { extractHeaderCaptureTimeNs } from "../autonomy/CoordinateFrames.js";
import { validateInboundPayload } from "../autonomy/AutonomyVisualizationModel.js";
import {
    activeTopicSignalPath,
    candidateTopicSignalPath,
    oracleTopicSignalPath,
    referenceTopicSignalPath,
    topicSignalPath,
} from "../scripting/runtime/SignalPaths.js";
import { isHeavyValue } from "../scripting/runtime/SignalStore.js";

function topicRosType(topic) {
    return topic?.schema?.type || topic?.type || null;
}

function resolvePayloadLogClass(value, metadataLogClass) {
    if (metadataLogClass === "heavy" || isHeavyValue(value)) return "heavy";
    return metadataLogClass || "standard";
}

function shouldRouteDownstream(topic) {
    if (topic?.routeDownstream === false) return false;
    if (topic?.routeDownstream === true) return true;
    if (topic?.direction !== "input") return AUTHORITY_MODES.includes(topic?.authority);
    // Controls default on; perception/localization observational by default.
    return topic.stage === "controls";
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
        this.lastStatus = new Map();
        this._defineContractSignals();
    }

    getTopic(nameOrId) {
        return this.byName.get(nameOrId) || this.byId.get(nameOrId) || this.byContractId.get(nameOrId) || null;
    }

    reset() {
        this.sequence = 0;
        this.lastActive.clear();
        this.lastProducer.clear();
        this.lastStatus.clear();
    }

    getDeterministicState() {
        return {
            sequence: this.sequence,
            statuses: Object.fromEntries(
                [...this.lastStatus.entries()]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([id, status]) => [id, structuredClone(status)]),
            ),
        };
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
        const payloadCheck = validateInboundPayload(topic.contractId || topic.id, expectedType, info.value);
        if (!payloadCheck.ok) {
            return { ok: false, code: payloadCheck.code, message: payloadCheck.message, topic };
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

    diagnosticsPath(topic) {
        const contractId = topic.contractId || topic.id;
        return `diagnostics.topics.${contractId}`;
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
            if (validation.topic) {
                this._publishStatus(validation.topic, {
                    code: validation.code,
                    status: "rejected",
                    captureTimeNs: extractHeaderCaptureTimeNs(info?.value),
                    arrivalTimeNs,
                    applyTimeNs,
                    applyStep,
                    message: validation.message,
                });
            }
            return {
                ok: false,
                ...validation,
                payload: {
                    contractId: validation.topic?.contractId,
                    captureTimeNs: extractHeaderCaptureTimeNs(info?.value),
                    arrivalTimeNs,
                },
            };
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
            this._publishStatus(topic, {
                code: "invalid",
                status: "invalid",
                captureTimeNs,
                arrivalTimeNs,
                applyTimeNs,
                applyStep,
                message: `Topic "${topic.name}" exceeded validity window.`,
            });
            return {
                ok: false,
                code: "invalid",
                message: `Topic "${topic.name}" exceeded validity window.`,
                topic,
                payload: { contractId: topic.contractId, captureTimeNs, arrivalTimeNs },
            };
        }
        if (this.isExpired(topic, arrivalTimeNs, applyTimeNs)) {
            this._emitEvent("topic-stale", "warning", {
                topic: topic.name,
                contractId: topic.contractId,
                applyStep,
            });
            this._publishStatus(topic, {
                code: "stale",
                status: "stale",
                captureTimeNs,
                arrivalTimeNs,
                applyTimeNs,
                applyStep,
                message: `Topic "${topic.name}" exceeded timeout.`,
            });
            if (topic.fallback?.contractId) {
                const fallbackTopic = this.getTopic(topic.fallback.contractId);
                if (fallbackTopic) {
                    return this._writeActive(fallbackTopic, info, {
                        applyStep,
                        applyTimeNs,
                        arrivalTimeNs,
                        usedFallback: true,
                    });
                }
            }
            return {
                ok: false,
                code: "stale",
                message: `Topic "${topic.name}" exceeded timeout.`,
                topic,
                payload: { contractId: topic.contractId, captureTimeNs, arrivalTimeNs },
            };
        }
        return this._writeActive(topic, { ...info, captureTimeNs }, { applyStep, applyTimeNs, arrivalTimeNs });
    }

    routeOutbound(topicIdOrName, info, metadata = {}) {
        const topic = this.getTopic(topicIdOrName);
        if (!topic || topic.direction !== "output") return { ok: false };
        const producer = metadata.producer || topic.producer || "simulator";
        const producerPath = this.producerPath(topic, producer);
        const logClass = resolvePayloadLogClass(info.value, metadata.logClass);
        const observationalOracle = producer === "oracle" && metadata.observationalOracle === true;
        const routeActive = !observationalOracle && shouldRouteDownstream(topic);
        // Publish producer once. When intentionally routing active, `_writeActive`
        // owns the producer write so the same payload is not stored twice.
        if (!routeActive) {
            this._publish(producerPath, info.value, {
                ...metadata,
                type: "json",
                source: producer,
                category: "topics",
                replayRole: producer === "oracle" ? "derived" : "state",
                logClass,
                history: logClass === "heavy" ? undefined : false,
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
                    sequenceId: metadata.sequenceId ?? null,
                    syncGroupKey: metadata.syncGroupKey ?? null,
                    calibrationHash: metadata.calibrationHash ?? null,
                    canonicalSignalPath: metadata.canonicalSignalPath ?? null,
                },
            });
            this.lastProducer.set(topic.contractId || topic.id, {
                value: info.value,
                topic: topic.name,
                typeStr: info.typeStr ?? topicRosType(topic),
                contractId: topic.contractId,
                producer,
                sequence: metadata.sequenceId ?? null,
                captureTimeNs: metadata.captureTimeNs ?? null,
                deliveryTimeNs: metadata.deliveryTimeNs ?? null,
            });
            this._publishStatus(topic, {
                code: "ok",
                status: "ok",
                captureTimeNs: metadata.captureTimeNs ?? null,
                arrivalTimeNs: metadata.deliveryTimeNs ?? metadata.captureTimeNs ?? 0,
                applyTimeNs: metadata.deliveryTimeNs ?? metadata.captureTimeNs ?? 0,
                applyStep: metadata.cycle ?? 0,
                sequence: metadata.sequenceId ?? null,
                usedFallback: false,
                routeDownstream: false,
                lastGoodSequence: metadata.sequenceId ?? null,
            });
        } else {
            this._writeActive(topic, {
                ...info,
                captureTimeNs: metadata.captureTimeNs ?? info.captureTimeNs ?? null,
            }, {
                applyTimeNs: metadata.deliveryTimeNs ?? metadata.captureTimeNs ?? 0,
                arrivalTimeNs: metadata.deliveryTimeNs ?? metadata.captureTimeNs ?? 0,
                applyStep: metadata.cycle ?? 0,
                logClass,
                producerOverride: producer,
                metadata,
            });
        }
        return { ok: true, producerPath };
    }

    _writeActive(topic, info, {
        applyStep,
        applyTimeNs,
        arrivalTimeNs,
        usedFallback = false,
        logClass = null,
        producerOverride = null,
        metadata = null,
    } = {}) {
        const sequence = ++this.sequence;
        const payloadLogClass = resolvePayloadLogClass(info.value, logClass);
        const producer = producerOverride || topic.producer;
        // Keep one last envelope by reference for heavy payloads — do not structuredClone clouds.
        const value = payloadLogClass === "heavy"
            ? info.value
            : (typeof structuredClone === "function" ? structuredClone(info.value) : info.value);
        const envelope = {
            value,
            topic: topic.name,
            typeStr: info.typeStr ?? topicRosType(topic),
            contractId: topic.contractId,
            producer,
            authority: topic.authority,
            routeDownstream: shouldRouteDownstream(topic),
            sequence,
            applyStep,
            captureTimeNs: info.captureTimeNs ?? null,
            arrivalTimeNs,
            applyTimeNs,
            usedFallback,
        };
        const producerPath = this.producerPath(topic, producer);
        this._publish(producerPath, envelope.value, {
            timeUs: Math.round(applyTimeNs / 1000),
            cycle: applyStep,
            source: producer,
            type: "json",
            category: "topics",
            replayRole: topic.direction === "input" ? "input" : (producer === "oracle" ? "derived" : "state"),
            logClass: payloadLogClass,
            descriptorMetadata: {
                rosType: envelope.typeStr,
                topic: topic.name,
                contractId: topic.contractId,
                producer,
                sequenceId: sequence,
                captureTimeNs: envelope.captureTimeNs,
                arrivalTimeNs,
                applyTimeNs,
                canonicalSignalPath: metadata?.canonicalSignalPath ?? null,
            },
        });
        this.lastProducer.set(topic.contractId || topic.id, envelope);

        let activePath = null;
        if (shouldRouteDownstream(topic)) {
            activePath = this.activePath(topic);
            this._publish(activePath, envelope, {
                timeUs: Math.round(applyTimeNs / 1000),
                cycle: applyStep,
                source: "router",
                type: "json",
                category: "topics",
                replayRole: "derived",
                logClass: payloadLogClass,
                descriptorMetadata: {
                    authority: topic.authority,
                    contractId: topic.contractId,
                    topic: topic.name,
                    sequenceId: sequence,
                    routeDownstream: true,
                    canonicalSignalPath: metadata?.canonicalSignalPath ?? null,
                },
            });
            this.lastActive.set(topic.contractId || topic.id, envelope);
        }

        this._publishStatus(topic, {
            code: usedFallback ? "fallback" : "ok",
            status: usedFallback ? "fallback" : "ok",
            captureTimeNs: envelope.captureTimeNs,
            arrivalTimeNs,
            applyTimeNs,
            applyStep,
            sequence,
            usedFallback,
            routeDownstream: shouldRouteDownstream(topic),
            lastGoodSequence: sequence,
        });

        return { ok: true, topic, envelope, activePath, producerPath, usedFallback };
    }

    _publishStatus(topic, status) {
        const path = this.diagnosticsPath(topic);
        const previous = this.lastStatus.get(topic.contractId || topic.id);
        const lastGoodSequence = status.status === "ok" || status.status === "fallback"
            ? (status.lastGoodSequence ?? status.sequence ?? null)
            : (previous?.lastGoodSequence ?? null);
        const lastGoodCaptureTimeNs = status.status === "ok" || status.status === "fallback"
            ? (status.captureTimeNs ?? null)
            : (previous?.lastGoodCaptureTimeNs ?? null);
        const lastGoodApplyTimeNs = status.status === "ok" || status.status === "fallback"
            ? (status.applyTimeNs ?? null)
            : (previous?.lastGoodApplyTimeNs ?? null);
        const record = {
            topic: topic.name,
            contractId: topic.contractId || topic.id,
            ...status,
            ageNs: Number.isFinite(status.captureTimeNs) && Number.isFinite(status.applyTimeNs)
                ? Math.max(0, status.applyTimeNs - status.captureTimeNs)
                : null,
            // Flat scalars only — never nest prior status records.
            lastGoodSequence,
            lastGoodCaptureTimeNs,
            lastGoodApplyTimeNs,
        };
        this.lastStatus.set(topic.contractId || topic.id, record);
        const statusChanged = !previous
            || previous.status !== record.status
            || previous.code !== record.code
            || previous.sequence !== record.sequence;
        this._publish(path, record, {
            timeUs: Math.round((status.applyTimeNs || 0) / 1000),
            cycle: status.applyStep || 0,
            source: "router",
            type: "json",
            category: "diagnostics",
            replayRole: "derived",
            logClass: "standard",
            history: false,
            descriptorMetadata: {
                contractId: topic.contractId,
                topic: topic.name,
                status: status.status,
                code: status.code,
                retention: "none",
            },
        });
        if (statusChanged) {
            const eventName = status.status === "ok"
                ? "topic-routed"
                : status.status === "fallback"
                    ? "topic-fallback-applied"
                    : status.status === "stale"
                        ? "topic-stale"
                        : status.status === "invalid"
                            ? "topic-invalid"
                            : status.status === "rejected"
                                ? "topic-rejected"
                                : "topic-status";
            if (["topic-routed", "topic-fallback-applied"].includes(eventName)) {
                this._emitEvent(eventName, "info", {
                    topic: topic.name,
                    contractId: topic.contractId,
                    authority: topic.authority,
                    sequence: status.sequence ?? null,
                    routeDownstream: Boolean(status.routeDownstream),
                });
            }
        }
    }

    _defineContractSignals() {
        for (const topic of this.manifest?.topics || []) {
            if (topic.direction !== "input") continue;
            const contractId = topic.contractId || topic.id;
            this.telemetry?.defineSignal?.({
                path: this.producerPath(topic),
                type: "json",
                source: topic.producer,
                category: "topics",
                replayRole: "input",
                logClass: "standard",
                metadata: { contractId, topic: topic.name },
            });
            if (shouldRouteDownstream(topic)) {
                this.telemetry?.defineSignal?.({
                    path: this.activePath(topic),
                    type: "json",
                    source: "router",
                    category: "topics",
                    replayRole: "derived",
                    logClass: "standard",
                    metadata: { contractId, topic: topic.name },
                });
            }
            this.telemetry?.defineSignal?.({
                path: this.diagnosticsPath(topic),
                type: "json",
                source: "router",
                category: "diagnostics",
                replayRole: "derived",
                logClass: "standard",
                retention: "none",
                metadata: { contractId, topic: topic.name },
            });
        }
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
