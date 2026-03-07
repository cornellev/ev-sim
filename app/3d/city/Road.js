
/**
 * A road in the city.
 * Uses a bezier curve to define its shape, and has a width and lane markings.
 */
export class Road {
    constructor() {
        this.points = []; // list of Vector3 control points
        this.width = 4; // default width of the road
    }
}