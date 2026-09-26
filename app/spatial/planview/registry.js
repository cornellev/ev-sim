const layers = new Map();

/**
 * Register a plan-view layer. A later registration with the same id replaces
 * the previous one, so hot reload and tests stay idempotent.
 * @param {{ id: string, label?: string, group?: string, defaultVisible?: boolean, project: (frame: object) => object[] }} layer
 */
export function registerPlanLayer(layer) {
    if (!layer?.id || typeof layer.project !== "function") {
        throw new TypeError("A plan layer needs an id and a project function.");
    }
    layers.set(layer.id, {
        id: String(layer.id),
        label: layer.label || String(layer.id),
        group: layer.group || "overlay",
        defaultVisible: layer.defaultVisible !== false,
        project: layer.project,
    });
    return layer.id;
}

export function unregisterPlanLayer(id) {
    layers.delete(id);
}

/** Layers in registration order. Later layers paint above earlier ones. */
export function listPlanLayers() {
    return [...layers.values()];
}
