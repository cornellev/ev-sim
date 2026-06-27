import { generateBuildings } from "../../city/BuildingGenerator.js";
import { placeFusionObjectInScene } from "../placement/placeFusionObject.js";
import {
    addBuildingRectangle,
    addFeature,
    addRoadEdge,
    computeArmPoint,
    connectEndpointToIntersection,
    createIntersectionNode,
    findNearestIntersection,
    getDocumentNode,
    getOrCreateEndpointNode,
    isIntersectionNode,
    moveFeature,
    moveRoadNode,
    snapPoint,
} from "../document/documentMutations.js";
import { syncRoadsFromDocument } from "../document/DocumentSync.js";
import { upsertBakeBuildingRecord } from "./bakeBuildingSync.js";
import { MAP_TOOLS } from "../EditorState.js";
import { deleteMapSelectionFromRuntime, syncFeaturePosition } from "./mapRuntimeSync.js";
import { MAP_WORLD_SCALE, screenRadiusToWorld } from "./mapCoords.js";

const SNAP_RADIUS_SCREEN = 12;

export { SNAP_RADIUS_SCREEN };

/**
 * @param {{ x: number, z: number }} worldPoint
 * @param {import("../EditorState.js").EditorState} editor
 */
export function applySnap(worldPoint, editor) {
    const map = editor.snapshot().map;
    if (!map.snapEnabled) return worldPoint;
    return snapPoint(worldPoint, map.snapSize);
}

function resolveRoadNode(document, point, snapRadius) {
    const intersection = findNearestIntersection(point, document, snapRadius);
    if (intersection) return intersection;
    return getOrCreateEndpointNode(document, point, snapRadius);
}

function buildEdgeArms(document, startNode, endNode) {
    const options = {};

    if (isIntersectionNode(document, startNode)) {
        options.startArm = computeArmPoint(startNode, endNode);
    }

    if (isIntersectionNode(document, endNode)) {
        options.endArm = computeArmPoint(endNode, startNode);
    }

    return options;
}

/**
 * Road pen: handle click at world point.
 */
export function handleRoadPenClick({
    worldPoint,
    document,
    editor,
    data,
    scene,
    size,
}) {
    const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
    const snapped = applySnap(worldPoint, editor);
    const draft = editor.snapshot().map.draft;
    const node = resolveRoadNode(document, snapped, snapRadius);

    if (!draft?.type || draft.type !== "road-pen") {
        editor.setMapDraft({
            type: "road-pen",
            activeNodeId: node.id,
            cursor: { x: snapped.x, z: snapped.z },
        });
        document.notify();
        return { node };
    }

    if (draft.activeNodeId === node.id) {
        return { node };
    }

    const startNode = getDocumentNode(document, draft.activeNodeId);
    const edgeOptions = buildEdgeArms(document, startNode, node);
    const result = addRoadEdge(document, draft.activeNodeId, node.id, edgeOptions);
    if (!result.ok) {
        return { error: result.error, node };
    }

    editor.markDirty(true);
    syncRoadsFromDocument(data, scene, document);
    data.environment().objects().registerExistingContent(scene, data);
    data.simulation()?.render?.();

    editor.setMapDraft({
        type: "road-pen",
        activeNodeId: node.id,
        cursor: { x: snapped.x, z: snapped.z },
    });

    return { edge: result.edge, node };
}

export function handleIntersectionPlace({ worldPoint, document, editor }) {
    const snapped = applySnap(worldPoint, editor);
    const snapRadius = 2;
    const existing = findNearestIntersection(snapped, document, snapRadius);
    if (existing) return { node: existing, reused: true };

    const node = createIntersectionNode(document, snapped);
    editor.selectEntity(null);
    return { node, reused: false };
}

export function handleEndpointMove({
    document,
    editor,
    data,
    scene,
    nodeId,
    worldPoint,
    finalize = false,
}) {
    const snapped = applySnap(worldPoint, editor);
    const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);

    if (finalize) {
        const result = connectEndpointToIntersection(document, nodeId, snapped, snapRadius);
        if (!result.ok) return result;
        if (!result.connected) {
            return { ok: true, node: getDocumentNode(document, nodeId) };
        }

        editor.markDirty(true);
        syncRoadsFromDocument(data, scene, document);
        data.environment().objects().registerExistingContent(scene, data);
        data.simulation()?.render?.();
        return { ok: true, connected: true, intersection: result.intersection };
    }

    const result = moveRoadNode(document, nodeId, snapped, { snapRadius });
    if (!result.ok) return result;

    editor.markDirty(true);
    syncRoadsFromDocument(data, scene, document);
    data.environment().objects().registerExistingContent(scene, data);
    data.simulation()?.render?.();
    return result;
}

export function handleFeatureMove({ document, editor, data, featureId, worldPoint }) {
    const snapped = applySnap(worldPoint, editor);
    const result = moveFeature(document, featureId, snapped);
    if (!result.ok) return result;

    syncFeaturePosition(data, result.feature);
    editor.markDirty(true);
    data.simulation()?.render?.();
    return result;
}

export function handleMapDelete({ document, editor, data, scene, selection }) {
    const result = deleteMapSelectionFromRuntime(data, scene, document, selection);
    if (!result.ok) return result;

    editor.clearMapSelection();
    editor.markDirty(true);
    data.simulation()?.render?.();
    return result;
}

export function cancelRoadPen(editor) {
    editor.clearMapDraft();
}

export function finalizeRoadPen(editor) {
    editor.clearMapDraft();
}

export function handleBuildingRectDown({ worldPoint, editor }) {
    const snapped = applySnap(worldPoint, editor);
    editor.setMapDraft({
        type: "building-rect",
        cornerA: { x: snapped.x, z: snapped.z },
        cornerB: { x: snapped.x, z: snapped.z },
    });
}

export function handleBuildingRectMove({ worldPoint, editor }) {
    const draft = editor.snapshot().map.draft;
    if (draft?.type !== "building-rect" || !draft.cornerA) return;
    const snapped = applySnap(worldPoint, editor);
    editor.setMapDraft({
        ...draft,
        cornerB: { x: snapped.x, z: snapped.z },
    });
}

export function handleBuildingRectUp({ document, editor, data, scene }) {
    const draft = editor.snapshot().map.draft;
    if (draft?.type !== "building-rect" || !draft.cornerA || !draft.cornerB) {
        editor.clearMapDraft();
        return null;
    }

    const snapSize = editor.snapshot().map.snapEnabled ? editor.snapshot().map.snapSize : 0;
    const result = addBuildingRectangle(
        document,
        draft.cornerA,
        draft.cornerB,
        { snapSize },
    );

    editor.clearMapDraft();

    if (!result.ok) {
        return { error: result.error };
    }

    editor.markDirty(true);

    upsertBakeBuildingRecord(data, result.record);

    generateBuildings(scene, data, { records: [result.record] });
    data.environment().objects().registerExistingContent(scene, data);

    return { record: result.record };
}

export function handleFeaturePlace({
    worldPoint,
    document,
    editor,
    data,
    scene,
}) {
    const featureType = editor.snapshot().map.activeFeatureType;
    if (!featureType) return null;

    const snapped = applySnap(worldPoint, editor);
    const registry = data.environment().objects();

    const { entity, object } = placeFusionObjectInScene({
        data,
        scene,
        registry,
        assetId: featureType,
        point: { x: snapped.x, y: 0, z: snapped.z },
    });

    const result = addFeature(document, {
        id: object._uuid,
        type: featureType,
        x: snapped.x,
        z: snapped.z,
        dir: object.dir ?? 0,
    });

    if (!result.ok) return null;

    editor.markDirty(true);
    if (entity) editor.selectEntity(entity);
    data.simulation()?.render?.();

    return { record: result.record, entity };
}

export function panViewport(editor, deltaX, deltaY) {
    const map = editor.snapshot().map;
    const scale = map.zoom * MAP_WORLD_SCALE;
    editor.setMapViewport({
        centerX: map.centerX - deltaX / scale,
        centerZ: map.centerZ - deltaY / scale,
    });
}

export function zoomViewport(editor, screen, size, delta) {
    const map = editor.snapshot().map;
    const factor = delta > 0 ? 1.1 : 0.9;
    const nextZoom = Math.min(8, Math.max(0.25, map.zoom * factor));
    if (nextZoom === map.zoom) return;

    const scale = map.zoom * MAP_WORLD_SCALE;
    const worldX = map.centerX + (screen.x - size.width / 2) / scale;
    const worldZ = map.centerZ + (screen.y - size.height / 2) / scale;

    const nextScale = nextZoom * MAP_WORLD_SCALE;
    editor.setMapViewport({
        zoom: nextZoom,
        centerX: worldX - (screen.x - size.width / 2) / nextScale,
        centerZ: worldZ - (screen.y - size.height / 2) / nextScale,
    });
}

export function shouldPanOnPointer(activeMapTool) {
    return activeMapTool === MAP_TOOLS.PAN || activeMapTool === MAP_TOOLS.SELECT;
}

export function shouldPanImmediately(activeMapTool, altKey) {
    return activeMapTool === MAP_TOOLS.PAN || altKey;
}
