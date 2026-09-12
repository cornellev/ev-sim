/**
 * Commands over the legacy geometry domains (roads, buildings, features,
 * earth). They wrap the existing `documentMutations` helpers, create object
 * records for entities they add, and drop records for entities they remove so
 * the in-session overlay stays live.
 */

import { createId } from "../document/EnvironmentDocument.js";
import {
    addBuildingRecord,
    addBuildingRectangle,
    addFeature as addFeatureRecord,
    addRoadEdge as addRoadEdgeRecord,
    connectEndpointToIntersection,
    createIntersectionNode,
    getOrCreateEndpointNode,
    getOrCreateNode,
    moveRoadNode as moveRoadNodeRecord,
    removeBuilding as removeBuildingRecord,
    removeFeature as removeFeatureRecord,
    removeIntersectionNode,
    removeRoadEdge,
    setRoadNodeElevation as setRoadNodeElevationRecord,
    setTurnMovementAllowed,
    translateRoadNodes as translateRoadNodesRecord,
    updateRoadEdge as updateRoadEdgeRecord,
} from "../document/documentMutations.js";
import { BUILDING_TYPE_ID } from "../objects/types/building.js";
import { BUILTIN_PROP_TYPE_ID } from "../objects/types/builtinProp.js";
import { ROAD_TYPE_ID } from "../objects/types/road.js";
import { COMMAND_ISSUE_CODES, commandFailure, commandIssue, commandSuccess } from "./commandIssues.js";
import { ensureObjectRecord, removeObjectRecords } from "./objectMutations.js";

function mutationFailure(result, objectId = null) {
    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result?.error ?? "Mutation failed.", { objectId }));
}

// ----------------------------------------------------------------- features

export function addFeature({ id = null, type, x, z, rotationY = 0, dir = 0, tags, name, parentId = null, label = "Add prop" } = {}) {
    return {
        id: "add-feature",
        label,
        run(ctx) {
            const definition = ctx.registry.get(BUILTIN_PROP_TYPE_ID);
            let created;
            try {
                created = definition.create({ id: id ?? createId("feature"), assetId: type, x, z, rotationY, dir, tags, name });
            } catch (error) {
                return commandFailure(error?.issues?.length
                    ? error.issues.map((entry) => commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, entry.message, { path: ["command", ...(entry.path ?? [])] }))
                    : commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, error?.message ?? String(error)));
            }
            const result = addFeatureRecord(ctx.document, created.legacy, { notify: false });
            if (!result.ok) return mutationFailure(result);
            const record = ensureObjectRecord(ctx.document, {
                id: result.record.id,
                typeId: BUILTIN_PROP_TYPE_ID,
                typeVersion: definition.version,
                name: created.name,
                parentId,
            }, { notify: false });
            return commandSuccess({ feature: result.record, objectId: result.record.id, record: record.record });
        },
    };
}

export function removeFeature({ featureId, label = "Remove prop" } = {}) {
    return {
        id: "remove-feature",
        label,
        run(ctx) {
            const result = removeFeatureRecord(ctx.document, featureId, { notify: false });
            if (!result.ok) return mutationFailure(result, String(featureId));
            removeObjectRecords(ctx.document, [featureId], { notify: false });
            return commandSuccess({ removed: String(featureId) });
        },
    };
}

/** Absolute move used by MCP; the editor uses transform plans. */
export function moveFeature({ featureId, x, z, rotationY, label = "Move prop" } = {}) {
    return {
        id: "move-feature",
        label,
        run(ctx) {
            const feature = ctx.document.getFeature(String(featureId));
            if (!feature) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, "Feature not found.", { objectId: String(featureId) }));
            if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "x and z must be finite numbers.", { objectId: String(featureId) }));
            }
            feature.x = Number(x);
            feature.z = Number(z);
            if (rotationY !== undefined && Number.isFinite(Number(rotationY))) feature.rotationY = Number(rotationY);
            ctx.document.featuresAuthored = true;
            return commandSuccess({ feature });
        },
    };
}

// ---------------------------------------------------------------- buildings

export function addBuilding({ cornerA, cornerB, footprint, buildingId, height, textureId, snapSize, tags, meshName, name, parentId = null, label = "Add building" } = {}) {
    return {
        id: "add-building",
        label,
        run(ctx) {
            const result = Array.isArray(footprint)
                ? addBuildingRecord(ctx.document, { buildingId, footprint, height, textureId, tags, meshName }, { notify: false })
                : addBuildingRectangle(ctx.document, cornerA, cornerB, { height, textureId, snapSize, tags, meshName }, { notify: false });
            if (!result.ok) return mutationFailure(result);
            const definition = ctx.registry.get(BUILDING_TYPE_ID);
            const record = ensureObjectRecord(ctx.document, {
                id: result.record.buildingId,
                typeId: BUILDING_TYPE_ID,
                typeVersion: definition.version,
                name: name ?? "Building",
                parentId,
            }, { notify: false });
            return commandSuccess({ building: result.record, objectId: result.record.buildingId, record: record.record });
        },
    };
}

export function removeBuilding({ buildingId, label = "Remove building" } = {}) {
    return {
        id: "remove-building",
        label,
        run(ctx) {
            const result = removeBuildingRecord(ctx.document, buildingId, { notify: false });
            if (!result.ok) return mutationFailure(result, String(buildingId));
            removeObjectRecords(ctx.document, [buildingId], { notify: false });
            return commandSuccess({ removed: String(buildingId) });
        },
    };
}

// -------------------------------------------------------------------- roads

/** Polyline road: nodes snap to existing nodes within `snapRadius`. */
export function addRoad({ points = [], width, laneCount, bidirectional, snapRadius = 2, parentId = null, label = "Add road" } = {}) {
    return {
        id: "add-road",
        label,
        run(ctx) {
            if (!Array.isArray(points) || points.length < 2) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "A road needs at least two points."));
            }
            const document = ctx.document;
            const createdNodes = [];
            const createdEdges = [];
            const errors = [];
            const nodeIds = points.map((point) => {
                const before = new Set(document.roads.nodes.map((node) => node.id));
                const node = getOrCreateNode(document, point, snapRadius);
                if (!before.has(node.id)) createdNodes.push(node);
                return node.id;
            });
            for (let index = 0; index < nodeIds.length - 1; index += 1) {
                const result = addRoadEdgeRecord(document, nodeIds[index], nodeIds[index + 1], { width, laneCount, bidirectional }, { notify: false });
                if (!result.ok) {
                    errors.push(result.error);
                    continue;
                }
                createdEdges.push(result.edge);
            }
            if (createdEdges.length === 0) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, errors[0] ?? "No road edges were created."), { errors });
            }
            const definition = ctx.registry.get(ROAD_TYPE_ID);
            for (const edge of createdEdges) {
                ensureObjectRecord(document, { id: edge.id, typeId: ROAD_TYPE_ID, typeVersion: definition.version, name: "Road", parentId }, { notify: false });
            }
            return commandSuccess({ createdNodes, createdEdges, errors });
        },
    };
}

export function addRoadEdge({ startNodeId, endNodeId, options = {}, parentId = null, label = "Add road" } = {}) {
    return {
        id: "add-road-edge",
        label,
        run(ctx) {
            const result = addRoadEdgeRecord(ctx.document, startNodeId, endNodeId, options, { notify: false });
            if (!result.ok) return mutationFailure(result);
            const definition = ctx.registry.get(ROAD_TYPE_ID);
            ensureObjectRecord(ctx.document, { id: result.edge.id, typeId: ROAD_TYPE_ID, typeVersion: definition.version, name: "Road", parentId }, { notify: false });
            return commandSuccess({ edge: result.edge, objectId: result.edge.id });
        },
    };
}

export function updateRoadEdge({ edgeId, patch = {}, label = "Edit road" } = {}) {
    return {
        id: "update-road-edge",
        label,
        run(ctx) {
            const result = updateRoadEdgeRecord(ctx.document, edgeId, patch, { notify: false });
            if (!result.ok) return mutationFailure(result, String(edgeId));
            return commandSuccess({ edge: result.edge });
        },
    };
}

export function removeRoad({ edgeId, label = "Remove road" } = {}) {
    return {
        id: "remove-road",
        label,
        run(ctx) {
            const result = removeRoadEdge(ctx.document, edgeId, { notify: false });
            if (!result.ok) return mutationFailure(result, String(edgeId));
            removeObjectRecords(ctx.document, [edgeId], { notify: false });
            return commandSuccess({ removed: String(edgeId) });
        },
    };
}

export function removeIntersection({ nodeId, label = "Remove intersection" } = {}) {
    return {
        id: "remove-intersection",
        label,
        run(ctx) {
            const result = removeIntersectionNode(ctx.document, nodeId, { notify: false });
            if (!result.ok) return mutationFailure(result, String(nodeId));
            removeObjectRecords(ctx.document, [nodeId], { notify: false });
            return commandSuccess({ removed: String(nodeId), removedEdges: result.removedEdges });
        },
    };
}

export function createIntersection({ point, label = "Add intersection" } = {}) {
    return {
        id: "create-intersection",
        label,
        run(ctx) {
            if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.z))) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "Intersection point must have finite x and z."));
            }
            const node = createIntersectionNode(ctx.document, point, { notify: false });
            return commandSuccess({ node, objectId: node.id });
        },
    };
}

/** Create (or reuse within `snapRadius`) a free endpoint node for the road pen. */
export function createEndpointNode({ point, snapRadius = 0, label = "Add road node" } = {}) {
    return {
        id: "create-endpoint-node",
        label,
        run(ctx) {
            if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.z))) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "Node point must have finite x and z."));
            }
            const node = getOrCreateEndpointNode(ctx.document, point, snapRadius);
            ctx.document.roadsAuthored = true;
            return commandSuccess({ node });
        },
    };
}

export function setRoadNodeElevation({ nodeId, y, label = "Set elevation" } = {}) {
    return {
        id: "set-road-node-elevation",
        label,
        run(ctx) {
            const result = setRoadNodeElevationRecord(ctx.document, nodeId, y, { notify: false });
            if (!result.ok) return mutationFailure(result, String(nodeId));
            return commandSuccess({ node: result.node });
        },
    };
}

/**
 * Map-pen node move: free endpoints may snap to and merge into a nearby
 * intersection (`connect`), otherwise the node moves with the legacy
 * free-endpoint rule. Junction moves go through `translateRoadNodes`.
 */
export function moveRoadNode({ nodeId, point, snapRadius = 0, connect = false, label = "Move road node" } = {}) {
    return {
        id: "move-road-node",
        label,
        run(ctx) {
            if (connect && snapRadius > 0) {
                const connected = connectEndpointToIntersection(ctx.document, nodeId, point, snapRadius, { notify: false });
                if (!connected.ok) return mutationFailure(connected, String(nodeId));
                if (connected.connected) {
                    removeObjectRecords(ctx.document, [nodeId], { notify: false });
                    return commandSuccess({ connected: true, intersection: connected.intersection, edge: connected.edge });
                }
            }
            const result = moveRoadNodeRecord(ctx.document, nodeId, point, { snapRadius, notify: false });
            if (!result.ok) return mutationFailure(result, String(nodeId));
            return commandSuccess({ connected: false, node: result.node });
        },
    };
}

export function translateRoadNodes({ positions, label = "Move road nodes" } = {}) {
    return {
        id: "translate-road-nodes",
        label,
        run(ctx) {
            const result = translateRoadNodesRecord(ctx.document, positions, { notify: false });
            if (!result.ok) return mutationFailure(result);
            return commandSuccess({ nodeIds: result.nodeIds, edgeIds: result.edgeIds });
        },
    };
}

export function connectEndpoint({ endpointId, point, snapRadius, label = "Connect road" } = {}) {
    return {
        id: "connect-endpoint",
        label,
        run(ctx) {
            const result = connectEndpointToIntersection(ctx.document, endpointId, point, snapRadius, { notify: false });
            if (!result.ok) return mutationFailure(result, String(endpointId));
            if (result.connected) removeObjectRecords(ctx.document, [endpointId], { notify: false });
            return commandSuccess({ connected: result.connected === true, intersection: result.intersection ?? null, edge: result.edge ?? null });
        },
    };
}

export function setTurnRule({ nodeId, fromEdgeId, toEdgeId, allowed, label = "Set turn rule" } = {}) {
    return {
        id: "set-turn-rule",
        label,
        run(ctx) {
            const result = setTurnMovementAllowed(ctx.document, nodeId, fromEdgeId, toEdgeId, allowed, { notify: false });
            if (!result.ok) return mutationFailure(result, String(nodeId));
            return commandSuccess({ defaultAllowed: result.defaultAllowed, overridden: result.overridden });
        },
    };
}

// -------------------------------------------------------------------- earth

export function setEarthSource({ source, label = "Set Earth source" } = {}) {
    return {
        id: "set-earth-source",
        label,
        run(ctx) {
            if (!source || typeof source !== "object") {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "An earth source object is required."));
            }
            ctx.document.setEarthSource(source);
            return commandSuccess({ earth: ctx.document.snapshot().earth });
        },
    };
}

export function clearEarthSource({ label = "Clear Earth source" } = {}) {
    return {
        id: "clear-earth-source",
        label,
        run(ctx) {
            ctx.document.clearEarthSource();
            return commandSuccess({ earth: null });
        },
    };
}
