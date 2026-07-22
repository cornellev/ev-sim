import * as THREE from "three";
import { Box } from "../../data/objects/Box";

/** Traffic cone obstacle for placement / MCP environment editing. */
export class Cone extends Box {
    /**
     * @param {THREE.Vector3} position Base center resting on the ground.
     * @param {number} [height] Cone height in meters.
     * @param {number} [baseRadius] Base radius in meters.
     */
    constructor(position, height = 0.7, baseRadius = 0.18) {
        super(
            position.clone().add(new THREE.Vector3(0, height / 2, 0)),
            new THREE.Vector3(baseRadius * 2, height, baseRadius * 2),
        );
        this.height = height;
        this.baseRadius = baseRadius;
        this.color(0xf97316);
        this.setTags(["cone"]);
    }

    addToScene(scene) {
        const geometry = new THREE.ConeGeometry(this.baseRadius, this.height, 16);
        const material = new THREE.MeshStandardMaterial({
            color: this.getColor(),
            roughness: 0.75,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(this.position);
        mesh.userData.fusionObject = this;
        scene.add(mesh);
        this._mesh = mesh;
    }
}
