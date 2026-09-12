import * as THREE from "three";
import Unit from "../../util/Unit.js";
import { Road } from "./Road.js";
import { Intersection } from "./Intersection.js";
import { Triangle } from "../data/objects/Triangle.js";
import { laneDividerDescriptors } from "../../roads/RoadLaneModel.js";

const DEFAULT_ROAD_OPTIONS = {
    laneWidth: 3.5,
    bidirectionalLaneCount: 2,
    oneWayLaneCount: 1,
    shoulderWidth: 0.2,
    laneMarkingWidth: 0.2,
    dashLength: 3.5,
    dashGap: 2.5,
    elevation: 0.015,
    shoulderElevation: 0.008,
    markingElevation: 0.02,
    surfaceColor: 0x2d3034,
    shoulderColor: 0x4d5055,
    centerLineType: Road.BorderType.DASHED_YELLOW,
    oneWayDividerType: Road.BorderType.DASHED_WHITE,
    borderLeft: Road.BorderType.SOLID_WHITE,
    borderRight: Road.BorderType.SOLID_WHITE,
};

const DEFAULT_NETWORK_OPTIONS = {
    roadOptions: DEFAULT_ROAD_OPTIONS,
    intersectionOptions: {},
    maxIntersectionDegree: 4,
    intersectionInset: null,
    intersectionInsetFactor: 0.75,
    minIntersectionInset: 2.5,
    maxIntersectionInset: 10,
    straightAngleThreshold: -0.965,
    minRoadLength: 3,
    tension: 0.15,
};

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getNodeAdjacency(edges) {
    const adjacency = new Map();

    for (const edge of edges) {
        if (!adjacency.has(edge.startName)) adjacency.set(edge.startName, []);
        if (!adjacency.has(edge.endName)) adjacency.set(edge.endName, []);
        adjacency.get(edge.startName).push(edge);
        adjacency.get(edge.endName).push(edge);
    }

    return adjacency;
}

function validateIntersectionDegrees(adjacency, networkOptions) {
    const violations = [];

    for (const [nodeName, edges] of adjacency.entries()) {
        if (edges.length > networkOptions.maxIntersectionDegree) {
            violations.push({
                nodeName,
                degree: edges.length,
            });
        }
    }

    if (!violations.length) {
        return;
    }

    const summary = violations
        .map(({ nodeName, degree }) => `${nodeName} (${degree})`)
        .join(", ");

    throw new Error(
        `Road network nodes cannot exceed ${networkOptions.maxIntersectionDegree} connected roads. Violations: ${summary}`,
    );
}

function getOtherEndpoint(edge, nodeName) {
    return nodeName === edge.startName ? edge.endVec : edge.startVec;
}

function getOutboundDirection(edge, nodeName) {
    return getOtherEndpoint(edge, nodeName).clone().sub(edge.nodeVectors[nodeName]).setY(0).normalize();
}

function shouldCreateIntersection(nodeName, adjacency, options) {
    const edges = adjacency.get(nodeName) ?? [];
    if (edges.length < 2) return false;
    if (edges.length > 2) return true;

    const [a, b] = edges;
    const dirA = getOutboundDirection(a, nodeName);
    const dirB = getOutboundDirection(b, nodeName);

    if (!Number.isFinite(dirA.x) || !Number.isFinite(dirB.x)) {
        return false;
    }

    return dirA.dot(dirB) > options.straightAngleThreshold;
}

function computeIntersectionInset(nodeName, adjacency, networkOptions) {
    const connectedEdges = adjacency.get(nodeName) ?? [];
    if (connectedEdges.length < 2) return 0;

    let shortestEdge = Infinity;
    for (const edge of connectedEdges) {
        shortestEdge = Math.min(shortestEdge, edge.startVec.distanceTo(edge.endVec));
    }

    const roadOptions = networkOptions.roadOptions;
    const widestRoad = roadOptions.laneWidth * Math.max(roadOptions.bidirectionalLaneCount, roadOptions.oneWayLaneCount);
    const desiredInset = networkOptions.intersectionInset
        ?? widestRoad * networkOptions.intersectionInsetFactor;
    const maxFromEdgeLength = shortestEdge * 0.35;

    return clamp(
        Math.min(desiredInset, maxFromEdgeLength),
        networkOptions.minIntersectionInset,
        networkOptions.maxIntersectionInset,
    );
}

function computeTrimmedEndpoints(edge, trimStart, trimEnd, minRoadLength) {
    const startVec = edge.startVec.clone();
    const endVec = edge.endVec.clone();
    const axis = endVec.clone().sub(startVec);
    const length = axis.length();

    if (length === 0) {
        return {
            startPoint: startVec,
            endPoint: endVec,
        };
    }

    let safeTrimStart = Math.max(0, trimStart);
    let safeTrimEnd = Math.max(0, trimEnd);
    const maxTrim = Math.max(0, length - minRoadLength);
    const totalTrim = safeTrimStart + safeTrimEnd;

    if (totalTrim > maxTrim && totalTrim > 0) {
        const scale = maxTrim / totalTrim;
        safeTrimStart *= scale;
        safeTrimEnd *= scale;
    }

    const direction = axis.normalize();

    return {
        startPoint: startVec.addScaledVector(direction, safeTrimStart),
        endPoint: endVec.addScaledVector(direction, -safeTrimEnd),
    };
}

function createRoadPoints(startPoint, endPoint) {
    const midVec1 = new THREE.Vector3(
        (2 * startPoint.x + endPoint.x) / 3,
        (2 * startPoint.y + endPoint.y) / 3,
        (2 * startPoint.z + endPoint.z) / 3,
    );
    const midVec2 = new THREE.Vector3(
        (startPoint.x + 2 * endPoint.x) / 3,
        (startPoint.y + 2 * endPoint.y) / 3,
        (startPoint.z + 2 * endPoint.z) / 3,
    );

    return [startPoint, midVec1, midVec2, endPoint];
}

function createRoadFromEdge(edge, trimmedEndpoints, networkOptions) {
    const roadOptions = {
        ...networkOptions.roadOptions,
        ...(edge.roadOptions ?? {}),
    };
    const laneCount = edge.laneCount
        ?? (edge.bidirectional ? roadOptions.bidirectionalLaneCount : roadOptions.oneWayLaneCount);
    const width = edge.width ?? (roadOptions.laneWidth * laneCount);
    const centerLineType = edge.bidirectional
        ? roadOptions.centerLineType
        : laneCount > 1
            ? roadOptions.oneWayDividerType
            : Road.BorderType.NONE;

    const road = new Road(
        createRoadPoints(trimmedEndpoints.startPoint, trimmedEndpoints.endPoint),
        new Unit(width, Unit.Type.METER),
        edge.borderLeft ?? roadOptions.borderLeft,
        edge.borderRight ?? roadOptions.borderRight,
        {
            ...roadOptions,
            laneCount,
            centerLineType,
            direction: edge.bidirectional ? 0 : 1,
            tension: edge.tension ?? networkOptions.tension,
        },
    );

    road.oneWay = !edge.bidirectional;
    road.direction = edge.bidirectional ? 0 : 1;
    road.network = {
        edgeId: edge.id ?? null,
        startName: edge.startName,
        endName: edge.endName,
        bidirectional: edge.bidirectional,
    };

    return road;
}

/**
 * Plan a road network without creating meshes: resolve edges, adjacency,
 * intersection nodes, and insets from the WHOLE graph. Insets depend on every
 * incident edge, so callers that rebuild a subset still plan over all edges.
 * @param {Map<string, THREE.Vector3>} vectorMap
 * @param {Array<Array>} connections `[startName, endName, bidirectional, metadata]`
 * @param {Object} options
 */
export function planRoadNetwork(vectorMap, connections, options = {}) {
    const networkOptions = {
        ...DEFAULT_NETWORK_OPTIONS,
        ...options,
        roadOptions: {
            ...DEFAULT_ROAD_OPTIONS,
            ...(options.roadOptions ?? {}),
        },
        intersectionOptions: {
            ...(options.intersectionOptions ?? {}),
        },
    };

    const edges = [];

    for (const [startName, endName, bidirectional = true, metadata = {}] of connections) {
        const startNodeVec = vectorMap.get(startName)?.clone();
        const endNodeVec = vectorMap.get(endName)?.clone();

        if (!startNodeVec || !endNodeVec) {
            console.warn(`Missing vector for road connection: ${startName} to ${endName}`);
            continue;
        }

        const startVec = metadata.startArm
            ? new THREE.Vector3(metadata.startArm.x, metadata.startArm.y ?? 0, metadata.startArm.z)
            : startNodeVec.clone();
        const endVec = metadata.endArm
            ? new THREE.Vector3(metadata.endArm.x, metadata.endArm.y ?? 0, metadata.endArm.z)
            : endNodeVec.clone();

        edges.push({
            id: metadata.id ?? null,
            startName,
            endName,
            startVec,
            endVec,
            bidirectional,
            nodeVectors: {
                [startName]: startNodeVec,
                [endName]: endNodeVec,
            },
            width: Number.isFinite(metadata.width) ? metadata.width : null,
            laneCount: Number.isFinite(metadata.laneCount) ? metadata.laneCount : null,
            tension: Number.isFinite(metadata.tension) ? metadata.tension : null,
            borderLeft: metadata.borderLeft ?? null,
            borderRight: metadata.borderRight ?? null,
            roadOptions: Number.isFinite(metadata.shoulderWidth)
                ? { shoulderWidth: metadata.shoulderWidth }
                : null,
            hasExplicitStart: Boolean(metadata.startArm),
            hasExplicitEnd: Boolean(metadata.endArm),
        });
    }

    const adjacency = getNodeAdjacency(edges);
    validateIntersectionDegrees(adjacency, networkOptions);
    const intersectionNodes = new Set(
        [...adjacency.keys()].filter((nodeName) => shouldCreateIntersection(nodeName, adjacency, networkOptions)),
    );

    const nodeInsetMap = new Map();
    for (const nodeName of adjacency.keys()) {
        nodeInsetMap.set(
            nodeName,
            intersectionNodes.has(nodeName)
                ? computeIntersectionInset(nodeName, adjacency, networkOptions)
                : 0,
        );
    }

    for (const edge of edges) {
        edge.trimmedEndpoints = computeTrimmedEndpoints(
            edge,
            edge.hasExplicitStart ? 0 : (nodeInsetMap.get(edge.startName) ?? 0),
            edge.hasExplicitEnd ? 0 : (nodeInsetMap.get(edge.endName) ?? 0),
            networkOptions.minRoadLength,
        );
    }

    return {
        networkOptions,
        edges,
        adjacency,
        intersectionNodes,
        nodeInsetMap,
        nodes: vectorMap,
    };
}

/**
 * Create Road and Intersection objects from a plan. With `edgeIds` / `nodeIds`
 * only that subset is built; intersections outside the subset are untouched
 * and intersections inside it receive existing Road objects for edges that
 * were not rebuilt (`existingRoads`, keyed by edge id).
 * @param {THREE.Scene|null} scene
 * @param {ReturnType<typeof planRoadNetwork>} plan
 * @param {{ edgeIds?: Iterable<string>|null, nodeIds?: Iterable<string>|null, existingRoads?: Map<string, Road> }} [subset]
 */
export function materializeRoadNetwork(scene, plan, { edgeIds = null, nodeIds = null, existingRoads = new Map() } = {}) {
    const { networkOptions, edges, adjacency, intersectionNodes } = plan;
    const edgeFilter = edgeIds ? new Set([...edgeIds].map(String)) : null;
    const nodeFilter = nodeIds ? new Set([...nodeIds].map(String)) : null;

    const roads = [];
    const roadByEdge = new Map();

    for (const edge of edges) {
        if (edgeFilter && !edgeFilter.has(String(edge.id))) {
            const existing = existingRoads.get(String(edge.id));
            if (existing) {
                edge.road = existing;
                roadByEdge.set(String(edge.id), existing);
            }
            continue;
        }
        const road = createRoadFromEdge(edge, edge.trimmedEndpoints, networkOptions);
        edge.road = road;
        roads.push(road);
        if (edge.id !== null) roadByEdge.set(String(edge.id), road);

        if (scene) {
            road.setup(scene);
        }
    }

    const intersections = [];

    for (const nodeName of intersectionNodes) {
        if (nodeFilter && !nodeFilter.has(String(nodeName))) continue;
        const nodeEdges = adjacency.get(nodeName) ?? [];
        const intersectionRoads = nodeEdges
            .map((edge) => edge.road)
            .filter(Boolean);

        if (intersectionRoads.length < 2) continue;

        const intersection = new Intersection(intersectionRoads, networkOptions.intersectionOptions);
        intersection.networkNodeId = nodeName;
        intersections.push(intersection);

        if (scene) {
            intersection.setup(scene);
        }
    }

    return { roads, intersections, roadByEdge };
}

function indexedGeometry(vertices, indices) {
    const positions = new Float32Array(vertices.length * 3);
    const metric = (value) => Math.round(Number(value) * 1e6) / 1e6;
    vertices.forEach((point, index) => {
        positions[index * 3] = metric(point.x);
        positions[index * 3 + 1] = metric(point.y);
        positions[index * 3 + 2] = metric(point.z);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function stripVertices(left, right) {
    const vertices = [];
    const indices = [];
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) vertices.push(left[index], right[index]);
    for (let index = 0; index < Math.min(left.length, right.length) - 1; index += 1) {
        const offset = index * 2;
        indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
    }
    return { vertices, indices };
}

function truthTriangles(geometry, sourceIndices) {
    const attribute = geometry.getAttribute("position");
    const triangles = [];
    for (let index = 0; index < sourceIndices.length; index += 3) {
        const points = sourceIndices.slice(index, index + 3).map((vertexIndex) => new THREE.Vector3(
            attribute.getX(vertexIndex),
            attribute.getY(vertexIndex),
            attribute.getZ(vertexIndex),
        ));
        const triangle = new Triangle(points[0], points[1], points[2]);
        triangle.setTags(["road"]);
        triangle.visible = false;
        triangles.push(triangle);
    }
    return triangles;
}

function markingMesh(points, type, roadOptions) {
    if (!type || type === Road.BorderType.NONE || points.length < 2) return null;
    const dashed = type === Road.BorderType.DASHED_WHITE || type === Road.BorderType.DASHED_YELLOW;
    const yellow = type === Road.BorderType.SOLID_YELLOW || type === Road.BorderType.DASHED_YELLOW;
    const dashLength = Math.max(0.01, Number(roadOptions.dashLength ?? DEFAULT_ROAD_OPTIONS.dashLength));
    const dashGap = Math.max(0, Number(roadOptions.dashGap ?? DEFAULT_ROAD_OPTIONS.dashGap));
    const cycle = dashLength + dashGap;
    const halfWidth = Math.max(0.005, Number(roadOptions.laneMarkingWidth ?? DEFAULT_ROAD_OPTIONS.laneMarkingWidth) * 0.5);
    const vertices = [];
    const indices = [];
    let distance = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length <= 1e-9) continue;
        const include = !dashed || cycle <= 0 || ((distance + length * 0.5) % cycle) < dashLength;
        distance += length;
        if (!include) continue;
        const nx = -dz / length * halfWidth;
        const nz = dx / length * halfWidth;
        const offset = vertices.length;
        vertices.push(
            { x: start.x + nx, y: start.y, z: start.z + nz },
            { x: start.x - nx, y: start.y, z: start.z - nz },
            { x: end.x + nx, y: end.y, z: end.z + nz },
            { x: end.x - nx, y: end.y, z: end.z - nz },
        );
        indices.push(offset, offset + 2, offset + 1, offset + 1, offset + 2, offset + 3);
    }
    if (!indices.length) return null;
    const mesh = new THREE.Mesh(indexedGeometry(vertices, indices), new THREE.MeshBasicMaterial({
        color: yellow ? (roadOptions.yellowLineColor ?? 0xf0d25c) : (roadOptions.whiteLineColor ?? 0xf3f3ef),
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    }));
    mesh.name = "RoadMarking";
    mesh.renderOrder = 10;
    mesh.userData.bakeIgnore = true;
    return mesh;
}

function addCompiledRoadMarkings(root, entry, roadOptions) {
    const markings = [
        [entry.surface.carriagewayLeft, entry.edge.borderLeft ?? roadOptions.borderLeft],
        [entry.surface.carriagewayRight, entry.edge.borderRight ?? roadOptions.borderRight],
    ];
    for (const divider of laneDividerDescriptors(entry.edge)) {
        const left = entry.surface.laneCenterlines[divider.dividerIndex - 1];
        const right = entry.surface.laneCenterlines[divider.dividerIndex];
        if (!left || !right) continue;
        const count = Math.min(left.length, right.length);
        const points = Array.from({ length: count }, (_, index) => ({
            x: (left[index].x + right[index].x) * 0.5,
            y: (left[index].y + right[index].y) * 0.5,
            z: (left[index].z + right[index].z) * 0.5,
        }));
        markings.push([points, divider.opposing ? roadOptions.centerLineType : roadOptions.oneWayDividerType]);
    }
    for (const [points, type] of markings) {
        const mesh = markingMesh(points, type, roadOptions);
        if (mesh) root.add(mesh);
    }
}

/** Dispose GPU resources owned by one runtime road or intersection. */
export function disposeRoadRuntimeObject(value) {
    value?.root?.traverse?.((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material) => material?.dispose?.());
        else object.material?.dispose?.();
    });
}

function compiledRoadObject(entry, roadOptions) {
    const root = new THREE.Group();
    root.name = "Road";
    root.userData.bakeRoadSurface = true;
    const shoulderGeometry = indexedGeometry(entry.surface.vertices, entry.surface.indices);
    const carriageway = stripVertices(entry.surface.carriagewayLeft, entry.surface.carriagewayRight);
    const roadGeometry = indexedGeometry(carriageway.vertices, carriageway.indices);
    const shoulderMesh = new THREE.Mesh(shoulderGeometry, new THREE.MeshStandardMaterial({
        color: roadOptions.shoulderColor ?? DEFAULT_ROAD_OPTIONS.shoulderColor,
        roughness: roadOptions.shoulderRoughness ?? 1,
        metalness: roadOptions.metalness ?? 0.02,
        side: THREE.DoubleSide,
    }));
    shoulderMesh.name = "RoadShoulder";
    shoulderMesh.receiveShadow = true;
    shoulderMesh.userData.bakeRoadSurface = true;
    root.add(shoulderMesh);
    const roadMesh = new THREE.Mesh(roadGeometry, new THREE.MeshStandardMaterial({
        color: roadOptions.surfaceColor ?? DEFAULT_ROAD_OPTIONS.surfaceColor,
        roughness: roadOptions.surfaceRoughness ?? 0.95,
        metalness: roadOptions.metalness ?? 0.02,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
    }));
    roadMesh.name = "RoadSurface";
    roadMesh.receiveShadow = true;
    roadMesh.userData.bakeRoadSurface = true;
    root.add(roadMesh);
    const lanes = entry.surface.laneCenterlines.map((points) => points.map((point) => new THREE.Vector3(point.x, point.y, point.z)));
    const laneWidth = Number(entry.edge.width ?? 7) / Math.max(1, Number(entry.edge.laneCount ?? lanes.length));
    const laneMeshes = lanes.map((points) => {
        const vectors = points.map((point) => ({ x: point.x, y: point.y, z: point.z }));
        const left = [];
        const right = [];
        for (let index = 0; index < vectors.length; index += 1) {
            const previous = vectors[Math.max(0, index - 1)];
            const next = vectors[Math.min(vectors.length - 1, index + 1)];
            const dx = next.x - previous.x;
            const dz = next.z - previous.z;
            const length = Math.hypot(dx, dz) || 1;
            const amount = Math.max(0.01, laneWidth * 0.45);
            left.push({ x: vectors[index].x + dz / length * amount, y: vectors[index].y, z: vectors[index].z - dx / length * amount });
            right.push({ x: vectors[index].x - dz / length * amount, y: vectors[index].y, z: vectors[index].z + dx / length * amount });
        }
        const strip = stripVertices(left, right);
        const mesh = new THREE.Mesh(indexedGeometry(strip.vertices, strip.indices), new THREE.MeshStandardMaterial({ color: 0x00ff00, opacity: 0.5, transparent: true, side: THREE.DoubleSide }));
        mesh.visible = false;
        root.add(mesh);
        return mesh;
    });
    addCompiledRoadMarkings(root, entry, roadOptions);
    return {
        points: entry.trimmedSamples.points.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
        width: new Unit(Number(entry.edge.width ?? 7), Unit.Type.METER),
        borderLeft: entry.edge.borderLeft ?? roadOptions.borderLeft,
        borderRight: entry.edge.borderRight ?? roadOptions.borderRight,
        options: { ...roadOptions, laneCount: Number(entry.edge.laneCount ?? 2), shoulderWidth: Number(entry.edge.shoulderWidth ?? 0) },
        lanes,
        laneMeshes,
        root,
        roadEdges: {
            left: entry.surface.carriagewayLeft.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
            right: entry.surface.carriagewayRight.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
        },
        oneWay: entry.edge.bidirectional === false,
        direction: entry.edge.bidirectional === false ? Number(entry.edge.direction ?? 1) : 0,
        parent: null,
        triangles: truthTriangles(shoulderGeometry, entry.surface.indices),
        network: { geometryVersion: 2, edgeId: entry.edge.id, startName: entry.edge.startNodeId, endName: entry.edge.endNodeId, bidirectional: entry.edge.bidirectional !== false },
    };
}

function compiledIntersectionObject(junction, roads, roadOptions) {
    const geometry = indexedGeometry(junction.surface.vertices, junction.surface.indices);
    const root = new THREE.Group();
    root.name = "Intersection";
    root.userData.bakeRoadSurface = true;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: roadOptions.surfaceColor ?? DEFAULT_ROAD_OPTIONS.surfaceColor,
        roughness: roadOptions.surfaceRoughness ?? 0.95,
        metalness: roadOptions.metalness ?? 0.02,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
    }));
    mesh.receiveShadow = true;
    mesh.userData.bakeRoadSurface = true;
    root.add(mesh);
    return {
        roads,
        width: roads[0]?.width ?? new Unit(4, Unit.Type.METER),
        options: { ...roadOptions, laneCount: 0 },
        lanes: [],
        laneMeshes: [],
        root,
        roadEdges: junction.surface.vertices.map((point) => ({ center: new THREE.Vector3(point.x, point.y, point.z) })),
        triangles: truthTriangles(geometry, junction.surface.indices),
        networkNodeId: junction.node.id,
        networkGeometryVersion: 2,
    };
}

/** Materialize ED-04 geometry without resampling the compiler output. */
export function materializeCompiledRoadNetwork(scene, plan, { edgeIds = null, nodeIds = null, existingRoads = new Map(), roadOptions = {} } = {}) {
    const edgeFilter = edgeIds ? new Set([...edgeIds].map(String)) : null;
    const nodeFilter = nodeIds ? new Set([...nodeIds].map(String)) : null;
    const roads = [];
    const roadByEdge = new Map();
    for (const entry of plan.edges) {
        if (edgeFilter && !edgeFilter.has(String(entry.edge.id))) {
            const existing = existingRoads.get(String(entry.edge.id));
            if (existing) roadByEdge.set(String(entry.edge.id), existing);
            continue;
        }
        const road = compiledRoadObject(entry, { ...DEFAULT_ROAD_OPTIONS, ...roadOptions });
        roads.push(road);
        roadByEdge.set(String(entry.edge.id), road);
        if (scene) scene.add(road.root);
    }
    const intersections = [];
    for (const junction of plan.junctions) {
        if (nodeFilter && !nodeFilter.has(String(junction.node.id))) continue;
        const incidentRoads = junction.incidents.map((incident) => roadByEdge.get(String(incident.edgeId))).filter(Boolean);
        if (incidentRoads.length < 2) continue;
        const intersection = compiledIntersectionObject(junction, incidentRoads, { ...DEFAULT_ROAD_OPTIONS, ...roadOptions });
        intersections.push(intersection);
        if (scene) scene.add(intersection.root);
    }
    return { roads, intersections, roadByEdge };
}

/**
 * 
 * @param {THREE.Scene} scene 
 * @param {Map<string, THREE.Vector3>} vectorMap A map to store named vectors (e.g. "center", "leftBoundary", etc.) for use in road generation.
 * @param {Array<Array>} connections A list of connections/tuples between roads, where first element is the start vector name, second element is the end vector name, and third is whether the relation is bidirectional (e.g. [["center", "leftBoundary", true], ...])
 * @param {Object} options
 * @returns {{roads: Road[], intersections: Intersection[], graph: {nodes: Map<string, THREE.Vector3>, edges: Array<Object>, adjacency: Map<string, Array<Object>>}}}
 */
export function buildRoadNetwork(scene, vectorMap, connections, options = {}) {
    const plan = planRoadNetwork(vectorMap, connections, options);
    const { roads, intersections } = materializeRoadNetwork(scene, plan);

    return {
        roads,
        intersections,
        graph: {
            nodes: vectorMap,
            edges: plan.edges,
            adjacency: plan.adjacency,
        },
    };
}

export default buildRoadNetwork;
