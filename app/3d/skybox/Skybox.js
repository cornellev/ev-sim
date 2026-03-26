import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

/**
 * 
 * @param {THREE.Scene} scene 
 */
export function Skybox(scene) {
    const loader = new EXRLoader();
    loader.load('assets/skybox/sky.exr', (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.background = texture;
    });
}