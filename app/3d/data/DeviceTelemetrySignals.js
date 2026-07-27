import { sensorTypeRegistry } from "../devices/SensorTypeRegistry.js";

const COMMON_SIGNALS = Object.freeze([
    { suffix: "enabled", type: "boolean", replayRole: "state", logClass: "standard" },
    { suffix: "pose", type: "pose3", replayRole: "state", logClass: "standard" },
    { suffix: "output", type: "bytes", replayRole: "derived", logClass: "heavy" },
    { suffix: "droppedFrames", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "errors", type: "uint64", replayRole: "state", logClass: "standard" },
]);

export function getDeviceTelemetrySignals(device, registry = sensorTypeRegistry) {
    const outputs = registry.get(device.config?.type)?.run.outputs || device.telemetryOutputs || [];
    const deviceType = device.constructor?.name || "Device";
    return [
        ...COMMON_SIGNALS.map((signal) => ({
            ...signal,
            metadata: signal.suffix === "output" ? { deviceType } : undefined,
        })),
        ...outputs.map((output) => ({
            suffix: output.signal,
            type: "bytes",
            replayRole: "derived",
            logClass: "heavy",
            metadata: {
                deviceType,
                rosType: device.config?.schema?.[output.key] || output.rosType,
            },
        })),
    ];
}

