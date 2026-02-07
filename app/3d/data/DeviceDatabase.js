import Device from "../devices/Device";
import { Database } from "./Database";

export class DeviceDatabase extends Database {
    constructor(parent) {
        super(parent);
        this.devices = [];
    }

    /**
     * 
     * @param {Device} device 
     */
    addDevice(device) {
        this.devices.push(device);
        device.parent = this;
    }

    setup(scene) {
        for (const device of this.devices) {
            device.setup(scene);
        }

        const animate = () => {
            requestAnimationFrame(animate);
            this.execute();
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
}