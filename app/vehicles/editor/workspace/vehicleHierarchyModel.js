/** Rows for the vehicle hierarchy. Node labels come from the loaded glTF, not a second stored name. */

function axleLabel(axle) {
    if (axle === "front") return "Front axle";
    if (axle === "rear") return "Rear axle";
    return "Other wheels";
}

export function hierarchyNodesFromLease(lease) {
    const nodes = lease?.gltfJson?.nodes;
    if (!Array.isArray(nodes)) return [];
    return nodes.map((node, index) => ({
        index,
        name: node?.name ? String(node.name) : `part-${index}`,
    }));
}

export function buildVehicleHierarchy(manifest, { nodes = [] } = {}) {
    if (!manifest) return [];
    const rows = [
        { id: "body", kind: "body", label: "Body", depth: 0, disabled: false },
        {
            id: "model",
            kind: "model",
            label: manifest.model?.asset ? "Model" : "Model",
            depth: 0,
            disabled: !manifest.model?.asset,
        },
    ];
    const hidden = new Set(manifest.model?.hiddenNodeIndices ?? []);
    for (const node of nodes) {
        rows.push({
            id: `node-${node.index}`,
            kind: "model-node",
            label: hidden.has(node.index) ? `${node.name} (hidden)` : node.name,
            depth: 1,
            disabled: false,
            nodeIndex: node.index,
        });
    }
    const grouped = new Map();
    for (const wheel of manifest.wheels ?? []) {
        const axle = wheel.axle === "front" || wheel.axle === "rear" ? wheel.axle : "other";
        const list = grouped.get(axle) ?? [];
        list.push(wheel);
        grouped.set(axle, list);
    }
    for (const axle of ["front", "rear", "other"]) {
        const wheels = grouped.get(axle) ?? [];
        if (wheels.length === 0) continue;
        rows.push({ id: `axle-${axle}`, kind: "axle", label: axleLabel(axle), depth: 0, disabled: false });
        for (const wheel of wheels) {
            rows.push({ id: wheel.id, kind: "wheel", label: wheel.id, depth: 1, disabled: false });
        }
    }
    for (const sensor of manifest.sensors ?? []) {
        rows.push({
            id: sensor.id,
            kind: "sensor",
            label: sensor.name || sensor.id,
            sensorType: sensor.type || "",
            depth: 0,
            disabled: false,
        });
    }
    rows.push({ id: "lidar", kind: "lidar", label: "LiDAR zone", depth: 0, disabled: false });
    return rows;
}
