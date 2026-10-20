import { perceptionClassId } from "../../autonomy/PerceptionLabelCatalog.js";
import { OCCUPANCY_RESOLUTION_M } from "./constants.js";
import { reduceRangeImage } from "./SensorOccupancyGrid.js";

const GROUND_CLEARANCE_M = 0.05;

export function egoFootprintPolygon(vehicle, box) {
    const sizeX = Number(box?.size?.x) || 0;
    const sizeZ = Number(box?.size?.z) || 0;
    if (!(sizeX > 0) || !(sizeZ > 0)) return [];
    const yaw = Number(vehicle?.rotation?.y) || 0;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const centerX = Number(box?.center?.x) || 0;
    const centerZ = Number(box?.center?.z) || 0;
    const originX = (Number(vehicle?.position?.x) || 0) + centerX * cosine + centerZ * sine;
    const originZ = (Number(vehicle?.position?.z) || 0) - centerX * sine + centerZ * cosine;
    const halfLength = sizeX * 0.5;
    const halfWidth = sizeZ * 0.5;
    return [
        [-halfLength, -halfWidth],
        [halfLength, -halfWidth],
        [halfLength, halfWidth],
        [-halfLength, halfWidth],
    ].map(([localX, localZ]) => ({
        x: originX + localX * cosine + localZ * sine,
        z: originZ - localX * sine + localZ * cosine,
    }));
}

export function egoGroundY(vehicle, box) {
    const sizeY = Number(box?.size?.y) || 0;
    const centerY = Number(box?.center?.y) || 0;
    return (Number(vehicle?.position?.y) || 0) + centerY - sizeY * 0.5;
}

/** Reduce the raw range image for one lidar capture. Returns sparse world cells. */
export function reduceLidarOccupancy(device, buffer, vehicles) {
    if (device?.sensorOccupancy !== true || !(buffer instanceof Float32Array)) return null;
    const vehicle = (vehicles || []).find((entry) => (
        (entry.telemetryId || entry.id) === device.config.parentId
    ));
    if (!vehicle) return [];
    const pose = device.manager.sensorWorldPose?.(vehicle, device.config.pose);
    if (!pose) return [];
    const box = device.manager.vehicleBoxes?.[device.config.parentId] ?? null;
    const sizeY = Number(box?.size?.y) || 1.5;
    return reduceRangeImage({
        buffer,
        calibration: device.config.calibration,
        origin: pose.origin,
        quaternion: pose.quaternion,
        resolutionM: OCCUPANCY_RESOLUTION_M,
        groundY: egoGroundY(vehicle, box),
        minHeightM: GROUND_CLEARANCE_M,
        maxHeightM: sizeY,
        egoFootprint: egoFootprintPolygon(vehicle, box),
        roadSemanticId: perceptionClassId("road"),
    });
}
