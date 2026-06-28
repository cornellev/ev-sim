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
import { Environment } from "../environment/Environment";

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
        // Environment runtime (editor, registry, chunks). Access via environment(); document is environment().getDocument().
        this.environmentDocument = new Environment(this);
        this.bakeHarness = null;
        this._bakeRunConfig = null;
        this._splatAccumulator = null;
        this._skyManager = null;
        
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
     * @returns {Environment}
     */
    environment() {
        return this.environmentDocument;
    }

    editor() {
        return this.environmentDocument.editor();
    }

    sky() {
        return this.environmentDocument.sky();
    }

    setSkyManager(manager) {
        this._skyManager = manager;
    }

    skyManager() {
        return this._skyManager;
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
     * @param {import("../environment/visualization/BakeRunConfig").BakeRunConfig|null} config
     */
    setBakeRunConfig(config) {
        this._bakeRunConfig = config;
    }

    /**
     * @returns {import("../environment/visualization/BakeRunConfig").BakeRunConfig|null}
     */
    bakeRunConfig() {
        return this._bakeRunConfig;
    }

    /**
     * @param {import("../environment/visualization/SplatAccumulator").SplatAccumulator|null} accumulator
     */
    setSplatAccumulator(accumulator) {
        this._splatAccumulator = accumulator;
    }

    /**
     * @returns {import("../environment/visualization/SplatAccumulator").SplatAccumulator|null}
     */
    splats() {
        return this._splatAccumulator;
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