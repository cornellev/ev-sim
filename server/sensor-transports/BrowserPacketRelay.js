import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { decodeRelayFrame } from "../../app/simulation/sensors/BrowserPacketRelaySink.js";
import {
    hostDescriptorFromConfig,
    resolveSensorTransportHostConfig,
} from "./SensorTransportConfig.js";
import { UdpTransportRuntime } from "./UdpTransportRuntime.js";
import { udpTransportError } from "./UdpTransportErrors.js";

const GENERATION = 1;

function unsupported(message) {
    return udpTransportError("UNSUPPORTED_CAPABILITY", message, { operation: "browser-relay" });
}

/** Reads the host config named by CEV_SIM_BROWSER_PACKET_TRANSPORTS, or null when unset. */
export async function readBrowserPacketHostConfig(env = process.env) {
    const file = env.CEV_SIM_BROWSER_PACKET_TRANSPORTS;
    if (!file) return null;
    return resolveSensorTransportHostConfig(JSON.parse(await fs.readFile(file, "utf8")), {
        path: "CEV_SIM_BROWSER_PACKET_TRANSPORTS",
    });
}

/**
 * Sends browser-produced native packets through UdpTransportRuntime. One
 * browser session at a time: a new session releases the previous one, since
 * UDP source binds are exclusive.
 */
export class BrowserPacketRelay {
    constructor({ hostConfig = null, runtime = null } = {}) {
        this.hostConfig = hostConfig?.udp ? hostConfig : null;
        this.runtime = runtime ?? new UdpTransportRuntime();
        this.session = null;
    }

    hostDescriptor() {
        return hostDescriptorFromConfig(this.hostConfig ? { ...this.hostConfig, pcap: undefined } : null);
    }

    async open({ bindings = [], stepNs = 1 } = {}) {
        if (!this.hostConfig) throw unsupported("Browser packet relay has no UDP host config.");
        const endpoints = new Map();
        for (const binding of bindings) {
            if (binding?.adapter !== "udp") throw unsupported(`Browser packet relay only sends UDP, not "${binding?.adapter}".`);
            const endpoint = this.hostConfig.udp.endpoints.find((entry) => entry.id === binding.endpointId);
            if (!endpoint) throw unsupported(`UDP endpoint "${binding.endpointId}" is not configured.`);
            // Browser steps are not anchored to the server clock, so packet-offset deadlines cannot hold.
            if (endpoint.pacing.mode !== "burst") throw unsupported(`UDP endpoint "${endpoint.id}" must use burst pacing for browser runs.`);
            endpoints.set(endpoint.id, endpoint);
        }
        if (endpoints.size === 0) throw unsupported("Browser packet relay session needs at least one UDP binding.");
        await this.close();
        const environmentKey = `browser-${randomUUID()}`;
        await this.runtime.prepareEnvironment({
            environmentKey,
            endpoints: [...endpoints.values()],
            bindings,
            maxQueueBytes: this.hostConfig.udp.maxQueueBytesPerEnvironment,
            stepNs,
        });
        try {
            await this.runtime.beginGeneration({ environmentKey, generation: GENERATION });
        } catch (error) {
            await this.runtime.releaseEnvironment({ environmentKey });
            throw error;
        }
        this.session = environmentKey;
        return { sessionId: environmentKey };
    }

    async submit(sessionId, bytes) {
        if (!this.session || sessionId !== this.session) {
            throw udpTransportError("ENVIRONMENT_NOT_FOUND", `Browser packet relay session "${sessionId}" is not open.`, {
                operation: "submit-batch",
            });
        }
        const batches = decodeRelayFrame(bytes);
        for (const batch of batches) {
            for (const packet of batch.packets) {
                const digest = createHash("sha256").update(packet.payload).digest("hex");
                if (packet.payloadDigest !== digest) {
                    throw unsupported(`Packet ${batch.sensorId}/${packet.productId}/${packet.streamId}#${packet.packetIndex} digest mismatch.`);
                }
            }
        }
        let accepted = 0;
        try {
            for (const batch of batches) {
                const result = await this.runtime.submitBatch({ ...batch, environmentKey: sessionId, generation: GENERATION });
                accepted += result.accepted;
            }
        } catch (error) {
            // Runtime failures are reset-required; free the sockets so the next run can bind.
            await this.close();
            throw error;
        }
        return { accepted };
    }

    async close(sessionId = this.session) {
        if (!this.session || sessionId !== this.session) return { released: false };
        const environmentKey = this.session;
        this.session = null;
        await this.runtime.cancelGeneration({ environmentKey });
        return this.runtime.releaseEnvironment({ environmentKey });
    }

    async shutdown() {
        await this.close();
        await this.runtime.shutdown();
    }
}
