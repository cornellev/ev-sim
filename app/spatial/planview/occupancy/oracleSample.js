import { OCCUPANCY_CELLS, OCCUPANCY_RESOLUTION_M } from "../../../simulation/occupancy/constants.js";
import { liveOccupancyActors } from "../../../simulation/occupancy/liveOccupancyActors.js";
import { OracleOccupancyGrid, snapWindowOrigin } from "../../../simulation/occupancy/OracleOccupancyGrid.js";

function cell(value, resolution) {
    return Math.round((Number(value) || 0) / resolution);
}

function actorSignature(actors, resolution) {
    return actors.map((actor) => [
        actor.id,
        cell(actor.x, resolution),
        cell(actor.z, resolution),
        cell(actor.yaw, resolution),
        actor.length, actor.width, actor.centerX, actor.centerZ,
    ].join(":")).join("|");
}

function overlaySignature(obstacles) {
    return (obstacles || []).map((obstacle) => {
        const points = obstacle?.footprint || [];
        return `${obstacle?.id || ""}:${points.map((point) => `${point?.x},${point?.z}`).join(";")}`;
    }).join("|");
}

/**
 * One oracle costmap for the map view. `sample` returns the grid's own buffer;
 * paint it before the next call.
 */
export class PlanOccupancySampler {
    constructor({ resolutionM = OCCUPANCY_RESOLUTION_M, cells = OCCUPANCY_CELLS } = {}) {
        this.resolutionM = resolutionM;
        this.cells = cells;
        this.description = null;
        this.grid = null;
        this.signature = "";
        this.last = null;
    }

    sample({ description, ego, vehicles = [], resolvedRun = null, obstacles = [] } = {}) {
        if (!description || !ego) return null;
        if (this.description !== description) {
            this.description = description;
            this.grid = new OracleOccupancyGrid(description, { resolutionM: this.resolutionM, cells: this.cells });
            this.signature = "";
        }
        const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
        const actors = liveOccupancyActors(resolvedRun, vehicles, egoId);
        const snapped = snapWindowOrigin(ego.x, ego.z, this.resolutionM, this.cells);
        const signature = `${snapped.originCol}:${snapped.originRow}|${actorSignature(actors, this.resolutionM)}|${overlaySignature(obstacles)}`;
        if (signature === this.signature && this.last) return { ...this.last, changed: false };
        this.grid.setOverlay(obstacles);
        const sampled = this.grid.sample({ x: ego.x, z: ego.z, actors });
        this.signature = signature;
        this.last = {
            cells: sampled.cells,
            width: this.cells,
            height: this.cells,
            originX: sampled.originX,
            originZ: sampled.originZ,
            resolutionM: sampled.resolutionM,
            yawRad: 0,
            palette: "cost",
            changed: true,
        };
        return this.last;
    }
}
