import process from "node:process";

import { UdpTransportRuntime } from "./UdpTransportRuntime.js";
import { serializedUdpError } from "./UdpTransportErrors.js";

const runtime = new UdpTransportRuntime({
    identity: Object.freeze({
        kind: "cev-sim.udp-transport-runtime",
        version: 1,
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
    }),
});

async function command(name, payload = {}) {
    switch (name) {
        case "prepare-environment":
            return runtime.prepareEnvironment(payload);
        case "begin-generation":
            return runtime.beginGeneration(payload);
        case "submit-batch":
            return runtime.submitBatch(payload);
        case "finalize-generation":
            return runtime.finalizeGeneration(payload);
        case "cancel-generation":
            return runtime.cancelGeneration(payload);
        case "release-environment":
            return runtime.releaseEnvironment(payload);
        case "queued-bytes":
            return { queuedBytes: runtime.queuedBytesFor(payload.environmentKey) };
        case "shutdown":
            await runtime.shutdown();
            return { shutdown: true };
        default:
            throw Object.assign(new Error(`Unknown UDP sidecar command ${name}.`), { code: "INVALID_REQUEST" });
    }
}

process.on("message", async (message) => {
    if (!message || message.kind !== "cev-sim.udp-sidecar-request" || !Number.isSafeInteger(message.requestId)) {
        return;
    }
    try {
        const result = await command(message.command, message.payload);
        process.send?.({
            kind: "cev-sim.udp-sidecar-response",
            requestId: message.requestId,
            result,
        });
        if (message.command === "shutdown") setImmediate(() => process.exit(0));
    } catch (error) {
        process.send?.({
            kind: "cev-sim.udp-sidecar-response",
            requestId: message.requestId,
            error: serializedUdpError(error),
        });
    }
});

process.on("disconnect", async () => {
    try {
        await runtime.shutdown();
    } finally {
        process.exit(0);
    }
});
