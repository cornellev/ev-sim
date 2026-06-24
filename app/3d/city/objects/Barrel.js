import * as THREE from "three";
import { Box } from "../../data/objects/Box";
import Unit from "@/app/util/Unit";
import { Vector3 } from "three";

export class Barrel extends Box {
    /**
     * 
     * @param {THREE.Vector3} position 
     * @param {THREE.Vector3} size
     * 
     */
    constructor(position, size) {
        super(position.clone().add(new THREE.Vector3(0, size.y / 2, 0)), size);
        this.setTags(["barrel"]);
    }

    addToScene(scene) {
        const geometry = new THREE.CylinderGeometry(this.scale.x / 2, this.scale.x / 2, this.scale.y, 16);
        const material = new THREE.MeshStandardMaterial({ color: 0xcf761d });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(this.position);
        mesh.userData.fusionObject = this;
        
        this._mesh = mesh;
        scene.add(mesh);

        // super.addToScene(scene);
    }
}