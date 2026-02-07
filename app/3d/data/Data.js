import { KeyManager } from "../managers/KeyManager";
import { MouseManager } from "../managers/MouseManager";
import { DeviceDatabase } from "./DeviceDatabase";
import { ObjectDatabase } from "./ObjectDatabase";
import { Settings } from "./Settings";

export class Data {
    constructor() {
        this.deviceDatabase = new DeviceDatabase(this);
        this.objectDatabase = new ObjectDatabase(this);
        this._settings = new Settings();
        this.keyManager = null;
        this.mouseManager = null;
        
        this.scene = null;
        this.camera = null;
        this.renderer = null;
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
     * @returns {KeyManager}
     */
    keys() {
        return this.keyManager;
    }

    /**
     * @returns {MouseManager}
     */
    mouse() {
        return this.mouseManager;
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