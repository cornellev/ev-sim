import { SensorPublisher } from "../../3d/devices/SensorPublisher.js";
import { registerMsgDefinition } from "../../client/Client.js";
import { compareUtf8 } from "../world/WorldDescription.js";
import { assertLidarGeometryResource } from "../lidar/LidarGeometry.js";
import { assertCpuLidarBackendSelection } from "./CpuLidarBackend.js";
import { buildLidarMessages } from "./LidarProducts.js";

function clone(value) {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

class HeadlessCpuLidarDevice {
    constructor(config, manager, publisherOptions) {
        this.id = config.id;
        this.telemetryId = config.id;
        this.type = config.type;
        this.config = clone(config);
        this.manager = manager;
        this.enabled = config.enabled !== false;
        this.gpuCapture = false;
        this.contractPublisher = new SensorPublisher(this, this.config, publisherOptions);
    }

    captureAt(context) {
        const vehicles = this.manager.vehicles();
        const frames = this.manager.transformRuntime?.resolveCaptureFrames?.(
            this.config,
            vehicles,
            context.captureTimeNs,
        );
        if (frames?.ok === false) {
            this.contractPublisher._event("frame-invalid", "error", { reason: frames.message });
            return [];
        }
        if (this.config.noise.dropoutProbability > 0
            && context.rng.next() < this.config.noise.dropoutProbability) {
            this.contractPublisher.recordFrameDrop("lidar-frame-dropout", context.sampleIndex);
            return [];
        }
        const buffer = this.manager.scene.capture(this.config, vehicles);
        return buildLidarMessages({
            buffer,
            config: this.config,
            captureTimeNs: context.captureTimeNs,
            rng: context.rng,
            publisher: this.contractPublisher,
        });
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    dispose() {
        this.contractPublisher.dispose();
        this.manager = null;
    }
}

export class HeadlessCpuLidarSensorManager {
    constructor(vehicleSource, options = {}) {
        this.vehicleSource = vehicleSource;
        this.telemetry = options.telemetry ?? null;
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
        const configs = (Array.isArray(sensorRig.sensors) ? sensorRig.sensors : [])
            .filter((sensor) => sensor.enabled !== false && sensor.type === "lidar3d")
            .sort((left, right) => compareUtf8(left.id, right.id));
        if (configs.length === 0 || options.enabled === false) return this.devices;
        assertCpuLidarBackendSelection(options.backendSelection);
        assertLidarGeometryResource(options.lidarGeometry);
        this.seed = String(options.seed ?? "0");
        this.transformRuntime = options.transformRuntime ?? null;
        for (const [type, definition] of Object.entries(options.schemas ?? {})) {
            registerMsgDefinition(type, definition);
        }
        const { CpuLidarScene } = await import("./CpuLidarScene.js");
        this.scene = new CpuLidarScene(options.lidarGeometry);
        const ids = new Set();
        const vehicleIds = new Set(this.vehicles().map((vehicle) => vehicle.telemetryId || vehicle.id));
        this.devices = configs.map((config) => {
            if (!config.id || ids.has(config.id)) throw new Error(`LiDAR sensor IDs must be unique and non-empty: ${config.id || "<empty>"}.`);
            if (!vehicleIds.has(config.parentId)) {
                throw new Error(`LiDAR sensor "${config.id}" references unknown parent vehicle "${config.parentId}".`);
            }
            ids.add(config.id);
            return new HeadlessCpuLidarDevice(config, this, {
                seed: this.seed,
                topics: options.topics,
                topicRouter: options.topicRouter,
                calibrationHash: options.calibrationHash,
                stepNs: options.stepNs,
                runtimeData: this.runtimeData,
                // Capture timing is diagnostic only and must not perturb deterministic state.
                nowNs: () => 0,
            });
        });
        return this.devices;
    }

    update(_dt, clock) {
        this.clock = clock;
        for (const device of this.devices) {
            if (device.enabled) device.contractPublisher.update(clock);
        }
    }

    deliver(clock) {
        this.clock = clock;
        for (const device of this.devices) device.contractPublisher.deliver(clock);
    }

    resetRun({ resetSeed = this.seed } = {}) {
        this.seed = String(resetSeed);
        this.clock = { step: 0, timeNs: 0 };
        for (const device of this.devices) device.contractPublisher.reset({ resetSeed: this.seed });
        return this.getDeterministicState();
    }

    resetSchedule() {
        return this.resetRun({ resetSeed: this.seed });
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        for (const device of this.devices) device.dispose();
        this.devices = [];
        this.scene?.dispose();
        this.scene = null;
        this.transformRuntime = null;
    }

    getDeterministicState() {
        return this.devices.map((device) => ({
            id: device.id,
            type: device.type,
            enabled: device.enabled,
            publisher: device.contractPublisher.getDeterministicState(),
        }));
    }
}
