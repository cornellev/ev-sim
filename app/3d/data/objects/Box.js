import { BoxGeometry, Mesh, MeshStandardMaterial, Scene, Vector3 } from "three";
import { GLSLObject } from "./Object";

export class Box extends GLSLObject {
    /**
     * Constructor
     * @param {Vector3} position 
     * @param {Vector3} size 
     */
    constructor(position, size) {
        super(true, false, true);
        this.position = position;
        this.scale = size;
    }

    getSDF() {
        return `` +
`float sdBox(vec3 p, vec3 b) {
    vec3 d = abs(p) - b;
    return min(max(d.x, max(d.y, d.z)), 0.0) + length(max(d, 0.0));
}

// convenience overload using struct
float sdBox(vec3 p, Box box) {
    // if box.size is full size, use *0.5; if it's already half-extents, remove *0.5
    return sdBox(p - box.position, box.scale * 0.5);
}`;
    }
    
    getStruct() {
        return super.getStruct().rename("Box");
    }

    /**
     * Add the box to a Three.js scene for visualization
     * @param {Scene} scene 
     */
    addToScene(scene) {
        const geometry = new BoxGeometry(this.scale.x, this.scale.y, this.scale.z);
        const material = new MeshStandardMaterial({ color: this.getColor() });
        const cube = new Mesh(geometry, material);
        cube.position.set(this.position.x, this.position.y, this.position.z);
        cube.userData.fusionObject = this;
        scene.add(cube);

        this._mesh = cube;
    }
}