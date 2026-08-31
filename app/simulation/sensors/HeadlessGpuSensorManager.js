import { SensorPublisher } from "../../3d/devices/SensorPublisher.js";
import { buildCameraInfo, buildImageMessage } from "../../3d/devices/SensorMessages.js";
import { flipRows, warpBrownConrady } from "../../3d/perception/CameraRenderProducts.js";
import { compareUtf8 } from "../world/WorldDescription.js";
import { assertGpuSensorBackendSelection } from "./GpuSensorBackend.js";
import { buildLidarCapture } from "./LidarProducts.js";

function clone(value) {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function gaussian(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

function gridSize(config) {
    if (config.type === "camera") {
        return { width: config.calibration.width, height: config.calibration.height };
    }
    return {
        width: Math.ceil(
            (config.calibration.azimuth.endDeg - config.calibration.azimuth.startDeg)
            / config.calibration.azimuth.stepDeg,
        ),
        height: Math.ceil(
            (config.calibration.elevation.endDeg - config.calibration.elevation.startDeg)
            / config.calibration.elevation.stepDeg,
        ),
    };
}

class HeadlessGpuSensorDevice {
    constructor(config, manager, publisherOptions) {
        this.id = config.id;
        this.telemetryId = config.id;
        this.type = config.type;
        this.config = clone(config);
        this.manager = manager;
        this.enabled = config.enabled !== false;
        this.gpuCapture = true;
        this.perceptionObservations = publisherOptions.perceptionObservations === true;
        this.latestObservation = null;
        this.deliveryGeneration = 0;
        this.contractPublisher = new SensorPublisher(this, this.config, publisherOptions);
    }

    request(context) {
        const vehicles = this.manager.vehicles();
        const frames = this.manager.transformRuntime?.resolveCaptureFrames?.(
            this.config,
            vehicles,
            context.captureTimeNs,
        );
        if (frames?.ok === false) {
            this.contractPublisher._event("frame-invalid", "error", { reason: frames.message });
            return null;
        }
        if (this.config.noise.dropoutProbability > 0
            && context.rng.next() < this.config.noise.dropoutProbability) {
            this.contractPublisher.recordFrameDrop(`${this.type}-frame-dropout`, context.sampleIndex);
            return null;
        }
        const dimensions = gridSize(this.config);
        const material = this.manager.scene.description?.materials?.[0]?.colorRgba || [64, 96, 128, 255];
        return {
            id: this.id,
            type: this.type,
            ...dimensions,
            clearColor: material.map((value) => Number(value) / 255),
            captureTimeNs: context.captureTimeNs,
            sampleIndex: context.sampleIndex,
            rngState: context.rng._state,
            includeObservation: this.perceptionObservations
                && (this.type === "camera"
                    ? this.config.calibration.products?.rgb === true
                    : this.config.calibration.products?.pointCloud === true),
            sensor: this.config,
            vehicles: vehicles.map((vehicle) => ({
                id: vehicle.telemetryId || vehicle.id,
                position: vehicle.position,
                rotation: vehicle.rotation,
            })),
        };
    }

    async process(rendered, context) {
        let raw = rendered.data;
        if (!raw && rendered.rawSharedMemory) {
            const dimensions = gridSize(this.config);
            const spec = {
                dtype: this.type === "camera" ? 4 : 1,
                shape: [dimensions.height, dimensions.width, 4],
                byteOrder: 1,
            };
            const bytes = await this.manager.rendererClient.readSharedTensor(rendered.rawSharedMemory, spec);
            raw = this.type === "camera"
                ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                : new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        }
        if (this.type === "lidar3d") {
            const result = buildLidarCapture({
                buffer: raw,
                config: this.config,
                captureTimeNs: context.captureTimeNs,
                rng: context.rng,
                publisher: this.contractPublisher,
                includeObservation: this.perceptionObservations,
            });
            if (rendered.observation) result.observation = rendered.observation;
            if (rendered.rawSharedMemory) {
                await this.manager.rendererClient.releaseSharedTensor?.(rendered.rawSharedMemory);
            }
            return result;
        }
        const calibration = this.config.calibration;
        const upright = flipRows(raw, calibration.width, calibration.height, 4);
        const pixels = warpBrownConrady({
            data: upright,
            width: calibration.width,
            height: calibration.height,
            intrinsics: calibration.intrinsics,
            distortion: calibration.distortion,
            channels: 4,
            interpolation: "linear",
        });
        const noise = this.config.noise;
        if (noise.model === "gaussian" || Number(noise.bias) !== 0) {
            for (let offset = 0; offset < pixels.length; offset += 4) {
                for (let channel = 0; channel < 3; channel += 1) {
                    const perturbation = Number(noise.bias || 0)
                        + (noise.model === "gaussian" ? gaussian(context.rng) * Number(noise.standardDeviation || 0) : 0);
                    pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(pixels[offset + channel] + perturbation)));
                }
            }
        }
        const frameId = this.config.measurementFrameId || this.config.frameId;
        const messages = [];
        if (calibration.products?.rgb === true && this.config.outputs?.imageTopicId) {
            messages.push({
                topicId: this.config.outputs.imageTopicId,
                signal: "image",
                frameId,
                value: buildImageMessage({
                    data: pixels,
                    width: calibration.width,
                    height: calibration.height,
                    timeNs: context.captureTimeNs,
                    frameId,
                    encoding: "rgba8",
                }),
            });
        }
        if (calibration.products?.cameraInfo === true && this.config.outputs?.cameraInfoTopicId) {
            messages.push({
                topicId: this.config.outputs.cameraInfoTopicId,
                signal: "cameraInfo",
                frameId,
                value: buildCameraInfo({ ...calibration, timeNs: context.captureTimeNs, frameId }),
            });
        }
        const result = {
            messages,
            observation: this.perceptionObservations && calibration.products?.rgb === true
                ? rendered.observation
                    || { dtype: "uint8", shape: [calibration.height, calibration.width, 4], value: pixels }
                : null,
        };
        if (rendered.rawSharedMemory) {
            await this.manager.rendererClient.releaseSharedTensor?.(rendered.rawSharedMemory);
        }
        return result;
    }

    onDeliveredObservation(observation, metadata) {
        this.releaseObservation(this.latestObservation);
        this.deliveryGeneration += 1;
        this.latestObservation = {
            ...observation,
            ...metadata,
            generation: this.deliveryGeneration,
            validity: true,
        };
    }

    releaseObservation(observation) {
        if (!observation?.sharedMemory) return;
        const pending = this.manager.rendererClient.releaseSharedTensor?.(observation.sharedMemory);
        pending?.catch?.(() => {});
    }

    getObservationRecord(step) {
        const { width, height } = gridSize(this.config);
        const dtype = this.type === "camera" ? "uint8" : "float32";
        const shape = [height, width, this.type === "camera" ? 4 : 2];
        if (!this.latestObservation) {
            const value = this.type === "camera"
                ? new Uint8Array(height * width * 4)
                : new Float32Array(height * width * 2);
            return {
                id: this.id,
                dtype,
                shape,
                value,
                validity: false,
                sequence: 0,
                generation: 0,
                ageSteps: Number.MAX_SAFE_INTEGER,
            };
        }
        return {
            id: this.id,
            ...this.latestObservation,
            ageSteps: Math.max(0, Number(step) - this.latestObservation.deliveryStep),
        };
    }

    dispose() {
        this.releaseObservation(this.latestObservation);
        this.contractPublisher.dispose();
        this.manager = null;
    }
}

export class HeadlessGpuSensorManager {
    constructor(vehicleSource, options = {}) {
        this.vehicleSource = vehicleSource;
        this.telemetry = options.telemetry ?? null;
        this.rendererClient = options.rendererClient ?? null;
        this.devices = [];
        this.scene = null;
        this.transformRuntime = null;
        this.seed = "0";
        this.clock = { step: 0, timeNs: 0 };
        this.runtimeData = {
            bindings: () => ({ signalStore: this.telemetry }),
            simulation: () => ({ timeNs: this.clock.timeNs, steps: this.clock.step }),
            client: () => null,
        };
    }

    vehicles() {
        const source = typeof this.vehicleSource === "function" ? this.vehicleSource() : this.vehicleSource;
        return source?.vehicles ?? [];
    }

    async configureFromManifest(sensorRig = {}, options = {}) {
        this.disposeRun();
        const configs = (sensorRig.sensors || [])
            .filter((sensor) => sensor.enabled !== false && ["camera", "lidar3d"].includes(sensor.type))
            .sort((left, right) => compareUtf8(left.id, right.id));
        if (configs.length === 0 || options.enabled === false) return this.devices;
        assertGpuSensorBackendSelection(options.backendSelection);
        if (!this.rendererClient) throw new Error("GPU sensor backend requires a supervisor renderer client.");
        this.scene = options.renderScene || options.lidarGeometry;
        if (!this.scene) throw new Error("GPU sensor backend requires a resolved scene resource.");
        this.seed = String(options.seed ?? "0");
        this.transformRuntime = options.transformRuntime ?? null;
        const ids = new Set();
        const vehicleIds = new Set(this.vehicles().map((vehicle) => vehicle.telemetryId || vehicle.id));
        this.devices = configs.map((config) => {
            if (!config.id || ids.has(config.id)) throw new Error("GPU sensor IDs must be unique and non-empty.");
            if (!vehicleIds.has(config.parentId)) throw new Error(`GPU sensor ${config.id} references unknown vehicle ${config.parentId}.`);
            ids.add(config.id);
            return new HeadlessGpuSensorDevice(config, this, {
                seed: this.seed,
                topics: options.topics,
                topicRouter: options.topicRouter,
                calibrationHash: options.calibrationHash,
                stepNs: options.stepNs,
                runtimeData: this.runtimeData,
                perceptionObservations: options.perceptionObservations,
                nowNs: () => 0,
            });
        });
        return this.devices;
    }

    async updateAsync(_dt, clock) {
        this.clock = clock;
        const groups = new Map();
        for (const device of this.devices) {
            const publisher = device.contractPublisher;
            publisher._initializeSchedule(clock);
            while (clock.step >= publisher.nextCaptureStep) {
                const context = publisher._captureContext(clock);
                publisher.nextCaptureStep += publisher.periodSteps;
                if (context.skip) continue;
                publisher.health.captureAttempts += 1;
                const request = device.request(context);
                if (!request) continue;
                const key = device.config.syncGroupId
                    ? `${device.config.syncGroupId}:${context.captureTimeNs}`
                    : `${device.id}:${context.captureTimeNs}`;
                const group = groups.get(key) || [];
                group.push({ device, publisher, context, request });
                groups.set(key, group);
            }
        }
        for (const group of groups.values()) {
            const rendered = await this.rendererClient.captureGroup({
                scene: this.scene,
                requests: group.map((entry) => entry.request),
            });
            const byId = new Map(rendered.map((entry) => [entry.id, entry]));
            if (byId.size !== group.length || group.some((entry) => !byId.has(entry.device.id))) {
                throw Object.assign(new Error("GPU sync group returned an incomplete result."), {
                    code: "WORKER_CRASHED",
                    infrastructureFailure: true,
                });
            }
            for (const entry of group) {
                const result = await entry.device.process(byId.get(entry.device.id), entry.context);
                entry.publisher._acceptCapture(result, entry.context, 0);
            }
        }
        for (const device of this.devices) device.contractPublisher._publishHealth(clock);
    }

    deliver(clock) {
        this.clock = clock;
        for (const device of this.devices) device.contractPublisher.deliver(clock);
    }

    resetRun({ resetSeed = this.seed } = {}) {
        this.seed = String(resetSeed);
        this.clock = { step: 0, timeNs: 0 };
        for (const device of this.devices) {
            device.releaseObservation(device.latestObservation);
            device.contractPublisher.reset({ resetSeed: this.seed });
            device.latestObservation = null;
            device.deliveryGeneration = 0;
        }
        return this.getDeterministicState();
    }

    getPerceptionObservationRecords(step) {
        return this.devices
            .filter((device) => device.perceptionObservations)
            .map((device) => device.getObservationRecord(step));
    }

    getDeterministicState() {
        return this.devices.map((device) => ({
            id: device.id,
            type: device.type,
            enabled: device.enabled,
            publisher: device.contractPublisher.getDeterministicState(),
        }));
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        for (const device of this.devices) device.dispose();
        this.devices = [];
        this.scene = null;
        this.transformRuntime = null;
    }
}
