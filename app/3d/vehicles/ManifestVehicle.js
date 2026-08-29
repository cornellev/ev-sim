import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

import { PhysicalVehicle } from "./Vehicle";
import { createVehicleSensorDevice } from "../devices/SensorRuntimeRegistry.js";
import { Triangle } from "../data/objects/Triangle";
import { normalizeVehicleManifest, resolveVehicleModelUrl } from "../../vehicles/VehicleManifest.js";
import { applyModelPlacement } from "./ModelPlacement.js";

export { applyModelPlacement } from "./ModelPlacement.js";

const POSE_EPSILON = 1e-6;

/**
 * A vehicle instantiated entirely from a `cev-sim.vehicle` manifest: visual
 * model, wheels, sensors, physics dimensions, and the reduced-polygon LiDAR
 * collision zone all come from the document instead of hard-coded classes.
 */
export class ManifestVehicle extends PhysicalVehicle {
    /**
     * @param {import("../data/VehicleDatabase").VehicleDatabase} db
     * @param {object} manifest A `cev-sim.vehicle` document.
     * @param {THREE.Vector3} position
     * @param {THREE.Euler} rotation
     */
    constructor(db, manifest, position = new THREE.Vector3(), rotation = new THREE.Euler()) {
        super(db, position, rotation);

        this.manifest = normalizeVehicleManifest(manifest);
        this.vehicleManifestId = this.manifest.id;

        this.steeringAngle = 0;
        this.displaySteeringAngle = 0;

        // Physics reads collisionDimensions for the swept AABB half extents.
        this.collisionDimensions = { ...this.manifest.boundingBox.size };

        this.cameraFocusOffset = new THREE.Vector3(
            this.manifest.egoCenter.x,
            this.manifest.egoCenter.y,
            this.manifest.egoCenter.z,
        );

        /** @type {{ pivot: THREE.Group, steerable: boolean }[]} */
        this._wheels = [];
        /** @type {Triangle[]} */
        this._zoneTriangles = [];
        /** @type {THREE.Vector3[]} local-frame vertices from the manifest */
        this._zoneBaseVertices = [];
        /** @type {THREE.Vector3[]} world-frame vertices shared by triangles */
        this._zoneWorldVertices = [];
        this._zoneLastPose = null;

        // The base Vehicle constructor calls setupDevices() before the
        // manifest is assigned, so devices are created here instead.
        this._setupManifestDevices();
    }

    /** Devices come from the manifest; see _setupManifestDevices. */
    setupDevices() {}

    _setupManifestDevices() {
        for (const entry of this.manifest.sensors) {
            const device = createVehicleSensorDevice(entry, { vehicleManifestId: this.vehicleManifestId });
            if (typeof device.setEnabled === "function") device.setEnabled(entry.enabled !== false);
            else device.enabled = entry.enabled !== false;
            // Preserve this state across DeviceDatabase.configureFromManifest —
            // the vehicle document is their source of truth, not the run sensorRig.
            device.vehicleOwned = true;
            this.addDevice(device);
        }
    }

    async addToScene(scene) {
        this.sceneObject = new THREE.Group();
        this.sceneObject.position.copy(this.position);
        this.sceneObject.rotation.copy(this.rotation);
        scene.add(this.sceneObject);

        const modelUrl = resolveVehicleModelUrl(this.vehicleManifestId, this.manifest.model.asset);
        if (modelUrl) {
            try {
                const loader = new GLTFLoader();
                const gltf = await loader.loadAsync(modelUrl);
                applyModelPlacement(gltf.scene, this.manifest.model, this.manifest.boundingBox);
                this.sceneObject.add(gltf.scene);
            } catch (error) {
                console.warn(`Could not load model for vehicle "${this.vehicleManifestId}":`, error);
                this.sceneObject.add(this._buildPlaceholderBody());
            }
        } else {
            this.sceneObject.add(this._buildPlaceholderBody());
        }

        // Debug plate at the kinematic origin (vehicle-local 0,0,0).
        const originMarker = new THREE.Mesh(
            new THREE.BoxGeometry(0.35, 0.04, 0.35),
            new THREE.MeshBasicMaterial({ color: 0xff2d55, depthTest: false }),
        );
        originMarker.position.set(0, 0.02, 0);
        originMarker.renderOrder = 10;
        originMarker.name = "vehicle-origin-debug";
        this.sceneObject.add(originMarker);

        this._buildWheels();
        this._registerLidarZone();

        // Vehicles spawned mid-session never go through DeviceDatabase.setup, so
        // wire their devices here before the first updatePosition / onParentUpdate.
        for (const device of this.devices) {
            if (device.vehicleOwned && !device._sceneReady) {
                device.setup?.(scene);
                device._sceneReady = true;
            }
        }
    }

    _buildPlaceholderBody() {
        const { size, center } = this.manifest.boundingBox;
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(size.x, size.y, size.z),
            new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.7, metalness: 0.15 }),
        );
        mesh.position.set(center.x, center.y, center.z);
        mesh.castShadow = true;
        return mesh;
    }

    _buildWheels() {
        const material = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.85 });
        for (const wheel of this.manifest.wheels) {
            // Cylinder axis starts on Y; rotate onto Z, the lateral axis.
            const geometry = new THREE.CylinderGeometry(wheel.radius, wheel.radius, wheel.width, 24);
            geometry.rotateX(Math.PI / 2);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.castShadow = true;
            const pivot = new THREE.Group();
            pivot.position.set(wheel.position.x, wheel.position.y, wheel.position.z);
            pivot.add(mesh);
            this.sceneObject.add(pivot);
            this._wheels.push({ pivot, steerable: wheel.steerable });
        }
    }

    _registerLidarZone() {
        const zone = this.manifest.lidarZone;
        if (!zone.vertices.length || !zone.triangles.length) return;
        const objects = this.db?.getParent?.()?.objects?.();
        if (!objects) return;

        this._zoneBaseVertices = zone.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
        this._zoneWorldVertices = this._zoneBaseVertices.map((vertex) => vertex.clone());
        this._zoneTriangles = zone.triangles.map(([a, b, c]) => {
            const triangle = new Triangle(
                this._zoneWorldVertices[a],
                this._zoneWorldVertices[b],
                this._zoneWorldVertices[c],
            );
            triangle.visible = false;
            triangle.setTags(["vehicle"]);
            triangle._vehicleId = this.telemetryId;
            return triangle;
        });
        objects.addObjects(this._zoneTriangles);
        this._zoneLastPose = null;
        this._updateLidarZoneTransform();
    }

    _updateLidarZoneTransform() {
        if (this._zoneTriangles.length === 0) return;
        const pose = [
            this.position.x, this.position.y, this.position.z,
            this.rotation.x, this.rotation.y, this.rotation.z,
        ];
        if (this._zoneLastPose && pose.every((value, index) => Math.abs(value - this._zoneLastPose[index]) < POSE_EPSILON)) {
            return;
        }
        this._zoneLastPose = pose;

        const quaternion = new THREE.Quaternion().setFromEuler(this.rotation);
        for (let index = 0; index < this._zoneBaseVertices.length; index += 1) {
            this._zoneWorldVertices[index]
                .copy(this._zoneBaseVertices[index])
                .applyQuaternion(quaternion)
                .add(this.position);
        }
        for (const triangle of this._zoneTriangles) {
            triangle.notifyTextureUpdate();
        }
    }

    update(deltaTime) {
        // Planar bicycle kinematics, matching BigCar: velocity.x is the
        // vehicle-local forward speed and heading is local +X in world space.
        this.velocity.addScaledVector(this.acceleration, deltaTime);
        const speed = this.velocity.x;

        const maxSteer = Math.min(this.manifest.kinematics.maxSteeringAngle, Math.PI * 0.49);
        const steering = THREE.MathUtils.clamp(this.steeringAngle, -maxSteer, +maxSteer);
        const yawRate = (speed / this.manifest.kinematics.wheelbase) * Math.tan(steering);

        const heading = new THREE.Vector3(1, 0, 0).applyEuler(this.rotation);
        heading.y = 0;
        const headingLength = heading.length();
        if (headingLength > 0) heading.multiplyScalar(1 / headingLength);

        this.position.addScaledVector(heading, speed * deltaTime);
        this.rotation.y += yawRate * deltaTime;

        this.updatePosition(this.position);
        this.updateRotation(this.rotation);

        this.displaySteeringAngle += (steering - this.displaySteeringAngle) * 0.25;
        for (const wheel of this._wheels) {
            if (wheel.steerable) wheel.pivot.rotation.y = this.displaySteeringAngle;
        }

        this._updateLidarZoneTransform();
    }

    updatePosition(newPosition) {
        super.updatePosition(newPosition);
        this._updateLidarZoneTransform();
    }

    updateRotation(newRotation) {
        super.updateRotation(newRotation);
        this._updateLidarZoneTransform();
    }

    dispose() {
        const data = this.db?.getParent?.();
        if (this._zoneTriangles.length > 0) {
            const mine = new Set(this._zoneTriangles);
            data?.objects?.()?.replaceTriangles?.((triangle) => mine.has(triangle), []);
            this._zoneTriangles = [];
        }
        super.dispose();
    }
}
