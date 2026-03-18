import * as THREE from "three";
import { GLSLObject } from "./Object";

export class Cylinder extends GLSLObject {
    /**
     * Constructor
     * @param {THREE.Vector3} position
     * @param {Number} radius
     * @param {Number} height
     */
    constructor(position, radius, height) {
        super(true, false, true);
        this.position = position;
        this.radius = radius;
        this.height = height;
    }

    getSDF() {
        return `` +
`float sdCylinder(vec3 p, float r, float h) {
    vec2 d = abs(vec2(length(p.xz) - r, p.y)) - vec2(0.0, h * 0.5);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

// convenience overload using struct
float sdCylinder(vec3 p, Cylinder cyl) {
    return sdCylinder(p - cyl.position, cyl.radius, cyl.height);
}`;
    }

    getStruct() {
        return super.getStruct().rename("Cylinder")
            .addField("float", "radius").addField("float", "height");
    }

    /**
     * Add the cylinder to a Three.js scene for visualization
     * @param {THREE.Scene} scene 
     */
    addToScene(scene) {
        const geometry = new THREE.CylinderGeometry(this.radius, this.radius, this.height, 16);
        const material = new THREE.MeshStandardMaterial({ color: this.getColor() });
        const cylinder = new THREE.Mesh(geometry, material);
        cylinder.position.set(this.position.x, this.position.y + this.height / 2, this.position.z);
        scene.add(cylinder);

        this._mesh = cylinder;
    }
}