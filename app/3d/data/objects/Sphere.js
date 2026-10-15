import { Vector3 } from "three";
import { GLSLObject } from "./Object.js";

/**
 * Analytic LiDAR sphere. The camera mesh stays on the solids projector;
 * this record is the center and radius the shader evaluates.
 */
export class Sphere extends GLSLObject {
    /**
     * @param {Vector3|{ x: number, y: number, z: number }} position
     * @param {number} radius
     */
    constructor(position, radius) {
        super(true, false, false);
        if (position instanceof Vector3) this.position.copy(position);
        else this.position.set(position?.x ?? 0, position?.y ?? 0, position?.z ?? 0);
        this.radius = Number(radius) || 0;
        this.shape = "sphere";
        this.visible = false;
    }

    /**
     * @param {number} radius
     */
    setRadius(radius) {
        this.radius = Number(radius) || 0;
        this._notifyTexture?.(this);
    }

    addToScene() {
        return undefined;
    }
}
