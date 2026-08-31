import * as THREE from "three";
import { Data } from "../data/Data";
import { VehicleDatabase } from "../data/VehicleDatabase";
import Device from "../devices/Device";

// Execution flow of a new vehicle:
// super constructor -> setupDevices() -> post super constructor
// then, user needs to call addToScene() to add the vehicle to the scene and render it

export class Vehicle {
    /**
     * @param {VehicleDatabase} db 
     * @param {THREE.Vector3} position 
     * @param {THREE.Euler} rotation 
     */
    constructor(db, position=new THREE.Vector3(), rotation=new THREE.Euler()) {
        if (!(db instanceof VehicleDatabase)) {
            throw new Error("Vehicle constructor requires a VehicleDatabase instance");
        }

        this.position = position;
        this.rotation = rotation;
        this.devices = []; // list of VehicleDevice instances

        this.db = db;
        
        this.db.addVehicle(this); // add this vehicle to the database, which will manage it and call its update function each frame

        this.sceneObject = new THREE.Group(); // to be created by subclasses

        this.setupDevices();
    }

    /**
     * Add a device (sensor) to the vehicle and optionally add it to the database.
     * @param {Device} device 
     * @param {Boolean} addToDatabase 
     */
    addDevice(device, addToDatabase=true) {
        if (addToDatabase) this.db.getParent().devices().addDevice(device);
        
        device.parentVehicle = this;
        this.devices.push(device);
    }

    /**
     * Set up any devices (sensors) on the vehicle and add them to the scene.
     */
    setupDevices() {
        // to be implemented by subclasses
    }
    
    /**
     * Add the vehicle's 3D representation to the scene.
     * @param {THREE.Scene} scene 
     */
    addToScene(scene) {
        scene.add(this.sceneObject);
        // to be implemented by subclasses
    }

    // EVENTS

    /**
     * Called when the vehicle is fully added and ready in the scene. Can be used to trigger any start-up behavior or device activation.
     */
    start() {
        // to be implemented by subclasses
    }
    
    /**
     * Update the car actions.
     * Asynchronous to allow parallel execution of multiple vehicles' update functions, and to allow for async operations within the update (e.g. waiting for sensor data).
     * @param {Number} deltaTime Delta time in seconds.
     */
    update(deltaTime) {
        // to be implemented by subclasses
    }

    /**
     * Update the vehicle's position in the scene.
     * @param {THREE.Vector3} new_position 
     */
    updatePosition(new_position) {
        this.position.copy(new_position);
        this.sceneObject.position.copy(this.position).add(this.offset ? this.offset : new THREE.Vector3(0, 0, 0));

        for (let device of this.devices) {
            device.onParentUpdate();
        }
    }

    /**
     * Update the vehicle's rotation in the scene.
     * @param {THREE.Euler} new_rotation 
     */
    updateRotation(new_rotation) {
        this.rotation.copy(new_rotation);
        this.sceneObject.rotation.copy(this.rotation);
        
        for (let device of this.devices) {
            device.onParentUpdate();
        }
    }

    resetRunState(entry = {}) {
        const pose = entry.pose || {};
        const position = pose.position || { x: 0, y: 0, z: 0 };
        const rotation = pose.rotation || { x: 0, y: 0, z: 0, order: "XYZ" };
        this.position?.set?.(
            Number(position.x) || 0,
            Number(position.y) || 0,
            Number(position.z) || 0,
        );
        this.rotation?.set?.(
            Number(rotation.x) || 0,
            Number(rotation.y) || 0,
            Number(rotation.z) || 0,
            rotation.order || "XYZ",
        );
        this.velocity?.set?.(
            Number(entry.linearVelocity?.x) || 0,
            Number(entry.linearVelocity?.y) || 0,
            Number(entry.linearVelocity?.z) || 0,
        );
        this.acceleration?.set?.(
            Number(entry.linearAcceleration?.x) || 0,
            Number(entry.linearAcceleration?.y) || 0,
            Number(entry.linearAcceleration?.z) || 0,
        );
        if ("steeringAngle" in this || Number.isFinite(Number(entry.steeringAngle))) {
            this.steeringAngle = Number(entry.steeringAngle) || 0;
        }
        this.updatePosition?.(this.position);
        this.updateRotation?.(this.rotation);
    }

    getDeterministicState() {
        const vector = (value = {}) => ({
            x: Number(value.x) || 0,
            y: Number(value.y) || 0,
            z: Number(value.z) || 0,
        });
        return {
            id: String(this.telemetryId || this.id || ""),
            position: vector(this.position),
            rotation: { ...vector(this.rotation), order: this.rotation?.order || "XYZ" },
            velocity: vector(this.velocity),
            acceleration: vector(this.acceleration),
            steeringAngle: Number(this.steeringAngle) || 0,
        };
    }

    dispose() {
        const deviceDatabase = this.db?.getParent?.()?.devices?.();
        for (const device of [...this.devices]) {
            if (!deviceDatabase?.removeDevice?.(device)) {
                device.dispose?.();
            }
        }
        this.devices = [];
        this.sceneObject?.removeFromParent?.();
    }
}


// TOOD: give physics engine control stuff...
// TODO: JAX integration for physics engine and optimization, comms via client.
export class PhysicalVehicle extends Vehicle {
    /**
     * @param {VehicleDatabase} db 
     * @param {THREE.Vector3} position 
     * @param {THREE.Euler} rotation 
     */
    constructor(db, position=new THREE.Vector3(), rotation=new THREE.Euler()) {
        super(db, position, rotation);
        this.rigidBody = null; // to be set up by subclasses

        this.velocity = new THREE.Vector3(0, 0, 0);
        this.acceleration = new THREE.Vector3(0, 0, 0);
    }

    /**
     * Update the vehicle's physics state based on its velocity and acceleration.
     * @param {Number} deltaTime Delta time in seconds.
     */
    update(deltaTime) {
        // Simple physics integration (not using a physics engine here)
        this.velocity.addScaledVector(this.acceleration, deltaTime);
        const deltaPosition = new THREE.Vector3().copy(this.velocity).multiplyScalar(deltaTime);
        this.position.add(deltaPosition);
        this.updatePosition(this.position);
    }
}
