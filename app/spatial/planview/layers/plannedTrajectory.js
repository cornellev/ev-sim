import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "planned-trajectory",
    label: "Planned trajectory",
    group: "autonomy",
    defaultVisible: true,
    project(frame) {
        const tool = frame?.visualizationMap?.tools?.plannedTrajectory;
        return tool?.visible && tool.ready ? tool.output?.primitives ?? [] : [];
    },
});
