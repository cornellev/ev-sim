import {
    composeRep103Poses,
} from "./CoordinateFrames.js";
import {
    VISUALIZATION_STATUS,
    ageNs,
    emptyLocalizationSnapshot,
    emptyPerceptionSnapshot,
    localizationError,
    normalizeDetections2D,
    normalizeDetections3D,
    normalizeLanes,
    normalizeLegacyBoxes,
    normalizeOdometry,
    normalizeSemanticImage,
} from "./AutonomyVisualizationModel.js";
import {
    oracleTopicSignalPath,
} from "../scripting/runtime/SignalPaths.js";

const PERCEPTION_CONTRACTS = new Set([
    "perception-detections-2d",
    "perception-detections-3d",
    "perception-lanes",
    "perception-semantic",
    "perception-detections",
    "perception-lanes-legacy",
]);

const LOCALIZATION_CONTRACTS = new Set([
    "localization-estimate",
]);

function byteLengthOf(data) {
    if (!data) return 0;
    if (typeof data.byteLength === "number") return data.byteLength;
    if (Array.isArray(data)) return data.length;
    return 0;
}

export class CandidateOutputRuntime {
    constructor(options = {}) {
        this.telemetry = options.telemetry ?? null;
        this.transformRuntime = options.transformRuntime ?? null;
        this.manifest = options.manifest ?? null;
        this.lastPerception = emptyPerceptionSnapshot();
        this.lastLocalization = emptyLocalizationSnapshot();
        this.lastGoodPerception = null;
        this.lastGoodLocalization = null;
        this._defineSignals();
    }

    reset() {
        this.lastPerception = emptyPerceptionSnapshot();
        this.lastLocalization = emptyLocalizationSnapshot();
        this.lastGoodPerception = null;
        this.lastGoodLocalization = null;
        this._publishPerception(this.lastPerception, 0, 0);
        this._publishLocalization(this.lastLocalization, 0, 0);
    }

    setTransformRuntime(transformRuntime) {
        this.transformRuntime = transformRuntime ?? null;
    }

    ingestRouted(result, { applyStep = 0, applyTimeNs = 0 } = {}) {
        if (!result) return null;
        if (result.ok === false) {
            return this._ingestRejection(result, { applyStep, applyTimeNs });
        }
        const topic = result.topic;
        const envelope = result.envelope;
        if (!topic || !envelope) return null;
        const id = topic.contractId || topic.id;
        if (PERCEPTION_CONTRACTS.has(id)) {
            return this._ingestPerception(id, envelope, { applyStep, applyTimeNs, status: VISUALIZATION_STATUS.OK });
        }
        if (LOCALIZATION_CONTRACTS.has(id)) {
            return this._ingestLocalization(envelope, { applyStep, applyTimeNs, status: VISUALIZATION_STATUS.OK });
        }
        return null;
    }

    refreshOracle({ applyStep = 0, applyTimeNs = 0 } = {}) {
        if (!this.telemetry) return;
        const detections2d = this.telemetry.read?.(oracleTopicSignalPath("oracle-detections-2d"))?.value;
        const detections3d = this.telemetry.read?.(oracleTopicSignalPath("oracle-detections-3d"))?.value;
        const lanes = this.telemetry.read?.(oracleTopicSignalPath("oracle-lanes"))?.value;
        const truth = this.telemetry.read?.(oracleTopicSignalPath("truth-odometry"))?.value;

        const transformToMap = this._transformToMapBinder(applyTimeNs);
        const nextPerception = {
            ...this.lastPerception,
            oracle: {
                detections2d: detections2d ? normalizeDetections2D(detections2d, { source: "oracle" }) : [],
                detections3d: detections3d
                    ? normalizeDetections3D(detections3d, { source: "oracle", transformToMap })
                    : [],
                lanes: lanes ? normalizeLanes(lanes, { source: "oracle", transformToMap }) : [],
            },
        };
        this.lastPerception = nextPerception;
        this._publishPerception(nextPerception, applyStep, applyTimeNs);

        if (truth) {
            const truthNorm = normalizeOdometry(truth, { source: "oracle" });
            const nextLoc = {
                ...this.lastLocalization,
                truth: truthNorm,
                error: localizationError(this.lastLocalization.estimate, truthNorm),
            };
            this.lastLocalization = nextLoc;
            this._publishLocalization(nextLoc, applyStep, applyTimeNs);
        }
    }

    _ingestRejection(result, { applyStep, applyTimeNs }) {
        const contractId = result.topic?.contractId
            || result.payload?.contractId
            || null;
        const code = result.code || "rejected";
        const status = code === "stale"
            ? VISUALIZATION_STATUS.STALE
            : code === "invalid"
                ? VISUALIZATION_STATUS.INVALID
                : VISUALIZATION_STATUS.REJECTED;
        const meta = {
            captureTimeNs: result.payload?.captureTimeNs ?? null,
            arrivalTimeNs: result.payload?.arrivalTimeNs ?? null,
            applyTimeNs,
            status,
            statusCode: code,
            ageNs: ageNs(result.payload?.captureTimeNs, applyTimeNs),
        };

        if (contractId && PERCEPTION_CONTRACTS.has(contractId)) {
            const ghost = this.lastGoodPerception
                ? {
                    ...this.lastGoodPerception,
                    ...meta,
                    detections2d: (this.lastGoodPerception.detections2d || []).map((entry) => ({ ...entry, status })),
                    detections3d: (this.lastGoodPerception.detections3d || []).map((entry) => ({ ...entry, status })),
                    lanes: (this.lastGoodPerception.lanes || []).map((entry) => ({ ...entry, status })),
                    semantic: this.lastGoodPerception.semantic
                        ? { ...this.lastGoodPerception.semantic, status }
                        : null,
                }
                : emptyPerceptionSnapshot(meta);
            this.lastPerception = { ...ghost, oracle: this.lastPerception.oracle };
            this._publishPerception(this.lastPerception, applyStep, applyTimeNs);
            return this.lastPerception;
        }

        if (!contractId || LOCALIZATION_CONTRACTS.has(contractId)) {
            const ghost = this.lastGoodLocalization
                ? {
                    ...this.lastGoodLocalization,
                    ...meta,
                    estimate: this.lastGoodLocalization.estimate
                        ? { ...this.lastGoodLocalization.estimate, status }
                        : null,
                }
                : emptyLocalizationSnapshot(meta);
            ghost.truth = this.lastLocalization.truth;
            ghost.error = localizationError(ghost.estimate, ghost.truth);
            this.lastLocalization = ghost;
            this._publishLocalization(ghost, applyStep, applyTimeNs);
            return ghost;
        }
        return null;
    }

    _ingestPerception(contractId, envelope, { applyStep, applyTimeNs, status }) {
        const transformToMap = this._transformToMapBinder(envelope.captureTimeNs ?? applyTimeNs);
        const meta = {
            captureTimeNs: envelope.captureTimeNs ?? null,
            arrivalTimeNs: envelope.arrivalTimeNs ?? null,
            applyTimeNs,
            status,
            statusCode: null,
            ageNs: ageNs(envelope.captureTimeNs, applyTimeNs),
        };
        const next = {
            ...this.lastPerception,
            ...meta,
            oracle: this.lastPerception.oracle,
        };
        const value = envelope.value;
        if (contractId === "perception-detections-2d") {
            next.detections2d = normalizeDetections2D(value, { source: "candidate", status });
        } else if (contractId === "perception-detections-3d") {
            next.detections3d = normalizeDetections3D(value, { source: "candidate", status, transformToMap });
        } else if (contractId === "perception-lanes") {
            next.lanes = normalizeLanes(value, { source: "candidate", status, transformToMap });
        } else if (contractId === "perception-semantic") {
            next.semantic = normalizeSemanticImage(value, { source: "candidate", status });
        } else if (contractId === "perception-detections") {
            next.detections3d = normalizeLegacyBoxes(value, { source: "candidate", status });
        } else if (contractId === "perception-lanes-legacy") {
            next.lanes = normalizeLanes({ lanes: value.lanes }, { source: "candidate", status });
        }
        this.lastPerception = next;
        this.lastGoodPerception = structuredClone({
            ...next,
            semantic: next.semantic
                ? { ...next.semantic, data: null }
                : null,
        });
        this._publishPerception(next, applyStep, applyTimeNs);
        return next;
    }

    _ingestLocalization(envelope, { applyStep, applyTimeNs, status }) {
        const estimate = normalizeOdometry(envelope.value, { source: "candidate", status });
        const truthRaw = this.telemetry?.read?.(oracleTopicSignalPath("truth-odometry"))?.value;
        const truth = this.lastLocalization.truth
            || normalizeOdometry(truthRaw, { source: "oracle" });
        const next = {
            captureTimeNs: envelope.captureTimeNs ?? null,
            arrivalTimeNs: envelope.arrivalTimeNs ?? null,
            applyTimeNs,
            status,
            statusCode: null,
            ageNs: ageNs(envelope.captureTimeNs, applyTimeNs),
            estimate,
            truth,
            error: localizationError(estimate, truth),
        };
        this.lastLocalization = next;
        this.lastGoodLocalization = structuredClone(next);
        this._publishLocalization(next, applyStep, applyTimeNs);
        return next;
    }

    _transformToMapBinder(captureTimeNs) {
        const runtime = this.transformRuntime;
        if (!runtime?.lookupTransformChain) return null;
        return ({ position, rotation, frameId }) => {
            const mapFrameId = runtime.frames?.map || "map";
            const chain = runtime.lookupTransformChain(frameId, mapFrameId, captureTimeNs);
            if (!chain?.ok) return { ok: false, code: chain?.code, message: chain?.message };
            let pose = { position, rotation };
            for (const link of chain.transforms) {
                pose = composeRep103Poses(link, pose);
            }
            return { ok: true, pose };
        };
    }

    _defineSignals() {
        const define = (path, options = {}) => this.telemetry?.defineSignal?.({
            path,
            source: "candidate-output",
            type: "json",
            category: "visualization",
            replayRole: "derived",
            logClass: "standard",
            ...options,
        });
        define("visualization.perception.candidate");
        define("visualization.perception.oracle");
        define("visualization.perception.status");
        define("visualization.perception.candidate.semantic.bytes", { type: "bytes", logClass: "heavy" });
        define("visualization.localization.candidate");
        define("visualization.localization.status");
        define("visualization.localization.error");
    }

    _publishPerception(snapshot, applyStep, applyTimeNs) {
        if (!this.telemetry?.publishSignal) return;
        const common = {
            timeUs: Math.round(applyTimeNs / 1000),
            cycle: applyStep,
            source: "candidate-output",
            type: "json",
            category: "visualization",
            replayRole: "derived",
            logClass: "standard",
            descriptorMetadata: {
                captureTimeNs: snapshot.captureTimeNs,
                arrivalTimeNs: snapshot.arrivalTimeNs,
                applyTimeNs,
                status: snapshot.status,
            },
        };
        this.telemetry.publishSignal("visualization.perception.candidate", {
            detections2d: snapshot.detections2d,
            detections3d: snapshot.detections3d,
            lanes: snapshot.lanes,
            semantic: snapshot.semantic
                ? {
                    ...snapshot.semantic,
                    data: snapshot.semantic.data ? "[bytes]" : null,
                    byteLength: byteLengthOf(snapshot.semantic.data),
                }
                : null,
            captureTimeNs: snapshot.captureTimeNs,
            arrivalTimeNs: snapshot.arrivalTimeNs,
            applyTimeNs,
            status: snapshot.status,
            statusCode: snapshot.statusCode,
            ageNs: snapshot.ageNs,
        }, common);
        this.telemetry.publishSignal("visualization.perception.oracle", snapshot.oracle || {
            detections2d: [],
            detections3d: [],
            lanes: [],
        }, common);
        this.telemetry.publishSignal("visualization.perception.status", {
            status: snapshot.status,
            statusCode: snapshot.statusCode,
            ageNs: snapshot.ageNs,
            captureTimeNs: snapshot.captureTimeNs,
            arrivalTimeNs: snapshot.arrivalTimeNs,
            applyTimeNs,
        }, common);
        if (snapshot.semantic?.data) {
            this.telemetry.publishSignal("visualization.perception.candidate.semantic.bytes", snapshot.semantic.data, {
                ...common,
                type: "bytes",
                logClass: "heavy",
            });
        }
    }

    _publishLocalization(snapshot, applyStep, applyTimeNs) {
        if (!this.telemetry?.publishSignal) return;
        const common = {
            timeUs: Math.round(applyTimeNs / 1000),
            cycle: applyStep,
            source: "candidate-output",
            type: "json",
            category: "visualization",
            replayRole: "derived",
            logClass: "standard",
            descriptorMetadata: {
                captureTimeNs: snapshot.captureTimeNs,
                arrivalTimeNs: snapshot.arrivalTimeNs,
                applyTimeNs,
                status: snapshot.status,
            },
        };
        this.telemetry.publishSignal("visualization.localization.candidate", {
            estimate: snapshot.estimate,
            captureTimeNs: snapshot.captureTimeNs,
            arrivalTimeNs: snapshot.arrivalTimeNs,
            applyTimeNs,
            status: snapshot.status,
            statusCode: snapshot.statusCode,
            ageNs: snapshot.ageNs,
        }, common);
        this.telemetry.publishSignal("visualization.localization.status", {
            status: snapshot.status,
            statusCode: snapshot.statusCode,
            ageNs: snapshot.ageNs,
            captureTimeNs: snapshot.captureTimeNs,
            arrivalTimeNs: snapshot.arrivalTimeNs,
            applyTimeNs,
        }, common);
        this.telemetry.publishSignal("visualization.localization.error", snapshot.error, common);
    }
}
