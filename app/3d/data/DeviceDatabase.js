import Device from "../devices/Device";
import { Database } from "./Database";
import { validateDeviceTelemetryId } from "./DeviceTelemetryId";

const DEVICE_SIGNAL_SUFFIXES = ["enabled", "pose", "output"];

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
        if (!device.telemetryId) device.telemetryId = device.settings?.telemetryId || this._nextTelemetryId();
        const validation = validateDeviceTelemetryId(
            device.telemetryId,
            this.devices.map((candidate) => candidate.telemetryId),
        );
        if (!validation.ok) device.telemetryId = this._nextTelemetryId();
        this.devices.push(device);
        device.parent = this;
        if (device.settings && typeof device.settings === "object") device.settings.telemetryId = device.telemetryId;
        this._defineDeviceSignals(device);
        const telemetry = this.parent?.bindings?.()?.signalStore;
        telemetry?.emitTelemetryEvent?.({ category: "devices", name: "device-added", payload: { id: device.telemetryId, type: device.constructor?.name || "Device" } });
    }

    _nextTelemetryId() {
        const used = new Set(this.devices.map((device) => device.telemetryId));
        let index = this.devices.length + 1;
        while (used.has(`device-${index}`)) index += 1;
        return `device-${index}`;
    }

    _defineDeviceSignals(device) {
        const telemetry = this.parent?.bindings?.()?.signalStore;
        const prefix = `devices.${device.telemetryId}`;
        telemetry?.defineSignal?.({ path: `${prefix}.enabled`, type: "boolean", source: "devices", category: "devices", replayRole: "state", logClass: "standard" });
        telemetry?.defineSignal?.({ path: `${prefix}.pose`, type: "pose3", source: "devices", category: "devices", replayRole: "state", logClass: "standard" });
        telemetry?.defineSignal?.({ path: `${prefix}.output`, type: "bytes", source: "devices", category: "devices", replayRole: "derived", logClass: "heavy", metadata: { deviceType: device.constructor?.name || "Device" } });
    }

    renameTelemetryId(device, value) {
        if (!this.devices.includes(device)) throw new Error("The device is not registered in this simulation.");
        const previousId = device.telemetryId;
        const validation = validateDeviceTelemetryId(
            value,
            this.devices.filter((candidate) => candidate !== device).map((candidate) => candidate.telemetryId),
        );
        if (!validation.ok) throw new Error(validation.error);
        if (validation.id === previousId) return previousId;

        const telemetry = this.parent?.bindings?.()?.signalStore;
        for (const suffix of DEVICE_SIGNAL_SUFFIXES) telemetry?.removeSignal?.(`devices.${previousId}.${suffix}`);
        device.telemetryId = validation.id;
        if (device.settings && typeof device.settings === "object") device.settings.telemetryId = validation.id;
        this._defineDeviceSignals(device);
        this._publishDevice(device);
        telemetry?.emitTelemetryEvent?.({
            category: "devices",
            name: "device-telemetry-id-renamed",
            payload: { previousId, id: validation.id, type: device.constructor?.name || "Device" },
        });
        return validation.id;
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
