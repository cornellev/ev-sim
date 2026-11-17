import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "trails",
    label: "Trails",
    group: "actors",
    defaultVisible: true,
    project(frame) {
        const tool = frame?.visualizationMap?.tools?.trajectoryPast;
        return tool?.visible && tool.ready ? tool.output?.primitives ?? [] : [];
    },
});
