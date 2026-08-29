import { sensorTypeRegistry } from "../devices/SensorTypeRegistry.js";

const COMMON_SIGNALS = Object.freeze([
    { suffix: "enabled", type: "boolean", replayRole: "state", logClass: "standard" },
    { suffix: "pose", type: "pose3", replayRole: "state", logClass: "standard" },
    { suffix: "output", type: "json", replayRole: "derived", logClass: "standard" },
    { suffix: "captureAttempts", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "capturedFrames", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "deliveredFrames", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "droppedFrames", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "pointDrops", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "missedDeadlines", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "shaderBusyDrops", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "queueDepth", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "queueHighWaterMark", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "captureTimeNs", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "captureTimeTotalNs", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "encodeTimeNs", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "encodeTimeTotalNs", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "transportTimeNs", type: "uint64", replayRole: "state", logClass: "standard" },
    { suffix: "transportTimeTotalNs", type: "uint64", replayRole: "state", logClass: "standard" },
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

