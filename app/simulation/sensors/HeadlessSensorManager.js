import { compareUtf8 } from "../world/WorldDescription.js";
import { CPU_LIDAR_BACKEND_KIND } from "./CpuLidarBackend.js";
import { HeadlessCpuLidarSensorManager } from "./CpuLidarSensorManager.js";
import { GPU_SENSOR_BACKEND_KIND } from "./GpuSensorBackend.js";
import {
    HeadlessStateSensorManager,
    STATE_SENSOR_BACKEND_KIND,
    STATE_SENSOR_TYPES,
} from "./StateSensorBackend.js";
import { loadHeadlessMessageCodec } from "./HeadlessMessageCodec.js";
import { loadHeadlessVisualCaptureCodec } from "./HeadlessVisualCaptureCodec.js";
import { PluginSensorManager } from "./PluginSensorManager.js";

function rigWith(sensors) {
    return { sensors };
}

function selectionsForKind(selections, kind) {
    return selections.filter((entry) => Number(entry.kind) === kind);
}

export class HeadlessSensorManager {
    constructor(vehicleSource, options = {}) {
        this.state = new HeadlessStateSensorManager(vehicleSource, options);
        this.lidar = new HeadlessCpuLidarSensorManager(vehicleSource, options);
        this.plugin = new PluginSensorManager(vehicleSource, options);
        this.vehicleSource = vehicleSource;
        this.options = options;
        this.gpu = null;
        this.devices = [];
    }

    async configureFromManifest(sensorRig = {}, options = {}) {
        if (options.enabled === false) {
            this.disposeRun();
            return this.devices;
        }
        const enabled = (sensorRig.sensors ?? []).filter((sensor) => sensor.enabled !== false);
        const pluginRecords = (options.sensorAdmission?.sensors ?? [])
            .filter((entry) => entry.kind === "plugin-range-image");
        const pluginTypes = new Set(pluginRecords.map((entry) => entry.sensor.type));
        const needsMessageCodec = enabled.some((sensor) => ["camera", "lidar3d"].includes(sensor.type)
            || pluginTypes.has(sensor.type));
        const messageCodec = needsMessageCodec
            ? (options.messageCodec ?? this.options.messageCodec ?? await loadHeadlessMessageCodec())
            : (options.messageCodec ?? this.options.messageCodec ?? null);
        const unsupported = enabled.filter((sensor) => (
            !STATE_SENSOR_TYPES.includes(sensor.type) && !["lidar3d", "camera"].includes(sensor.type)
                && !pluginTypes.has(sensor.type)
        ));
        if (unsupported.length > 0) {
            const ids = unsupported.map((sensor) => `${sensor.id}:${sensor.type}`).sort(compareUtf8);
            throw new Error(`Unsupported headless sensor request(s): ${ids.join(", ")}.`);
        }
        const stateSensors = enabled.filter((sensor) => STATE_SENSOR_TYPES.includes(sensor.type));
        const lidarSensors = enabled.filter((sensor) => sensor.type === "lidar3d");
        const pluginSensors = enabled.filter((sensor) => pluginTypes.has(sensor.type));
        const cameraSensors = enabled.filter((sensor) => sensor.type === "camera");
        const selections = options.backendSelections ?? [];
        const stateSelections = selectionsForKind(selections, STATE_SENSOR_BACKEND_KIND);
        const lidarSelections = selectionsForKind(selections, CPU_LIDAR_BACKEND_KIND);
        const gpuSelections = selectionsForKind(selections, GPU_SENSOR_BACKEND_KIND);
        const requiresState = options.requireStateSensors || stateSensors.length > 0;
        if (cameraSensors.length > 0 && gpuSelections.length === 0) {
            const ids = cameraSensors.map((sensor) => `${sensor.id}:${sensor.type}`).sort(compareUtf8);
            throw new Error(`Unsupported headless sensor request(s): ${ids.join(", ")}.`);
        }
        if (stateSelections.length !== (requiresState ? 1 : 0)) {
            throw new Error(`Expected ${requiresState ? "exactly one" : "no"} state-sensor backend selection; received ${stateSelections.length}.`);
        }
        if ((lidarSensors.length > 0 || pluginSensors.length > 0) && lidarSelections.length + gpuSelections.length < 1) {
            throw new Error("LiDAR requires either a CPU or GPU sensor backend selection.");
        }
        if (pluginSensors.length > 0 && lidarSelections.length !== 1) {
            throw new Error("Plugin range-image sensors require exactly one CPU LiDAR backend selection.");
        }
        if (lidarSensors.length === 0 && pluginSensors.length === 0 && lidarSelections.length > 0) {
            throw new Error("A CPU LiDAR backend was selected but the manifest has no enabled lidar3d sensor.");
        }
        if (cameraSensors.length > 0 && gpuSelections.length !== 1) {
            throw new Error(`Exactly one GPU sensor backend selection is required for cameras; received ${gpuSelections.length}.`);
        }
        if (gpuSelections.length > 1 || (gpuSelections.length > 0
            && cameraSensors.length === 0
            && (lidarSensors.length === 0 || lidarSelections.length > 0))) {
            throw new Error("GPU sensor backend selection is duplicate or unused.");
        }
        await this.state.configureFromManifest(rigWith(stateSensors), {
            ...options,
            backendSelection: stateSelections[0],
        });
        const gpuLidar = lidarSelections.length === 0 ? lidarSensors : [];
        await this.lidar.configureFromManifest(rigWith(lidarSelections.length > 0 ? lidarSensors : []), {
            ...options,
            messageCodec,
            backendSelection: lidarSelections[0],
        });
        await this.plugin.configure(options.sensorAdmission, {
            ...options,
            messageCodec,
            backendSelection: lidarSelections[0],
            pluginSession: options.pluginSession,
        });
        if (cameraSensors.length > 0 || gpuLidar.length > 0) {
            const { HeadlessGpuSensorManager } = await import("./HeadlessGpuSensorManager.js");
            const visualCapture = options.visualCapture
                ?? this.options.visualCapture
                ?? await loadHeadlessVisualCaptureCodec();
            this.gpu = new HeadlessGpuSensorManager(this.vehicleSource, this.options);
            await this.gpu.configureFromManifest(rigWith([...cameraSensors, ...gpuLidar]), {
                ...options,
                messageCodec,
                visualCapture,
                backendSelection: gpuSelections[0],
            });
        }
        this.devices = [...this.state.devices, ...this.lidar.devices, ...this.plugin.devices, ...(this.gpu?.devices || [])]
            .sort((left, right) => compareUtf8(left.id, right.id));
        return this.devices;
    }

    update(dt, clock) {
        if (this.gpu?.devices.length) throw new Error("GPU sensors require updateAsync().");
        this.state.update(dt, clock);
        this.lidar.update(dt, clock);
        this.plugin.update(dt, clock);
    }

    async updateAsync(dt, clock) {
        this.state.update(dt, clock);
        this.lidar.update(dt, clock);
        await this.plugin.updateAsync(dt, clock);
        await this.gpu?.updateAsync(dt, clock);
    }

    deliver(clock) {
        this.state.deliver(clock);
        this.lidar.deliver(clock);
        this.plugin.deliver(clock);
        this.gpu?.deliver(clock);
    }

    resetRun(options = {}) {
        this.state.resetRun(options);
        this.lidar.resetRun(options);
        this.plugin.resetRun(options);
        this.gpu?.resetRun(options);
        return this.getDeterministicState();
    }

    resetSchedule() {
        return this.resetRun();
    }

    getObservationRecords(step) {
        return this.state.getObservationRecords(step);
    }

    getPerceptionObservationRecords(step) {
        return [
            ...this.lidar.getPerceptionObservationRecords(step),
            ...this.plugin.getPerceptionObservationRecords(step),
            ...(this.gpu?.getPerceptionObservationRecords(step) || []),
        ].sort((left, right) => compareUtf8(left.id, right.id));
    }

    finalizeRun() {
        this.plugin.finalizeRun();
        return this.getDeterministicState();
    }

    disposeRun() {
        this.state.disposeRun();
        this.lidar.disposeRun();
        this.plugin.disposeRun();
        this.gpu?.disposeRun();
        this.gpu = null;
        this.devices = [];
    }

    getDeterministicState() {
        return [
            ...this.state.getDeterministicState(),
            ...this.lidar.getDeterministicState(),
            ...this.plugin.getDeterministicState(),
            ...(this.gpu?.getDeterministicState() || []),
        ]
            .sort((left, right) => compareUtf8(left.id, right.id));
    }
}
