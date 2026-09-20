import {
    canonicalExactStringify,
    sha256ExactBytes,
} from "../visual/VisualLayer.js";

export const NATIVE_SENSOR_PACKET_KIND = "cev-sim.native-sensor-packet";
export const NATIVE_SENSOR_PACKET_VERSION = 1;

const MAGIC = new Uint8Array([0x43, 0x45, 0x56, 0x50]); // CEVP
const encoder = new TextEncoder();

function uint(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path} must be a nonnegative safe integer.`);
    return value;
}

export function packetPayloadDigest(payload) {
    if (!(payload instanceof Uint8Array)) throw new TypeError("Native packet payload must be a Uint8Array.");
    return sha256ExactBytes(payload);
}

/** Encode record metadata and opaque payload without rewriting the payload bytes. */
export function encodeNativeSensorPacket(packet, metadata = {}) {
    const payload = packet?.payload;
    if (!(payload instanceof Uint8Array)) throw new TypeError("Native packet payload must be a Uint8Array.");
    const description = {
        kind: NATIVE_SENSOR_PACKET_KIND,
        version: NATIVE_SENSOR_PACKET_VERSION,
        sensorId: String(metadata.sensorId ?? ""),
        productId: String(packet.productId ?? ""),
        streamId: String(packet.streamId ?? ""),
        sampleIndex: uint(metadata.sampleIndex, "sampleIndex"),
        packetIndex: uint(packet.packetIndex, "packetIndex"),
        captureTimeNs: uint(metadata.captureTimeNs, "captureTimeNs"),
        offsetNs: uint(packet.offsetNs, "offsetNs"),
        scheduledDeliveryTimeNs: uint(metadata.scheduledDeliveryTimeNs, "scheduledDeliveryTimeNs"),
        deliveryTimeNs: uint(metadata.deliveryTimeNs, "deliveryTimeNs"),
        actualDeliveryStep: uint(metadata.actualDeliveryStep, "actualDeliveryStep"),
        payloadLength: payload.byteLength,
        payloadDigest: packetPayloadDigest(payload),
    };
    const metadataBytes = encoder.encode(canonicalExactStringify(description));
    const bytes = new Uint8Array(12 + metadataBytes.byteLength + payload.byteLength);
    bytes.set(MAGIC, 0);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, NATIVE_SENSOR_PACKET_VERSION, true);
    view.setUint16(6, 0, true);
    view.setUint32(8, metadataBytes.byteLength, true);
    bytes.set(metadataBytes, 12);
    bytes.set(payload, 12 + metadataBytes.byteLength);
    return Object.freeze({ description: Object.freeze(description), bytes });
}

export function decodeNativeSensorPacket(input) {
    const bytes = input instanceof Uint8Array
        ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.byteLength < 12 || MAGIC.some((byte, index) => bytes[index] !== byte)) {
        throw new TypeError("Native sensor packet envelope has invalid magic or length.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(4, true) !== NATIVE_SENSOR_PACKET_VERSION || view.getUint16(6, true) !== 0) {
        throw new TypeError("Native sensor packet envelope version or flags are unsupported.");
    }
    const metadataLength = view.getUint32(8, true);
    if (12 + metadataLength > bytes.byteLength) throw new TypeError("Native sensor packet metadata is truncated.");
    const description = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, 12 + metadataLength)));
    const payload = bytes.slice(12 + metadataLength);
    if (description.kind !== NATIVE_SENSOR_PACKET_KIND
        || description.version !== NATIVE_SENSOR_PACKET_VERSION
        || description.payloadLength !== payload.byteLength
        || description.payloadDigest !== packetPayloadDigest(payload)) {
        throw new TypeError("Native sensor packet metadata does not match its payload.");
    }
    return { description, payload };
}
