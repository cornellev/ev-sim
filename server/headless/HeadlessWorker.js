import process from "node:process";

import { HeadlessSession } from "./HeadlessSession.js";
import { ManagedHeadlessSession } from "./ManagedHeadlessSession.js";
import { HeadlessEpisode } from "../../app/simulation/headless/HeadlessEpisode.js";
import { validateSharedTensorReference } from "./SharedTensorArena.js";

let session = null;
let initialized = null;
let handling = false;
let nextRendererRequestId = 1;
const rendererRequests = new Map();

const rendererClient = {
    request(operation, payload) {
        if (!process.connected) return Promise.reject(Object.assign(new Error("Renderer IPC is disconnected."), { code: "WORKER_CRASHED", infrastructureFailure: true }));
        const requestId = nextRendererRequestId++;
        return new Promise((resolve, reject) => {
            rendererRequests.set(requestId, { resolve, reject });
            process.send?.({ kind: "cev-sim.renderer-request", requestId, operation, payload });
        });
    },
    captureGroup(payload) {
        return this.request("capture-group", payload);
    },
    provenance() {
        return this.request("provenance", {});
    },
    releaseSharedTensor(reference) {
        return this.request("release-shared", { reference });
    },
    async readSharedTensor(reference, spec) {
        return validateSharedTensorReference(reference, {
            environmentToken: String(reference.regionName).split(/[\\/]/).at(-1),
            spec,
        });
    },
};

function serializedError(error) {
    return {
        name: error?.name || "Error",
        code: error?.code || "INTERNAL",
        message: error?.message || "Worker command failed.",
        details: error?.details ?? null,
        stack: error?.stack || null,
    };
}

function health() {
    return session?.health() ?? {
        state: "idle",
        rssBytes: process.memoryUsage().rss,
        heapBytes: process.memoryUsage().heapUsed,
        lastCompletedStep: 0,
        queueBytes: 0,
        sensorQueueBytes: 0,
        recordingQueueBytes: 0,
    };
}

async function command(name, payload = {}) {
    switch (name) {
        case "initialize": {
            await session?.close();
            const managed = payload.mode === "managed-experiment";
            session = managed
                ? new ManagedHeadlessSession({ limits: payload.limits })
                : new HeadlessSession({
                    limits: payload.limits,
                    episodeFactory: () => new HeadlessEpisode({ rendererClient }),
                });
            const descriptor = await session.prepare(
                payload.bundle,
                managed ? { metricDefinitions: payload.metricDefinitions } : payload.episodeSpec,
            );
            initialized = {
                bundle: payload.bundle,
                episodeSpec: payload.episodeSpec,
                limits: payload.limits,
            };
            return { descriptor };
        }
        case "run-managed":
            if (!(session instanceof ManagedHeadlessSession)) throw Object.assign(new Error("Worker is not initialized for a managed experiment."), { code: "ENVIRONMENT_NOT_FOUND" });
            return { finalized: await session.run(payload) };
        case "reset": {
            if (!session || !initialized) throw Object.assign(new Error("Worker is not initialized."), { code: "ENVIRONMENT_NOT_FOUND" });
            const reset = await session.reset(payload.episodeSpec, {
                artifactPolicy: { ...payload.artifactPolicy, outputUri: payload.outputUri },
                outputUri: payload.outputUri,
            });
            return { reset };
        }
        case "step":
            if (!session) throw Object.assign(new Error("Worker is not initialized."), { code: "ENVIRONMENT_NOT_FOUND" });
            return { transition: await session.stepAsync(payload.action) };
        case "finalize":
            if (!session) throw Object.assign(new Error("Worker is not initialized."), { code: "ENVIRONMENT_NOT_FOUND" });
            return { finalized: await session.finalize(payload.options) };
        case "health":
            return { health: health() };
        case "close":
            await session?.close();
            session = null;
            initialized = null;
            return { closed: true };
        default:
            throw Object.assign(new Error(`Unknown worker command ${name}.`), { code: "INVALID_REQUEST" });
    }
}

process.on("message", async (message) => {
    if (message?.kind === "cev-sim.renderer-response") {
        const pending = rendererRequests.get(message.requestId);
        if (!pending) return;
        rendererRequests.delete(message.requestId);
        if (message.error) {
            const error = Object.assign(new Error(message.error.message), message.error);
            pending.reject(error);
        } else pending.resolve(message.result);
        return;
    }
    if (!message || message.kind !== "cev-sim.worker-request" || !Number.isSafeInteger(message.requestId)) return;
    if (handling) {
        process.send?.({
            kind: "cev-sim.worker-response",
            requestId: message.requestId,
            error: serializedError(Object.assign(new Error("Only one worker command may be in flight."), { code: "INTERNAL" })),
            health: health(),
        });
        return;
    }
    handling = true;
    try {
        const result = await command(message.command, message.payload);
        process.send?.({ kind: "cev-sim.worker-response", requestId: message.requestId, result, health: health() });
        if (message.command === "close") setImmediate(() => process.exit(0));
    } catch (error) {
        process.send?.({
            kind: "cev-sim.worker-response",
            requestId: message.requestId,
            error: serializedError(error),
            health: health(),
        });
    } finally {
        handling = false;
    }
});

process.on("disconnect", async () => {
    for (const pending of rendererRequests.values()) {
        pending.reject(Object.assign(new Error("Renderer IPC disconnected."), { code: "WORKER_CRASHED", infrastructureFailure: true }));
    }
    rendererRequests.clear();
    try {
        await session?.close();
    } finally {
        process.exit(0);
    }
});

const healthTimer = setInterval(() => {
    if (process.connected) process.send?.({ kind: "cev-sim.worker-health", health: health() });
}, Math.max(25, Number(process.env.CEV_SIM_WORKER_HEALTH_MS) || 250));
healthTimer.unref();
