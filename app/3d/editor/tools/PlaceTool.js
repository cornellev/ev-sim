import * as THREE from "three";
import { EDITOR_TOOLS } from "../EditorState.js";
import { placeFusionObjectInScene } from "../placement/placeFusionObject.js";
import { getGroundPointFromEvent, isOverlayEvent } from "../editorPointerUtils.js";

function createGhost() {
    const geometry = new THREE.CylinderGeometry(0.45, 0.45, 0.12, 24);
    const material = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.06;
    mesh.userData.skipEnvironmentSelection = true;
    return mesh;
}

export class PlaceTool {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.editor = data.editor();
        this.registry = data.environment().objects();
        this.ghost = null;
        this.disposeMove = data.mouse()?.registerMove?.((event) => this.handleMove(event));
        this.disposeClick = data.mouse()?.registerClick?.((event) => this.handleClick(event));
        this.disposeEditor = this.editor.subscribe((snapshot) => this.syncGhost(snapshot));
    }

    getActiveAsset(snapshot = this.editor.snapshot()) {
        if (snapshot.activeTool !== EDITOR_TOOLS.PLACE || !snapshot.activePlacement?.id) return null;
        return snapshot.activePlacement;
    }

    syncGhost(snapshot) {
        const activeAsset = this.getActiveAsset(snapshot);
        if (!activeAsset && this.ghost) {
            this.scene.remove(this.ghost);
            this.ghost.geometry?.dispose?.();
            this.ghost.material?.dispose?.();
            this.ghost = null;
            this.data.simulation()?.render?.();
        }
    }

    ensureGhost() {
        if (!this.ghost) {
            this.ghost = createGhost();
            this.scene.add(this.ghost);
        }
        return this.ghost;
    }

    handleMove(event) {
        if (isOverlayEvent(event) || !this.getActiveAsset()) return;
        const point = getGroundPointFromEvent(event, this.camera, this.renderer);
        if (!point) return;

        const ghost = this.ensureGhost();
        ghost.position.set(point.x, 0.06, point.z);
        this.data.simulation()?.render?.();
    }

    handleClick(event) {
        const asset = this.getActiveAsset();
        if (!asset || isOverlayEvent(event)) return;

        const point = getGroundPointFromEvent(event, this.camera, this.renderer);
        if (!point) return;

        const { entity } = placeFusionObjectInScene({
            data: this.data,
            scene: this.scene,
            registry: this.registry,
            assetId: asset.id,
            point,
            label: asset.label,
        });

        this.editor.selectEntity(entity);
        this.editor.markDirty(true);
        this.data.simulation()?.render?.();
    }

    dispose() {
        this.disposeMove?.();
        this.disposeClick?.();
        this.disposeEditor?.();
        if (this.ghost) {
            this.scene.remove(this.ghost);
            this.ghost.geometry?.dispose?.();
            this.ghost.material?.dispose?.();
            this.ghost = null;
        }
    }
}
