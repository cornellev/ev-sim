import * as THREE from "three";
import { readObjectTransform } from "../objects/objectGraph.js";
import { objectTypeRegistry } from "../objects/ObjectTypeRegistry.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { EDITOR_TOOLS } from "../EditorState.js";
import { descendantIds, indexObjectsById } from "../commands/objectMutations.js";
import { GROUP_TYPE_ID } from "../objects/types/group.js";
import { entityIdForObject, entityIdForSub } from "../selection/selectionIds.js";

const TRANSFORM_CONTROL_LOCK = "environment-transform-controls";

const TOOL_MODES = Object.freeze({
    [EDITOR_TOOLS.TRANSLATE]: "translate",
    [EDITOR_TOOLS.ROTATE]: "rotate",
    [EDITOR_TOOLS.SCALE]: "scale",
});

const GROUND_TYPES = new Set(["builtin-prop", "building"]);
const ROAD_TYPES = new Set(["road", "intersection"]);

/**
 * Resolve what a selection transforms: the sub-object handle alone when a
 * sub-selection is set, otherwise every selected record (groups expand to
 * their descendants) that has a runtime entity. Pure over the registry and
 * document; exported for tests.
 */
export function resolveTransformTargets({ selectionSnapshot, document, registry }) {
    const empty = { objectIds: [], sub: null, object3Ds: [], typeIds: new Set(), hasGroup: false };
    if (!selectionSnapshot || !document || !registry) return empty;
    if (selectionSnapshot.sub) {
        const entity = registry.getEntity(entityIdForSub(selectionSnapshot.sub));
        return {
            objectIds: [],
            sub: { ...selectionSnapshot.sub },
            object3Ds: entity?.object3D ? [entity.object3D] : [],
            typeIds: new Set(["road-node"]),
            hasGroup: false,
        };
    }
    const byId = indexObjectsById(document.objects);
    const object3Ds = [];
    const typeIds = new Set();
    let hasGroup = false;
    const visit = (id) => {
        const record = byId.get(String(id));
        if (!record) return;
        if (record.typeId === GROUP_TYPE_ID) {
            hasGroup = true;
            for (const child of descendantIds(byId, record.id)) visit(child);
            return;
        }
        typeIds.add(record.typeId);
        const entityId = entityIdForObject(record, registry);
        const entity = entityId ? registry.getEntity(entityId) : null;
        if (entity?.object3D) object3Ds.push(entity.object3D);
    };
    for (const id of selectionSnapshot.ids ?? []) visit(id);
    return { objectIds: [...(selectionSnapshot.ids ?? [])], sub: null, object3Ds, typeIds, hasGroup };
}

/**
 * Axis gating per selection kind. Props: planar translate, yaw, no scale.
 * Buildings: planar translate, yaw, scale (per-axis alone, uniform in groups).
 * Roads and nodes: translate XYZ, yaw, uniform scale. Mixed and groups: the
 * most restrictive combination.
 */
export function resolveGizmoPolicy(targets, mode) {
    const types = targets.typeIds;
    const hasProps = types.has("builtin-prop");
    const hasBuildings = types.has("building");
    const hasRoads = [...types].some((typeId) => ROAD_TYPES.has(typeId) || typeId === "road-node");
    const onlyRoads = hasRoads && !hasProps && !hasBuildings;
    const multi = targets.hasGroup || (targets.objectIds?.length ?? 0) > 1;
    if (mode === "scale") {
        if (hasProps) return { supported: false, reason: "Props cannot be scaled." };
        const uniformOnly = multi || hasRoads;
        return { supported: true, showX: !uniformOnly, showY: !uniformOnly, showZ: !uniformOnly, uniformOnly };
    }
    if (mode === "rotate") {
        return { supported: true, showX: false, showY: true, showZ: false, uniformOnly: false };
    }
    // translate
    const planar = hasProps || hasBuildings;
    return { supported: true, showX: true, showY: !planar || onlyRoads, showZ: true, uniformOnly: false };
}

export class TransformTool {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.editor = data.editor();
        this.registry = data.environment().objects();
        this.document = data.environment().getDocument();
        this.selection = data.selection?.() ?? data.environment().selection?.();
        this.bus = data.commands?.() ?? data.environment().commands?.();
        this.gestureId = null;
        this.gestureCancelled = false;
        this.pivotStart = new THREE.Matrix4();
        this.lastIssues = [];
        this.targets = resolveTransformTargets({ selectionSnapshot: null, document: this.document, registry: this.registry });

        this.pivot = new THREE.Group();
        this.pivot.name = "EnvironmentTransformPivot";
        this.pivot.userData.skipEnvironmentSelection = true;
        this.pivot.visible = false;
        scene.add(this.pivot);

        this.controls = new TransformControls(camera, renderer.domElement);
        this.helper = this.controls.getHelper?.() ?? this.controls;
        this.helper.userData.skipEnvironmentSelection = true;
        this.helper.visible = false;
        scene.add(this.helper);

        this.onObjectChange = () => {
            if (!this.gestureId || this.gestureCancelled) return;
            this.pivot.updateMatrixWorld(true);
            const delta = this.pivot.matrixWorld.clone().multiply(this.pivotStart.clone().invert());
            const result = this.bus.updateGesture(this.gestureId, { matrix: [...delta.elements] });
            this.lastIssues = result.ok ? [] : result.issues;
            this.data.simulation()?.render?.();
        };

        this.onDraggingChanged = (event) => {
            if (event.value) this.beginDrag();
            else this.endDrag();
            this.data.simulation()?.render?.();
        };

        this.controls.addEventListener("objectChange", this.onObjectChange);
        this.controls.addEventListener("dragging-changed", this.onDraggingChanged);
        this.disposeEditor = this.editor.subscribe(() => this.sync());
        this.disposeSelection = this.selection?.subscribe?.(() => this.sync()) ?? null;
        this.disposeDocument = this.document.subscribe((snapshot, event) => {
            if (event?.transient) return;
            this.sync();
        });
        this.disposeBus = this.bus?.subscribe?.((snapshot) => {
            if (this.gestureId && snapshot.activeGesture?.id !== this.gestureId) {
                // Cancelled or committed elsewhere (Escape, another command).
                this.gestureCancelled = true;
            }
        }) ?? null;
    }

    get isDragging() {
        return this.gestureId !== null;
    }

    beginDrag() {
        this.data.settings()?.disableControls?.(TRANSFORM_CONTROL_LOCK);
        const mode = TOOL_MODES[this.editor.snapshot().activeTool];
        const label = mode === "rotate" ? "Rotate" : mode === "scale" ? "Scale" : "Move";
        const begun = this.bus.beginGesture({ objectIds: this.targets.objectIds, sub: this.targets.sub, label });
        if (!begun.ok) {
            this.gestureId = null;
            this.gestureCancelled = true;
            this.lastIssues = begun.issues;
            console.warn("[environment] transform rejected:", begun.issues.map((issue) => issue.message).join("; "));
            return;
        }
        this.gestureId = begun.gestureId;
        this.gestureCancelled = false;
        this.lastIssues = [];
        this.pivot.updateMatrixWorld(true);
        this.pivotStart.copy(this.pivot.matrixWorld);
    }

    endDrag() {
        this.data.settings()?.enableControls?.(TRANSFORM_CONTROL_LOCK);
        this.selection?.suppress?.(300);
        const gestureId = this.gestureId;
        this.gestureId = null;
        if (gestureId && !this.gestureCancelled && this.bus.activeGesture?.id === gestureId) {
            const committed = this.bus.commitGesture(gestureId);
            if (!committed.ok) this.lastIssues = committed.issues;
        }
        this.gestureCancelled = false;
        this.sync();
    }

    /** Escape during a drag: restore the pristine records and ignore the rest of the drag. */
    cancelActiveGesture() {
        const gestureId = this.gestureId;
        if (gestureId && this.bus.activeGesture?.id === gestureId) {
            this.bus.cancelGesture(gestureId);
        }
        if (!gestureId) return false;
        this.gestureCancelled = true;
        this.gestureId = null;
        this.sync();
        return true;
    }

    detach() {
        this.controls.detach();
        this.helper.visible = false;
        this.pivot.visible = false;
    }

    sync() {
        if (this.gestureId) return; // never move the pivot mid-drag
        const snapshot = this.editor.snapshot();
        const mode = TOOL_MODES[snapshot.activeTool];
        this.targets = resolveTransformTargets({
            selectionSnapshot: this.selection?.snapshot?.() ?? null,
            document: this.document,
            registry: this.registry,
        });
        if (!mode || this.targets.object3Ds.length === 0) {
            this.detach();
            this.data.simulation()?.render?.();
            return;
        }
        const policy = resolveGizmoPolicy(this.targets, mode);
        if (!policy.supported) {
            this.detach();
            this.data.simulation()?.render?.();
            return;
        }
        this.controls.setMode(mode);
        this.controls.showX = policy.showX;
        this.controls.showY = policy.showY;
        this.controls.showZ = policy.showZ;
        // ED-03 view options: local axes follow the primary object's yaw for a
        // single selection (multi-selections stay in world space); snapping
        // applies per mode.
        const local = snapshot.transformSpace === "local" && this.targets.objectIds.length === 1 && !this.targets.sub;
        this.controls.setSpace(local ? "local" : "world");
        const snap = snapshot.transformSnap ?? {};
        this.controls.setTranslationSnap(snap.enabled ? snap.translation : null);
        this.controls.setRotationSnap(snap.enabled ? THREE.MathUtils.degToRad(snap.rotationDeg) : null);
        this.controls.setScaleSnap(snap.enabled ? snap.scale : null);
        positionPivotAtCenter(this.pivot, this.targets.object3Ds);
        if (local) {
            const record = this.document.getObject(this.targets.objectIds[0]);
            const transform = record ? readObjectTransform(record, this.document, objectTypeRegistry) : null;
            if (Number.isFinite(transform?.rotationY)) this.pivot.rotation.set(0, transform.rotationY, 0);
        }
        this.pivot.visible = true;
        this.pivot.updateMatrixWorld(true);
        this.controls.attach(this.pivot);
        this.helper.visible = true;
        this.data.simulation()?.render?.();
    }

    dispose() {
        this.disposeEditor?.();
        this.disposeSelection?.();
        this.disposeDocument?.();
        this.disposeBus?.();
        this.controls.removeEventListener("objectChange", this.onObjectChange);
        this.controls.removeEventListener("dragging-changed", this.onDraggingChanged);
        this.controls.detach();
        this.helper.parent?.remove?.(this.helper);
        this.pivot.parent?.remove?.(this.pivot);
        this.controls.dispose?.();
    }
}

export function unionBounds(object3Ds) {
    const box = new THREE.Box3();
    for (const object3D of object3Ds) {
        object3D.updateMatrixWorld(true);
        const objectBox = new THREE.Box3().setFromObject(object3D);
        if (objectBox.isEmpty()) {
            const position = new THREE.Vector3();
            object3D.getWorldPosition(position);
            objectBox.setFromCenterAndSize(position, new THREE.Vector3(0.001, 0.001, 0.001));
        }
        box.union(objectBox);
    }
    return box;
}

function positionPivotAtCenter(pivot, object3Ds) {
    const box = unionBounds(object3Ds);
    const center = new THREE.Vector3();
    if (!box.isEmpty()) box.getCenter(center);
    pivot.position.copy(center);
    pivot.rotation.set(0, 0, 0);
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
}
