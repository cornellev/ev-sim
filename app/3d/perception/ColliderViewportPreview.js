import * as THREE from "three";
import { colliderViewportGeometry, unconfiguredColliderSource } from "./colliderViewportGeometry.js";

const SOLID_COLOR = 0xc4ccd6;
const FLOOR_COLOR = 0x5c6570;

function meshFromShape(shape, material) {
    if (shape.kind === "box") {
        const geometry = new THREE.BoxGeometry(shape.size.x, shape.size.y, shape.size.z);
        if (shape.yaw) geometry.rotateY(shape.yaw);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(shape.center.x, shape.center.y, shape.center.z);
        return mesh;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(shape.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(shape.indices, 1));
    geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, material);
}

function writeMesh(mesh, shape) {
    const position = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    if (!position || !index || position.count !== shape.positions.length / 3 || index.count !== shape.indices.length) return false;
    position.array.set(shape.positions);
    position.needsUpdate = true;
    index.array.set(shape.indices);
    index.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
    return true;
}

function clearGroup(group) {
    for (const child of group.children) child.geometry?.dispose();
    group.clear();
}

/**
 * Replaces the viewport frame with contact colliders. The visual scene is not drawn.
 */
export class ColliderViewportPreview {
    /**
     * @param {{ physics?: Function }} data
     */
    constructor(data) {
        this.data = data;
        this.enabled = false;
        this._frame = null;
        this._floorKey = null;
        this._description = undefined;
        this._staticEntries = [];
        this._savedClear = new THREE.Color();
        this._scene = new THREE.Scene();
        this._solidMaterial = new THREE.MeshBasicMaterial({
            color: SOLID_COLOR,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        this._floorMaterial = new THREE.LineBasicMaterial({
            color: FLOOR_COLOR,
            toneMapped: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });
        this._staticGroup = new THREE.Group();
        this._vehicleGroup = new THREE.Group();
        this._rigidGroup = new THREE.Group();
        this._vehicleMeshes = [];
        this._rigidMeshes = new Map();
        this._floor = new THREE.LineSegments(new THREE.BufferGeometry(), this._floorMaterial);
        this._floor.frustumCulled = false;
        this._floor.visible = false;
        this._scene.add(this._staticGroup, this._vehicleGroup, this._rigidGroup, this._floor);
    }

    /**
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this.enabled = enabled === true;
    }

    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Camera} camera
     * @returns {boolean}
     */
    render(renderer, camera) {
        if (!this.enabled || !renderer || !camera) return false;
        this._sync();
        this._draw(renderer, () => {
            renderer.setClearColor(0x000000, 1);
            renderer.setRenderTarget(null);
            renderer.clear();
            renderer.render(this._scene, camera);
        });
        return true;
    }

    dispose() {
        this.enabled = false;
        clearGroup(this._staticGroup);
        clearGroup(this._vehicleGroup);
        clearGroup(this._rigidGroup);
        this._vehicleMeshes = [];
        this._rigidMeshes.clear();
        this._floor.geometry.dispose();
        this._solidMaterial.dispose();
        this._floorMaterial.dispose();
        this._frame = null;
        this._floorKey = null;
        this._description = undefined;
        this._staticEntries = [];
    }

    // Physics lists stay empty until a run configures them. Until then the loaded description is the collider set.
    // A playground vehicle can spawn after that configure, leaving vehicleStates empty.
    _source() {
        const physics = this.data?.physics?.() ?? null;
        const vehicles = this.data?.vehicles?.()?.vehicles;
        if (physics?.preparedWorldDescription) {
            if ((physics.vehicleStates?.length ?? 0) > 0 || !vehicles?.length) return physics;
            return {
                staticColliders: physics.staticColliders,
                rigidBodyStates: physics.rigidBodyStates,
                preparedWorldDescription: physics.preparedWorldDescription,
                vehicleStates: vehicles.map((vehicle) => ({ vehicle })),
            };
        }
        const description = this.data?.environment?.()?.worldDescription ?? null;
        if (description !== this._description) {
            this._description = description;
            this._staticEntries = unconfiguredColliderSource(description).staticColliders;
        }
        return unconfiguredColliderSource(description, vehicles, this._staticEntries);
    }

    _sync() {
        const frame = colliderViewportGeometry(this._source(), this._frame);
        if (frame.staticSource !== this._frame?.staticSource) this._rebuildStatic(frame.staticShapes);
        this._syncVehicles(frame.vehicles);
        this._syncRigid(frame.rigidBodies);
        this._syncFloor(frame.floor);
        this._frame = frame;
    }

    _rebuildStatic(shapes) {
        clearGroup(this._staticGroup);
        for (const shape of shapes) this._staticGroup.add(meshFromShape(shape, this._solidMaterial));
    }

    _syncVehicles(boxes) {
        while (this._vehicleMeshes.length > boxes.length) {
            const mesh = this._vehicleMeshes.pop();
            this._vehicleGroup.remove(mesh);
            mesh.geometry.dispose();
        }
        for (let index = 0; index < boxes.length; index += 1) {
            let mesh = this._vehicleMeshes[index];
            if (!mesh) {
                mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this._solidMaterial);
                this._vehicleMeshes.push(mesh);
                this._vehicleGroup.add(mesh);
            }
            const box = boxes[index];
            mesh.position.set(box.center.x, box.center.y, box.center.z);
            mesh.rotation.set(0, box.yaw, 0);
            mesh.scale.set(box.size.x, box.size.y, box.size.z);
        }
    }

    _syncRigid(bodies) {
        const seen = new Set();
        for (const body of bodies) {
            seen.add(body.id);
            let mesh = this._rigidMeshes.get(body.id);
            if (!mesh || !writeMesh(mesh, body)) {
                if (mesh) {
                    this._rigidGroup.remove(mesh);
                    mesh.geometry.dispose();
                }
                mesh = meshFromShape(body, this._solidMaterial);
                this._rigidGroup.add(mesh);
                this._rigidMeshes.set(body.id, mesh);
            }
        }
        for (const [id, mesh] of this._rigidMeshes) {
            if (seen.has(id)) continue;
            this._rigidGroup.remove(mesh);
            mesh.geometry.dispose();
            this._rigidMeshes.delete(id);
        }
    }

    _syncFloor(floor) {
        const key = floor ? `${floor.y}:${floor.minX}:${floor.maxX}:${floor.minZ}:${floor.maxZ}` : "";
        if (key !== this._floorKey) {
            this._floorKey = key;
            this._floor.geometry.dispose();
            const geometry = new THREE.BufferGeometry();
            if (floor) geometry.setAttribute("position", new THREE.BufferAttribute(floor.positions, 3));
            this._floor.geometry = geometry;
        }
        this._floor.visible = Boolean(floor);
    }

    _draw(renderer, body) {
        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        renderer.getClearColor(this._savedClear);
        const previousAlpha = renderer.getClearAlpha();
        try {
            renderer.autoClear = true;
            body();
        } finally {
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(this._savedClear, previousAlpha);
            renderer.autoClear = previousAutoClear;
        }
    }
}
