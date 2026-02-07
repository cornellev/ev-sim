import { GLSLObject } from "./Object";
import * as THREE from "three";

export class Sphere extends GLSLObject {
    /**
     * Constructor
     * @param {Vector3} position 
     * @param {number} radius 
     */
    constructor(position, radius) {
        super(true, false, false);
        this.position = position;
        this.radius = radius;
    }

    getSDF() {
        return `` +
`float sdSphere(vec3 p, float r) {
    return length(p) - r;
}`;
    }

    getStruct() {
        return super.getStruct()
            .addField("float", "radius")
            .rename("Sphere");
    }

    addToScene(scene) {
        const geometry = new THREE.SphereGeometry(this.radius, 32, 32);
        const material = new THREE.MeshStandardMaterial({ color: this.getColor() });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.set(this.position.x, this.position.y, this.position.z);
        scene.add(sphere);

        this._mesh = sphere;
    }
}