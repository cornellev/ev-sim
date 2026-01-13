import * as THREE from "three";

export class Point3D {
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    distanceTo(otherPoint) {
        const dx = this.x - otherPoint.x;
        const dy = this.y - otherPoint.y;
        const dz = this.z - otherPoint.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    length() {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }

    subtract(otherPoint) {
        return new Point3D(this.x - otherPoint.x, this.y - otherPoint.y, this.z - otherPoint.z);
    }

    add(otherPoint) {
        return new Point3D(this.x + otherPoint.x, this.y + otherPoint.y, this.z + otherPoint.z);
    }

    scale(scalar) {
        return new Point3D(this.x * scalar, this.y * scalar, this.z * scalar);
    }

    normalize() {
        const len = this.length();
        if (len === 0) return new Point3D(0, 0, 0);
        return this.scale(1 / len);
    }
    
    toArray() {
        return [this.x, this.y, this.z];
    }

    clone() {
        return new Point3D(this.x, this.y, this.z);
    }

    equals(otherPoint) {
        return this.x === otherPoint.x && this.y === otherPoint.y && this.z === otherPoint.z;
    }

    toVector3() {
        return new THREE.Vector3(this.x, this.y, this.z);
    }
}

export class Object {
    constructor() {

    }

    signedDistanceTo(otherObject) {
        // Implement SDF calculation between this object and otherObject
    }

    signedDistanceToPoint(point) {
        // Implement SDF calculation between this object and a point
    }

    toGLSLObject() {
        // Convert this object to a GLSL-compatible representation
    }

    getType() {
        return this.constructor.name;
    }
}