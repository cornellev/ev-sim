import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

/**
 * 
 * @param {THREE.Scene} scene 
 * @param {THREE.WebGLRenderer} [renderer]
 */
export function Skybox(scene, renderer = null) {
    const loader = new EXRLoader();
    loader.load('assets/skybox/sky.exr', (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.background = texture;
        scene.environment = texture;

        if (renderer) {
            renderer.compile(scene, new THREE.PerspectiveCamera());
        }
    });
}