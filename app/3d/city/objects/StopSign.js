import * as THREE from "three";
import { Box } from "../../data/objects/Box";
import Unit from "@/app/util/Unit";

export class StopSign extends Box {
    /**
     * 
     * @param {THREE.Vector3} position 
     * @param {Unit} height 
     * @param {Number} dir - direction the stop sign is facing, 0,1,2,3 for N,E,S,W (or +X, +Z, -X, -Z) respectively
     */
    constructor(position, height, dir) {
        // Persist direction for later orientation in addToScene().
        // If left undefined, rotations can become NaN and the sign may not render.
        const facingX = dir === 0 || dir === 2;
        const thickness = new Unit(2, Unit.Type.INCH).getValue(Unit.Type.METER);
        const faceSize = new Unit(36, Unit.Type.INCH).getValue(Unit.Type.METER);

        const signD = new Unit(24, Unit.Type.INCH).getValue(Unit.Type.METER);

        super(position.clone().add(new THREE.Vector3(0, height.getValue(Unit.Type.METER) / 2 + signD / 2, 0)), new THREE.Vector3(
            // Use a thin dimension along the facing axis and a large one across it.
            facingX ? thickness : faceSize,
            height.getValue(Unit.Type.METER) + signD,
            facingX ? faceSize : thickness
        ));

        this.dir = dir;
        // random int32
        this.id = Math.floor(Math.random() * 0xFFFFFFFF);
    }

    addToScene(scene) {
        const pos = this.position.clone();
        pos.y -= this.scale.y / 2; // move down so bottom is at original position

        // add the pole
        const poleHeight = this.scale.y - new Unit(24, Unit.Type.INCH).getValue(Unit.Type.METER);
        const geometry = new THREE.CylinderGeometry(0.05, 0.05, poleHeight, 8);
        const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
        const pole = new THREE.Mesh(geometry, material);

        // the pole's bottom is at the stop sign's position, so offset it up by half the pole height
        pole.position.set(this.position.x, pos.y + poleHeight / 2, this.position.z);

        // add the sign
        const scale = Math.max(this.scale.x, this.scale.z); // use the larger horizontal scale for the sign size
        const signGeometry = new THREE.CircleGeometry(scale / 2, 6);
        const signMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xff0000,
            side: THREE.DoubleSide
        });

        const sign = new THREE.Mesh(signGeometry, signMaterial);
        sign.position.set(this.position.x, pos.y + poleHeight + scale / 4, this.position.z);
        // CircleGeometry faces +Z by default; map dir (0:+X, 1:+Z, 2:-X, 3:-Z) to a Y-rotation.
        sign.rotation.y = (Math.PI / 2) * (1 - this.dir);

        const mesh = new THREE.Group();
        mesh.add(pole);
        mesh.add(sign);
        this._mesh = mesh;

        // super.addToScene(scene); // call parent method to store reference

        scene.add(mesh);
    }
}