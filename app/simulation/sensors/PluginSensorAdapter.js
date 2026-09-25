import { deepFreeze } from "../../util/cloneJson.js";
import { clonePluginJson } from "../../plugin/PluginJson.js";
import { PLUGIN_ERROR_CODES, assertSynchronous, pluginError } from "../../plugin/PluginErrors.js";
import { simulationSha256 } from "../kernel/SimulationHashes.js";
import { buildMeasuredRangeImage } from "./LidarProducts.js";
import { buildPointCloud2, sensorHeader } from "./SensorMessages.js";
import { SensorPublisher } from "./SensorPublisher.js";

export const PLUGIN_SENSOR_LIFECYCLE_METHODS = Object.freeze([
    "prepare",
    "reset",
    "captureAt",
    "getDeterministicState",
    "hydrateDeterministicState",
    "finalize",
    "dispose",
]);

function fields(record, sensorId, hook) {
    return {
        pluginId: record.pluginId,
        packageHash: record.packageHash,
        contributionId: record.type,
        unitId: sensorId,
        hook,
        requiresReset: true,
    };
}

function wrapError(error, record, sensorId, hook) {
    if (error?.code) {
        error.pluginId ??= record.pluginId;
        error.packageHash ??= record.packageHash;
        error.contributionId ??= record.type;
        error.unitId ??= sensorId;
        error.hook ??= hook;
        error.requiresReset = true;
        error.infrastructureFailure = true;
        return error;
    }
    const wrapped = pluginError(
        PLUGIN_ERROR_CODES.EXECUTION,
        `Plugin sensor "${sensorId}" hook "${hook}" failed: ${error?.message || String(error)}`,
        { ...fields(record, sensorId, hook), cause: error },
    );
    wrapped.infrastructureFailure = true;
    return wrapped;
}

function callHook(instance, record, sensorId, hook, ...args) {
    try {
        return assertSynchronous(instance[hook](...args), hook, fields(record, sensorId, hook));
    } catch (error) {
        throw wrapError(error, record, sensorId, hook);
    }
}

export function createPluginSensorInstance(record, sensorId) {
    let instance;
    try {
        instance = assertSynchronous(record.create(), "create", fields(record, sensorId, "create"));
    } catch (error) {
        throw wrapError(error, record, sensorId, "create");
    }
    if (!instance || typeof instance !== "object") {
        throw wrapError(new TypeError("create() must return an object."), record, sensorId, "create");
    }
    const missing = PLUGIN_SENSOR_LIFECYCLE_METHODS.find((method) => typeof instance[method] !== "function");
    if (missing) {
        try { instance.dispose?.(); } catch { /* preserve lifecycle validation error */ }
        throw pluginError(
            PLUGIN_ERROR_CODES.REGISTRATION,
            `Plugin sensor type "${record.type}" is missing ${missing}().`,
            fields(record, sensorId, missing),
        );
    }
    return instance;
}

function rngFacade(rng) {
    return Object.freeze({
        next: () => rng.next(),
        range: (min, max) => rng.range(min, max),
        int: (max) => rng.int(max),
        intRange: (min, max) => rng.intRange(min, max),
    });
}

const POINT_CLOUD_FIELDS = Object.freeze([
    { name: "x", offset: 0, datatype: 7, count: 1 },
    { name: "y", offset: 4, datatype: 7, count: 1 },
    { name: "z", offset: 8, datatype: 7, count: 1 },
    { name: "intensity", offset: 12, datatype: 7, count: 1 },
]);

function validatePointCloud(value, sensorId, productId, captureTimeNs, frameId) {
    const expectedHeader = sensorHeader(captureTimeNs, frameId);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || value.height !== 1 || !Number.isSafeInteger(value.width) || value.width < 0
        || value.point_step !== 16 || value.row_step !== value.width * value.point_step
        || value.is_bigendian !== false || value.is_dense !== true
        || JSON.stringify(value.header) !== JSON.stringify(expectedHeader)
        || JSON.stringify(value.fields) !== JSON.stringify(POINT_CLOUD_FIELDS)
        || !(value.data instanceof Uint8Array) || value.data.byteLength !== value.row_step) {
        throw new TypeError(`Plugin sensor "${sensorId}" product "${productId}" returned an invalid PointCloud2 value.`);
    }
    return {
        header: expectedHeader,
        height: 1,
        width: value.width,
        fields: POINT_CLOUD_FIELDS.map((field) => ({ ...field })),
        is_bigendian: false,
        point_step: 16,
        row_step: value.row_step,
        data: new Uint8Array(value.data),
        is_dense: true,
    };
}

function validateObservation(value, descriptor, layout, sensorId) {
    if (!descriptor) {
        if (value != null) throw new TypeError(`Packet-only plugin sensor "${sensorId}" returned an undeclared observation.`);
        return null;
    }
    const expectedShape = descriptor.shape;
    if (!value || value.dtype !== "float32"
        || !Array.isArray(value.shape) || value.shape.length !== 3
        || value.shape.some((entry, index) => entry !== expectedShape[index])
        || !(value.value instanceof Float32Array)
        || value.value.length !== expectedShape.reduce((total, size) => total * size, 1)) {
        throw new TypeError(`Plugin sensor "${sensorId}" must return float32[${expectedShape.join(",")}] observation values.`);
    }
    const copy = new Float32Array(value.value);
    for (let index = 0; index < copy.length; index += 2) {
        const range = copy[index];
        const incidence = copy[index + 1];
        if (!Number.isFinite(range) || !Number.isFinite(incidence)
            || range < 0 || range > layout.maxRangeM || incidence < 0 || incidence > 1
            || (range === 0 && incidence !== 0)) {
            throw new RangeError(`Plugin sensor "${sensorId}" observation contains an invalid range/incidence pair at ray ${index / 2}.`);
        }
    }
    return { dtype: "float32", shape: [...expectedShape], value: copy };
}

function observationFromBuffer(buffer, descriptor) {
    const value = new Float32Array(descriptor.shape[0] * descriptor.shape[1] * 2);
    for (let ray = 0; ray < value.length / 2; ray += 1) {
        value[ray * 2] = buffer[ray * 4];
        value[ray * 2 + 1] = buffer[ray * 4 + 1];
    }
    return { dtype: "float32", shape: [...descriptor.shape], value };
}

export class PluginSensorDevice {
    constructor(admission, {
        factory,
        instance = null,
        scene,
        vehicles,
        Publisher = SensorPublisher,
        publisherOptions = {},
        transformRuntime = null,
    } = {}) {
        this.id = admission.sensor.id;
        this.telemetryId = this.id;
        this.type = admission.sensor.type;
        this.config = admission.sensor;
        this.admission = admission;
        this.telemetryOutputs = admission.products
            .filter((product) => product.kind === "pointCloud")
            .map((product) => ({
                key: product.outputKey,
                signal: product.signal,
                rosType: product.rosType,
            }));
        this.factory = factory;
        this.scene = scene;
        this.vehicles = vehicles;
        this.transformRuntime = transformRuntime;
        this.enabled = true;
        this.gpuCapture = false;
        this.manifestManaged = true;
        this.latestObservation = null;
        this.deliveryGeneration = 0;
        this.lastCaptureDigest = null;
        this.finalizedState = null;
        this.instance = instance ?? createPluginSensorInstance(factory, this.id);
        const calibration = deepFreeze(structuredClone(this.config.calibration));
        this.calibration = calibration;
        try {
            callHook(this.instance, this.factory, this.id, "prepare", Object.freeze({
                calibration,
                helpers: Object.freeze({ sensorAbi: 1, family: "range-image" }),
            }));
            this.contractPublisher = new Publisher(this, this.config, {
                ...publisherOptions,
                pluginStrict: true,
                pluginIdentity: factory,
            });
        } catch (error) {
            try { callHook(this.instance, this.factory, this.id, "dispose"); } catch { /* preserve preparation failure */ }
            this.instance = null;
            throw error;
        }
    }

    setup() {}

    getParent() {
        return this.parent ?? null;
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    _sampling(buffer, captureTimeNs) {
        const frameId = this.config.measurementFrameId || this.config.frameId;
        return Object.freeze({
            buildPointCloud2: (source = buffer) => buildPointCloud2({
                buffer: source,
                bufferEncoding: "metric-v2",
                calibration: this.calibration,
                timeNs: captureTimeNs,
                frameId,
            }),
            buildObservation: (source = buffer) => {
                if (!this.admission.observation) throw new Error("This sensor type has no declared observation mapping.");
                return observationFromBuffer(source, this.admission.observation);
            },
        });
    }

    _validateCapture(captured, context) {
        if (!captured || typeof captured !== "object" || Array.isArray(captured)) {
            throw new TypeError(`Plugin sensor "${this.id}" captureAt() must return an object.`);
        }
        const keys = Object.keys(captured);
        const unknown = keys.find((key) => !["messages", "observation"].includes(key));
        if (unknown || !Array.isArray(captured.messages)) {
            throw new TypeError(`Plugin sensor "${this.id}" capture result is malformed.`);
        }
        const products = new Map(this.admission.products.map((product) => [product.productId, product]));
        const pointCloudCounts = new Map();
        const messages = [];
        const nativePackets = [];
        let packetIndex = 0;
        for (const entry of captured.messages) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Plugin sensor messages must be objects.");
            const product = products.get(entry.productId);
            if (!product) throw new TypeError(`Plugin sensor "${this.id}" returned undeclared product "${entry.productId}".`);
            if (product.kind === "pointCloud") {
                const entryKeys = Object.keys(entry).sort();
                if (entryKeys.join(",") !== "productId,value") throw new TypeError("Point-cloud messages contain only productId and value.");
                const frameId = this.config.measurementFrameId || this.config.frameId;
                const value = validatePointCloud(
                    entry.value,
                    this.id,
                    product.productId,
                    context.captureTimeNs,
                    frameId,
                );
                pointCloudCounts.set(product.productId, (pointCloudCounts.get(product.productId) ?? 0) + 1);
                messages.push({
                    topicId: product.topicId,
                    signal: product.signal,
                    frameId,
                    value,
                });
                continue;
            }
            const entryKeys = Object.keys(entry).sort();
            if (entryKeys.join(",") !== "offsetNs,payload,productId,streamId") {
                throw new TypeError("Vendor packet messages contain only productId, streamId, payload, and offsetNs.");
            }
            const stream = product.streams.find((candidate) => candidate.streamId === entry.streamId);
            if (!stream) throw new TypeError(`Plugin sensor "${this.id}" returned undeclared stream "${entry.streamId}".`);
            if (!(entry.payload instanceof Uint8Array) || entry.payload.byteLength > stream.maxPayloadBytes) {
                throw new RangeError(`Plugin sensor "${this.id}" stream "${entry.streamId}" exceeded its declared payload size.`);
            }
            if (!Number.isSafeInteger(entry.offsetNs) || entry.offsetNs < 0 || entry.offsetNs >= context.scanDurationNs) {
                throw new RangeError(`Plugin sensor "${this.id}" packet offset must be inside scanDurationNs.`);
            }
            nativePackets.push({
                productId: product.productId,
                streamId: stream.streamId,
                payload: new Uint8Array(entry.payload),
                offsetNs: entry.offsetNs,
                packetIndex: packetIndex++,
            });
        }
        for (const product of this.admission.products.filter((entry) => entry.kind === "pointCloud")) {
            if ((pointCloudCounts.get(product.productId) ?? 0) !== 1) {
                throw new TypeError(`Plugin sensor "${this.id}" must return exactly one "${product.productId}" point-cloud message per successful capture.`);
            }
        }
        const observation = validateObservation(
            captured.observation ?? null,
            this.admission.observation,
            this.admission.layout,
            this.id,
        );
        return { messages, nativePackets, observation };
    }

    captureAt(context) {
        try {
            const vehicleList = typeof this.vehicles === "function" ? this.vehicles() : this.vehicles;
            const frames = this.transformRuntime?.resolveCaptureFrames?.(
                this.config,
                vehicleList,
                context.captureTimeNs,
            );
            if (frames?.ok === false) {
                throw new Error(frames.message || "Sensor frame resolution failed.");
            }
            if (this.config.noise?.dropoutProbability > 0
                && context.measurementRng.next() < this.config.noise.dropoutProbability) {
                this.contractPublisher.recordFrameDrop("plugin-sensor-frame-dropout", context.sampleIndex);
                return { messages: [], nativePackets: [], rng: context.deliveryRng };
            }
            const raw = this.scene.capture(this.config, vehicleList);
            const measured = buildMeasuredRangeImage({
                buffer: raw,
                config: this.config,
                rng: context.measurementRng,
                publisher: this.contractPublisher,
            });
            const pluginBuffer = new Float32Array(measured);
            const captured = callHook(this.instance, this.factory, this.id, "captureAt", Object.freeze({
                buffer: pluginBuffer,
                calibration: this.calibration,
                captureTimeNs: context.captureTimeNs,
                sampleIndex: context.sampleIndex,
                scanDurationNs: context.scanDurationNs,
                rng: rngFacade(context.pluginRng),
                sampling: this._sampling(pluginBuffer, context.captureTimeNs),
            }));
            const validated = this._validateCapture(captured, context);
            this.lastCaptureDigest = simulationSha256({
                messages: validated.messages,
                nativePackets: validated.nativePackets.map((packet) => ({ ...packet, payload: packet.payload })),
                observation: validated.observation,
            });
            return { ...validated, rng: context.deliveryRng };
        } catch (error) {
            throw wrapError(error, this.factory, this.id, error?.hook ?? "captureAt");
        }
    }

    onDeliveredObservation(observation, metadata) {
        this.deliveryGeneration += 1;
        this.latestObservation = {
            ...observation,
            ...metadata,
            generation: this.deliveryGeneration,
            validity: true,
        };
    }

    getObservationRecord(step) {
        const descriptor = this.admission.observation;
        if (!descriptor) return null;
        if (!this.latestObservation) {
            return {
                id: this.id,
                dtype: descriptor.dtype,
                shape: [...descriptor.shape],
                value: new Float32Array(descriptor.shape.reduce((total, size) => total * size, 1)),
                validity: false,
                sequence: 0,
                generation: 0,
                ageSteps: Number.MAX_SAFE_INTEGER,
            };
        }
        return { id: this.id, ...this.latestObservation, ageSteps: Math.max(0, Number(step) - this.latestObservation.deliveryStep) };
    }

    resetRunState({ resetSeed = "0" } = {}) {
        this.latestObservation = null;
        this.deliveryGeneration = 0;
        this.lastCaptureDigest = null;
        this.finalizedState = null;
        callHook(this.instance, this.factory, this.id, "reset", Object.freeze({
            resetSeed: String(resetSeed),
            sensorId: this.id,
        }));
    }

    hydrateDeterministicState(snapshot = {}) {
        if (snapshot.stateVersion !== this.factory.descriptor.stateVersion) {
            throw wrapError(new Error("Plugin sensor state version mismatch."), this.factory, this.id, "hydrateDeterministicState");
        }
        callHook(this.instance, this.factory, this.id, "hydrateDeterministicState", clonePluginJson(snapshot.state ?? {}, `${this.id}.state`));
    }

    getDeterministicState() {
        const state = clonePluginJson(
            callHook(this.instance, this.factory, this.id, "getDeterministicState") ?? {},
            `${this.id}.state`,
        );
        return {
            pluginId: this.factory.pluginId,
            runtimeHash: this.factory.runtimeHash,
            sensorId: this.id,
            type: this.type,
            stateVersion: this.factory.descriptor.stateVersion,
            state,
            publisher: this.contractPublisher.getDeterministicState(),
            lastCaptureDigest: this.lastCaptureDigest,
        };
    }

    finalize() {
        if (this.finalizedState) return this.finalizedState;
        const value = callHook(this.instance, this.factory, this.id, "finalize") ?? {};
        this.finalizedState = clonePluginJson(value, `${this.id}.finalize`);
        return this.finalizedState;
    }

    dispose() {
        this.contractPublisher?.dispose?.();
        if (this.instance) {
            callHook(this.instance, this.factory, this.id, "dispose");
            this.instance = null;
        }
        this.scene = null;
        this.vehicles = null;
        this.transformRuntime = null;
    }
}
