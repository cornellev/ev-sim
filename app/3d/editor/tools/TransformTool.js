import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { EDITOR_TOOLS } from "../EditorState.js";

const TRANSFORM_CONTROL_LOCK = "environment-transform-controls";

const TOOL_MODES = Object.freeze({
    [EDITOR_TOOLS.TRANSLATE]: "translate",
    [EDITOR_TOOLS.ROTATE]: "rotate",
    [EDITOR_TOOLS.SCALE]: "scale",
});

export class TransformTool {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.editor = data.editor();
        this.registry = data.environment().objects();
        this.selectedEntityId = null;
        this.previousPivotMatrixWorld = new THREE.Matrix4();

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
            if (!this.selectedEntityId) return;
            const entity = this.registry.getEntity(this.selectedEntityId);
            if (!entity?.object3D) return;

            this.pivot.updateMatrixWorld(true);
            const currentPivotMatrixWorld = this.pivot.matrixWorld.clone();
            const delta = currentPivotMatrixWorld.clone()
                .multiply(this.previousPivotMatrixWorld.clone().invert());

            applyWorldDelta(entity.object3D, delta);
            this.previousPivotMatrixWorld.copy(currentPivotMatrixWorld);
            this.registry.updateEntityTransform(this.selectedEntityId);
            this.editor.markDirty(true, false);
            this.data.simulation()?.render?.();
        };

        this.onDraggingChanged = (event) => {
            if (event.value) {
                this.data.settings()?.disableControls?.(TRANSFORM_CONTROL_LOCK);
            } else {
                this.editor.suppressSelection?.(300);
                this.data.settings()?.enableControls?.(TRANSFORM_CONTROL_LOCK);
            }
            this.data.simulation()?.render?.();
        };

        this.controls.addEventListener("objectChange", this.onObjectChange);
        this.controls.addEventListener("dragging-changed", this.onDraggingChanged);
        this.disposeEditor = this.editor.subscribe((snapshot) => this.sync(snapshot));
    }

    sync(snapshot) {
        const mode = TOOL_MODES[snapshot.activeTool];
        const selectedId = snapshot.selection?.id ?? null;
        const entity = selectedId ? this.registry.getEntity(selectedId) : null;

        if (!mode || !entity?.object3D) {
            this.selectedEntityId = null;
            this.controls.detach();
            this.helper.visible = false;
            this.pivot.visible = false;
            this.data.simulation()?.render?.();
            return;
        }

        this.selectedEntityId = entity.id;
        this.controls.setMode(mode);
        positionPivotAtObjectCenter(this.pivot, entity.object3D);
        this.pivot.visible = true;
        this.pivot.updateMatrixWorld(true);
        this.previousPivotMatrixWorld.copy(this.pivot.matrixWorld);
        this.controls.attach(this.pivot);
        this.helper.visible = true;
        this.data.simulation()?.render?.();
    }

    dispose() {
        this.disposeEditor?.();
        this.controls.removeEventListener("objectChange", this.onObjectChange);
        this.controls.removeEventListener("dragging-changed", this.onDraggingChanged);
        this.controls.detach();
        this.helper.parent?.remove?.(this.helper);
        this.pivot.parent?.remove?.(this.pivot);
        this.controls.dispose?.();
    }
}

function getObjectCenter(object3D) {
    const box = new THREE.Box3().setFromObject(object3D);
    const center = new THREE.Vector3();

    if (box.isEmpty()) {
        object3D.getWorldPosition(center);
    } else {
        box.getCenter(center);
    }

    return center;
}

function positionPivotAtObjectCenter(pivot, object3D) {
    const center = getObjectCenter(object3D);
    pivot.position.copy(center);
    pivot.rotation.set(0, 0, 0);
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
}

function applyWorldDelta(object3D, deltaMatrixWorld) {
    object3D.updateMatrixWorld(true);
    const nextWorldMatrix = deltaMatrixWorld.clone().multiply(object3D.matrixWorld);
    const parentWorldInverse = object3D.parent
        ? object3D.parent.matrixWorld.clone().invert()
        : new THREE.Matrix4();
    const nextLocalMatrix = parentWorldInverse.multiply(nextWorldMatrix);

    nextLocalMatrix.decompose(object3D.position, object3D.quaternion, object3D.scale);
    object3D.updateMatrixWorld(true);
}
