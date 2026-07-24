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
        if (!device.telemetryId) device.telemetryId = `device-${this.devices.length + 1}`;
        this.devices.push(device);
        device.parent = this;
        const telemetry = this.parent?.bindings?.()?.signalStore;
        const prefix = `devices.${device.telemetryId}`;
        telemetry?.defineSignal?.({ path: `${prefix}.enabled`, type: "boolean", source: "devices", category: "devices", replayRole: "state", logClass: "standard" });
        telemetry?.defineSignal?.({ path: `${prefix}.pose`, type: "pose3", source: "devices", category: "devices", replayRole: "state", logClass: "standard" });
        telemetry?.defineSignal?.({ path: `${prefix}.output`, type: "bytes", source: "devices", category: "devices", replayRole: "derived", logClass: "heavy", metadata: { deviceType: device.constructor?.name || "Device" } });
        telemetry?.emitTelemetryEvent?.({ category: "devices", name: "device-added", payload: { id: device.telemetryId, type: device.constructor?.name || "Device" } });
    }

    disableLoop() {
        this.loopDisabled = true;
    }

    setup(scene) {
        for (const device of this.devices) {
            device.setup(scene);
        }
        
        console.log("Setup", this.devices.length, "devices");
    }

    update(dt) {
        if (this.loopDisabled) return;

        this.execute(dt);
    }

    execute(dt) {
        for (const device of this.devices) {
            if (device.enabled) {
                device.execute(dt);
            }
            this._publishDevice(device);
        }
    }

    async asyncExecute(dt) {
        for (const device of this.devices) {
            if (device.enabled) {
                await device.execute(dt);
            }
            this._publishDevice(device);
        }
    }

    _publishDevice(device) {
        const telemetry = this.parent?.bindings?.()?.signalStore;
        if (!telemetry || !device.telemetryId) return;
        const prefix = `devices.${device.telemetryId}`;
        const position = device.getPosition?.();
        const rotation = device.getRotation?.();
        const options = { source: "devices", category: "devices", replayRole: "state", logClass: "standard" };
        telemetry.publishSignal(`${prefix}.enabled`, Boolean(device.enabled), { ...options, type: "boolean" });
        telemetry.publishSignal(`${prefix}.pose`, {
            position: { x: Number(position?.x || 0), y: Number(position?.y || 0), z: Number(position?.z || 0) },
            rotation: { x: Number(rotation?.x || 0), y: Number(rotation?.y || 0), z: Number(rotation?.z || 0), order: rotation?.order || "XYZ" },
        }, { ...options, type: "pose3" });
    }
}
