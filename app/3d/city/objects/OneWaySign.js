import * as THREE from "three";
import { Box } from "../../data/objects/Box";
import Unit from "@/app/util/Unit";

/**
 * Minimal rectangular “One Way” sign placeholder (FIII.2).
 * @param {THREE.Vector3} groundPos Bottom of pole on the ground.
 * @param {number} dir Same convention as StopSign: 0=N/+X, 1=E/+Z, 2=S/-X, 3=W/-Z
 */
export class OneWaySign extends Box {
    constructor(groundPos, dir = 1) {
        const w = new Unit(24, Unit.Type.INCH).getValue(Unit.Type.METER);
        const h = new Unit(12, Unit.Type.INCH).getValue(Unit.Type.METER);
        const t = new Unit(1, Unit.Type.INCH).getValue(Unit.Type.METER);
        const poleH = new Unit(6, Unit.Type.FOOT).getValue(Unit.Type.METER);

        const facingX = dir === 0 || dir === 2;
        const boardCenter = groundPos.clone().add(new THREE.Vector3(0, poleH + h / 2, 0));

        super(
            boardCenter,
            new THREE.Vector3(facingX ? t : w, h, facingX ? w : t)
        );

        this.dir = dir;
        this._poleH = poleH;
        this._ground = groundPos.clone();
    }

    addToScene(scene) {
        const poleGeom = new THREE.CylinderGeometry(0.05, 0.05, this._poleH, 8);
        const poleMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
        const pole = new THREE.Mesh(poleGeom, poleMat);
        pole.position.set(
            this._ground.x,
            this._ground.y + this._poleH / 2,
            this._ground.z
        );

        const boardGeom = new THREE.BoxGeometry(this.scale.x, this.scale.y, this.scale.z);
        const boardMat = new THREE.MeshStandardMaterial({ color: 0x1e4f96 });
        const board = new THREE.Mesh(boardGeom, boardMat);
        board.position.set(this.position.x, this.position.y, this.position.z);
        board.rotation.y = (Math.PI / 2) * (1 - this.dir);

        const group = new THREE.Group();
        group.add(pole);
        group.add(board);
        scene.add(group);
        this._mesh = group;
    }
}
