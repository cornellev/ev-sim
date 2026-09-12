import { cloneRoadLanes, validateRoadLaneLayout } from "./RoadLaneModel.js";

const MODES = new Set(["auto", "aligned", "free"]);
const KINDS = new Set(["polyline", "cubic-bezier"]);
const EPSILON = 1e-9;

function point(value) {
    if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.z))) return null;
    return { x: Number(value.x), y: Number.isFinite(Number(value.y)) ? Number(value.y) : 0, z: Number(value.z) };
}

function vector(value) {
    return point(value);
}

function add(left, right) {
    return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left, right) {
    return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value, amount) {
    return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function length(value) {
    return Math.hypot(value.x, value.y, value.z);
}

function normalize(value) {
    const magnitude = length(value);
    return magnitude <= EPSILON ? null : scale(value, 1 / magnitude);
}

function issue(path, code, message, objectId = null) {
    return { path, code, message, severity: "error", ...(objectId ? { objectId } : {}) };
}

export function roadGeometryVersionOf(value) {
    const candidate = value?.roads?.geometryVersion
        ?? value?.document?.roads?.geometryVersion
        ?? value?.manifest?.document?.roads?.geometryVersion
        ?? value?.geometryVersion;
    return candidate === undefined || candidate === null ? 1 : Number(candidate);
}

export function cloneRoadGeometry(value) {
    if (value === undefined || value === null) return null;
    return {
        version: Number(value.version ?? 1),
        kind: String(value.kind ?? ""),
        knots: Array.isArray(value.knots) ? value.knots.map((knot) => ({
            id: String(knot.id ?? ""),
            ...(knot.position ? { position: point(knot.position) ?? { ...knot.position } } : {}),
            ...(knot.mode !== undefined ? { mode: String(knot.mode) } : {}),
            ...(knot.handleIn ? { handleIn: vector(knot.handleIn) ?? { ...knot.handleIn } } : {}),
            ...(knot.handleOut ? { handleOut: vector(knot.handleOut) ?? { ...knot.handleOut } } : {}),
        })) : [],
    };
}

function nodeLookup(nodeById, id) {
    if (nodeById?.get) return nodeById.get(String(id)) ?? null;
    if (Array.isArray(nodeById)) return nodeById.find((entry) => String(entry.id) === String(id)) ?? null;
    return nodeById?.[String(id)] ?? null;
}

function automaticHandles(points, index) {
    const current = points[index];
    if (index === 0) {
        const chord = subtract(points[1], current);
        return { handleIn: null, handleOut: scale(chord, 1 / 3) };
    }
    if (index === points.length - 1) {
        const chord = subtract(points[index - 1], current);
        return { handleIn: scale(chord, 1 / 3), handleOut: null };
    }
    const previous = points[index - 1];
    const next = points[index + 1];
    const direction = normalize(subtract(next, previous));
    if (!direction) return { handleIn: null, handleOut: null };
    const handleLength = Math.min(length(subtract(current, previous)), length(subtract(next, current))) / 3;
    return {
        handleIn: scale(direction, -handleLength),
        handleOut: scale(direction, handleLength),
    };
}

export function resolveRoadEdge(edge, nodeById) {
    const start = point(nodeLookup(nodeById, edge?.startNodeId));
    const end = point(nodeLookup(nodeById, edge?.endNodeId));
    if (!start || !end) throw new TypeError(`Road "${edge?.id ?? ""}" is missing an endpoint node.`);
    const geometry = cloneRoadGeometry(edge?.geometry) ?? {
        version: 1,
        kind: "polyline",
        knots: [{ id: "start" }, { id: "end" }],
    };
    const positions = geometry.knots.map((knot, index) => (
        index === 0 ? start : index === geometry.knots.length - 1 ? end : point(knot.position)
    ));
    if (positions.some((value) => !value)) throw new TypeError(`Road "${edge?.id ?? ""}" has an invalid knot position.`);
    const knots = geometry.knots.map((knot, index) => {
        const automatic = geometry.kind === "cubic-bezier" ? automaticHandles(positions, index) : {};
        const mode = geometry.kind === "cubic-bezier" ? (knot.mode ?? "auto") : null;
        return {
            id: String(knot.id),
            position: positions[index],
            ...(mode ? { mode } : {}),
            ...(geometry.kind === "cubic-bezier" && index > 0
                ? { handleIn: mode === "auto" ? automatic.handleIn : vector(knot.handleIn) ?? automatic.handleIn }
                : {}),
            ...(geometry.kind === "cubic-bezier" && index < positions.length - 1
                ? { handleOut: mode === "auto" ? automatic.handleOut : vector(knot.handleOut) ?? automatic.handleOut }
                : {}),
        };
    });
    const spans = [];
    for (let index = 0; index < knots.length - 1; index += 1) {
        const first = knots[index];
        const second = knots[index + 1];
        spans.push(geometry.kind === "cubic-bezier" ? {
            kind: "cubic-bezier",
            p0: first.position,
            p1: add(first.position, first.handleOut),
            p2: add(second.position, second.handleIn),
            p3: second.position,
        } : {
            kind: "polyline",
            p0: first.position,
            p1: second.position,
        });
    }
    return {
        ...edge,
        id: String(edge.id),
        startNodeId: String(edge.startNodeId),
        endNodeId: String(edge.endNodeId),
        geometry: { version: 1, kind: geometry.kind, knots },
        spans,
    };
}

export function validateRoadDomain(roads, { maxDegree = 4, requireVersion = null } = {}) {
    const issues = [];
    const version = roadGeometryVersionOf({ roads });
    const explicitVersion = roads?.geometryVersion;
    if (explicitVersion !== undefined && (!Number.isInteger(explicitVersion) || ![1, 2].includes(explicitVersion))) {
        issues.push(issue(["roads", "geometryVersion"], "road.geometry.version-unsupported", `Road geometry version ${String(explicitVersion)} is unsupported.`));
    }
    if (requireVersion !== null && version !== requireVersion) {
        issues.push(issue(["roads", "geometryVersion"], "road.geometry.version-required", `Road geometry version ${requireVersion} is required.`));
    }
    const nodes = Array.isArray(roads?.nodes) ? roads.nodes : [];
    const edges = Array.isArray(roads?.edges) ? roads.edges : [];
    if (version === 1 && edges.some((edge) => edge?.geometry !== undefined && edge?.geometry !== null)) {
        issues.push(issue(["roads", "edges"], "road.geometry.version-missing", "Road edge geometry requires roads.geometryVersion 2."));
    }
    const nodeById = new Map();
    for (const [index, node] of nodes.entries()) {
        const id = String(node?.id ?? "");
        if (!id) issues.push(issue(["roads", "nodes", index, "id"], "road.node.id-missing", "Road node ID is required."));
        else if (nodeById.has(id)) issues.push(issue(["roads", "nodes", index, "id"], "road.node.id-duplicate", `Duplicate road node "${id}".`, id));
        else nodeById.set(id, node);
        if (!point(node)) issues.push(issue(["roads", "nodes", index], "road.node.position-invalid", `Road node "${id}" must have finite coordinates.`, id));
    }
    const edgeIds = new Set();
    const degree = new Map();
    for (const [index, edge] of edges.entries()) {
        const id = String(edge?.id ?? "");
        if (!id) issues.push(issue(["roads", "edges", index, "id"], "road.edge.id-missing", "Road edge ID is required."));
        else if (edgeIds.has(id)) issues.push(issue(["roads", "edges", index, "id"], "road.edge.id-duplicate", `Duplicate road edge "${id}".`, id));
        edgeIds.add(id);
        for (const field of ["startNodeId", "endNodeId"]) {
            const nodeId = String(edge?.[field] ?? "");
            if (!nodeById.has(nodeId)) issues.push(issue(["roads", "edges", index, field], "road.edge.node-missing", `Road "${id}" references missing node "${nodeId}".`, id));
            degree.set(nodeId, (degree.get(nodeId) ?? 0) + 1);
        }
        if (String(edge?.startNodeId) === String(edge?.endNodeId)) {
            issues.push(issue(["roads", "edges", index], "road.edge.loop-invalid", `Road "${id}" cannot use the same node twice.`, id));
        }
        const lane = validateRoadLaneLayout(edge, { geometryVersion: version });
        for (const laneIssue of lane.issues) {
            issues.push(issue(["roads", "edges", index, ...laneIssue.path], laneIssue.code, laneIssue.message, id));
        }
        if (version === 2 || edge?.geometry) {
            const geometry = edge?.geometry;
            if (!geometry || geometry.version !== 1 || !KINDS.has(geometry.kind) || !Array.isArray(geometry.knots) || geometry.knots.length < 2) {
                issues.push(issue(["roads", "edges", index, "geometry"], "road.geometry.invalid", `Road "${id}" requires a supported geometry with at least two knots.`, id));
                continue;
            }
            const ids = new Set();
            for (const [knotIndex, knot] of geometry.knots.entries()) {
                const knotId = String(knot?.id ?? "");
                if (!knotId || ids.has(knotId)) issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex, "id"], "road.geometry.knot-id-invalid", `Road "${id}" has a missing or duplicate knot ID.`, id));
                ids.add(knotId);
                if (knotIndex === 0 && knotId !== "start" || knotIndex === geometry.knots.length - 1 && knotId !== "end") {
                    issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex, "id"], "road.geometry.endpoint-id-invalid", `Road "${id}" endpoint knot IDs must be "start" and "end".`, id));
                }
                if (knotIndex > 0 && knotIndex < geometry.knots.length - 1 && !point(knot?.position)) {
                    issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex, "position"], "road.geometry.knot-position-invalid", `Road "${id}" has an invalid interior knot.`, id));
                }
                if ((knotIndex === 0 || knotIndex === geometry.knots.length - 1) && knot?.position !== undefined) {
                    issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex, "position"], "road.geometry.endpoint-position-forbidden", `Road "${id}" endpoint positions come from topology nodes.`, id));
                }
                if (geometry.kind === "cubic-bezier" && !MODES.has(knot?.mode ?? "auto")) {
                    issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex, "mode"], "road.geometry.mode-invalid", `Road "${id}" has an invalid handle mode.`, id));
                }
                if (geometry.kind === "polyline" && (knot?.mode !== undefined || knot?.handleIn !== undefined || knot?.handleOut !== undefined)) {
                    issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex], "road.geometry.polyline-handle-forbidden", `Polyline road "${id}" cannot store Bézier modes or handles.`, id));
                }
                if (geometry.kind === "cubic-bezier") {
                    const mode = knot?.mode ?? "auto";
                    const needsIn = knotIndex > 0;
                    const needsOut = knotIndex < geometry.knots.length - 1;
                    if (mode === "auto" && (knot?.handleIn !== undefined || knot?.handleOut !== undefined)) {
                        issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex], "road.geometry.auto-handle-stored", `Automatic knot "${knotId}" must omit handles.`, id));
                    }
                    if (mode !== "auto" && (needsIn && !vector(knot?.handleIn) || needsOut && !vector(knot?.handleOut))) {
                        issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex], "road.geometry.manual-handle-missing", `Manual knot "${knotId}" requires its used handles.`, id));
                    }
                    if (!needsIn && knot?.handleIn !== undefined || !needsOut && knot?.handleOut !== undefined) {
                        issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex], "road.geometry.outer-handle-forbidden", `Road endpoint knot "${knotId}" stores an unused outer handle.`, id));
                    }
                    if (mode === "aligned" && needsIn && needsOut && vector(knot?.handleIn) && vector(knot?.handleOut)) {
                        const incoming = vector(knot.handleIn);
                        const outgoing = vector(knot.handleOut);
                        const cross = Math.hypot(
                            incoming.y * outgoing.z - incoming.z * outgoing.y,
                            incoming.z * outgoing.x - incoming.x * outgoing.z,
                            incoming.x * outgoing.y - incoming.y * outgoing.x,
                        );
                        const dot = incoming.x * outgoing.x + incoming.y * outgoing.y + incoming.z * outgoing.z;
                        if (cross > 1e-7 * Math.max(1, length(incoming) * length(outgoing)) || dot >= 0) {
                            issues.push(issue(["roads", "edges", index, "geometry", "knots", knotIndex], "road.geometry.aligned-handle-invalid", `Aligned knot "${knotId}" must have opposing collinear handles.`, id));
                        }
                    }
                }
            }
            try {
                const resolved = resolveRoadEdge(edge, nodeById);
                for (const [spanIndex, span] of resolved.spans.entries()) {
                    const startPoint = span.p0;
                    const endPoint = span.kind === "cubic-bezier" ? span.p3 : span.p1;
                    if (Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y, endPoint.z - startPoint.z) <= EPSILON) {
                        issues.push(issue(["roads", "edges", index, "geometry", "knots", spanIndex], "road.geometry.span-zero", `Road "${id}" contains a zero-length span.`, id));
                    }
                }
            } catch (error) {
                issues.push(issue(["roads", "edges", index, "geometry"], "road.geometry.resolve-failed", error.message, id));
            }
        }
    }
    for (const [nodeId, count] of degree) {
        if (count > maxDegree) issues.push(issue(["roads", "nodes", nodeId], "road.topology.degree-exceeded", `Road node "${nodeId}" exceeds degree ${maxDegree}.`, nodeId));
    }
    return { ok: issues.length === 0, issues };
}

function metricKnot(knot) {
    return {
        position: point(knot.position),
        ...(knot.handleIn ? { handleIn: vector(knot.handleIn) } : {}),
        ...(knot.handleOut ? { handleOut: vector(knot.handleOut) } : {}),
    };
}

/** Metric lane record: id, direction, and width only. Markings are appearance. */
export function metricRoadLanes(lanes) {
    if (!Array.isArray(lanes)) return null;
    return lanes.map((lane) => ({
        id: String(lane?.id ?? ""),
        direction: Number(lane?.direction) === 0 ? 0 : Number(lane?.direction),
        width: Number(lane?.width),
    }));
}

export function normalizeMetricRoads(roads) {
    const version = roadGeometryVersionOf({ roads });
    if (version === 1) return roads;
    const nodeById = new Map((roads?.nodes ?? []).map((node) => [String(node.id), node]));
    return {
        geometryVersion: 2,
        nodes: (roads?.nodes ?? []).map((node) => ({ ...node })),
        edges: (roads?.edges ?? []).map((edge) => {
            const resolved = resolveRoadEdge(edge, nodeById);
            return {
                ...edge,
                ...(Array.isArray(edge.lanes) ? { lanes: metricRoadLanes(edge.lanes) } : {}),
                geometry: {
                    version: 1,
                    kind: resolved.geometry.kind,
                    knots: resolved.geometry.knots.map(metricKnot),
                },
            };
        }),
        ...((roads?.turnRules ?? []).length ? { turnRules: roads.turnRules.map((rule) => ({ ...rule })) } : {}),
    };
}

/** Rehydrate editor-only knot identity/modes when validating a metric v2 resource. */
export function authorRoadsFromMetric(roads) {
    if (roadGeometryVersionOf({ roads }) !== 2) return roads;
    return {
        geometryVersion: 2,
        nodes: (roads?.nodes ?? []).map((node) => ({ ...node })),
        edges: (roads?.edges ?? []).map((edge) => ({
            ...edge,
            ...(Array.isArray(edge.lanes) ? { lanes: cloneRoadLanes(edge.lanes) } : {}),
            geometry: {
                version: 1,
                kind: edge.geometry.kind,
                knots: edge.geometry.knots.map((knot, index, values) => ({
                    id: knot.id ?? (index === 0 ? "start" : index === values.length - 1 ? "end" : `k${index}`),
                    ...(index > 0 && index < values.length - 1 ? { position: { ...knot.position } } : {}),
                    ...(edge.geometry.kind === "cubic-bezier" ? {
                        mode: knot.mode ?? "free",
                        ...(index > 0 && knot.handleIn ? { handleIn: { ...knot.handleIn } } : {}),
                        ...(index < values.length - 1 && knot.handleOut ? { handleOut: { ...knot.handleOut } } : {}),
                    } : {}),
                })),
            },
        })),
        ...((roads?.turnRules ?? []).length ? { turnRules: roads.turnRules.map((rule) => ({ ...rule })) } : {}),
    };
}
