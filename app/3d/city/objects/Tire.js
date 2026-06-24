import * as THREE from "three";
import { Box } from "../../data/objects/Box";

/** Small tire-shaped obstacle for FI.2 (machine vision tire detection layout). */
export class Tire extends Box {
    /**
     * @param {THREE.Vector3} position Center of the tire (resting on ground).
     * @param {number} majorRadius Outer radius (m).
     * @param {number} tubeRadius Tube thickness (m).
     */
    constructor(position, majorRadius = 0.22, tubeRadius = 0.06) {
        super(position.clone().add(new THREE.Vector3(0, tubeRadius, 0)), new THREE.Vector3(majorRadius * 2, tubeRadius * 2, majorRadius * 2));
        this.majorRadius = majorRadius;
        this.tubeRadius = tubeRadius;
        this.color(0x1a1a1a);
        this.setTags(["tire"]);
    }

    addToScene(scene) {
        const geometry = new THREE.TorusGeometry(this.majorRadius, this.tubeRadius, 12, 32);
        const material = new THREE.MeshStandardMaterial({ color: this.getColor(), roughness: 0.9 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = Math.PI / 2;
        mesh.position.copy(this.position);
        mesh.userData.fusionObject = this;
        scene.add(mesh);
        this._mesh = mesh;
    }
}
