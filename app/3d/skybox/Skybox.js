import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

const SKYBOX_PATH = 'assets/skybox/sky.exr';

/**
 * Load the HDR sky environment and apply it to the scene.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} [renderer]
 * @returns {Promise<THREE.Texture | null>}
 */
export function loadSkybox(scene, renderer = null) {
    return new Promise((resolve) => {
        const loader = new EXRLoader();
        loader.load(
            SKYBOX_PATH,
            (texture) => {
                texture.mapping = THREE.EquirectangularReflectionMapping;
                scene.background = texture;
                scene.environment = texture;

                if (renderer) {
                    renderer.compile(scene, new THREE.PerspectiveCamera());
                }

                resolve(texture);
            },
            undefined,
            (error) => {
                console.warn('Skybox failed to load, keeping fallback background', error);
                resolve(null);
            },
        );
    });
}

/**
 * @deprecated Use loadSkybox instead.
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} [renderer]
 */
export function Skybox(scene, renderer = null) {
    loadSkybox(scene, renderer);
}
