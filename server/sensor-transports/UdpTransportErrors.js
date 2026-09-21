import { HeadlessRunnerError } from "../headless/HeadlessRunnerErrors.js";

export function udpTransportError(code, message, details = {}) {
    const error = new HeadlessRunnerError(code, message, {
        component: "udp-sidecar",
        endpointId: details.endpointId ?? null,
        generation: details.generation ?? null,
        operation: details.operation ?? null,
        uncertainSubmission: details.uncertainSubmission === true,
        requiresReset: true,
        ...(details.extra && typeof details.extra === "object" ? details.extra : {}),
    });
    error.requiresReset = true;
    return error;
}

export function serializedUdpError(error) {
    return {
        name: error?.name || "Error",
        code: error?.code || "INTERNAL",
        message: error?.message || "UDP transport failed.",
        details: error?.details ?? null,
        requiresReset: error?.requiresReset !== false,
        stack: error?.stack || null,
    };
}

export function reviveUdpError(value, fallback = "INTERNAL") {
    if (value instanceof HeadlessRunnerError) return value;
    const error = udpTransportError(value?.code || fallback, value?.message || "UDP transport failed.", {
        endpointId: value?.details?.endpointId,
        generation: value?.details?.generation,
        operation: value?.details?.operation,
        uncertainSubmission: value?.details?.uncertainSubmission === true,
        extra: value?.details && typeof value.details === "object" ? value.details : {},
    });
    if (value?.stack) error.stack = value.stack;
    return error;
}
