import * as THREE from "three";
import { EDITOR_TOOLS } from "../EditorState.js";
import { getCanvasPointer, isOverlayEvent } from "../editorPointerUtils.js";
import { objectIdForEntity, subForEntity } from "../selection/selectionIds.js";

const POINTER_DRAG_THRESHOLD_PX = 5;
const POINTER_DRAG_THRESHOLD_SQ = POINTER_DRAG_THRESHOLD_PX * POINTER_DRAG_THRESHOLD_PX;

export function getPickableObjectRoots(registry, { layers } = {}) {
    if (!registry) return [];

    return registry.listEntities()
        .filter((entity) => entity.visible !== false && entity.hidden !== true)
        .filter((entity) => !layers || layers[entity.layer] !== false)
        .map((entity) => registry.getEntity(entity.id)?.object3D)
        .filter((object3D) => object3D?.visible !== false);
}

export function isPointerDrag(start, end, thresholdSq = POINTER_DRAG_THRESHOLD_SQ) {
    if (!start || !end) return false;

    const dx = end.clientX - start.clientX;
    const dy = end.clientY - start.clientY;
    return (dx * dx) + (dy * dy) > thresholdSq;
}

export function pickEnvironmentEntity({
    clientX,
    clientY,
    camera,
    renderer,
    registry,
    layers,
}) {
    if (!camera || !renderer?.domElement || !registry) {
        return null;
    }

    const pointer = getCanvasPointer(clientX, clientY, renderer);
    if (!pointer) return null;

    const pickableRoots = getPickableObjectRoots(registry, { layers });
    if (pickableRoots.length === 0) return null;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(pickableRoots, true);

    for (const hit of intersects) {
        const entity = registry.findEntityFromObject3D(hit.object);
        if (entity?.visible !== false && entity?.hidden !== true) {
            return entity;
        }
    }

    return null;
}

/** Additive selection modifier: Shift, Cmd, or Ctrl. */
export function isAdditiveSelectionEvent(event) {
    return Boolean(event?.shiftKey || event?.metaKey || event?.ctrlKey);
}

/**
 * Translate a picked runtime entity into a selection change. Road-node
 * handles select their incident edge with the node as sub-selection so the
 * gizmo can move the endpoint alone. Exported for tests.
 */
export function applyPickToSelection({ selection, document, entity, additive = false, activeTool = EDITOR_TOOLS.SELECT }) {
    if (!selection) return;
    if (!entity) {
        if (activeTool === EDITOR_TOOLS.SELECT && !additive) selection.clear();
        return;
    }
    const sub = subForEntity(entity);
    if (sub) {
        const edge = document?.roads?.edges?.find((candidate) => candidate.startNodeId === sub.id || candidate.endNodeId === sub.id) ?? null;
        selection.select(edge ? [edge.id] : [], { mode: "replace", sub });
        return;
    }
    const objectId = objectIdForEntity(entity);
    if (!objectId) return;
    selection.select(objectId, { mode: additive ? "toggle" : "replace" });
}

export class SelectTool {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.registry = data.environment().objects();
        this.editor = data.editor();
        this.selection = data.selection?.() ?? data.environment().selection?.() ?? null;
        this.pointerDown = null;
        this.disposeDown = data.mouse()?.registerDown?.((event) => this.handlePointerDown(event));
        this.disposeUp = data.mouse()?.registerUp?.((event) => this.handlePointerUp(event));
    }

    handlePointerDown(event) {
        if (event.button !== 0 || isOverlayEvent(event)) return;

        this.pointerDown = {
            button: event.button,
            clientX: event.clientX,
            clientY: event.clientY,
            target: event.target,
        };
    }

    handlePointerUp(event) {
        const pointerDown = this.pointerDown;
        this.pointerDown = null;

        if (event.button !== 0 || !pointerDown || pointerDown.button !== 0) return;
        if (this.selection?.isSuppressed?.()) return;
        if (isOverlayEvent(event)) return;
        if (isPointerDrag(pointerDown, event)) return;

        const { activeTool, layers } = this.editor.snapshot();

        const selectableTools = new Set([
            EDITOR_TOOLS.SELECT,
            EDITOR_TOOLS.TRANSLATE,
            EDITOR_TOOLS.ROTATE,
            EDITOR_TOOLS.SCALE,
        ]);

        if (!selectableTools.has(activeTool)) return;

        const entity = pickEnvironmentEntity({
            clientX: pointerDown.clientX,
            clientY: pointerDown.clientY,
            camera: this.camera,
            renderer: this.renderer,
            registry: this.registry,
            layers,
        });

        applyPickToSelection({
            selection: this.selection,
            document: this.data.environment().getDocument(),
            entity,
            additive: isAdditiveSelectionEvent(event),
            activeTool,
        });

        this.data.simulation()?.render?.();
    }

    dispose() {
        this.disposeDown?.();
        this.disposeUp?.();
    }
}
