import * as THREE from "three";
import { Data } from "../data/Data";

export class Vehicle {
    constructor() {
        this.position = new THREE.Vector3(0, 0, 0);
        this.rotation = new THREE.Euler(0, 0, 0);
        this.devices = [];

        this.sceneObject = new THREE.Group(); // to be created by subclasses
    }

    /**
     * Set up any devices (sensors) on the vehicle and add them to the scene.
     * @param {Data} data 
     */
    setupDevices(data) {
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

    /**
     * Update the vehicle's position in the scene.
     * @param {THREE.Vector3} new_position 
     */
    updatePosition(new_position) {
        this.position.copy(new_position);
        this.sceneObject.position.copy(this.position);
    }

    /**
     * Update the vehicle's rotation in the scene.
     * @param {THREE.Euler} new_rotation 
     */
    updateRotation(new_rotation) {
        this.rotation.copy(new_rotation);
        this.sceneObject.rotation.copy(this.rotation);
    }
}