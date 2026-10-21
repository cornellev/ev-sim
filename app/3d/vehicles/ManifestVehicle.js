import * as THREE from "three";

import { PhysicalVehicle } from "./Vehicle";
import { getSensorType } from "../devices/SensorTypeRegistry.js";
import { createVehicleSensorDevice, sensorRuntimeRegistry } from "../devices/SensorRuntimeRegistry.js";
import { Triangle } from "../data/objects/Triangle";
import { normalizeVehicleManifest, resolveVehicleModelUrl } from "../../vehicles/VehicleManifest.js";
import { measurePlacedVehicleModel } from "../../vehicles/model/measurePlacedVehicle.js";
import { publishedVehicleModelSource, VehicleModelLoader } from "./VehicleModelLoader.js";
import {
    applyMeasuredPlacement,
    captureModelRest,
    presentBoundWheels,
} from "./presentBoundWheels.js";
import { attachVehiclePlant, resetVehiclePlant, stepVehiclePlant } from "./VehiclePlantAdapter.js";
import { visualWheelYaws } from "../../vehicles/plan/turnGeometry.js";
import { resetEgoPresentation, updateEgoPresentation } from "./EgoPresentation.js";

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
     * @param {{ skipManifestDevices?: boolean }} [options]
     */
    constructor(db, manifest, position = new THREE.Vector3(), rotation = new THREE.Euler(), options = {}) {
        super(db, position, rotation);

        this.manifest = normalizeVehicleManifest(manifest);
        this.vehicleManifestId = this.manifest.id;

        this.steeringAngle = 0;
        this.displaySteeringAngle = 0;

        // Physics reads collisionDimensions and collisionCenter for the swept oriented box.
        this.collisionDimensions = { ...this.manifest.boundingBox.size };
        this.collisionCenter = { ...this.manifest.boundingBox.center };
        const catalogProvided = options.plants !== undefined;
        attachVehiclePlant(this, {
            id: this.telemetryId || this.manifest.id,
            type: this.manifest.id,
            pose: { position: this.position, rotation: this.rotation },
        }, { manifest: this.manifest }, {
            plantPluginId: options.plantPluginId,
            plantRuntimeHash: options.plantRuntimeHash,
            plantModel: options.plantModel,
            stepper: options.plantStepper ?? null,
            unresolved: Boolean(this.manifest.dynamics?.plant)
                && !options.plantStepper
                && (options.unresolvedPluginPlant === true || !catalogProvided),
        });

        this.cameraFocusOffset = new THREE.Vector3(
            this.manifest.egoCenter.x,
            this.manifest.egoCenter.y,
            this.manifest.egoCenter.z,
        );
        this.modelLoader = options.modelLoader ?? null;
        this._ownsModelLoader = this.modelLoader == null;
        this._modelLoadToken = 0;
        this._modelLease = null;

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
        if (!options.skipManifestDevices) this._setupManifestDevices();
    }

    /** Devices come from the manifest; see _setupManifestDevices. */
    setupDevices() {}

    _setupManifestDevices() {
        for (const entry of this.manifest.sensors) {
            const definition = getSensorType(entry.type);
            if (definition?.pluginSensor) continue;
            if (!sensorRuntimeRegistry.get(entry.type)?.createVehicleDevice) continue;
            const device = createVehicleSensorDevice(entry, { vehicleManifestId: this.vehicleManifestId });
            if (typeof device.setEnabled === "function") device.setEnabled(entry.enabled !== false);
            else device.enabled = entry.enabled !== false;
            // Created from the vehicle document. addToScene uses this to call
            // setup when the device missed DeviceDatabase.setup. A run still
            // disables it; disposeRun restores the enabled state set above.
            device.vehicleOwned = true;
            this.addDevice(device);
        }
    }

    async addToScene(scene) {
        this.sceneObject = new THREE.Group();
        this.sceneObject.position.copy(this.position);
        this.sceneObject.rotation.copy(this.rotation);
        this._wheels = [];
        this._wheelsPresented = false;
        scene.add(this.sceneObject);
        const sceneObject = this.sceneObject;
        const token = ++this._modelLoadToken;

        const modelUrl = resolveVehicleModelUrl(this.vehicleManifestId, this.manifest.model.asset);
        if (modelUrl) {
            try {
                if (!this.modelLoader) {
                    this.modelLoader = new VehicleModelLoader({ THREE });
                    this._ownsModelLoader = true;
                }
                const lease = await this.modelLoader.load({
                    slotId: this.vehicleManifestId,
                    source: publishedVehicleModelSource(this.manifest, modelUrl),
                    model: this.manifest.model,
                    boundingBox: this.manifest.boundingBox,
                });
                if (token !== this._modelLoadToken) {
                    lease?.dispose?.();
                    return;
                }
                if (!lease?.root || lease.stale || lease.aborted) {
                    lease?.dispose?.();
                    sceneObject.add(this._buildPlaceholderBody());
                } else {
                    this._modelLease = lease;
                    sceneObject.add(lease.root);
                    if (this.manifest.version === 3 && lease.glbBytes) {
                        try {
                            this._presentCanonicalModel(lease, sceneObject);
                        } catch (error) {
                            console.warn(`Could not present bound wheels for "${this.vehicleManifestId}":`, error);
                        }
                    }
                }
            } catch (error) {
                console.warn(`Could not load model for vehicle "${this.vehicleManifestId}":`, error);
                if (token === this._modelLoadToken) sceneObject.add(this._buildPlaceholderBody());
            }
        } else if (token === this._modelLoadToken) {
            sceneObject.add(this._buildPlaceholderBody());
        }

        if (token !== this._modelLoadToken) return;

        if (!this._wheelsPresented) this._buildWheels();

        // Debug plate at the kinematic origin (vehicle-local 0,0,0).
        const originMarker = new THREE.Mesh(
            new THREE.BoxGeometry(0.35, 0.04, 0.35),
            new THREE.MeshBasicMaterial({ color: 0xff2d55, depthTest: false }),
        );
        originMarker.position.set(0, 0.02, 0);
        originMarker.renderOrder = 10;
        originMarker.name = "vehicle-origin-debug";
        this.sceneObject.add(originMarker);

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

    _presentCanonicalModel(lease, parent) {
        const measurement = measurePlacedVehicleModel({
            glbBytes: lease.glbBytes,
            model: this.manifest.model,
            boundingBox: this.manifest.boundingBox,
            hiddenNodeIndices: this.manifest.model?.hiddenNodeIndices ?? [],
        });
        applyMeasuredPlacement(lease.root, measurement.placement);
        this._modelRest = captureModelRest(lease.root, lease.nodeMappings);
        const presented = presentBoundWheels({
            root: lease.root,
            wheelsGroup: parent,
            manifest: this.manifest,
            nodeMappings: lease.nodeMappings,
            THREE,
        });
        this._wheels = [...presented.pivots, ...presented.cylinders].map((entry) => ({
            wheelId: entry.wheelId,
            pivot: entry.pivot,
            steerable: entry.steerable,
        }));
        this._wheelsPresented = true;
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
            this._wheels.push({ wheelId: wheel.id, pivot, steerable: wheel.steerable });
        }
    }

    _applyVisualSteering() {
        const yaws = visualWheelYaws(this.manifest, this.displaySteeringAngle);
        const byId = new Map(yaws.map((entry) => [entry.wheelId, entry.yaw]));
        for (const wheel of this._wheels) {
            if (wheel.wheelId && byId.has(wheel.wheelId)) {
                wheel.pivot.rotation.y = byId.get(wheel.wheelId);
            } else {
                wheel.pivot.rotation.y = wheel.steerable ? this.displaySteeringAngle : 0;
            }
        }
    }

    _registerLidarZone() {
        const zone = this.manifest.lidarZone;
        if (!zone.vertices.length || !zone.triangles.length) return;
        const objects = this.db?.getParent?.()?.objects?.();
        if (!objects) return;

        this._zoneBaseVertices = zone.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
        this._zoneWorldVertices = this._zoneBaseVertices.map((vertex) => vertex.clone());
        this._zoneTriangles = zone.triangles.map(([a, b, c], triangleIndex) => {
            const triangle = new Triangle(
                this._zoneWorldVertices[a],
                this._zoneWorldVertices[b],
                this._zoneWorldVertices[c],
            );
            triangle.visible = false;
            triangle.setTags(["vehicle"]);
            triangle._vehicleId = this.telemetryId;
            triangle.lidarTwinId = `actor:${this.telemetryId}:lidar-zone:${triangleIndex}`;
            triangle.lidarTriangleIndex = triangleIndex;
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
        const maxSteer = Math.min(this.manifest.kinematics.maxSteeringAngle, Math.PI * 0.49);
        const steering = THREE.MathUtils.clamp(this.steeringAngle, -maxSteer, +maxSteer);
        stepVehiclePlant(this, deltaTime);

        this.displaySteeringAngle += (steering - this.displaySteeringAngle) * 0.25;
        this._applyVisualSteering();

        this._updateLidarZoneTransform();
        updateEgoPresentation(this, deltaTime);
    }

    disableControls() {
        this.controlsEnabled = false;
    }

    updatePosition(newPosition) {
        super.updatePosition(newPosition);
        this._updateLidarZoneTransform();
    }

    updateRotation(newRotation) {
        super.updateRotation(newRotation);
        this._updateLidarZoneTransform();
    }

    resetRunState(entry = {}) {
        this._zoneLastPose = null;
        super.resetRunState(entry);
        resetVehiclePlant(this, entry);
        this.displaySteeringAngle = Number(entry.steeringAngle) || 0;
        this._applyVisualSteering();
        this._updateLidarZoneTransform();
        resetEgoPresentation(this);
    }

    getDeterministicState() {
        return super.getDeterministicState();
    }

    dispose() {
        this._modelLoadToken += 1;
        this._modelLease?.dispose();
        this._modelLease = null;
        if (this._ownsModelLoader) this.modelLoader?.dispose();
        const data = this.db?.getParent?.();
        if (this._zoneTriangles.length > 0) {
            const mine = new Set(this._zoneTriangles);
            data?.objects?.()?.replaceTriangles?.((triangle) => mine.has(triangle), []);
            this._zoneTriangles = [];
        }
        super.dispose();
    }
}
