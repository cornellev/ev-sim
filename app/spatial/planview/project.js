import { listPlanLayers } from "./registry.js";
import { isVisible } from "./visibility.js";

/**
 * Run visible layers in registration order.
 * @param {object} frame
 * @param {Record<string, boolean>} visibility
 */
export function projectPlanView(frame, visibility) {
    const primitives = [];
    for (const layer of listPlanLayers()) {
        if (!isVisible(visibility, layer.id)) continue;
        const projected = layer.project(frame) ?? [];
        if (!Array.isArray(projected)) continue;
        for (const primitive of projected) {
            if (!primitive) continue;
            primitives.push({ ...primitive, layerId: layer.id });
        }
    }
    return primitives;
}
