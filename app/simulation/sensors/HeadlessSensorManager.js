import { compareUtf8 } from "../world/WorldDescription.js";
import { CPU_LIDAR_BACKEND_KIND } from "./CpuLidarBackend.js";
import { HeadlessCpuLidarSensorManager } from "./CpuLidarSensorManager.js";
import {
    HeadlessStateSensorManager,
    STATE_SENSOR_BACKEND_KIND,
    STATE_SENSOR_TYPES,
} from "./StateSensorBackend.js";

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
        this.devices = [];
    }

    async configureFromManifest(sensorRig = {}, options = {}) {
        if (options.enabled === false) {
            this.disposeRun();
            return this.devices;
        }
        const enabled = (sensorRig.sensors ?? []).filter((sensor) => sensor.enabled !== false);
        const unsupported = enabled.filter((sensor) => (
            !STATE_SENSOR_TYPES.includes(sensor.type) && sensor.type !== "lidar3d"
        ));
        if (unsupported.length > 0) {
            const ids = unsupported.map((sensor) => `${sensor.id}:${sensor.type}`).sort(compareUtf8);
            throw new Error(`Unsupported headless sensor request(s): ${ids.join(", ")}.`);
        }
        const stateSensors = enabled.filter((sensor) => STATE_SENSOR_TYPES.includes(sensor.type));
        const lidarSensors = enabled.filter((sensor) => sensor.type === "lidar3d");
        const selections = options.backendSelections ?? [];
        const stateSelections = selectionsForKind(selections, STATE_SENSOR_BACKEND_KIND);
        const lidarSelections = selectionsForKind(selections, CPU_LIDAR_BACKEND_KIND);
        const requiresState = options.requireStateSensors || stateSensors.length > 0;
        if (stateSelections.length !== (requiresState ? 1 : 0)) {
            throw new Error(`Expected ${requiresState ? "exactly one" : "no"} state-sensor backend selection; received ${stateSelections.length}.`);
        }
        if (lidarSensors.length > 0 && lidarSelections.length !== 1) {
            throw new Error(`Exactly one CPU LiDAR backend selection is required; received ${lidarSelections.length}.`);
        }
        if (lidarSensors.length === 0 && lidarSelections.length > 0) {
            throw new Error("A CPU LiDAR backend was selected but the manifest has no enabled lidar3d sensor.");
        }
        await this.state.configureFromManifest(rigWith(stateSensors), {
            ...options,
            backendSelection: stateSelections[0],
        });
        await this.lidar.configureFromManifest(rigWith(lidarSensors), {
            ...options,
            backendSelection: lidarSelections[0],
        });
        this.devices = [...this.state.devices, ...this.lidar.devices]
            .sort((left, right) => compareUtf8(left.id, right.id));
        return this.devices;
    }

    update(dt, clock) {
        this.state.update(dt, clock);
        this.lidar.update(dt, clock);
    }

    deliver(clock) {
        this.state.deliver(clock);
        this.lidar.deliver(clock);
    }

    resetRun(options = {}) {
        this.state.resetRun(options);
        this.lidar.resetRun(options);
        return this.getDeterministicState();
    }

    resetSchedule() {
        return this.resetRun();
    }

    getObservationRecords(step) {
        return this.state.getObservationRecords(step);
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        this.state.disposeRun();
        this.lidar.disposeRun();
        this.devices = [];
    }

    getDeterministicState() {
        return [...this.state.getDeterministicState(), ...this.lidar.getDeterministicState()]
            .sort((left, right) => compareUtf8(left.id, right.id));
    }
}
