import { modelNodeId } from "./workspace/vehicleHierarchyModel.js";

/**
 * Closest-hit identity for the vehicle studio. An existing marker pick wins,
 * including a bound wheel. Otherwise the nearest mapped glTF node is the part.
 */
export function pickFromHitObject(object, nodeMappings) {
    const seen = new Set();
    let current = object;
    while (current && !seen.has(current)) {
        seen.add(current);
        const pick = current.userData?.pick;
        if (pick?.kind) return { kind: pick.kind, id: pick.id ?? null };
        const mapped = nodeMappings?.get?.(current);
        if (Number.isInteger(mapped?.nodeIndex)) {
            return { kind: "model-node", id: modelNodeId(mapped.nodeIndex) };
        }
        current = current.parent;
    }
    return null;
}
