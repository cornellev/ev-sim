import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "controls",
    label: "Control arc",
    group: "autonomy",
    defaultVisible: true,
    project(frame) {
        const tool = frame?.visualizationMap?.tools?.ackermann;
        return tool?.visible && tool.ready ? tool.output?.primitives ?? [] : [];
    },
});
