/**
 * Geometric conflict checks for environment documents.
 * Operates on plain document snapshots / EnvironmentDocument instances —
 * no Three.js scene required.
 */

const DEFAULT_FEATURE_RADIUS = 0.6;
const FEATURE_RADIUS_BY_TYPE = Object.freeze({
    "stop-sign": 0.4,
    "one-way-sign": 0.4,
    barrel: 0.5,
    tire: 0.3,
    cone: 0.25,
});

/**
 * @param {{ x: number, y?: number, z: number } | { x: number, z: number }} point
 * @returns {{ x: number, z: number }}
 */
function toXZ(point) {
    return { x: Number(point.x) || 0, z: Number(point.z) || 0 };
}

/**
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 */
function distanceXZ(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Cross product of OA×OB in xz.
 * @param {{ x: number, z: number }} o
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 */
function cross(o, a, b) {
    return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

function onSegment(a, b, p) {
    return (
        Math.min(a.x, b.x) - 1e-9 <= p.x
        && p.x <= Math.max(a.x, b.x) + 1e-9
        && Math.min(a.z, b.z) - 1e-9 <= p.z
        && p.z <= Math.max(a.z, b.z) + 1e-9
    );
}

/**
 * Proper 2D segment intersection (including collinear overlap endpoints).
 * @param {{ x: number, z: number }} a1
 * @param {{ x: number, z: number }} a2
 * @param {{ x: number, z: number }} b1
 * @param {{ x: number, z: number }} b2
 */
export function segmentsIntersect(a1, a2, b1, b2) {
    const d1 = cross(a1, a2, b1);
    const d2 = cross(a1, a2, b2);
    const d3 = cross(b1, b2, a1);
    const d4 = cross(b1, b2, a2);

    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }

    if (Math.abs(d1) < 1e-9 && onSegment(a1, a2, b1)) return true;
    if (Math.abs(d2) < 1e-9 && onSegment(a1, a2, b2)) return true;
    if (Math.abs(d3) < 1e-9 && onSegment(b1, b2, a1)) return true;
    if (Math.abs(d4) < 1e-9 && onSegment(b1, b2, a2)) return true;
    return false;
}

/**
 * Minimum distance between two finite segments in xz.
 */
export function segmentDistance(a1, a2, b1, b2) {
    if (segmentsIntersect(a1, a2, b1, b2)) return 0;

    const candidates = [
        pointToSegmentDistance(a1, b1, b2),
        pointToSegmentDistance(a2, b1, b2),
        pointToSegmentDistance(b1, a1, a2),
        pointToSegmentDistance(b2, a1, a2),
    ];
    return Math.min(...candidates);
}

/**
 * @param {{ x: number, z: number }} p
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 */
export function pointToSegmentDistance(p, a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-12) return distanceXZ(p, a);

    let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return distanceXZ(p, { x: a.x + t * dx, z: a.z + t * dz });
}

function getFootprintAxes(footprint) {
    const pts = footprint.map(toXZ);
    if (pts.length < 4) {
        const edge = {
            x: (pts[1]?.x ?? pts[0].x + 1) - pts[0].x,
            z: (pts[1]?.z ?? pts[0].z) - pts[0].z,
        };
        const len = Math.hypot(edge.x, edge.z) || 1;
        return [
            { x: edge.x / len, z: edge.z / len },
            { x: -edge.z / len, z: edge.x / len },
        ];
    }

    const edge0 = { x: pts[1].x - pts[0].x, z: pts[1].z - pts[0].z };
    const edge1 = { x: pts[3].x - pts[0].x, z: pts[3].z - pts[0].z };
    const len0 = Math.hypot(edge0.x, edge0.z) || 1;
    const len1 = Math.hypot(edge1.x, edge1.z) || 1;
    return [
        { x: edge0.x / len0, z: edge0.z / len0 },
        { x: edge1.x / len1, z: edge1.z / len1 },
    ];
}

function projectFootprint(axis, footprint) {
    let min = Infinity;
    let max = -Infinity;
    for (const p3 of footprint) {
        const p = toXZ(p3);
        const d = p.x * axis.x + p.z * axis.z;
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return { min, max };
}

function intervalsOverlap(a, b, padding = 0) {
    return a.max > b.min + padding && b.max > a.min + padding;
}

/**
 * Separating-axis theorem overlap for rectangular footprints in xz.
 * Shared by procedural building generation and MCP / editor validation.
 *
 * @param {{ x: number, y?: number, z: number }[]} a
 * @param {{ x: number, y?: number, z: number }[]} b
 * @param {number} [padding]
 */
export function footprintsOverlap(a, b, padding = 0) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) {
        return false;
    }

    const axes = [...getFootprintAxes(a), ...getFootprintAxes(b)];
    for (const axis of axes) {
        const projA = projectFootprint(axis, a);
        const projB = projectFootprint(axis, b);
        if (!intervalsOverlap(projA, projB, padding)) {
            return false;
        }
    }
    return true;
}

/**
 * Build a rectangular corridor footprint around a road edge centerline.
 * @param {{ x: number, z: number }} start
 * @param {{ x: number, z: number }} end
 * @param {number} width
 */
export function roadCorridorFootprint(start, end, width) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    const half = Math.max(width, 0.1) / 2;
    const nx = (-dz / len) * half;
    const nz = (dx / len) * half;

    return [
        { x: start.x + nx, y: 0, z: start.z + nz },
        { x: start.x - nx, y: 0, z: start.z - nz },
        { x: end.x - nx, y: 0, z: end.z - nz },
        { x: end.x + nx, y: 0, z: end.z + nz },
    ];
}

function getNodeMap(document) {
    const nodes = document.roads?.nodes ?? [];
    return new Map(nodes.map((node) => [node.id, node]));
}

function edgeEndpoints(edge, nodeMap) {
    const start = nodeMap.get(edge.startNodeId);
    const end = nodeMap.get(edge.endNodeId);
    if (!start || !end) return null;
    return {
        start: toXZ(start),
        end: toXZ(end),
        width: Number(edge.width) > 0 ? Number(edge.width) : 7,
    };
}

function edgesShareNode(a, b) {
    return a.startNodeId === b.startNodeId
        || a.startNodeId === b.endNodeId
        || a.endNodeId === b.startNodeId
        || a.endNodeId === b.endNodeId;
}

/**
 * @param {object} document EnvironmentDocument or snapshot
 * @param {object} [options]
 * @param {string[]} [options.edgeIds] only check these edges against others
 * @param {string[]} [options.buildingIds]
 * @param {string[]} [options.featureIds]
 */
export function findDocumentConflicts(document, options = {}) {
    const conflicts = [];
    const nodeMap = getNodeMap(document);
    const edges = document.roads?.edges ?? [];
    const buildings = document.buildings ?? [];
    const features = document.features ?? [];

    const edgeFilter = options.edgeIds ? new Set(options.edgeIds) : null;
    const buildingFilter = options.buildingIds ? new Set(options.buildingIds) : null;
    const featureFilter = options.featureIds ? new Set(options.featureIds) : null;

    // Road–road crossings / corridor overlaps (ignore shared-node junctions).
    for (let i = 0; i < edges.length; i++) {
        const edgeA = edges[i];
        const endsA = edgeEndpoints(edgeA, nodeMap);
        if (!endsA) continue;

        for (let j = i + 1; j < edges.length; j++) {
            const edgeB = edges[j];
            if (edgeFilter && !edgeFilter.has(edgeA.id) && !edgeFilter.has(edgeB.id)) {
                continue;
            }
            if (edgesShareNode(edgeA, edgeB)) continue;

            const endsB = edgeEndpoints(edgeB, nodeMap);
            if (!endsB) continue;

            const centerlineHit = segmentsIntersect(endsA.start, endsA.end, endsB.start, endsB.end);
            const clearance = (endsA.width + endsB.width) / 2;
            const corridorHit = !centerlineHit
                && segmentDistance(endsA.start, endsA.end, endsB.start, endsB.end) < clearance;

            if (centerlineHit || corridorHit) {
                conflicts.push({
                    kind: centerlineHit ? "road-crossing" : "road-corridor-overlap",
                    severity: "warning",
                    message: centerlineHit
                        ? `Road "${edgeA.id}" crosses road "${edgeB.id}".`
                        : `Road corridors for "${edgeA.id}" and "${edgeB.id}" overlap.`,
                    edgeIds: [edgeA.id, edgeB.id],
                });
            }
        }
    }

    // Building–building overlaps.
    for (let i = 0; i < buildings.length; i++) {
        const buildingA = buildings[i];
        for (let j = i + 1; j < buildings.length; j++) {
            const buildingB = buildings[j];
            if (
                buildingFilter
                && !buildingFilter.has(buildingA.buildingId)
                && !buildingFilter.has(buildingB.buildingId)
            ) {
                continue;
            }
            if (footprintsOverlap(buildingA.footprint, buildingB.footprint, 0.1)) {
                conflicts.push({
                    kind: "building-overlap",
                    severity: "warning",
                    message: `Building "${buildingA.buildingId}" overlaps building "${buildingB.buildingId}".`,
                    buildingIds: [buildingA.buildingId, buildingB.buildingId],
                });
            }
        }
    }

    // Building–road overlaps.
    for (const building of buildings) {
        if (buildingFilter && !buildingFilter.has(building.buildingId)) continue;
        const corridorHits = [];
        for (const edge of edges) {
            const ends = edgeEndpoints(edge, nodeMap);
            if (!ends) continue;
            const corridor = roadCorridorFootprint(ends.start, ends.end, ends.width);
            if (footprintsOverlap(building.footprint, corridor, 0)) {
                corridorHits.push(edge.id);
            }
        }
        if (corridorHits.length > 0) {
            conflicts.push({
                kind: "building-road-overlap",
                severity: "warning",
                message: `Building "${building.buildingId}" overlaps road corridor(s): ${corridorHits.join(", ")}.`,
                buildingId: building.buildingId,
                edgeIds: corridorHits,
            });
        }
    }

    // Feature proximity / containment.
    for (const feature of features) {
        if (featureFilter && !featureFilter.has(feature.id)) continue;
        const point = toXZ(feature);
        const radius = FEATURE_RADIUS_BY_TYPE[feature.type] ?? DEFAULT_FEATURE_RADIUS;

        for (const building of buildings) {
            if (pointInFootprint(point, building.footprint) || distanceToFootprint(point, building.footprint) < radius) {
                conflicts.push({
                    kind: "object-building-overlap",
                    severity: "warning",
                    message: `Object "${feature.id}" (${feature.type}) intersects building "${building.buildingId}".`,
                    featureId: feature.id,
                    buildingId: building.buildingId,
                });
            }
        }

        for (const edge of edges) {
            const ends = edgeEndpoints(edge, nodeMap);
            if (!ends) continue;
            const dist = pointToSegmentDistance(point, ends.start, ends.end);
            if (dist < ends.width / 2 + radius) {
                conflicts.push({
                    kind: "object-road-overlap",
                    severity: "info",
                    message: `Object "${feature.id}" (${feature.type}) is on or near road "${edge.id}".`,
                    featureId: feature.id,
                    edgeId: edge.id,
                    distance: dist,
                });
            }
        }

        for (const other of features) {
            if (other.id === feature.id) continue;
            if (featureFilter && !featureFilter.has(feature.id) && !featureFilter.has(other.id)) {
                continue;
            }
            // Only emit once per pair (lexicographic id order).
            if (other.id < feature.id) continue;
            const otherRadius = FEATURE_RADIUS_BY_TYPE[other.type] ?? DEFAULT_FEATURE_RADIUS;
            const dist = distanceXZ(point, toXZ(other));
            if (dist < radius + otherRadius) {
                conflicts.push({
                    kind: "object-object-overlap",
                    severity: "warning",
                    message: `Objects "${feature.id}" and "${other.id}" are too close (${dist.toFixed(2)}m).`,
                    featureIds: [feature.id, other.id],
                    distance: dist,
                });
            }
        }
    }

    return conflicts;
}

/**
 * @param {{ x: number, z: number }} point
 * @param {{ x: number, y?: number, z: number }[]} footprint
 */
export function pointInFootprint(point, footprint) {
    if (!Array.isArray(footprint) || footprint.length < 3) return false;
    // Ray cast in +x.
    let inside = false;
    for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
        const a = toXZ(footprint[i]);
        const b = toXZ(footprint[j]);
        const intersect = ((a.z > point.z) !== (b.z > point.z))
            && (point.x < ((b.x - a.x) * (point.z - a.z)) / ((b.z - a.z) || 1e-12) + a.x);
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * @param {{ x: number, z: number }} point
 * @param {{ x: number, y?: number, z: number }[]} footprint
 */
export function distanceToFootprint(point, footprint) {
    if (pointInFootprint(point, footprint)) return 0;
    let min = Infinity;
    for (let i = 0; i < footprint.length; i++) {
        const a = toXZ(footprint[i]);
        const b = toXZ(footprint[(i + 1) % footprint.length]);
        min = Math.min(min, pointToSegmentDistance(point, a, b));
    }
    return min;
}

/**
 * Convenience: conflicts involving newly created ids only.
 */
export function conflictsForNewEntities(document, {
    edgeIds = [],
    buildingIds = [],
    featureIds = [],
} = {}) {
    return findDocumentConflicts(document, { edgeIds, buildingIds, featureIds })
        .filter((conflict) => {
            if (edgeIds.length && conflict.edgeIds?.some((id) => edgeIds.includes(id))) return true;
            if (edgeIds.length && edgeIds.includes(conflict.edgeId)) return true;
            if (buildingIds.length && (
                buildingIds.includes(conflict.buildingId)
                || conflict.buildingIds?.some((id) => buildingIds.includes(id))
            )) return true;
            if (featureIds.length && (
                featureIds.includes(conflict.featureId)
                || conflict.featureIds?.some((id) => featureIds.includes(id))
            )) return true;
            return false;
        });
}
