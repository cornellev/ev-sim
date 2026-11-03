export const BROWSER_PACKET_RELAY_FRAME_KIND = "cev-sim.browser-packet-relay-frame";
export const BROWSER_PACKET_RELAY_FRAME_VERSION = 1;

const MAGIC = new Uint8Array([0x43, 0x45, 0x56, 0x52]); // CEVR
const PREFIX_BYTES = MAGIC.length + 4;
const EMPTY_HOST = Object.freeze({ adapters: Object.freeze([]), endpoints: Object.freeze([]) });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function jsonSafe(_key, value) {
    return typeof value === "bigint" ? value.toString() : value;
}

/** Frame layout: "CEVR", u32 LE header length, UTF-8 JSON header, payload bytes in header order. */
export function encodeRelayFrame(batches) {
    const payloads = [];
    const header = {
        kind: BROWSER_PACKET_RELAY_FRAME_KIND,
        version: BROWSER_PACKET_RELAY_FRAME_VERSION,
        batches: batches.map((batch) => ({
            sensorId: batch.sensorId,
            sampleIndex: batch.sampleIndex,
            actualDeliveryStep: batch.actualDeliveryStep,
            captureTimeNs: batch.captureTimeNs,
            scheduledDeliveryTimeNs: batch.scheduledDeliveryTimeNs,
            deliveryTimeNs: batch.deliveryTimeNs,
            packets: batch.packets.map((packet) => {
                payloads.push(packet.payload);
                return {
                    productId: packet.productId,
                    streamId: packet.streamId,
                    packetIndex: packet.packetIndex,
                    offsetNs: packet.offsetNs,
                    byteLength: packet.payload.byteLength,
                    payloadDigest: packet.payloadDigest,
                };
            }),
        })),
    };
    const headerBytes = textEncoder.encode(JSON.stringify(header, jsonSafe));
    const total = PREFIX_BYTES + headerBytes.byteLength
        + payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
    const frame = new Uint8Array(total);
    frame.set(MAGIC, 0);
    new DataView(frame.buffer).setUint32(MAGIC.length, headerBytes.byteLength, true);
    frame.set(headerBytes, PREFIX_BYTES);
    let offset = PREFIX_BYTES + headerBytes.byteLength;
    for (const payload of payloads) {
        frame.set(payload, offset);
        offset += payload.byteLength;
    }
    return frame;
}

export function decodeRelayFrame(bytes) {
    const frame = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (frame.byteLength < PREFIX_BYTES || MAGIC.some((value, index) => frame[index] !== value)) {
        throw new Error("Browser packet relay frame has no CEVR prefix.");
    }
    const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
        .getUint32(MAGIC.length, true);
    if (PREFIX_BYTES + headerLength > frame.byteLength) {
        throw new Error("Browser packet relay frame header is truncated.");
    }
    const header = JSON.parse(textDecoder.decode(frame.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength)));
    if (header?.kind !== BROWSER_PACKET_RELAY_FRAME_KIND || header.version !== BROWSER_PACKET_RELAY_FRAME_VERSION
        || !Array.isArray(header.batches)) {
        throw new Error(`Browser packet relay frame must be ${BROWSER_PACKET_RELAY_FRAME_KIND} version 1.`);
    }
    let offset = PREFIX_BYTES + headerLength;
    const batches = header.batches.map((batch) => ({
        ...batch,
        packets: (Array.isArray(batch?.packets) ? batch.packets : []).map((packet) => {
            const length = Number(packet?.byteLength);
            if (!Number.isSafeInteger(length) || length < 0 || offset + length > frame.byteLength) {
                throw new Error("Browser packet relay frame payload is truncated.");
            }
            const payload = frame.slice(offset, offset + length);
            offset += length;
            const { byteLength: _byteLength, ...rest } = packet;
            return { ...rest, payload };
        }),
    }));
    if (offset !== frame.byteLength) throw new Error("Browser packet relay frame has trailing bytes.");
    return batches;
}

/**
 * Native packet sink for browser runs. Batches collected during one delivery
 * step are posted to the sim server, which sends them as UDP. It never throws
 * into the simulation step: while a post is in flight, or after the relay
 * fails, batches are dropped and counted.
 */
export class BrowserPacketRelaySink {
    constructor({ baseUrl = "/api/browser-packets", fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
        this.baseUrl = baseUrl;
        this.fetchImpl = fetchImpl;
        this.host = EMPTY_HOST;
        this.sessionId = null;
        this.pending = [];
        this.inFlight = null;
        this.stats = { sentBatches: 0, droppedBatches: 0, lastError: null };
    }

    hostDescriptor() {
        return this.host;
    }

    async refreshHost() {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/host`);
            this.host = response.ok ? await response.json() : EMPTY_HOST;
        } catch {
            this.host = EMPTY_HOST;
        }
        return this.host;
    }

    /** Opens a relay session for the run's UDP bindings. Throws if the server refuses them. */
    async configure({ bindings = [], stepNs = 1 } = {}) {
        await this.close();
        this.stats = { sentBatches: 0, droppedBatches: 0, lastError: null };
        const udp = bindings.filter((binding) => binding.adapter === "udp");
        if (udp.length === 0) return null;
        const response = await this.fetchImpl(`${this.baseUrl}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bindings: udp, stepNs }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw Object.assign(new Error(body.error || `Browser packet relay refused the run (${response.status}).`), {
                code: body.code ?? "UNSUPPORTED_CAPABILITY",
            });
        }
        this.sessionId = body.sessionId;
        return this.sessionId;
    }

    enqueueBatch(batch) {
        if (this.sessionId) this.pending.push(batch);
        else this.stats.droppedBatches += 1;
    }

    endDeliveryStep() {
        if (this.pending.length === 0) return;
        const batches = this.pending;
        this.pending = [];
        if (this.inFlight || !this.sessionId) {
            this.stats.droppedBatches += batches.length;
            return;
        }
        const sessionId = this.sessionId;
        this.inFlight = this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/batches`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: encodeRelayFrame(batches),
        }).then(async (response) => {
            if (response.ok) {
                this.stats.sentBatches += batches.length;
                return;
            }
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Browser packet relay failed (${response.status}).`);
        }).catch((error) => {
            this.stats.droppedBatches += batches.length;
            this.stats.lastError = error.message;
            // The server releases a failed UDP session; stop posting until the next configure().
            if (this.sessionId === sessionId) this.sessionId = null;
            console.warn(`[packet-relay] ${error.message}`);
        }).finally(() => {
            this.inFlight = null;
        });
    }

    async close() {
        const sessionId = this.sessionId;
        this.sessionId = null;
        this.pending = [];
        await this.inFlight;
        if (!sessionId) return;
        await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
            .catch(() => {});
    }
}
