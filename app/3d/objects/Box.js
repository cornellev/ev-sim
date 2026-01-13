import * as THREE from "three";
import RectangleObstacle from "../basic/RectangleObstacle";
import { Object } from "./Object";

export class Box extends Object {
    static getGLSLStruct() {
        return `
        struct Box {
            vec3 position;
            vec3 size;
        };
        `
    }

    static getSDF() {
        return `
        float sdBox(vec3 p, vec3 b) {
            vec3 d = abs(p) - b;
            return min(max(d.x, max(d.y, d.z)), 0.0) + length(max(d, 0.0));
        }

        // convenience overload using your struct
        float sdBox(vec3 p, Box box) {
        // if box.size is full size, use *0.5; if it's already half-extents, remove *0.5
        return sdBox(p - box.position, box.size * 0.5);
        }
        `;
    }

    constructor(location, width, height, depth) {
        super();
        this.location = location;
        this.width = width;
        this.height = height;
        this.depth = depth;
    }

    getType() {
        return "Box";
    }

    fromMesh(mesh) {
        const { width, height, depth } = mesh.geometry.parameters;
        return new Box(width, height, depth);
    }

    toMesh() {
        return (
            <RectangleObstacle key={`${this.location.x}-${this.location.y}-${this.location.z}-${Math.random()}`} width={this.width} height={this.height} depth={this.depth} location={this.location.toArray()}></RectangleObstacle>
        )
    }

    toGLSLObject() {
        return {
            position: this.location.toVector3(),
            size: new THREE.Vector3(this.width, this.height, this.depth)
        }
    }

    signedDistanceToPoint(point) {
        const dx = Math.max(Math.abs(point.x) - this.width / 2, 0);
        const dy = Math.max(Math.abs(point.y) - this.height / 2, 0);
        const dz = Math.max(Math.abs(point.z) - this.depth / 2, 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    signedDistanceTo(otherObject) {
        if (otherObject.getType() === "Box") {
            const dx = Math.abs(otherObject.width - this.width) / 2;
            const dy = Math.abs(otherObject.height - this.height) / 2;
            const dz = Math.abs(otherObject.depth - this.depth) / 2;
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        throw new Error("signedDistanceTo not implemented for this object type");
    }
}