import { OracleOccupancyGrid } from "./occupancy/OracleOccupancyGrid.js";
import { OCCUPANCY_CELLS } from "./occupancy/constants.js";
import { liveOccupancyActors } from "./occupancy/liveOccupancyActors.js";

export const PLANNING_COSTMAP_TOPIC = "/planning/costmap";
const PERIOD_NS = 500_000_000;

export function encodePlanningCostmap(sample, rows = OCCUPANCY_CELLS, cols = rows) {
    const cells = new Uint8Array(rows * cols);
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
            cells[row * cols + col] = sample.cells[(rows - row - 1) * cols + col] === 1 ? 255 : 0;
        }
    }
    const chunks = [];
    for (let offset = 0; offset < cells.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...cells.subarray(offset, offset + 0x8000)));
    }
    return JSON.stringify({
        rows,
        cols,
        resolution: sample.resolutionM,
        origin_x: sample.originX,
        origin_y: -(sample.originZ + rows * sample.resolutionM),
        cells: btoa(chunks.join("")),
    });
}

export class PlanningCostmapPublisher {
    constructor(resolvedRun, context, grid = new OracleOccupancyGrid(resolvedRun.world?.description)) {
        this.resolvedRun = resolvedRun;
        this.context = context;
        this.grid = grid;
        this.egoId = resolvedRun.manifest.controls?.targetVehicleId || "ego";
        this.nextPublishNs = 0;
        this.pending = null;
    }

    reset() {
        this.nextPublishNs = 0;
        this.grid?.setOverlay([]);
    }

    publish(timeNs, vehicles) {
        if (!this.grid || this.pending || timeNs < this.nextPublishNs) return;
        const client = this.context.topics.client();
        if (!client?.isOpen?.()) return;
        const ego = vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === this.egoId);
        if (!ego) return;
        this.nextPublishNs = timeNs + PERIOD_NS;
        try {
            this.grid.setOverlay(this.context.episodeOverlay?.toObstacles?.() ?? []);
            const sample = this.grid.sample({
                x: ego.position.x,
                z: ego.position.z,
                actors: liveOccupancyActors(this.resolvedRun, vehicles, this.egoId),
            });
            const payload = encodePlanningCostmap(sample, this.grid.cells);
            this.pending = Promise.resolve(client.publish(PLANNING_COSTMAP_TOPIC, "std_msgs/String", payload))
                .catch((error) => this.reportError(error))
                .finally(() => { this.pending = null; });
        } catch (error) {
            this.reportError(error);
        }
    }

    reportError(error) {
        if (error?.code !== "websocket-backpressure") {
            console.warn("Planning costmap publish failed:", error);
        }
    }

    dispose() {
        this.grid = null;
        this.context = null;
        this.resolvedRun = null;
    }
}

export function createPlanningCostmapPublisher(resolvedRun, context) {
    // shortcut: October 31 browser demo only; add an opt-in contract before reuse.
    if (context.rendering?.target?.() !== "browser" || resolvedRun.manifest.id !== "oct-31-testing") return null;
    return new PlanningCostmapPublisher(resolvedRun, context);
}
