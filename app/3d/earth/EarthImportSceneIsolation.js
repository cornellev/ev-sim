import * as THREE from "three";

/**
 * @param {THREE.Object3D} object
 */
export function isEarthImportPreservedObject(object) {
    if (!object) return false;
    if (object.userData?.preserveInEarthImportMode) return true;
    if (object.userData?.earthImportLayer) return true;
    if (object.name === "TakramEnvironmentSky" || object.name === "GoogleEarthTiles") {
        return true;
    }
    return false;
}

/**
 * Hides existing environment content while Earth Import mode is active,
 * leaving only preserved roots such as the skybox and Google Earth tiles.
 */
export class EarthImportSceneIsolation {
    constructor() {
        /** @type {Map<THREE.Object3D, boolean>} */
        this.hiddenRoots = new Map();
        this.active = false;
    }

    /**
     * @param {THREE.Scene|null} scene
     */
    activate(scene) {
        if (!scene || this.active) return;
        this.active = true;

        for (const child of scene.children) {
            if (isEarthImportPreservedObject(child)) continue;
            this.hiddenRoots.set(child, child.visible);
            child.visible = false;
        }
    }

    /**
     * @param {THREE.Scene|null} scene
     */
    deactivate(scene) {
        if (!this.active) return;

        for (const [child, visible] of this.hiddenRoots) {
            child.visible = visible;
        }

        this.hiddenRoots.clear();
        this.active = false;
    }

    /**
     * New scene roots (e.g. freshly loaded tiles) should remain visible while isolated.
     * @param {THREE.Object3D} object
     */
    registerPreservedRoot(object) {
        if (!object || !this.active) return;
        this.hiddenRoots.delete(object);
        object.visible = true;
    }
}
