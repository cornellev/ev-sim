import { OCCUPANCY_CELLS, OCCUPANCY_RESOLUTION_M } from "../../../simulation/occupancy/constants.js";
import { egoFootprintPolygon, egoGroundY } from "../../../simulation/occupancy/reduceLidarOccupancy.js";
import { projectSparseCells, reduceRangeImage } from "../../../simulation/occupancy/SensorOccupancyGrid.js";
import { snapWindowOrigin } from "../../../simulation/occupancy/OracleOccupancyGrid.js";
import { lidarSensorWorldPose } from "../../../simulation/sensors/CpuLidarScene.js";

function lidarDevices(vehicles) {
    const found = [];
    for (const vehicle of vehicles || []) {
        for (const device of vehicle?.devices || []) {
            if (!device?.config?.calibration || !device.config.pose || !(device.buff instanceof Float32Array)) continue;
            found.push({ vehicle, device });
        }
    }
    return found;
}

/** Latest manifest-lidar range images, projected into the published window. */
export class PlanLidarSampler {
    constructor({ resolutionM = OCCUPANCY_RESOLUTION_M, cells = OCCUPANCY_CELLS } = {}) {
        this.resolutionM = resolutionM;
        this.cells = cells;
        this.window = new Uint8Array(cells * cells);
        this.buffs = [];
        this.origin = "";
        this.last = null;
    }

    sample({ vehicles = [], resolvedRun = null, ego } = {}) {
        if (!ego) return null;
        const devices = lidarDevices(vehicles);
        if (devices.length === 0) return null;
        const snapped = snapWindowOrigin(ego.x, ego.z, this.resolutionM, this.cells);
        const origin = `${snapped.originCol}:${snapped.originRow}`;
        const buffs = devices.map(({ device }) => device.buffGeneration ?? device.buff);
        if (this.last && origin === this.origin && buffs.length === this.buffs.length && buffs.every((buff, index) => buff === this.buffs[index])) {
            return { ...this.last, changed: false };
        }
        const sparse = [];
        for (const { vehicle, device } of devices) {
            const id = vehicle.telemetryId || vehicle.id;
            const box = (resolvedRun?.vehicles || []).find((entry) => entry.actorId === id)?.manifest?.boundingBox ?? null;
            const pose = lidarSensorWorldPose(vehicle, device.config.pose);
            sparse.push(...reduceRangeImage({
                buffer: device.buff,
                calibration: device.config.calibration,
                origin: pose.origin,
                quaternion: pose.quaternion,
                resolutionM: this.resolutionM,
                groundY: egoGroundY(vehicle, box),
                egoFootprint: egoFootprintPolygon(vehicle, box),
            }));
        }
        projectSparseCells(sparse, {
            originCol: snapped.originCol,
            originRow: snapped.originRow,
            cells: this.cells,
            into: this.window,
        });
        this.buffs = buffs;
        this.origin = origin;
        this.last = {
            cells: this.window,
            width: this.cells,
            height: this.cells,
            originX: snapped.originX,
            originZ: snapped.originZ,
            resolutionM: this.resolutionM,
            yawRad: 0,
            palette: "ternary",
            changed: true,
        };
        return this.last;
    }
}
