import { sensorTypeRegistry } from "./SensorTypeRegistry.js";

export class SensorRuntimeFactoryRegistry {
    constructor({ definitions = sensorTypeRegistry, createUnknownPreview = () => null } = {}) {
        this.definitions = definitions;
        this.createUnknownPreview = createUnknownPreview;
        this.factories = new Map();
    }

    register(type, factories) {
        if (!this.definitions.get(type)) throw new Error(`Cannot register runtime for unknown sensor type "${type}".`);
        if (this.factories.has(type)) throw new Error(`Runtime for sensor type "${type}" is already registered.`);
        const normalized = Object.freeze({ ...factories });
        this.factories.set(type, normalized);
        return normalized;
    }

    get(type) {
        return this.factories.get(String(type ?? "")) || null;
    }

    createRunDevice(config, options = {}) {
        const factory = this.get(config?.type)?.createRunDevice;
        if (!factory) throw new Error(`Unsupported run sensor type "${config?.type}".`);
        return factory(config, options);
    }

    createVehicleDevice(entry, context = {}) {
        const factory = this.get(entry?.type)?.createVehicleDevice;
        if (!factory) throw new Error(`Unsupported vehicle sensor type "${entry?.type}".`);
        return factory(entry, context);
    }

    createPreview(sensor) {
        const factory = this.get(sensor?.type)?.createPreview;
        return factory ? factory(sensor) : this.createUnknownPreview(sensor);
    }

    previewSignature(sensor) {
        const factory = this.get(sensor?.type)?.previewSignature;
        return factory ? factory(sensor) : String(sensor?.type || "unknown");
    }
}

