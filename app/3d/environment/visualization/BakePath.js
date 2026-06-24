import * as THREE from "three";

/**
 * Ordered path used by the bake harness to sample camera poses.
 */
export class BakePath {
    /**
     * @param {Array<{ position: THREE.Vector3, rotation?: THREE.Euler }>} vertices
     */
    constructor(vertices = []) {
        this.vertices = vertices.map((vertex) => ({
            position: vertex.position.clone(),
            rotation: vertex.rotation
                ? new THREE.Euler(
                    vertex.rotation.x,
                    vertex.rotation.y,
                    vertex.rotation.z,
                    vertex.rotation.order || "XYZ"
                )
                : null,
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
            position: position.clone(),
            rotation: rotation
                ? new THREE.Euler(rotation.x, rotation.y, rotation.z, rotation.order || "XYZ")
                : null,
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

            const segmentLength = this._segmentLengths[i] || 1e-6;
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
