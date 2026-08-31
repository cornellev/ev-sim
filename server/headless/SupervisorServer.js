import { promises as fs } from "node:fs";

import { loadHeadlessGrpcSchema } from "./GrpcSchema.js";
import { HeadlessSupervisor } from "./HeadlessSupervisor.js";
import { resolveSupervisorConfig } from "./SupervisorConfig.js";

async function prepareSocket(socketPath) {
    let stat;
    try {
        stat = await fs.lstat(socketPath);
    } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path ${socketPath}.`);
    await fs.unlink(socketPath);
}

function unary(handler, supervisor, { allowDuringShutdown = false } = {}) {
    return async (call, callback) => {
        const abort = new AbortController();
        const onCancelled = () => abort.abort();
        call.on("cancelled", onCancelled);
        try {
            if (supervisor.shuttingDown && !allowDuringShutdown) {
                const error = new Error("Supervisor is shutting down.");
                error.code = loadHeadlessGrpcSchema().grpc.status.UNAVAILABLE;
                callback(error);
                return;
            }
            callback(null, await handler(call.request, { signal: abort.signal }));
        } catch (error) {
            callback(null, { error: { code: 14, message: error.message, retryable: false, canonicalDetailJson: Buffer.alloc(0) } });
        } finally {
            call.removeListener("cancelled", onCancelled);
        }
    };
}

function bind(server, address, credentials) {
    return new Promise((resolve, reject) => {
        server.bindAsync(address, credentials, (error, port) => error ? reject(error) : resolve(port));
    });
}

function shutdown(server, graceMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            server.forceShutdown();
            done();
        }, graceMs);
        server.tryShutdown(done);
    });
}

export async function startHeadlessSupervisor(options = {}) {
    const config = options.config?.listener
        ? options.config
        : resolveSupervisorConfig(options);
    const supervisor = options.supervisor ?? new HeadlessSupervisor({ ...config, workerFactory: options.workerFactory });
    const { grpc, service } = loadHeadlessGrpcSchema();
    const server = new grpc.Server({
        "grpc.max_receive_message_length": config.maxRpcMessageBytes,
        "grpc.max_send_message_length": config.maxRpcMessageBytes,
    });
    server.addService(service.service, {
        getCapabilities: unary((request) => supervisor.getCapabilities(request), supervisor),
        createBatch: unary((request, context) => supervisor.createBatch(request, context), supervisor),
        resetBatch: unary((request, context) => supervisor.resetBatch(request, context), supervisor),
        stepBatch: unary((request, context) => supervisor.stepBatch(request, context), supervisor),
        finalizeBatch: unary((request, context) => supervisor.finalizeBatch(request, context), supervisor),
        closeBatch: unary((request, context) => supervisor.closeBatch(request, context), supervisor),
        health: unary((request) => supervisor.health(request), supervisor, { allowDuringShutdown: true }),
    });
    let address;
    if (config.listener.kind === "socket") {
        await prepareSocket(config.listener.path);
        address = `unix:${config.listener.path}`;
    } else {
        address = config.listener.address;
    }
    const boundPort = await bind(server, address, grpc.ServerCredentials.createInsecure());
    let closed = false;
    return {
        supervisor,
        server,
        config,
        address: config.listener.kind === "socket"
            ? config.listener.path
            : config.listener.host.includes(":") ? `[${config.listener.host}]:${boundPort}` : `${config.listener.host}:${boundPort}`,
        async close() {
            if (closed) return;
            closed = true;
            await supervisor.close();
            await shutdown(server, config.shutdownGraceMs);
            if (config.listener.kind === "socket") {
                try {
                    await fs.unlink(config.listener.path);
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }
            }
        },
    };
}
