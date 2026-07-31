import {
    buildArcLengthPolyline,
    dedupePolyline,
    distance3d,
    pointFrom,
    projectPointToPolyline,
    sampleArcLengthPolyline,
} from "./geometry.js";
import {
    buildDirectedRoadGraph,
    environmentDocumentFrom,
    hashEnvironmentRoadNetwork,
    projectPointToRoadNetwork,
    routeBetweenProjections,
} from "./roadGraph.js";
import { hashWaypoints, normalizeWaypoints } from "./waypoints.js";
import { stableStringify } from "./hash.js";

const EPSILON = 1e-9;
export const ROUTE_SCHEMA = "cev-sim.route";
export const ROUTE_VERSION = 1;

export function normalizeRoute(value = {}) {
    const source = Array.isArray(value) ? { waypoints: value } : { ...(value ?? {}) };
    const verification = source.verification && typeof source.verification === "object"
        ? source.verification
        : null;
    return {
        ...source,
        schema: source.schema ?? ROUTE_SCHEMA,
        version: source.version ?? ROUTE_VERSION,
        waypoints: normalizeWaypoints(source.waypoints ?? []),
        verified: source.verified === true || Boolean(verification),
        sections: source.sections ?? verification?.sections ?? [],
        edgeTraversal: source.edgeTraversal ?? verification?.edgeTraversal ?? [],
        polyline: source.polyline ?? verification?.polyline ?? [],
        cumulativeDistances: source.cumulativeDistances ?? verification?.cumulativeDistances ?? [],
        totalLength: source.totalLength ?? verification?.totalLength ?? 0,
        environmentHash: source.environmentHash ?? verification?.environmentHash ?? null,
        waypointHash: source.waypointHash ?? verification?.waypointHash ?? null,
        verification,
    };
}

export const createCanonicalRoute = normalizeRoute;

function isFinitePoint(value) {
    return value
        && typeof value === "object"
        && Number.isFinite(Number(value.x))
        && Number.isFinite(Number(value.y ?? 0))
        && Number.isFinite(Number(value.z));
}

function validateArcGeometry(polyline, cumulativeDistances, totalLength, path, issues) {
    if (!Array.isArray(polyline) || polyline.length === 0 || !polyline.every(isFinitePoint)) {
        issues.push({ code: "route.verification.polyline-invalid", path, message: "Verified route geometry requires a finite, non-empty polyline." });
        return;
    }
    if (!Array.isArray(cumulativeDistances)
        || cumulativeDistances.length !== polyline.length
        || cumulativeDistances.some((distance) => !Number.isFinite(distance) || distance < 0)) {
        issues.push({ code: "route.verification.distances-invalid", path: `${path}.cumulativeDistances`, message: "Verified route cumulative distances must match its polyline." });
        return;
    }
    for (let index = 1; index < cumulativeDistances.length; index += 1) {
        if (cumulativeDistances[index] + EPSILON < cumulativeDistances[index - 1]) {
            issues.push({ code: "route.verification.distances-unordered", path: `${path}.cumulativeDistances`, message: "Verified route cumulative distances must be ordered." });
            return;
        }
    }
    if (!Number.isFinite(totalLength)
        || totalLength < 0
        || Math.abs(cumulativeDistances.at(-1) - totalLength) > EPSILON) {
        issues.push({ code: "route.verification.length-invalid", path: `${path}.totalLength`, message: "Verified route length must equal the final cumulative distance." });
    }
}

/**
 * Validate the self-contained portion of a persisted directed A* proof.
 * When an environment is supplied the proof is also deterministically rebuilt
 * and must be byte-for-byte equivalent under stable JSON serialization.
 */
export function validateRouteVerification(route, environment = null) {
    const issues = [];
    const verification = route?.verification;
    const waypoints = normalizeWaypoints(route?.waypoints ?? []);
    if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
        return {
            ok: false,
            issues: [{ code: "route.verification.required", path: "verification", message: "Route must contain a canonical verification proof." }],
            expected: null,
        };
    }
    if (verification.algorithm !== "directed-a-star" || verification.algorithmVersion !== 1) {
        issues.push({ code: "route.verification.algorithm-invalid", path: "verification.algorithm", message: "Route verification must use directed-a-star version 1." });
    }
    if (typeof verification.environmentHash !== "string" || !verification.environmentHash) {
        issues.push({ code: "route.verification.environment-hash-required", path: "verification.environmentHash", message: "Route verification requires an environment hash." });
    }
    const currentWaypointHash = hashWaypoints(waypoints);
    if (typeof verification.waypointHash !== "string" || !verification.waypointHash) {
        issues.push({ code: "route.verification.waypoint-hash-required", path: "verification.waypointHash", message: "Route verification requires a waypoint hash." });
    } else if (verification.waypointHash !== currentWaypointHash) {
        issues.push({ code: "route.verification.waypoints-changed", path: "verification.waypointHash", message: "Route verification does not match the current waypoints." });
    }

    if (!Array.isArray(verification.sections) || verification.sections.length !== Math.max(0, waypoints.length - 1)) {
        issues.push({ code: "route.verification.sections-invalid", path: "verification.sections", message: "Route verification must contain one section between each pair of waypoints." });
    } else {
        verification.sections.forEach((section, index) => {
            const sectionPath = `verification.sections.${index}`;
            if (!section || typeof section !== "object"
                || section.index !== index
                || section.fromWaypointId !== waypoints[index]?.id
                || section.toWaypointId !== waypoints[index + 1]?.id) {
                issues.push({ code: "route.verification.section-identity-invalid", path: sectionPath, message: `Verified route section ${index} does not match its waypoints.` });
                return;
            }
            if (!Array.isArray(section.nodeIds)
                || !Array.isArray(section.edgeIds)
                || !Array.isArray(section.edgeTraversal)) {
                issues.push({ code: "route.verification.section-traversal-invalid", path: sectionPath, message: `Verified route section ${index} requires node and edge traversal arrays.` });
            }
            validateArcGeometry(
                section.polyline,
                section.cumulativeDistances,
                section.length,
                sectionPath,
                issues,
            );
        });
    }
    if (!Array.isArray(verification.edgeTraversal)) {
        issues.push({ code: "route.verification.traversal-invalid", path: "verification.edgeTraversal", message: "Route verification requires an edge traversal." });
    }
    validateArcGeometry(
        verification.polyline,
        verification.cumulativeDistances,
        verification.totalLength,
        "verification",
        issues,
    );

    let expected = null;
    if (environment && issues.length === 0) {
        const rebuilt = verifyRoute(environment, { waypoints });
        if (!rebuilt.ok) {
            issues.push({ code: "route.verification.rebuild-failed", path: "verification", message: rebuilt.error || "The route cannot be verified against the current environment." });
        } else {
            expected = rebuilt.verification;
            if (stableStringify(verification) !== stableStringify(expected)) {
                issues.push({ code: "route.verification.noncanonical", path: "verification", message: "Route verification is not the canonical directed A* result for the current environment and waypoints." });
            }
        }
    }
    return { ok: issues.length === 0, issues, expected };
}

function verificationArguments(first, second, third = {}) {
    const firstLooksEnvironment = Boolean(first?.roads || first?.document?.roads || first?.manifest?.document?.roads);
    const secondLooksEnvironment = Boolean(second?.roads || second?.document?.roads || second?.manifest?.document?.roads);

    if (first?.environment && (first.route || first.waypoints)) {
        const route = first.route ?? Object.fromEntries(
            Object.entries(first).filter(([key]) => key !== "environment"),
        );
        return { environment: first.environment, route, options: second ?? {} };
    }
    if (firstLooksEnvironment) {
        const route = Array.isArray(second) ? { waypoints: second } : (second ?? {});
        return { environment: first, route, options: third ?? {} };
    }
    if (first?.waypoints && secondLooksEnvironment) {
        return { environment: second, route: first, options: third ?? {} };
    }
    return { environment: first?.environment ?? second, route: first?.route ?? first ?? {}, options: third ?? {} };
}

function authoredPosition(waypoint) {
    const point = pointFrom(waypoint?.authoredPosition ?? waypoint);
    return point ? { ...point } : null;
}

function projectedWaypoint(waypoint, projection) {
    return {
        ...waypoint,
        authoredPosition: authoredPosition(waypoint),
        x: projection.x,
        y: projection.y,
        z: projection.z,
        position: { ...projection.point },
        anchor: {
            kind: projection.kind,
            id: projection.nodeId ?? projection.edgeId,
            fraction: projection.t ?? 0,
        },
        projection: {
            kind: projection.kind,
            nodeId: projection.nodeId,
            edgeId: projection.edgeId,
            t: projection.t,
            point: { ...projection.point },
        },
    };
}

function projectionFromStableAnchor(waypoint, graph) {
    const anchor = waypoint?.anchor;
    const position = pointFrom(waypoint);
    if (!anchor?.id || !position) return null;

    if (anchor.kind === "intersection") {
        const node = graph.nodes.get(String(anchor.id));
        if (!node || distance3d(position, node) > 1e-6) return null;
        const point = { x: node.x, y: node.y, z: node.z };
        return {
            kind: "intersection",
            nodeId: node.id,
            edgeId: null,
            t: null,
            point,
            position: point,
            ...point,
            distance: distance3d(position, point),
        };
    }

    if (anchor.kind !== "road" || !Number.isFinite(Number(anchor.fraction))) return null;
    const edge = graph.edges.get(String(anchor.id));
    const start = edge && graph.nodes.get(edge.startNodeId);
    const end = edge && graph.nodes.get(edge.endNodeId);
    if (!edge || !start || !end) return null;
    const t = Math.max(0, Math.min(1, Number(anchor.fraction)));
    const point = {
        x: start.x + ((end.x - start.x) * t),
        y: start.y + ((end.y - start.y) * t),
        z: start.z + ((end.z - start.z) * t),
    };
    if (distance3d(position, point) > 1e-6) return null;
    return {
        kind: "road",
        nodeId: null,
        edgeId: edge.id,
        t,
        point,
        position: point,
        ...point,
        distance: distance3d(position, point),
    };
}

function sectionFromPath(index, from, to, path) {
    const arc = buildArcLengthPolyline(path.polyline);
    return {
        index,
        fromWaypointId: from.id,
        toWaypointId: to.id,
        nodeIds: [...path.nodeIds],
        edgeIds: [...path.edgeIds],
        edgeTraversal: path.edgeTraversal.map((step) => ({ ...step })),
        polyline: arc.polyline,
        cumulativeDistances: arc.cumulativeDistances,
        length: arc.totalLength,
    };
}

function flattenSections(sections) {
    const polyline = dedupePolyline(sections.flatMap((section) => section.polyline));
    const arc = buildArcLengthPolyline(polyline);
    return {
        polyline: arc.polyline,
        cumulativeDistances: arc.cumulativeDistances,
        totalLength: arc.totalLength,
        edgeTraversal: sections.flatMap((section) => section.edgeTraversal.map((step) => ({
            ...step,
            sectionIndex: section.index,
        }))),
    };
}

function unverifiedRoute(route, waypoints, environmentHash, waypointHash) {
    return {
        ...route,
        schema: route.schema ?? ROUTE_SCHEMA,
        version: route.version ?? ROUTE_VERSION,
        waypoints,
        verified: false,
        environmentHash,
        waypointHash,
        sections: [],
        edgeTraversal: [],
        polyline: [],
        cumulativeDistances: [],
        totalLength: 0,
        verification: null,
    };
}

/**
 * Verify authored waypoints and build deterministic canonical route geometry.
 *
 * Supported forms:
 *   verifyRoute(environment, waypointsOrRoute, options?)
 *   verifyRoute(route, environment, options?)
 *   verifyRoute({ environment, route })
 */
export function verifyRoute(first, second, third) {
    const { environment, route: routeInput, options } = verificationArguments(first, second, third);
    const route = Array.isArray(routeInput) ? { waypoints: routeInput } : { ...(routeInput ?? {}) };
    const rawWaypoints = Array.isArray(route.waypoints) ? route.waypoints : [];
    const waypoints = normalizeWaypoints(rawWaypoints);
    const environmentHash = options.environmentHash ?? hashEnvironmentRoadNetwork(environment);
    let waypointHash = hashWaypoints(waypoints);
    const issues = [];

    if (waypoints.length < 2) {
        issues.push({
            code: "route.waypoints.required",
            message: "A route requires a start and finish waypoint.",
        });
    }

    rawWaypoints.forEach((waypoint, index) => {
        if (pointFrom(waypoint)) return;
        issues.push({
            code: "route.waypoint.position-invalid",
            message: `Waypoint ${index} requires finite X and Z coordinates.`,
            waypointId: waypoint?.id ?? null,
            index,
        });
    });

    const document = environmentDocumentFrom(environment);
    const graph = buildDirectedRoadGraph(environment);
    if (document.roads.nodes.length === 0 || document.roads.edges.length === 0) {
        issues.push({
            code: "route.environment.road-network-empty",
            message: "The selected environment has no routable road network.",
        });
    }

    const projected = waypoints.map((waypoint, index) => {
        if (issues.some((issue) => issue.code === "route.waypoint.position-invalid" && issue.index === index)) {
            return waypoint;
        }
        const projection = projectionFromStableAnchor(waypoint, graph)
            ?? projectPointToRoadNetwork(
                waypoint.authoredPosition ?? waypoint,
                environment,
                options.projection ?? {},
            );
        if (!projection) {
            issues.push({
                code: "route.waypoint.off-road",
                message: `${waypoint.label || `Waypoint ${index}`} is not on a road or intersection.`,
                waypointId: waypoint.id,
                index,
            });
            return waypoint;
        }
        return projectedWaypoint(waypoint, projection);
    });

    // The persisted, snapped positions are the canonical route identity. The
    // unsnapped click remains available as authoredPosition for editor UX.
    if (!issues.some((issue) => issue.code === "route.waypoint.off-road")) {
        waypointHash = hashWaypoints(projected);
    }

    if (issues.length > 0) {
        const failedRoute = unverifiedRoute(route, projected, environmentHash, waypointHash);
        return {
            ok: false,
            issues,
            error: issues[0].message,
            route: failedRoute,
            waypoints: failedRoute.waypoints,
            verification: null,
        };
    }

    const sections = [];
    for (let index = 0; index < projected.length - 1; index += 1) {
        const from = projected[index];
        const to = projected[index + 1];
        const path = routeBetweenProjections(from.projection, to.projection, graph);
        if (!path.ok) {
            issues.push({
                code: "route.section.disconnected",
                message: `No directed road path connects ${from.label || from.id} to ${to.label || to.id}.`,
                section: index,
                fromWaypointId: from.id,
                toWaypointId: to.id,
            });
            continue;
        }
        sections.push(sectionFromPath(index, from, to, path));
    }

    if (issues.length > 0) {
        const failedRoute = unverifiedRoute(route, projected, environmentHash, waypointHash);
        return {
            ok: false,
            issues,
            error: issues[0].message,
            route: failedRoute,
            waypoints: failedRoute.waypoints,
            verification: null,
        };
    }

    const flattened = flattenSections(sections);
    const verification = {
        algorithm: "directed-a-star",
        algorithmVersion: 1,
        environmentId: document.environmentId ?? null,
        environmentHash,
        waypointHash,
        sections,
        edgeTraversal: flattened.edgeTraversal,
        polyline: flattened.polyline,
        cumulativeDistances: flattened.cumulativeDistances,
        totalLength: flattened.totalLength,
    };
    const verifiedRoute = {
        ...route,
        schema: route.schema ?? ROUTE_SCHEMA,
        version: route.version ?? ROUTE_VERSION,
        waypoints: projected,
        verified: true,
        ...verification,
        verification,
    };
    return {
        ok: true,
        issues: [],
        route: verifiedRoute,
        waypoints: verifiedRoute.waypoints,
        verification,
    };
}

export const verifyCanonicalRoute = verifyRoute;

export function buildVerifiedRoute(...args) {
    const result = verifyRoute(...args);
    if (!result.ok) {
        const error = new Error(result.error || "Route verification failed.");
        error.issues = result.issues;
        throw error;
    }
    return result.route;
}

export function invalidateRouteVerification(route) {
    return unverifiedRoute(
        route ?? {},
        normalizeWaypoints(route?.waypoints ?? []),
        route?.environmentHash ?? null,
        hashWaypoints(route?.waypoints ?? []),
    );
}

export function isRouteVerificationCurrent(route, environment) {
    if (!route?.verified) return false;
    return route.environmentHash === hashEnvironmentRoadNetwork(environment)
        && route.waypointHash === hashWaypoints(route.waypoints ?? []);
}

export function getRoutePolyline(route) {
    if (Array.isArray(route)) return dedupePolyline(route);
    const direct = route?.polyline ?? route?.verification?.polyline;
    if (Array.isArray(direct) && direct.length) return dedupePolyline(direct);
    if (Array.isArray(route?.sections) && route.sections.length) {
        return dedupePolyline(route.sections.flatMap((section) => section.polyline ?? []));
    }
    return dedupePolyline(route?.waypoints ?? []);
}

export function routeSectionCount(route) {
    if (Array.isArray(route?.sections) && route.sections.length > 0) return route.sections.length;
    const waypoints = Array.isArray(route) ? route : route?.waypoints;
    return Math.max(0, (waypoints?.length ?? 0) - 1);
}

export function sampleRoute(route, percent) {
    const sampled = sampleArcLengthPolyline(getRoutePolyline(route), percent);
    if (!sampled) return null;
    return { ...sampled, section: sectionAtDistance(route, sampled.distance) };
}

export const followRoute = sampleRoute;

function legacySectionPolyline(route, sectionIndex) {
    const list = Array.isArray(route) ? route : route?.waypoints ?? [];
    if (sectionIndex < 0 || sectionIndex >= list.length - 1) return null;
    return [list[sectionIndex], list[sectionIndex + 1]];
}

export function sampleRouteSection(route, section, percent) {
    const sectionIndex = Math.trunc(Number(section));
    if (!Number.isFinite(sectionIndex) || sectionIndex < 0) return null;
    const definition = Array.isArray(route?.sections) ? route.sections[sectionIndex] : null;
    const polyline = definition?.polyline ?? legacySectionPolyline(route, sectionIndex);
    if (!polyline) return null;
    const sampled = sampleArcLengthPolyline(polyline, percent);
    return sampled ? { ...sampled, section: sectionIndex } : null;
}

export const followRouteSection = sampleRouteSection;

function sectionAtDistance(route, distance) {
    if (!Array.isArray(route?.sections) || route.sections.length === 0) {
        const waypoints = Array.isArray(route) ? route : route?.waypoints ?? [];
        let cursor = 0;
        for (let index = 0; index < waypoints.length - 1; index += 1) {
            const start = pointFrom(waypoints[index]);
            const end = pointFrom(waypoints[index + 1]);
            if (!start || !end) continue;
            const length = distance3d(start, end);
            if (distance <= cursor + length + EPSILON) return index;
            cursor += length;
        }
        return waypoints.length > 1 ? waypoints.length - 2 : -1;
    }
    let cursor = 0;
    for (const section of route.sections) {
        const length = Number.isFinite(section.length)
            ? section.length
            : buildArcLengthPolyline(section.polyline ?? []).totalLength;
        if (distance <= cursor + length + EPSILON) return section.index ?? 0;
        cursor += length;
    }
    return route.sections.at(-1)?.index ?? route.sections.length - 1;
}

export function projectPoseToRoute(route, pose) {
    if (Array.isArray(route?.sections) && route.sections.length) {
        let prefix = 0;
        let best = null;
        const totalLength = route.totalLength ?? route.sections.reduce((sum, section) => (
            sum + (section.length ?? buildArcLengthPolyline(section.polyline ?? []).totalLength)
        ), 0);
        for (const section of route.sections) {
            const projection = projectPointToPolyline(pose, section.polyline ?? []);
            const length = section.length ?? buildArcLengthPolyline(section.polyline ?? []).totalLength;
            if (projection) {
                const distanceAlong = prefix + projection.distanceAlong;
                const candidate = {
                    ...projection,
                    distanceAlong,
                    progress: totalLength <= EPSILON ? 1 : distanceAlong / totalLength,
                    section: section.index ?? 0,
                };
                if (!best
                    || candidate.distance < best.distance - EPSILON
                    || (Math.abs(candidate.distance - best.distance) <= EPSILON && candidate.distanceAlong < best.distanceAlong)) {
                    best = candidate;
                }
            }
            prefix += length;
        }
        return best;
    }

    const projection = projectPointToPolyline(pose, getRoutePolyline(route));
    if (!projection) return null;
    return { ...projection, section: projection.segment };
}

export function routeProgress(route, pose) {
    const projection = projectPoseToRoute(route, pose);
    return projection
        ? { progress: projection.progress, segment: projection.section, projection }
        : { progress: 0, segment: 0, projection: null };
}

/** Return exact current length even for legacy routes. */
export function routeLength(route) {
    if (Number.isFinite(route?.totalLength)) return route.totalLength;
    return buildArcLengthPolyline(getRoutePolyline(route)).totalLength;
}

export function distanceToRouteEnd(route, pose) {
    const end = getRoutePolyline(route).at(-1);
    const point = pointFrom(pose);
    return end && point ? distance3d(point, end) : Infinity;
}
