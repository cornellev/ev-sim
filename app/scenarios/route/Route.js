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
    offsetEdgeSample,
    pointOnEdgeCenterline,
    projectPointToRoadNetwork,
    routeOrderedProjections,
    stitchTravelSectionPolylines,
} from "./roadGraph.js";
import { hashWaypoints, hashWaypointsV3, hashWaypointsV4, normalizeWaypoints } from "./waypoints.js";
import { stableStringify } from "./hash.js";
import { canonicalNumericTree } from "../../simulation/kernel/SimulationHashes.js";
import {
    laneCenterPoint,
    nearestLaneIndexForOffset,
    roadLaneCount,
    signedRightOffset,
} from "../../roads/RoadLaneModel.js";
import { roadGeometryVersionOf } from "../../roads/RoadGeometryRecord.js";
import { ROAD_GEOMETRY_POLICY_V1 } from "../../roads/RoadGeometryPolicy.js";

const EPSILON = 1e-9;
export const ROUTE_SCHEMA = "cev-sim.route";
export const ROUTE_VERSION = 1;
export const ROUTE_ALGORITHM = "directed-a-star";
export const ROUTE_ALGORITHM_VERSION = 5;
export const ROUTE_ALGORITHM_VERSION_V6 = 6;
const CENTERLINE_EPSILON = 1e-6;

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
        verified: verification?.algorithm === ROUTE_ALGORITHM
            && [ROUTE_ALGORITHM_VERSION, ROUTE_ALGORITHM_VERSION_V6].includes(verification?.algorithmVersion)
            && verification?.waypointHash === hashWaypoints(source.waypoints ?? []),
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

export function routeAlgorithmVersionFor(environment) {
    const version = roadGeometryVersionOf(environmentDocumentFrom(environment));
    if (version === 2) return ROUTE_ALGORITHM_VERSION_V6;
    if (version === 1) return ROUTE_ALGORITHM_VERSION;
    throw new TypeError(`Unsupported road geometry version: ${String(version)}.`);
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
export function validateRouteVerification(route, environment = null, options = {}) {
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
    const legacyVersion = verification?.algorithm === ROUTE_ALGORITHM
        && [3, 4].includes(verification.algorithmVersion)
        && (options.allowLegacyVersions === true || options.allowLegacyV3 === true);
    const currentVersion = [ROUTE_ALGORITHM_VERSION, ROUTE_ALGORITHM_VERSION_V6].includes(verification?.algorithmVersion);
    const expectedVersion = environment ? routeAlgorithmVersionFor(environment) : verification?.algorithmVersion;
    if (!legacyVersion && (verification.algorithm !== ROUTE_ALGORITHM || !currentVersion || verification.algorithmVersion !== expectedVersion)) {
        issues.push({ code: "route.verification.algorithm-invalid", path: "verification.algorithm", message: `Route verification must use ${ROUTE_ALGORITHM} version ${expectedVersion}.` });
    }
    if (verification.algorithmVersion === ROUTE_ALGORITHM_VERSION_V6
        && (verification.distanceMetric !== "xz"
            || verification.geometryPolicy?.id !== ROAD_GEOMETRY_POLICY_V1.id
            || verification.geometryPolicy?.version !== ROAD_GEOMETRY_POLICY_V1.version)) {
        issues.push({ code: "route.verification.geometry-policy-invalid", path: "verification.geometryPolicy", message: "Route verification v6 requires the frozen XZ road geometry policy." });
    }
    if (typeof verification.environmentHash !== "string" || !verification.environmentHash) {
        issues.push({ code: "route.verification.environment-hash-required", path: "verification.environmentHash", message: "Route verification requires an environment hash." });
    }
    const currentWaypointHash = verification?.algorithmVersion === 3 && legacyVersion
        ? hashWaypointsV3(waypoints)
        : verification?.algorithmVersion === 4 && legacyVersion
            ? hashWaypointsV4(waypoints)
            : hashWaypoints(waypoints);
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
            } else if (!legacyVersion && section.edgeTraversal.some((step) => (
                !Number.isInteger(step?.fromLaneIndex)
                || !Number.isInteger(step?.toLaneIndex)
                || !isFinitePoint(step?.fromSubnode?.position)
                || !isFinitePoint(step?.toSubnode?.position)
            ))) {
                issues.push({
                    code: "route.verification.lane-traversal-invalid",
                    path: `${sectionPath}.edgeTraversal`,
                    message: `Verified route section ${index} requires physical lane assignments and lane-boundary subnodes.`,
                });
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
    if (environment && issues.length === 0 && legacyVersion) {
        const currentEnvironmentHash = hashEnvironmentRoadNetwork(environment);
        if (verification.environmentHash !== currentEnvironmentHash) {
            issues.push({ code: "route.verification.environment-changed", path: "verification.environmentHash", message: "Route verification does not match the current road network." });
        }
    } else if (environment && issues.length === 0) {
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
            ...(projection.kind === "road" ? {
                laneMode: projection.laneMode === "fixed" ? "fixed" : "auto",
                ...(projection.laneMode === "fixed" ? { laneIndex: projection.laneIndex } : {}),
            } : {}),
        },
        projection: {
            kind: projection.kind,
            nodeId: projection.nodeId,
            edgeId: projection.edgeId,
            t: projection.t,
            laneIndex: projection.laneIndex ?? null,
            laneMode: projection.laneMode ?? null,
            rightOffset: projection.rightOffset ?? null,
            centerlinePoint: projection.centerlinePoint ? { ...projection.centerlinePoint } : null,
            point: { ...projection.point },
        },
    };
}

function projectionFromStableAnchor(waypoint, graph) {
    const anchor = waypoint?.anchor;
    if (!anchor?.id) return null;

    if (anchor.kind === "intersection") {
        const node = graph.nodes.get(String(anchor.id));
        if (!node) return null;
        const point = { x: node.x, y: node.y, z: node.z };
        return {
            kind: "intersection",
            nodeId: node.id,
            edgeId: null,
            t: null,
            point,
            position: point,
            ...point,
            distance: 0,
        };
    }

    if (anchor.kind !== "road" || !Number.isFinite(Number(anchor.fraction))) return null;
    const edge = graph.edges.get(String(anchor.id));
    const start = edge && graph.nodes.get(edge.startNodeId);
    const end = edge && graph.nodes.get(edge.endNodeId);
    if (!edge || !start || !end) return null;
    const t = Math.max(0, Math.min(1, Number(anchor.fraction)));
    const centerlinePoint = pointOnEdgeCenterline(edge, t, graph);
    const pointerPoint = pointFrom(waypoint?.authoredPosition ?? waypoint, centerlinePoint);
    const rightOffset = signedRightOffset(pointerPoint, start, end);
    const explicitLaneIndex = Number.isInteger(anchor.laneIndex) ? anchor.laneIndex : null;
    const laneMode = anchor.laneMode === "auto"
        ? "auto"
        : anchor.laneMode === "fixed" || explicitLaneIndex !== null
            ? "fixed"
            : roadLaneCount(edge) === 1 || Math.abs(rightOffset) > CENTERLINE_EPSILON
                ? "fixed"
                : "auto";
    const laneIndex = explicitLaneIndex ?? nearestLaneIndexForOffset(edge, rightOffset);
    const point = laneMode === "fixed"
        ? graph.geometryVersion === 2
            ? offsetEdgeSample(edge, t, laneIndex, graph)
            : laneCenterPoint(centerlinePoint, start, end, edge, laneIndex)
        : centerlinePoint;
    // Anchor + fraction are authoritative; displayed position may sit on the
    // right-hand travel offset rather than the centerline.
    return {
        kind: "road",
        nodeId: null,
        edgeId: edge.id,
        t,
        laneIndex,
        laneMode,
        rightOffset,
        centerlinePoint,
        point,
        position: point,
        ...point,
        distance: 0,
    };
}

function sectionFromPath(index, from, to, path, distanceMetric = "3d") {
    const arc = buildArcLengthPolyline(path.polyline, distanceMetric);
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

function flattenSections(sections, distanceMetric = "3d") {
    const polyline = dedupePolyline(sections.flatMap((section) => section.polyline));
    const arc = buildArcLengthPolyline(polyline, distanceMetric);
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
    const algorithmVersion = routeAlgorithmVersionFor(environment);
    const distanceMetric = algorithmVersion === ROUTE_ALGORITHM_VERSION_V6 ? "xz" : "3d";

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
    if (graph.laneIssues?.length > 0) {
        const issue = graph.laneIssues[0];
        issues.push({
            code: "route.environment.lane-layout-invalid",
            message: `Road "${issue.edgeId}" has an invalid lane layout: ${issue.error}`,
            edgeId: issue.edgeId,
        });
    }
    if (graph.turnRuleIssues?.length > 0) {
        const issue = graph.turnRuleIssues[0];
        issues.push({
            code: "route.environment.turn-rules-invalid",
            message: `Turn rule ${issue.index} is invalid: ${issue.error}.`,
        });
    }

    const projected = waypoints.map((waypoint, index) => {
        if (issues.some((issue) => issue.code === "route.waypoint.position-invalid" && issue.index === index)) {
            return waypoint;
        }
        const anchorEdge = waypoint.anchor?.kind === "road"
            ? graph.edges.get(String(waypoint.anchor.id))
            : null;
        if (algorithmVersion === ROUTE_ALGORITHM_VERSION_V6 && waypoint.anchor) {
            const anchor = waypoint.anchor;
            const validShape = anchor.kind === "intersection"
                ? Boolean(anchor.id)
                : anchor.kind === "road"
                    && Boolean(anchor.id)
                    && Number.isFinite(Number(anchor.fraction))
                    && Number(anchor.fraction) >= 0
                    && Number(anchor.fraction) <= 1;
            if (!validShape) {
                issues.push({ code: "route.waypoint.anchor-invalid", message: `${waypoint.label || `Waypoint ${index}`} has an invalid explicit anchor.`, waypointId: waypoint.id, index });
                return waypoint;
            }
            const exists = anchor.kind === "road" ? graph.edges.has(String(anchor.id)) : graph.nodes.has(String(anchor.id));
            if (!exists) {
                issues.push({ code: "route.waypoint.anchor-missing", message: `${waypoint.label || `Waypoint ${index}`} references a missing ${anchor.kind}.`, waypointId: waypoint.id, index });
                return waypoint;
            }
        }
        const hasExplicitLaneIndex = waypoint.anchor?.kind === "road"
            && Object.prototype.hasOwnProperty.call(waypoint.anchor, "laneIndex");
        const explicitLaneIndex = Number.isInteger(waypoint.anchor?.laneIndex)
            ? waypoint.anchor.laneIndex
            : null;
        if (anchorEdge && (waypoint.anchor?.laneMode === "fixed" || hasExplicitLaneIndex)
            && (explicitLaneIndex === null || explicitLaneIndex < 0 || explicitLaneIndex >= roadLaneCount(anchorEdge))) {
            issues.push({
                code: "route.waypoint.lane-invalid",
                message: `${waypoint.label || `Waypoint ${index}`} references an invalid physical lane.`,
                waypointId: waypoint.id,
                index,
            });
            return waypoint;
        }
        const anchoredProjection = projectionFromStableAnchor(waypoint, graph);
        const projection = anchoredProjection
            ?? (algorithmVersion === ROUTE_ALGORITHM_VERSION_V6 && waypoint.anchor ? null : projectPointToRoadNetwork(
                waypoint.authoredPosition ?? waypoint,
                environment,
                options.projection ?? {},
            ));
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
    if (!issues.some((issue) => ["route.waypoint.off-road", "route.waypoint.lane-invalid"].includes(issue.code))) {
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

    const itinerary = routeOrderedProjections(projected.map((waypoint) => waypoint.projection), graph);
    const sections = [];
    if (!itinerary.ok) {
        const index = Math.max(0, Math.min(projected.length - 2, itinerary.section ?? 0));
        const from = projected[index];
        const to = projected[index + 1];
        const code = [
            "route.section.illegal-direction",
            "route.section.lane-unreachable",
            "route.section.turn-restricted",
            "route.environment.lane-layout-invalid",
            "route.environment.turn-rules-invalid",
        ].includes(itinerary.code) ? itinerary.code : "route.section.disconnected";
        const message = code === "route.section.illegal-direction"
            ? `Travel from ${from.label || from.id} to ${to.label || to.id} goes the wrong way on a one-way road.`
            : code === "route.section.lane-unreachable"
                ? `No legal route can reach the selected lane at ${to.label || to.id} from ${from.label || from.id}.`
            : code === "route.section.turn-restricted"
                ? `Travel from ${from.label || from.id} to ${to.label || to.id} violates an intersection turn restriction.`
                : code === "route.environment.lane-layout-invalid"
                    ? itinerary.error
                    : code === "route.environment.turn-rules-invalid"
                        ? itinerary.error
                    : `No directed road path connects ${from.label || from.id} to ${to.label || to.id}.`;
        issues.push({
            code,
            message,
            section: index,
            fromWaypointId: from.id,
            toWaypointId: to.id,
        });
    } else {
        itinerary.paths.forEach((path, index) => {
            sections.push(sectionFromPath(index, projected[index], projected[index + 1], path, distanceMetric));
        });
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

    // Join section polylines at intersection waypoints with the same offset-line
    // corner used within a single directed path (avoids left-turn node-offset folds).
    const stitchedSections = stitchTravelSectionPolylines(sections, graph);

    // Align displayed waypoint positions with the offset travel polyline while
    // keeping centerline/intersection anchors as the stable identity.
    const aligned = projected.map((waypoint, index) => {
        if (waypoint.anchor?.kind === "road" && waypoint.anchor?.laneMode === "fixed") {
            return waypoint;
        }
        let travelPoint = null;
        if (index === 0) {
            travelPoint = stitchedSections[0]?.polyline?.[0] ?? null;
        } else if (index === projected.length - 1) {
            travelPoint = stitchedSections[stitchedSections.length - 1]?.polyline?.at(-1) ?? null;
        } else {
            travelPoint = stitchedSections[index]?.polyline?.[0]
                ?? stitchedSections[index - 1]?.polyline?.at(-1)
                ?? null;
        }
        if (!travelPoint) return waypoint;
        return {
            ...waypoint,
            x: travelPoint.x,
            y: travelPoint.y,
            z: travelPoint.z,
            position: { ...travelPoint },
        };
    });
    waypointHash = hashWaypoints(aligned);

    const flattened = flattenSections(stitchedSections, distanceMetric);
    const verification = canonicalNumericTree({
        algorithm: ROUTE_ALGORITHM,
        algorithmVersion,
        ...(algorithmVersion === ROUTE_ALGORITHM_VERSION_V6 ? {
            geometryPolicy: { id: ROAD_GEOMETRY_POLICY_V1.id, version: ROAD_GEOMETRY_POLICY_V1.version },
            distanceMetric: "xz",
        } : {}),
        environmentId: document.environmentId ?? null,
        environmentHash,
        waypointHash,
        sections: stitchedSections,
        edgeTraversal: flattened.edgeTraversal,
        polyline: flattened.polyline,
        cumulativeDistances: flattened.cumulativeDistances,
        totalLength: flattened.totalLength,
    });
    const verifiedRoute = {
        ...route,
        schema: route.schema ?? ROUTE_SCHEMA,
        version: route.version ?? ROUTE_VERSION,
        waypoints: aligned,
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
    const verification = route?.verification;
    if (verification?.algorithm !== ROUTE_ALGORITHM
        || ![ROUTE_ALGORITHM_VERSION, ROUTE_ALGORITHM_VERSION_V6].includes(verification?.algorithmVersion)
        || (environment && verification.algorithmVersion !== routeAlgorithmVersionFor(environment))
        || verification?.waypointHash !== hashWaypoints(route?.waypoints ?? [])) {
        return false;
    }
    return !environment || verification.environmentHash === hashEnvironmentRoadNetwork(environment);
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
    const sampled = sampleArcLengthPolyline(getRoutePolyline(route), percent, route?.verification?.distanceMetric ?? "3d");
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
    const sampled = sampleArcLengthPolyline(polyline, percent, route?.verification?.distanceMetric ?? "3d");
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
            : buildArcLengthPolyline(section.polyline ?? [], route?.verification?.distanceMetric ?? "3d").totalLength;
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
            sum + (section.length ?? buildArcLengthPolyline(section.polyline ?? [], route?.verification?.distanceMetric ?? "3d").totalLength)
        ), 0);
        for (const section of route.sections) {
            const projection = projectPointToPolyline(pose, section.polyline ?? [], { distanceMetric: route?.verification?.distanceMetric ?? "3d" });
            const length = section.length ?? buildArcLengthPolyline(section.polyline ?? [], route?.verification?.distanceMetric ?? "3d").totalLength;
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

    const projection = projectPointToPolyline(pose, getRoutePolyline(route), { distanceMetric: route?.verification?.distanceMetric ?? "3d" });
    if (!projection) return null;
    return { ...projection, section: projection.segment };
}

/**
 * Directed route tangent at the closest projection of `pose`.
 * Uses the verified polyline travel direction (not the ambient road edge).
 */
export function routeTangentAtPose(route, pose) {
    const projection = projectPoseToRoute(route, pose);
    if (!projection) return null;
    return {
        projection,
        heading: Number.isFinite(projection.heading) ? projection.heading : 0,
        tangent: projection.tangent ?? { x: Math.sin(projection.heading || 0), z: Math.cos(projection.heading || 0) },
    };
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
    return buildArcLengthPolyline(getRoutePolyline(route), route?.verification?.distanceMetric ?? "3d").totalLength;
}

export function distanceToRouteEnd(route, pose) {
    const end = getRoutePolyline(route).at(-1);
    const point = pointFrom(pose);
    return end && point ? distance3d(point, end) : Infinity;
}
