import Device from "../devices/Device";
import { Database } from "./Database";
import { validateDeviceTelemetryId } from "./DeviceTelemetryId";
import { createRunSensorDevice } from "../devices/SensorRuntimeRegistry.js";
import { getDeviceTelemetrySignals } from "./DeviceTelemetrySignals.js";

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
        const signals = getDeviceTelemetrySignals(device);
        for (const signal of signals) {
            telemetry?.defineSignal?.({
                path: `${prefix}.${signal.suffix}`,
                type: signal.type,
                source: "devices",
                category: "devices",
                replayRole: signal.replayRole,
                logClass: signal.logClass,
                ...(signal.metadata ? { metadata: signal.metadata } : {}),
            });
        }
        device._telemetrySignalSuffixes = signals.map((signal) => signal.suffix);
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
        for (const suffix of device._telemetrySignalSuffixes || getDeviceTelemetrySignals(device).map((signal) => signal.suffix)) {
            telemetry?.removeSignal?.(`devices.${previousId}.${suffix}`);
        }
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

    configureFromManifest(sensorRig = {}, options = {}) {
        const previous = this.devices.filter((device) => device.manifestManaged);
        for (const device of previous) {
            device.dispose?.();
            if (device.parentVehicle) {
                device.parentVehicle.devices = device.parentVehicle.devices.filter((candidate) => candidate !== device);
            }
            this.devices = this.devices.filter((candidate) => candidate !== device);
        }
        for (const device of this.devices) {
            if (!device.manifestManaged && !device.vehicleOwned) {
                device._legacyEnabledBeforeRun ??= device.enabled;
                device.enabled = false;
            }
        }

        const vehicles = this.parent?.vehicles?.()?.vehicles || [];
        const byId = new Map(vehicles.map((vehicle, index) => [vehicle.telemetryId || `vehicle-${index + 1}`, vehicle]));
        for (const config of [...(sensorRig.sensors || [])].sort((left, right) => left.id.localeCompare(right.id))) {
            if (config.enabled === false) continue;
            const device = createRunSensorDevice(config, options);
            const vehicle = byId.get(config.parentId);
            if (!vehicle) throw new Error(`Sensor "${config.id}" references unknown parent vehicle "${config.parentId}".`);
            this.addDevice(device);
            device.parentVehicle = vehicle;
            vehicle.devices.push(device);
            if (this.parent?.scene) device.setup(this.parent.scene);
        }
        this.loopDisabled = false;
    }

    resetSchedule() {
        for (const device of this.devices) device.contractPublisher?.reset?.();
    }

    update(dt, clock = null) {
        if (this.loopDisabled) return;
        const ordered = [...this.devices].sort((left, right) => String(left.telemetryId || "").localeCompare(String(right.telemetryId || "")));
        for (const device of ordered) {
            if (device.enabled && device.contractPublisher && clock) device.contractPublisher.update(clock);
            else if (device.enabled && !device.contractPublisher) device.execute(dt);
            this._publishDevice(device, clock);
        }
    }

    deliver(clock) {
        const ordered = [...this.devices].sort((left, right) => String(left.telemetryId || "").localeCompare(String(right.telemetryId || "")));
        for (const device of ordered) device.contractPublisher?.deliver?.(clock);
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

    _publishDevice(device, clock = null) {
        const telemetry = this.parent?.bindings?.()?.signalStore;
        if (!telemetry || !device.telemetryId) return;
        const prefix = `devices.${device.telemetryId}`;
        const position = device.getPosition?.();
        const rotation = device.getRotation?.();
        const options = {
            source: "devices", category: "devices", replayRole: "state", logClass: "standard",
            ...(clock ? { timeUs: Math.round(clock.timeNs / 1000), cycle: clock.step } : {}),
        };
        telemetry.publishSignal(`${prefix}.enabled`, Boolean(device.enabled), { ...options, type: "boolean" });
        telemetry.publishSignal(`${prefix}.pose`, {
            position: { x: Number(position?.x || 0), y: Number(position?.y || 0), z: Number(position?.z || 0) },
            rotation: { x: Number(rotation?.x || 0), y: Number(rotation?.y || 0), z: Number(rotation?.z || 0), order: rotation?.order || "XYZ" },
        }, { ...options, type: "pose3" });
    }
}
