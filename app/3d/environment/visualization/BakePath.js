import * as THREE from "three";
import {
    interpolateBakePathSample,
    pathLengthMeters,
    planIntegerSampleDistances,
    rotationToQuaternion,
} from "../visual/BakeRunCatalog.js";

function toVector3(value) {
    if (!value) return new THREE.Vector3();
    if (value.isVector3 || typeof value.clone === "function") return value.clone();
    return new THREE.Vector3(value.x ?? 0, value.y ?? 0, value.z ?? 0);
}

function toEuler(value) {
    if (!value) return null;
    if (value.isEuler) {
        return new THREE.Euler(value.x, value.y, value.z, value.order || "XYZ");
    }
    if (value.w !== undefined) {
        const quaternion = new THREE.Quaternion(
            value.x,
            value.y,
            value.z,
            value.w,
        );
        return new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
    }
    return new THREE.Euler(value.x ?? 0, value.y ?? 0, value.z ?? 0, value.order || "XYZ");
}

/**
 * Ordered path used by the bake harness to sample camera poses.
 */
export class BakePath {
    /**
     * @param {Array<{ position: THREE.Vector3|{x:number,y:number,z:number}, rotation?: THREE.Euler|object }>} vertices
     */
    constructor(vertices = []) {
        this.vertices = vertices.map((vertex) => ({
            position: toVector3(vertex.position ?? vertex),
            rotation: toEuler(vertex.rotation),
        }));

        this._segmentLengths = [];
        this._cumulativeLengths = [0];
        this.totalLength = 0;
        this._rebuild();
    }

    /**
     * @param {THREE.Vector3} position
     * @param {THREE.Euler|null} rotation
     * @returns {this}
     */
    addVertex(position, rotation = null) {
        this.vertices.push({
            position: toVector3(position),
            rotation: toEuler(rotation),
        });
        this._rebuild();
        return this;
    }

    _rebuild() {
        this._segmentLengths = [];
        this._cumulativeLengths = [0];
        this.totalLength = 0;

        if (this.vertices.length < 2) {
            return;
        }

        for (let i = 0; i < this.vertices.length - 1; i++) {
            const length = this.vertices[i].position.distanceTo(this.vertices[i + 1].position);
            this._segmentLengths.push(length);
            this.totalLength += length;
            this._cumulativeLengths.push(this.totalLength);
        }
    }

    /**
     * @param {number} distance
     * @returns {{
     *   position: THREE.Vector3,
     *   rotation: THREE.Euler,
     *   distance: number,
     *   segmentIndex: number,
     *   t: number
     * }|null}
     */
    sampleAtDistance(distance) {
        if (this.vertices.length === 0) return null;

        if (this.vertices.length === 1) {
            const only = this.vertices[0];
            return {
                position: only.position.clone(),
                rotation: only.rotation
                    ? only.rotation.clone()
                    : new THREE.Euler(0, 0, 0, "XYZ"),
                distance: 0,
                segmentIndex: 0,
                t: 0,
            };
        }

        const clampedDistance = Math.max(0, Math.min(distance, this.totalLength));

        for (let i = 0; i < this._segmentLengths.length; i++) {
            const segmentStart = this._cumulativeLengths[i];
            const segmentEnd = this._cumulativeLengths[i + 1];

            if (clampedDistance > segmentEnd && i < this._segmentLengths.length - 1) {
                continue;
            }

            const segmentLength = this._segmentLengths[i];
            const localDistance = clampedDistance - segmentStart;
            const t = segmentLength > 0 ? localDistance / segmentLength : 0;

            const start = this.vertices[i];
            const end = this.vertices[i + 1];
            const position = start.position.clone().lerp(end.position, t);

            let rotation;
            if (start.rotation && end.rotation) {
                rotation = new THREE.Euler(
                    THREE.MathUtils.lerp(start.rotation.x, end.rotation.x, t),
                    THREE.MathUtils.lerp(start.rotation.y, end.rotation.y, t),
                    THREE.MathUtils.lerp(start.rotation.z, end.rotation.z, t),
                    start.rotation.order || "XYZ"
                );
            } else {
                const tangent = end.position.clone().sub(start.position);
                if (tangent.lengthSq() > 1e-6) {
                    rotation = new THREE.Euler(0, Math.atan2(tangent.x, tangent.z), 0, "XYZ");
                } else if (start.rotation) {
                    rotation = start.rotation.clone();
                } else {
                    rotation = new THREE.Euler(0, 0, 0, "XYZ");
                }
            }

            return {
                position,
                rotation,
                distance: clampedDistance,
                segmentIndex: i,
                t,
            };
        }

        const last = this.vertices[this.vertices.length - 1];
        return {
            position: last.position.clone(),
            rotation: last.rotation
                ? last.rotation.clone()
                : new THREE.Euler(0, 0, 0, "XYZ"),
            distance: this.totalLength,
            segmentIndex: Math.max(0, this.vertices.length - 2),
            t: 1,
        };
    }

    /**
     * Integer-index sampling used by version-1 bake jobs. Distances are
     * `sampleIndex * deltaDistance`, the final sample is the explicit path
     * endpoint, and zero-length segments hold the start vertex.
     * @param {number} sampleIndex
     * @param {number} deltaDistance
     * @param {{ includeEndpoints?: boolean }} [options]
     */
    sampleAtIndex(sampleIndex, deltaDistance, options = {}) {
        const sampling = {
            deltaDistance,
            includeEndpoints: options.includeEndpoints !== false,
            zeroLengthPolicy: "hold-start",
        };
        const vertices = this.vertices.map((vertex) => ({
            position: { x: vertex.position.x, y: vertex.position.y, z: vertex.position.z },
            rotation: vertex.rotation
                ? rotationToQuaternion(vertex.rotation, "path.rotation")
                : { x: 0, y: 0, z: 0, w: 1 },
        }));
        const distances = planIntegerSampleDistances(pathLengthMeters({ vertices }), sampling);
        const distance = distances[sampleIndex];
        if (distance == null) return null;
        const sample = interpolateBakePathSample(vertices, distance);
        if (!sample) return null;
        const quaternion = new THREE.Quaternion(
            sample.rotation.x,
            sample.rotation.y,
            sample.rotation.z,
            sample.rotation.w,
        );
        return {
            position: new THREE.Vector3(sample.position.x, sample.position.y, sample.position.z),
            rotation: new THREE.Euler().setFromQuaternion(quaternion, "XYZ"),
            distance: sample.distance,
            segmentIndex: sample.segmentIndex,
            t: sample.t,
            sampleIndex,
        };
    }

    /**
     * 
     * @param {Data} data 
     */
    display(data) {
        const scene = data.scene;

        const material = new THREE.LineBasicMaterial({ color: 0xff0000 });
        const points = this.vertices.map((v) => v.position);
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geometry, material);
        line.userData.bakeIgnore = true;
        scene.add(line);

        for (const vertex of this.vertices) {
            const sphereGeometry = new THREE.SphereGeometry(0.1, 8, 8);
            const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
            const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
            sphere.position.copy(vertex.position);
            sphere.userData.bakeIgnore = true;
            scene.add(sphere);
        }
    }
}
