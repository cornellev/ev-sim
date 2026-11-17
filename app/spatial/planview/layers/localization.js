import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "localization",
    label: "Localization",
    group: "autonomy",
    defaultVisible: true,
    project(frame) {
        const tool = frame?.visualizationMap?.tools?.localization;
        return tool?.ready && tool.visible ? tool.output?.primitives ?? [] : [];
    },
});
