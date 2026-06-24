import { Client } from "@/app/client/Client";
import { KeyManager } from "../managers/KeyManager";
import { MouseManager } from "../managers/MouseManager";
import { City } from "./City";
import { DeviceDatabase } from "./DeviceDatabase";
import { ObjectDatabase } from "./ObjectDatabase";
import { Settings } from "./Settings";
import { VehicleDatabase } from "./VehicleDatabase";
import { ClientManager } from "../managers/ClientManager";
import { PhysicsEngine } from "@/app/physics/PhysicsEngine";
import { SimulationEngine } from "@/app/simulation/SimulationEngine";

export class Data {
    constructor() {
        this.deviceDatabase = new DeviceDatabase(this);
        this.objectDatabase = new ObjectDatabase(this);
        this.vehicleDatabase = new VehicleDatabase(this);
        this.cityDatabase = new City(this);
        this.physicsEngine = new PhysicsEngine(this);
        this._settings = new Settings();
        this.keyManager = null;
        this.mouseManager = null;

        this.clientManager = new ClientManager(this);

        this.simulationEngine = new SimulationEngine(this);
        this.bakeHarness = null;
        
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.spark = null;

        (async () => {
            await this.clientManager.setup();
        })();
    }

    /**
     * @return {ClientManager}
     */
    client() {
        return this.clientManager; 
    }

    /**
     * @return {PhysicsEngine}
     */
    physics() {
        return this.physicsEngine;
    }

    /**
     * @returns {DeviceDatabase}
     */
    devices() {
        return this.deviceDatabase;
    }

    /**
     * @returns {ObjectDatabase}
     */
    objects() {
        return this.objectDatabase;
    }
    
    /**
     * @returns {Settings}
     */
    settings() {
        return this._settings;
    }

    /**
     * @returns {VehicleDatabase}
     */
    vehicles() {
        return this.vehicleDatabase;
    }

    /**
     * @returns {KeyManager}
     */
    keys() {
        return this.keyManager;
    }

    /**
     * @returns {SimulationEngine}
     */
    simulation() {
        return this.simulationEngine;
    }

    /**
     * @param {import("../environment/visualization/BakeHarness").BakeHarness|null} harness
     */
    setBakeHarness(harness) {
        this.bakeHarness = harness;
    }

    /**
     * @returns {import("../environment/visualization/BakeHarness").BakeHarness|null}
     */
    baking() {
        return this.bakeHarness;
    }

    /**
     * @returns {MouseManager}
     */
    mouse() {
        return this.mouseManager;
    }

    /**
     * @returns {City}
     */
    city() {
        return this.cityDatabase;
    }
    
    /**
     * @returns {Object} containing scene, camera, renderer
     * @returns {{scene:THREE.Scene, camera:THREE.Camera, renderer:THREE.WebGLRenderer}}
     */
    three() {
        return {
            scene: this.scene,
            camera: this.camera,
            renderer: this.renderer
        };
    }
}