import * as THREE from "three";

import { sanitizePreviewObject } from "./VisualPreviewIsolation.js";

export class VisualPreviewHost {
    constructor(displayScene) {
        this.displayScene = displayScene;
        this.root = new THREE.Group();
        this.root.name = "cev-sim.visual-preview";
        sanitizePreviewObject(this.root, { layerHash: null, instanceId: null });
        displayScene?.add?.(this.root);
    }

    dispose() {
        this.displayScene?.remove?.(this.root);
        this.root.clear();
        this.displayScene = null;
        this.root = null;
    }
}
