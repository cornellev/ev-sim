import Device from "../devices/Device";
import { Database } from "./Database";

export class DeviceDatabase extends Database {
    constructor(parent) {
        super(parent);
        this.devices = [];

        this.loopDisabled = false; // set to true to disable automatic execution loop (for manual control in tests, etc.)
    }

    /**
     * 
     * @param {Device} device 
     */
    addDevice(device) {
        this.devices.push(device);
        device.parent = this;
    }

    disableLoop() {
        this.loopDisabled = true;
    }

    setup(scene) {
        for (const device of this.devices) {
            device.setup(scene);
        }
        
        console.log("Setup", this.devices.length, "devices");

        const animate = () => {
            requestAnimationFrame(animate);
            if (!this.loopDisabled) this.execute();
        };
        animate();
    }

    execute() {
        for (const device of this.devices) {
            if (device.enabled) {
                device.execute();
            }
        }
    }

    async asyncExecute() {
        for (const device of this.devices) {
            if (device.enabled) {
                await device.execute();
            }
        }
    }
}