/** Rows for the vehicle hierarchy. Node labels come from the loaded glTF, not a second stored name. */

function axleLabel(axle) {
    if (axle === "front") return "Front axle";
    if (axle === "rear") return "Rear axle";
    return "Other wheels";
}

export function hierarchyVisibilityKey(kind, id) {
    return `${kind}:${id}`;
}

export const MODEL_VISIBILITY_KEY = hierarchyVisibilityKey("model", "model");
export const ZONE_VISIBILITY_KEY = hierarchyVisibilityKey("lidar", "lidar");

function visibilitySet(hiddenIds) {
    return hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds ?? []);
}

export function toggleVisibilityKey(hiddenIds, key) {
    const next = new Set(visibilitySet(hiddenIds));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
}

export function setVisibilityKey(hiddenIds, key, hidden) {
    const next = new Set(visibilitySet(hiddenIds));
    if (hidden) next.add(key);
    else next.delete(key);
    return next;
}

/** Model and LiDAR-zone hides survive a vehicle change. Other rows do not. */
export function retainModelAndZoneVisibility(hiddenIds) {
    const next = new Set();
    for (const key of visibilitySet(hiddenIds)) {
        if (key === MODEL_VISIBILITY_KEY || key === ZONE_VISIBILITY_KEY) next.add(key);
    }
    return next;
}

/** Drop glTF-node hides when the model asset changes and indexes no longer match. */
export function clearModelNodeVisibility(hiddenIds) {
    const next = new Set(visibilitySet(hiddenIds));
    for (const key of next) {
        if (String(key).startsWith("model-node:")) next.delete(key);
    }
    return next;
}

function nodesByIndex(nodes) {
    return new Map((nodes ?? []).map((node) => [node.index, node]));
}

/**
 * Viewport hide for a glTF node. `includeSelf` is the node's own flag.
 * `includeModel` adds the Model row. Ancestors are always included.
 */
export function modelNodeViewportHidden(hiddenIds, index, nodes, { includeModel = false, includeSelf = true } = {}) {
    const hidden = visibilitySet(hiddenIds);
    const byIndex = nodes instanceof Map ? nodes : nodesByIndex(nodes);
    if (includeModel && hidden.has(MODEL_VISIBILITY_KEY)) return true;
    if (includeSelf && hidden.has(hierarchyVisibilityKey("model-node", `node-${index}`))) return true;
    const seen = new Set();
    let parent = byIndex.get(index)?.parentIndex;
    while (Number.isInteger(parent) && !seen.has(parent)) {
        seen.add(parent);
        if (hidden.has(hierarchyVisibilityKey("model-node", `node-${parent}`))) return true;
        parent = byIndex.get(parent)?.parentIndex;
    }
    return false;
}

export function hierarchyNodesFromLease(lease) {
    const nodes = lease?.gltfJson?.nodes;
    if (!Array.isArray(nodes)) return [];
    const parentIndex = new Map();
    nodes.forEach((node, index) => {
        const children = Array.isArray(node?.children) ? node.children : [];
        for (const child of children) {
            if (Number.isInteger(child) && child >= 0 && child < nodes.length && !parentIndex.has(child)) {
                parentIndex.set(child, index);
            }
        }
    });
    return nodes.map((node, index) => ({
        index,
        name: node?.name ? String(node.name) : `part-${index}`,
        parentIndex: parentIndex.has(index) ? parentIndex.get(index) : null,
    }));
}

function withVisibility(row, hiddenIds, inherited) {
    const ownHidden = visibilitySet(hiddenIds).has(hierarchyVisibilityKey(row.kind, row.id));
    return { ...row, ownHidden, hidden: ownHidden || inherited };
}

function axleId(axle) {
    return axle === "front" || axle === "rear" ? axle : "other";
}

export function buildVehicleHierarchy(manifest, { nodes = [], hiddenIds = [] } = {}) {
    if (!manifest) return [];
    const hidden = visibilitySet(hiddenIds);
    const byIndex = nodesByIndex(nodes);
    const rows = [
        withVisibility({ id: "body", kind: "body", label: "Body", depth: 0, disabled: false }, hidden, false),
        withVisibility({
            id: "model",
            kind: "model",
            label: "Model",
            depth: 0,
            disabled: !manifest.model?.asset,
        }, hidden, false),
    ];
    const semanticHidden = new Set(manifest.model?.hiddenNodeIndices ?? []);
    for (const node of nodes) {
        rows.push(withVisibility({
            id: `node-${node.index}`,
            kind: "model-node",
            label: semanticHidden.has(node.index) ? `${node.name} (hidden)` : node.name,
            depth: 1,
            disabled: false,
            nodeIndex: node.index,
        }, hidden, modelNodeViewportHidden(hidden, node.index, byIndex, { includeModel: true, includeSelf: false })));
    }
    const grouped = new Map();
    for (const wheel of manifest.wheels ?? []) {
        const axle = axleId(wheel.axle);
        const list = grouped.get(axle) ?? [];
        list.push(wheel);
        grouped.set(axle, list);
    }
    for (const axle of ["front", "rear", "other"]) {
        const wheels = grouped.get(axle) ?? [];
        if (wheels.length === 0) continue;
        rows.push(withVisibility({ id: `axle-${axle}`, kind: "axle", label: axleLabel(axle), depth: 0, disabled: false }, hidden, false));
        for (const wheel of wheels) {
            const nodeIndex = wheel.visual?.kind === "model-node" && Number.isInteger(wheel.visual.nodeIndex)
                ? wheel.visual.nodeIndex
                : null;
            const sourceHidden = nodeIndex != null && modelNodeViewportHidden(hidden, nodeIndex, byIndex, {
                includeModel: false,
                includeSelf: true,
            });
            const axleHidden = hidden.has(hierarchyVisibilityKey("axle", `axle-${axle}`));
            rows.push(withVisibility({
                id: wheel.id,
                kind: "wheel",
                label: wheel.id,
                depth: 1,
                disabled: false,
                nodeIndex,
            }, hidden, axleHidden || sourceHidden));
        }
    }
    for (const sensor of manifest.sensors ?? []) {
        rows.push(withVisibility({
            id: sensor.id,
            kind: "sensor",
            label: sensor.name || sensor.id,
            sensorType: sensor.type || "",
            depth: 0,
            disabled: false,
        }, hidden, false));
    }
    rows.push(withVisibility({ id: "lidar", kind: "lidar", label: "LiDAR zone", depth: 0, disabled: false }, hidden, false));
    return rows;
}
