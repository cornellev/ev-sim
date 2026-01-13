import { Object } from "./Object";

export class Sphere extends Object {
    constructor(radius = 1) {
        super();
        this.radius = radius;
    }
    
    getType() {
        return "Sphere";
    }
    
    signedDistanceToPoint(point) {
        return point.length() - this.radius;
    }

    signedDistanceTo(otherObject) {
        if (otherObject.getType() === "Sphere") {
            return Math.abs(otherObject.radius - this.radius);
        }
        throw new Error("signedDistanceTo not implemented for this object type");
    }
}