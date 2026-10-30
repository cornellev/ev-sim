import { OCCUPANCY_CELLS, OCCUPANCY_RESOLUTION_M } from "../occupancy/constants.js";
import { OracleOccupancyGrid } from "../occupancy/OracleOccupancyGrid.js";
import { liveOccupancyActors } from "../occupancy/liveOccupancyActors.js";
import { projectSparseCells } from "../occupancy/SensorOccupancyGrid.js";
import {
    PlanningOracleObservationBuilder,
    createPlanningOracleObservationSpace,
} from "./PlanningOracleObservation.js";
import { boxSpace, dictionarySpace, namedTensor, tensorMap } from "./TensorProtocol.js";

const FLOAT_BOUND = Number.MAX_VALUE;

function occupancyEntries(id, cells, low, high) {
    return [
        { key: `oracle/${id}`, space: boxSpace(`oracle/${id}`, 1, "uint8", [cells, cells], [low], [high]) },
        { key: `oracle/${id}/origin`, space: boxSpace(`oracle/${id}/origin`, 1, "float64", [2], [-FLOAT_BOUND], [FLOAT_BOUND]) },
    ];
}

export function createPlanningOccupancyObservationSpace(sensorDescriptors = [], actorCount = 0) {
    const base = createPlanningOracleObservationSpace(sensorDescriptors, actorCount);
    return dictionarySpace("planning-occupancy", 1, [
        ...base.dictionary.entries,
        ...occupancyEntries("occupancy", OCCUPANCY_CELLS, 0, 1),
        { key: "oracle/occupancy/resolution", space: boxSpace("oracle/occupancy/resolution", 1, "float64", [1], [OCCUPANCY_RESOLUTION_M], [OCCUPANCY_RESOLUTION_M]) },
    ]);
}

export function createSensorOccupancyObservationSpace(sensorDescriptors = [], actorCount = 0) {
    const base = createPlanningOccupancyObservationSpace(sensorDescriptors, actorCount);
    return dictionarySpace("sensor-occupancy", 1, [
        ...base.dictionary.entries,
        ...occupancyEntries("sensor-occupancy", OCCUPANCY_CELLS, 0, 2),
    ]);
}

function vehicleList(source) {
    const resolved = typeof source === "function" ? source() : source;
    if (Array.isArray(resolved?.vehicles)) return resolved.vehicles;
    if (typeof resolved?.list === "function") return resolved.list();
    return [];
}

function lidarDevices(sensorManager) {
    const seen = new Set();
    const devices = [];
    for (const list of [sensorManager?.lidar?.devices, sensorManager?.gpu?.devices, sensorManager?.devices]) {
        for (const device of list || []) {
            if (device?.type !== "lidar3d" || seen.has(device)) continue;
            seen.add(device);
            devices.push(device);
        }
    }
    return devices;
}

export class PlanningOccupancyObservationBuilder {
    constructor(sensorManager, route, vehicleSource, resolvedRun, options = {}) {
        this.oracle = new PlanningOracleObservationBuilder(sensorManager, route, vehicleSource, resolvedRun);
        this.vehicleSource = vehicleSource;
        this.resolvedRun = resolvedRun;
        this.egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
        this.getOverlayObstacles = options.getOverlayObstacles || (() => []);
        this.grid = new OracleOccupancyGrid(resolvedRun?.world?.description, {
            resolutionM: OCCUPANCY_RESOLUTION_M,
            cells: OCCUPANCY_CELLS,
        });
        this.sensorWindow = options.sensorOccupancy ? new Uint8Array(OCCUPANCY_CELLS * OCCUPANCY_CELLS) : null;
        this.sensorManager = sensorManager;
    }

    reset() {
        this.oracle.reset();
        this.grid.setOverlay([]);
    }

    build(options = {}) {
        const base = this.oracle.build(options);
        const vehicles = vehicleList(this.vehicleSource);
        const ego = vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === this.egoId) ?? vehicles[0] ?? null;
        this.grid.setOverlay(this.getOverlayObstacles() || []);
        const sample = this.grid.sample({
            x: Number(ego?.position?.x) || 0,
            z: Number(ego?.position?.z) || 0,
            actors: liveOccupancyActors(this.resolvedRun, vehicles, this.egoId),
        });
        const entries = [
            ...base.entries,
            namedTensor("oracle/occupancy", "uint8", [OCCUPANCY_CELLS, OCCUPANCY_CELLS], sample.cells),
            namedTensor("oracle/occupancy/origin", "float64", [2], [sample.originX, sample.originZ]),
            namedTensor("oracle/occupancy/resolution", "float64", [1], [OCCUPANCY_RESOLUTION_M]),
        ];
        if (this.sensorWindow) {
            const sparse = lidarDevices(this.sensorManager).flatMap((device) => device.latestOccupancyCells || []);
            projectSparseCells(sparse, {
                originCol: sample.originCol,
                originRow: sample.originRow,
                cells: OCCUPANCY_CELLS,
                into: this.sensorWindow,
            });
            entries.push(
                namedTensor("oracle/sensor-occupancy", "uint8", [OCCUPANCY_CELLS, OCCUPANCY_CELLS], this.sensorWindow),
                namedTensor("oracle/sensor-occupancy/origin", "float64", [2], [sample.originX, sample.originZ]),
            );
        }
        return tensorMap(entries);
    }
}
