import { listPlanLayers } from "./registry.js";

export function defaultVisibility(layerList = listPlanLayers()) {
    return Object.fromEntries(layerList.map((layer) => [layer.id, layer.defaultVisible]));
}

export function isVisible(state, id) {
    return state?.[id] !== false;
}

export function toggleLayer(state, id) {
    return { ...state, [id]: !isVisible(state, id) };
}

export function layersInGroup(group, layerList = listPlanLayers()) {
    return layerList.filter((layer) => layer.group === group);
}

export function isGroupVisible(state, group, layerList = listPlanLayers()) {
    const members = layersInGroup(group, layerList);
    return members.length > 0 && members.every((layer) => isVisible(state, layer.id));
}

/** Show every layer in the group, or hide them when they are already all shown. */
export function toggleGroup(state, group, layerList = listPlanLayers()) {
    const members = layersInGroup(group, layerList);
    const show = !isGroupVisible(state, group, layerList);
    const next = { ...state };
    for (const layer of members) next[layer.id] = show;
    return next;
}
