import {
    add3 as add,
    distance3 as distance,
    distanceXZ,
    lerp3 as lerp,
    normalize3,
    scale3 as scale,
    sub3 as subtract,
} from "../math/linalg.js";
import { laneCenterRightOffset, roadLaneCount } from "./RoadLaneModel.js";
import { ROAD_GEOMETRY_POLICY_V1, validateRoadGeometryPolicy } from "./RoadGeometryPolicy.js";

const EPSILON = 1e-9;

function normalize(value) {
    return normalize3(value, EPSILON);
}

function cubicPoint(span, u) {
    const a = lerp(span.p0, span.p1, u);
    const b = lerp(span.p1, span.p2, u);
    const c = lerp(span.p2, span.p3, u);
    const d = lerp(a, b, u);
    const e = lerp(b, c, u);
    return lerp(d, e, u);
}

function cubicTangent(span, u) {
    const one = 1 - u;
    return add(
        add(scale(subtract(span.p1, span.p0), 3 * one * one), scale(subtract(span.p2, span.p1), 6 * one * u)),
        scale(subtract(span.p3, span.p2), 3 * u * u),
    );
}

export function evaluate(edge, at) {
    const spanIndex = Math.trunc(Number(at?.span));
    const u = Number(at?.u);
    if (!Number.isInteger(spanIndex) || spanIndex < 0 || spanIndex >= (edge?.spans?.length ?? 0) || !Number.isFinite(u) || u < 0 || u > 1) {
        throw new RangeError("Road parameter must reference a valid span and u in [0, 1].");
    }
    const span = edge.spans[spanIndex];
    const point = span.kind === "cubic-bezier" ? cubicPoint(span, u) : lerp(span.p0, span.p1, u);
    const tangent = normalize(span.kind === "cubic-bezier" ? cubicTangent(span, u) : subtract(span.p1, span.p0));
    if (!tangent) throw new TypeError(`Road "${edge.id}" has an unusable tangent.`);
    return { point, tangent, at: { span: spanIndex, u } };
}

function pointLineDistance(point, start, end) {
    const chord = subtract(end, start);
    const chordLength = Math.hypot(chord.x, chord.y, chord.z);
    if (chordLength <= EPSILON) return distance(point, start);
    const cross = {
        x: (point.y - start.y) * chord.z - (point.z - start.z) * chord.y,
        y: (point.z - start.z) * chord.x - (point.x - start.x) * chord.z,
        z: (point.x - start.x) * chord.y - (point.y - start.y) * chord.x,
    };
    return Math.hypot(cross.x, cross.y, cross.z) / chordLength;
}

function splitCubic(span) {
    const p01 = lerp(span.p0, span.p1, 0.5);
    const p12 = lerp(span.p1, span.p2, 0.5);
    const p23 = lerp(span.p2, span.p3, 0.5);
    const p012 = lerp(p01, p12, 0.5);
    const p123 = lerp(p12, p23, 0.5);
    const middle = lerp(p012, p123, 0.5);
    return [
        { kind: "cubic-bezier", p0: span.p0, p1: p01, p2: p012, p3: middle },
        { kind: "cubic-bezier", p0: middle, p1: p123, p2: p23, p3: span.p3 },
    ];
}

export function sampleCenterline(edge, policy = ROAD_GEOMETRY_POLICY_V1) {
    const policyResult = validateRoadGeometryPolicy(policy);
    if (!policyResult.ok) throw new TypeError(policyResult.errors[0]);
    if (!Array.isArray(edge?.spans) || edge.spans.length === 0) throw new TypeError("A resolved road requires at least one span.");
    const points = [];
    const parameters = [];
    const append = (point, parameter) => {
        if (points.length >= policy.maxSamplesPerEdge) throw new RangeError(`Road "${edge.id}" exceeds ${policy.maxSamplesPerEdge} samples.`);
        const previous = points.at(-1);
        if (!previous || distance(previous, point) > EPSILON) {
            points.push({ ...point });
            parameters.push({ ...parameter });
        } else {
            parameters[parameters.length - 1] = { ...parameter };
        }
    };
    for (let spanIndex = 0; spanIndex < edge.spans.length; spanIndex += 1) {
        const span = edge.spans[spanIndex];
        if (spanIndex === 0) append(span.p0, { span: spanIndex, u: 0 });
        if (span.kind === "polyline") {
            const count = Math.max(1, Math.ceil(distance(span.p0, span.p1) / policy.maxSampleSpacing));
            for (let index = 1; index <= count; index += 1) append(lerp(span.p0, span.p1, index / count), { span: spanIndex, u: index / count });
            continue;
        }
        const stack = [{ span, u0: 0, u1: 1, depth: 0 }];
        while (stack.length > 0) {
            const current = stack.pop();
            const flat = Math.max(
                pointLineDistance(current.span.p1, current.span.p0, current.span.p3),
                pointLineDistance(current.span.p2, current.span.p0, current.span.p3),
            ) <= policy.maxChordDeviation;
            const spaced = distance(current.span.p0, current.span.p3) <= policy.maxSampleSpacing;
            if (flat && spaced) {
                append(current.span.p3, { span: spanIndex, u: current.u1 });
                continue;
            }
            if (current.depth >= policy.maxDepth) throw new RangeError(`Road "${edge.id}" sampling exhausted depth ${policy.maxDepth}.`);
            const [left, right] = splitCubic(current.span);
            const middle = (current.u0 + current.u1) * 0.5;
            stack.push({ span: right, u0: middle, u1: current.u1, depth: current.depth + 1 });
            stack.push({ span: left, u0: current.u0, u1: middle, depth: current.depth + 1 });
        }
    }
    const tangents = parameters.map((at, index) => {
        try {
            return evaluate(edge, at).tangent;
        } catch {
            const previous = points[Math.max(0, index - 1)];
            const next = points[Math.min(points.length - 1, index + 1)];
            return normalize(subtract(next, previous));
        }
    });
    if (tangents.some((value) => !value)) throw new TypeError(`Road "${edge.id}" has an unusable tangent.`);
    const cumulativeXZ = [0];
    for (let index = 1; index < points.length; index += 1) cumulativeXZ.push(cumulativeXZ[index - 1] + distanceXZ(points[index - 1], points[index]));
    const totalLengthXZ = cumulativeXZ.at(-1) ?? 0;
    if (totalLengthXZ <= EPSILON) throw new TypeError(`Road "${edge.id}" has zero XZ length.`);
    return { points, parameters, tangents, cumulativeXZ, totalLengthXZ };
}

function rightNormal(tangent) {
    const length = Math.hypot(tangent.x, tangent.z);
    if (length <= EPSILON) return null;
    return { x: -tangent.z / length, y: 0, z: tangent.x / length };
}

function offsetSamples(samples, offset, policy = ROAD_GEOMETRY_POLICY_V1) {
    const result = [];
    for (let index = 0; index < samples.points.length; index += 1) {
        const previousPoint = samples.points[Math.max(0, index - 1)];
        const nextPoint = samples.points[Math.min(samples.points.length - 1, index + 1)];
        const incoming = index > 0 ? rightNormal(subtract(samples.points[index], previousPoint)) : null;
        const outgoing = index < samples.points.length - 1 ? rightNormal(subtract(nextPoint, samples.points[index])) : null;
        const normal = outgoing ?? incoming ?? rightNormal(samples.tangents[index]);
        if (!normal) throw new TypeError("Road surface contains an unusable lateral normal.");
        let direction = normal;
        let multiplier = offset;
        if (incoming && outgoing) {
            const summed = normalize(add(incoming, outgoing));
            const denominator = summed ? summed.x * outgoing.x + summed.z * outgoing.z : 0;
            if (summed && Math.abs(denominator) > EPSILON) {
                direction = summed;
                const miter = offset / denominator;
                if (Math.abs(1 / denominator) > policy.miterLimit) {
                    // A bevel is two vertices at the same centerline sample,
                    // one on each incident segment. Duplicate zero-offset lane
                    // paths too, so every compiled lateral path has the same
                    // deterministic topology.
                    result.push(
                        add(samples.points[index], scale(incoming, offset)),
                        add(samples.points[index], scale(outgoing, offset)),
                    );
                    continue;
                }
                multiplier = miter;
            }
        }
        result.push(add(samples.points[index], scale(direction, multiplier)));
    }
    return result;
}

export function buildLaneCenterline(edge, laneIndex, samples) {
    if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= roadLaneCount(edge)) throw new RangeError("Physical lane index is out of range.");
    return offsetSamples(samples, laneCenterRightOffset(edge, laneIndex));
}

function boundsOf(points) {
    return {
        min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)), z: Math.min(...points.map((point) => point.z)) },
        max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)), z: Math.max(...points.map((point) => point.z)) },
    };
}

export function buildRoadSurface(edge, context = {}) {
    const policy = context.policy ?? ROAD_GEOMETRY_POLICY_V1;
    const samples = context.samples ?? sampleCenterline(edge, policy);
    const halfCarriageway = Math.max(0, Number(edge.width ?? 7)) * 0.5;
    const halfPaved = halfCarriageway + Math.max(0, Number(edge.shoulderWidth ?? 0));
    const leftBoundary = offsetSamples(samples, -halfPaved, policy);
    const rightBoundary = offsetSamples(samples, halfPaved, policy);
    const carriagewayLeft = offsetSamples(samples, -halfCarriageway, policy);
    const carriagewayRight = offsetSamples(samples, halfCarriageway, policy);
    const vertices = [];
    const stripPointCount = Math.min(leftBoundary.length, rightBoundary.length);
    for (let index = 0; index < stripPointCount; index += 1) vertices.push(leftBoundary[index], rightBoundary[index]);
    const indices = [];
    const upward = (a, b, c) => (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    for (let index = 0; index < stripPointCount - 1; index += 1) {
        const left = index * 2;
        const right = left + 1;
        const nextLeft = left + 2;
        const nextRight = left + 3;
        const candidate = [left, right, nextLeft, right, nextRight, nextLeft];
        for (let face = 0; face < candidate.length; face += 3) {
            const triangle = candidate.slice(face, face + 3);
            const winding = upward(vertices[triangle[0]], vertices[triangle[1]], vertices[triangle[2]]);
            if (Math.abs(winding) <= EPSILON) throw new TypeError("Road surface contains a degenerate strip triangle.");
            indices.push(...(winding > 0 ? triangle : [triangle[0], triangle[2], triangle[1]]));
        }
    }
    const laneCenterlines = Array.from({ length: roadLaneCount(edge) }, (_, laneIndex) => buildLaneCenterline(edge, laneIndex, samples));
    return {
        vertices,
        indices,
        leftBoundary,
        rightBoundary,
        carriagewayLeft,
        carriagewayRight,
        laneCenterlines,
        bounds: boundsOf(vertices),
    };
}

export function projectPointToRoad(point, compiledEdge) {
    const samples = compiledEdge?.samples;
    if (!samples?.points?.length) return null;
    let best = null;
    for (let index = 0; index < samples.points.length - 1; index += 1) {
        const start = samples.points[index];
        const end = samples.points[index + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared <= EPSILON ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
        const projected = lerp(start, end, t);
        const distanceValue = distanceXZ(point, projected);
        const distanceAlong = samples.cumulativeXZ[index] + distanceXZ(start, end) * t;
        const candidate = { point: projected, distance: distanceValue, distanceAlong, fraction: distanceAlong / samples.totalLengthXZ, segment: index, t };
        if (!best || candidate.distance < best.distance - EPSILON || Math.abs(candidate.distance - best.distance) <= EPSILON && candidate.distanceAlong < best.distanceAlong) best = candidate;
    }
    return best;
}

function serializeResolvedKnot(knot, index, count) {
    return {
        id: knot.id,
        ...(index > 0 && index < count - 1 ? { position: { ...knot.position } } : {}),
        mode: "free",
        ...(index > 0 ? { handleIn: { ...knot.handleIn } } : {}),
        ...(index < count - 1 ? { handleOut: { ...knot.handleOut } } : {}),
    };
}

export function splitEdge(edge, at) {
    const spanIndex = Math.trunc(Number(at?.span));
    const u = Number(at?.u);
    if (!Number.isInteger(spanIndex) || spanIndex < 0 || spanIndex >= edge.spans.length || !Number.isFinite(u) || u <= 0 || u >= 1) throw new RangeError("A split must be inside a valid road span.");
    const knots = edge.geometry.knots.map((knot) => ({ ...knot, position: { ...knot.position }, ...(knot.handleIn ? { handleIn: { ...knot.handleIn } } : {}), ...(knot.handleOut ? { handleOut: { ...knot.handleOut } } : {}) }));
    const span = edge.spans[spanIndex];
    let splitPoint;
    if (span.kind === "polyline") {
        splitPoint = lerp(span.p0, span.p1, u);
        knots.splice(spanIndex + 1, 0, { id: "split", position: splitPoint });
    } else {
        const p01 = lerp(span.p0, span.p1, u);
        const p12 = lerp(span.p1, span.p2, u);
        const p23 = lerp(span.p2, span.p3, u);
        const p012 = lerp(p01, p12, u);
        const p123 = lerp(p12, p23, u);
        splitPoint = lerp(p012, p123, u);
        knots[spanIndex].mode = "free";
        knots[spanIndex].handleOut = subtract(p01, span.p0);
        knots[spanIndex + 1].mode = "free";
        knots[spanIndex + 1].handleIn = subtract(p23, span.p3);
        knots.splice(spanIndex + 1, 0, {
            id: "split",
            position: splitPoint,
            mode: "free",
            handleIn: subtract(p012, splitPoint),
            handleOut: subtract(p123, splitPoint),
        });
    }
    const serialized = knots.map((knot, index) => serializeResolvedKnot(knot, index, knots.length));
    if (edge.geometry.kind === "polyline") serialized.forEach((knot) => { delete knot.mode; delete knot.handleIn; delete knot.handleOut; });
    const leftKnots = structuredClone(serialized.slice(0, spanIndex + 2));
    const rightKnots = structuredClone(serialized.slice(spanIndex + 1));
    leftKnots[0].id = "start";
    leftKnots[leftKnots.length - 1].id = "end";
    rightKnots[0].id = "start";
    rightKnots[rightKnots.length - 1].id = "end";
    delete leftKnots[0].position;
    delete leftKnots.at(-1).position;
    delete rightKnots[0].position;
    delete rightKnots.at(-1).position;
    delete leftKnots[0].handleIn;
    delete leftKnots.at(-1).handleOut;
    delete rightKnots[0].handleIn;
    delete rightKnots.at(-1).handleOut;
    return {
        point: splitPoint,
        geometry: { version: 1, kind: edge.geometry.kind, knots: serialized },
        leftGeometry: { version: 1, kind: edge.geometry.kind, knots: leftKnots },
        rightGeometry: { version: 1, kind: edge.geometry.kind, knots: rightKnots },
    };
}

export function validateGeometry(edge, context = {}) {
    try {
        const samples = sampleCenterline(edge, context.policy ?? ROAD_GEOMETRY_POLICY_V1);
        const surface = buildRoadSurface(edge, { ...context, samples });
        if (surface.indices.some((index) => index < 0 || index >= surface.vertices.length)) throw new TypeError("Road surface contains an invalid index.");
        for (let index = 0; index < surface.indices.length; index += 3) {
            const a = surface.vertices[surface.indices[index]];
            const b = surface.vertices[surface.indices[index + 1]];
            const c = surface.vertices[surface.indices[index + 2]];
            const upward = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
            if (!(upward > EPSILON)) throw new TypeError("Road surface is inverted or folded.");
        }
        return { ok: true, issues: [], samples, surface };
    } catch (error) {
        return { ok: false, issues: [{ path: ["roads", "edges", edge?.id ?? ""], code: "road.geometry.invalid", message: error.message, severity: "error", objectId: edge?.id ?? null }] };
    }
}
