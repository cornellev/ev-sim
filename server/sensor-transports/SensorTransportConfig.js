import { HeadlessRunnerError } from "../headless/HeadlessRunnerErrors.js";

export const SENSOR_TRANSPORT_HOST_CONFIG_KIND = "cev-sim.sensor-transport-host-config";
export const SENSOR_TRANSPORT_HOST_CONFIG_VERSION = 1;
export const IPV4_UDP_HEADER_BYTES = 28;
export const DEFAULT_PCAP_MTU = 1500;
export const DEFAULT_IPV4_TTL = 64;
export const MIN_PCAP_MTU = 576;
export const MAX_PCAP_MTU = 65535;

function invalid(message, details = null) {
    return new HeadlessRunnerError("INVALID_REQUEST", message, details);
}

function exactKeys(value, allowed, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw invalid(`${path} must be an object.`);
    }
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw invalid(`${path} contains unknown field "${unknown}".`);
}

function trimmedId(value, path) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
        throw invalid(`${path} must be a non-empty trimmed string.`);
    }
    return value;
}

function uniqueIds(values, path) {
    const seen = new Set();
    for (const id of values) {
        if (seen.has(id)) throw invalid(`${path} contains duplicate id "${id}".`);
        seen.add(id);
    }
}

export function parseMacAddress(value, path) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text)) {
        throw invalid(`${path} must be a canonical six-octet MAC address.`);
    }
    return text;
}

export function parseIpv4Address(value, path) {
    const text = String(value ?? "").trim();
    const parts = text.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
        throw invalid(`${path} must be an IPv4 address.`);
    }
    return text;
}

function integerField(value, path, { minimum, maximum, fallback }) {
    if (value === undefined || value === null) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw invalid(`${path} must be an integer in [${minimum}, ${maximum}].`);
    }
    return number;
}

function pcapBasename(value, path) {
    const fileName = trimmedId(value, path);
    if (/[\\/]/.test(fileName)
        || fileName.includes("\0")
        || fileName === "."
        || fileName === ".."
        || fileName.startsWith(".")
        || fileName.split(".").some((part) => part === "..")
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.pcap$/.test(fileName)) {
        throw invalid(`${path} must be a safe .pcap basename with no path traversal.`);
    }
    return fileName;
}

export function maxPayloadBytesForMtu(mtu) {
    return Math.max(0, Number(mtu) - IPV4_UDP_HEADER_BYTES);
}

export function resolveSensorTransportHostConfig(value, { path = "packetTransports" } = {}) {
    if (value === undefined || value === null) return null;
    exactKeys(value, ["kind", "version", "pcap"], path);
    if (value.kind !== SENSOR_TRANSPORT_HOST_CONFIG_KIND
        || value.version !== SENSOR_TRANSPORT_HOST_CONFIG_VERSION) {
        throw invalid(`${path} must be ${SENSOR_TRANSPORT_HOST_CONFIG_KIND} version ${SENSOR_TRANSPORT_HOST_CONFIG_VERSION}.`);
    }
    exactKeys(value.pcap, ["artifacts", "endpoints"], `${path}.pcap`);
    if (!Array.isArray(value.pcap.artifacts) || value.pcap.artifacts.length < 1) {
        throw invalid(`${path}.pcap.artifacts must be a non-empty array.`);
    }
    if (!Array.isArray(value.pcap.endpoints) || value.pcap.endpoints.length < 1) {
        throw invalid(`${path}.pcap.endpoints must be a non-empty array.`);
    }
    const artifacts = value.pcap.artifacts.map((entry, index) => {
        const artifactPath = `${path}.pcap.artifacts.${index}`;
        exactKeys(entry, ["id", "fileName"], artifactPath);
        return Object.freeze({
            id: trimmedId(entry.id, `${artifactPath}.id`),
            fileName: pcapBasename(entry.fileName, `${artifactPath}.fileName`),
        });
    });
    uniqueIds(artifacts.map((entry) => entry.id), `${path}.pcap.artifacts`);
    uniqueIds(artifacts.map((entry) => entry.fileName), `${path}.pcap.artifacts`);
    const artifactIds = new Set(artifacts.map((entry) => entry.id));
    const endpoints = value.pcap.endpoints.map((entry, index) => {
        const endpointPath = `${path}.pcap.endpoints.${index}`;
        exactKeys(entry, [
            "id",
            "artifactId",
            "mtu",
            "ethernet",
            "ipv4",
            "udp",
            "adapter",
            "maxPayloadBytes",
        ], endpointPath);
        exactKeys(entry.ethernet, ["sourceMac", "destinationMac"], `${endpointPath}.ethernet`);
        exactKeys(entry.ipv4, ["sourceAddress", "destinationAddress", "ttl"], `${endpointPath}.ipv4`);
        exactKeys(entry.udp, ["sourcePort", "destinationPort"], `${endpointPath}.udp`);
        const mtu = integerField(entry.mtu, `${endpointPath}.mtu`, {
            minimum: MIN_PCAP_MTU,
            maximum: MAX_PCAP_MTU,
            fallback: DEFAULT_PCAP_MTU,
        });
        const artifactId = trimmedId(entry.artifactId, `${endpointPath}.artifactId`);
        if (!artifactIds.has(artifactId)) {
            throw invalid(`${endpointPath}.artifactId "${artifactId}" is not a declared PCAP artifact.`);
        }
        return Object.freeze({
            id: trimmedId(entry.id, `${endpointPath}.id`),
            adapter: "pcap",
            artifactId,
            mtu,
            maxPayloadBytes: maxPayloadBytesForMtu(mtu),
            ethernet: Object.freeze({
                sourceMac: parseMacAddress(entry.ethernet.sourceMac, `${endpointPath}.ethernet.sourceMac`),
                destinationMac: parseMacAddress(entry.ethernet.destinationMac, `${endpointPath}.ethernet.destinationMac`),
            }),
            ipv4: Object.freeze({
                sourceAddress: parseIpv4Address(entry.ipv4.sourceAddress, `${endpointPath}.ipv4.sourceAddress`),
                destinationAddress: parseIpv4Address(entry.ipv4.destinationAddress, `${endpointPath}.ipv4.destinationAddress`),
                ttl: integerField(entry.ipv4.ttl, `${endpointPath}.ipv4.ttl`, {
                    minimum: 1,
                    maximum: 255,
                    fallback: DEFAULT_IPV4_TTL,
                }),
            }),
            udp: Object.freeze({
                sourcePort: integerField(entry.udp.sourcePort, `${endpointPath}.udp.sourcePort`, {
                    minimum: 1,
                    maximum: 65535,
                    fallback: undefined,
                }),
                destinationPort: integerField(entry.udp.destinationPort, `${endpointPath}.udp.destinationPort`, {
                    minimum: 1,
                    maximum: 65535,
                    fallback: undefined,
                }),
            }),
        });
    });
    uniqueIds(endpoints.map((entry) => entry.id), `${path}.pcap.endpoints`);
    if (endpoints.some((entry) => entry.udp.sourcePort == null || entry.udp.destinationPort == null)) {
        throw invalid(`${path}.pcap.endpoints require UDP source and destination ports.`);
    }
    return Object.freeze({
        kind: SENSOR_TRANSPORT_HOST_CONFIG_KIND,
        version: SENSOR_TRANSPORT_HOST_CONFIG_VERSION,
        pcap: Object.freeze({
            artifacts: Object.freeze(artifacts),
            endpoints: Object.freeze(endpoints),
        }),
    });
}

export function hostDescriptorFromConfig(hostConfig) {
    if (!hostConfig) {
        return Object.freeze({
            adapters: Object.freeze([]),
            endpoints: Object.freeze([]),
        });
    }
    const resolved = hostConfig.kind === SENSOR_TRANSPORT_HOST_CONFIG_KIND
        ? hostConfig
        : resolveSensorTransportHostConfig(hostConfig);
    return Object.freeze({
        adapters: Object.freeze(["pcap"]),
        endpoints: Object.freeze(resolved.pcap.endpoints.map((entry) => Object.freeze({
            id: entry.id,
            adapter: "pcap",
            mtu: entry.mtu,
            maxPayloadBytes: entry.maxPayloadBytes,
        }))),
    });
}

export function readSensorTransportHostConfig(value) {
    return resolveSensorTransportHostConfig(value, { path: "sensor-transport-config" });
}
