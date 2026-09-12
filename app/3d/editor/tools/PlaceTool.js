import * as THREE from "three";
import { EDITOR_TOOLS } from "../EditorState.js";
import { addFeature } from "../commands/legacyCommands.js";
import { getPlacementAsset } from "../placement/placementCatalogData.js";
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

/** Signs face +X by default (legacy quadrant 1); other props have no facing. */
export function defaultFacingForAsset(assetId) {
    return getPlacementAsset(assetId)?.kind === "sign" ? 1 : 0;
}

export class PlaceTool {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.editor = data.editor();
        this.registry = data.environment().objects();
        this.selection = data.selection?.() ?? data.environment().selection?.();
        this.bus = data.commands?.() ?? data.environment().commands?.();
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

        // The command creates the record; the SceneProjector places the mesh.
        const result = this.bus.execute(addFeature({
            type: asset.id,
            x: point.x,
            z: point.z,
            dir: defaultFacingForAsset(asset.id),
            rotationY: 0,
            name: asset.label,
            label: `Place ${asset.label ?? asset.id}`,
        }));
        if (result.ok && result.result?.objectId) {
            this.selection?.select(result.result.objectId);
        } else if (!result.ok) {
            console.warn("[environment] placement rejected:", result.issues.map((issue) => issue.message).join("; "));
        }
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
