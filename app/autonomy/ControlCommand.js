import { validateNativeTopicValue } from "../simulation/NativeTopicContracts.js";
import { emptyInternalCommand, CONTROL_MODES } from "./ControlCommandAdapter.js";

export function normalizeControlSetpoint(value) {
    if (value == null) return null;
    const fields = ["speedMps", "accelerationMps2", "jerkMps3", "steeringRad", "steeringRateRadps"];
    if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["mode", ...fields].includes(key))) throw new Error("Invalid native control setpoint.");
    const mode = value.mode ?? "stop";
    if (!CONTROL_MODES.includes(mode)) throw new Error("Invalid native control mode.");
    const result = { mode };
    for (const field of fields) { result[field] = value[field] ?? 0; if (typeof result[field] !== "number" || !Number.isFinite(result[field])) throw new Error(`Invalid native control ${field}.`); }
    return result;
}

export function normalizeControlCommand(value, { runId, frameId = "base_link", applyTimeNs = 0, producer = "candidate", source = "topic" } = {}) {
    const invalid = (code, message) => ({ ok: false, code, message, command: null });
    const validation = validateNativeTopicValue("cev.control-command", value);
    if (!validation.ok) return invalid(validation.code, validation.message);
    if (typeof value.sequence !== "string") return invalid("invalid-sequence", "Native command sequence requires an exact decimal string.");
    if (runId !== undefined && value.runId !== runId) return invalid("run-mismatch", "Command belongs to another run.");
    if (!CONTROL_MODES.includes(value.mode)) return invalid("invalid-mode", "Unsupported command mode.");
    if (value.frameId !== frameId) return invalid("invalid-frame", "Command frame does not match the controlled base frame.");
    if (value.captureTimeNs > applyTimeNs) return invalid("future-capture", "Command capture time is in the future.");
    if (value.deadlineNs > 0 && (value.deadlineNs < value.captureTimeNs || applyTimeNs > value.deadlineNs)) return invalid("expired-deadline", "Command deadline has passed or precedes capture.");
    const stop = value.mode === "stop";
    return { ok: true, command: emptyInternalCommand({ ...value,
        deadlineNs: value.deadlineNs || null, speedMps: stop ? 0 : value.speedMps,
        accelerationMps2: stop ? 0 : value.accelerationMps2,
        steeringRadRep103: stop ? 0 : value.steeringRad, steeringRadThree: stop ? 0 : value.steeringRad,
        producer, source }) };
}

export function controlCommandValue(command, { runId = "", applyTimeNs = 0, frameId = "base_link" } = {}) {
    return { runId, mode: command.mode === "hold" ? "velocity" : command.mode || "stop", sequence: String(command.sequence || 0),
        captureTimeNs: command.captureTimeNs ?? applyTimeNs, deadlineNs: command.deadlineNs ?? 0,
        frameId: command.frameId || frameId, speedMps: command.speedMps || 0, accelerationMps2: command.accelerationMps2 || 0,
        jerkMps3: command.jerkMps3 || 0, steeringRad: command.steeringRadRep103 || 0, steeringRateRadps: command.steeringRateRadps || 0 };
}
