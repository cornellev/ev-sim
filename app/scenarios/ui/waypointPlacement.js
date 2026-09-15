import { roadLaneCount, roadLaneId } from "../../roads/RoadLaneModel.js";
import { edgeBoundaryFractions, offsetEdgeSample } from "../route/roadGraph.js";

const lerp = (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
});

/** Build once per environment, using the same lane geometry/fractions as routing. */
export function buildWaypointLaneIndex(graph) {
    const segments = [];
    const edges = [...graph.edges.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const edge of edges) {
        const { startT, endT } = edgeBoundaryFractions(edge, graph);
        const samples = edge.compiled?.samples;
        const fractions = samples
            ? samples.cumulativeXZ.map((distance) => distance / samples.totalLengthXZ)
            : [0, 1];
        for (let laneIndex = 0; laneIndex < roadLaneCount(edge); laneIndex += 1) {
            const points = edge.compiled?.fullSurface.laneCenterlines[laneIndex]
                ?? [offsetEdgeSample(edge, 0, laneIndex, graph), offsetEdgeSample(edge, 1, laneIndex, graph)];
            for (let index = 0; index < points.length - 1; index += 1) {
                const fromT = Math.max(startT, fractions[index]);
                const toT = Math.min(endT, fractions[index + 1]);
                const span = fractions[index + 1] - fractions[index];
                if (toT < fromT || span <= 0) continue;
                const from = lerp(points[index], points[index + 1], (fromT - fractions[index]) / span);
                const to = lerp(points[index], points[index + 1], (toT - fractions[index]) / span);
                segments.push({ edgeId: edge.id, laneIndex, laneId: roadLaneId(edge, laneIndex), fromT, toT, from, to });
            }
        }
    }
    return { geometryVersion: graph.geometryVersion, segments };
}

/** Release-only snap: search actual lane segments, including off-road drops. */
export function snapWaypointToNearestLane(authoredPosition, index) {
    if (!Number.isFinite(authoredPosition?.x) || !Number.isFinite(authoredPosition?.z)) return null;
    let nearest = null;
    let distanceSquared = Infinity;
    for (const segment of index.segments) {
        const dx = segment.to.x - segment.from.x;
        const dz = segment.to.z - segment.from.z;
        const lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared > 0 ? Math.max(0, Math.min(1, (
            (authoredPosition.x - segment.from.x) * dx + (authoredPosition.z - segment.from.z) * dz
        ) / lengthSquared)) : 0;
        const position = lerp(segment.from, segment.to, t);
        const distance = (authoredPosition.x - position.x) ** 2 + (authoredPosition.z - position.z) ** 2;
        // Stable edge/lane/segment order resolves exact ties without lane flipping.
        if (distance >= distanceSquared) continue;
        distanceSquared = distance;
        nearest = {
            authoredPosition: { ...authoredPosition, y: 0 },
            position,
            anchor: {
                kind: "road",
                id: segment.edgeId,
                fraction: segment.fromT + (segment.toT - segment.fromT) * t,
                laneMode: "fixed",
                laneIndex: segment.laneIndex,
                ...(index.geometryVersion === 2 ? { laneId: segment.laneId } : {}),
            },
        };
    }
    return nearest;
}
