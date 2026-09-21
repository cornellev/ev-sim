import { HeadlessRunnerError } from "../headless/HeadlessRunnerErrors.js";

export const SENSOR_TRANSPORT_HOST_CONFIG_KIND = "cev-sim.sensor-transport-host-config";
export const SENSOR_TRANSPORT_HOST_CONFIG_VERSION = 1;
export const IPV4_UDP_HEADER_BYTES = 28;
export const DEFAULT_PCAP_MTU = 1500;
export const DEFAULT_UDP_MTU = DEFAULT_PCAP_MTU;
export const DEFAULT_IPV4_TTL = 64;
export const MIN_PCAP_MTU = 576;
export const MIN_UDP_MTU = MIN_PCAP_MTU;
export const MAX_PCAP_MTU = 65535;
export const MAX_UDP_MTU = MAX_PCAP_MTU;
export const UDP_PACING_MODES = Object.freeze(["burst", "packet-offset"]);

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

function ipv4Octets(value) {
    return String(value).split(".").map((part) => Number(part));
}

export function isIpv4Multicast(address) {
    const first = ipv4Octets(address)[0];
    return first >= 224 && first <= 239;
}

export function isIpv4Broadcast(address) {
    return address === "255.255.255.255";
}

export function isIpv4Unspecified(address) {
    return address === "0.0.0.0";
}

export function isIpv4UnicastLiteral(address) {
    if (isIpv4Unspecified(address) || isIpv4Broadcast(address) || isIpv4Multicast(address)) return false;
    return ipv4Octets(address)[0] < 240;
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

function parseUdpPacing(value, path) {
    if (value === undefined || value === null) {
        return Object.freeze({ mode: "burst" });
    }
    exactKeys(value, ["mode", "latenessBudgetNs"], path);
    const mode = trimmedId(value.mode, `${path}.mode`);
    if (!UDP_PACING_MODES.includes(mode)) {
        throw invalid(`${path}.mode must be burst or packet-offset.`);
    }
    if (mode === "burst") {
        if (value.latenessBudgetNs !== undefined && value.latenessBudgetNs !== null) {
            throw invalid(`${path}.latenessBudgetNs is only valid for packet-offset pacing.`);
        }
        return Object.freeze({ mode: "burst" });
    }
    if (value.latenessBudgetNs === undefined || value.latenessBudgetNs === null) {
        throw invalid(`${path}.latenessBudgetNs is required for packet-offset pacing.`);
    }
    const latenessBudgetNs = integerField(value.latenessBudgetNs, `${path}.latenessBudgetNs`, {
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        fallback: undefined,
    });
    return Object.freeze({ mode: "packet-offset", latenessBudgetNs });
}

function parseUdpHostEndpoint(entry, index, path) {
    const endpointPath = `${path}.udp.endpoints.${index}`;
    exactKeys(entry, [
        "id",
        "mtu",
        "source",
        "destination",
        "pacing",
        "adapter",
        "maxPayloadBytes",
    ], endpointPath);
    exactKeys(entry.source, ["address", "port"], `${endpointPath}.source`);
    exactKeys(entry.destination, ["address", "port"], `${endpointPath}.destination`);
    const mtu = integerField(entry.mtu, `${endpointPath}.mtu`, {
        minimum: MIN_UDP_MTU,
        maximum: MAX_UDP_MTU,
        fallback: DEFAULT_UDP_MTU,
    });
    const sourceAddress = parseIpv4Address(entry.source.address, `${endpointPath}.source.address`);
    if (isIpv4Multicast(sourceAddress) || isIpv4Broadcast(sourceAddress) || ipv4Octets(sourceAddress)[0] >= 240) {
        throw invalid(`${endpointPath}.source.address must be an IPv4 unicast address or 0.0.0.0.`);
    }
    const destinationAddress = parseIpv4Address(
        entry.destination.address,
        `${endpointPath}.destination.address`,
    );
    if (!isIpv4UnicastLiteral(destinationAddress)) {
        throw invalid(`${endpointPath}.destination.address must be an IPv4 unicast literal.`);
    }
    return Object.freeze({
        id: trimmedId(entry.id, `${endpointPath}.id`),
        adapter: "udp",
        mtu,
        maxPayloadBytes: maxPayloadBytesForMtu(mtu),
        source: Object.freeze({
            address: sourceAddress,
            port: integerField(entry.source.port, `${endpointPath}.source.port`, {
                minimum: 1,
                maximum: 65535,
                fallback: undefined,
            }),
        }),
        destination: Object.freeze({
            address: destinationAddress,
            port: integerField(entry.destination.port, `${endpointPath}.destination.port`, {
                minimum: 1,
                maximum: 65535,
                fallback: undefined,
            }),
        }),
        pacing: parseUdpPacing(entry.pacing, `${endpointPath}.pacing`),
    });
}

function assertUdpBindCompatibility(endpoints, path) {
    for (let left = 0; left < endpoints.length; left += 1) {
        for (let right = left + 1; right < endpoints.length; right += 1) {
            const first = endpoints[left];
            const second = endpoints[right];
            if (first.source.port !== second.source.port) continue;
            if (first.source.address === second.source.address) continue;
            if (isIpv4Unspecified(first.source.address) || isIpv4Unspecified(second.source.address)) {
                throw invalid(
                    `${path}.udp.endpoints contain overlapping exclusive binds for port ${first.source.port}.`,
                    { leftId: first.id, rightId: second.id },
                );
            }
        }
    }
}

function resolvePcapSection(pcap, path) {
    exactKeys(pcap, ["artifacts", "endpoints"], `${path}.pcap`);
    if (!Array.isArray(pcap.artifacts) || pcap.artifacts.length < 1) {
        throw invalid(`${path}.pcap.artifacts must be a non-empty array.`);
    }
    if (!Array.isArray(pcap.endpoints) || pcap.endpoints.length < 1) {
        throw invalid(`${path}.pcap.endpoints must be a non-empty array.`);
    }
    const artifacts = pcap.artifacts.map((entry, index) => {
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
    const endpoints = pcap.endpoints.map((entry, index) => {
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
        artifacts: Object.freeze(artifacts),
        endpoints: Object.freeze(endpoints),
    });
}

function resolveUdpSection(udp, path) {
    exactKeys(udp, ["maxQueueBytesPerEnvironment", "endpoints"], `${path}.udp`);
    const maxQueueBytesPerEnvironment = integerField(
        udp.maxQueueBytesPerEnvironment,
        `${path}.udp.maxQueueBytesPerEnvironment`,
        { minimum: 1, maximum: Number.MAX_SAFE_INTEGER, fallback: undefined },
    );
    if (maxQueueBytesPerEnvironment == null) {
        throw invalid(`${path}.udp.maxQueueBytesPerEnvironment is required.`);
    }
    if (!Array.isArray(udp.endpoints) || udp.endpoints.length < 1) {
        throw invalid(`${path}.udp.endpoints must be a non-empty array.`);
    }
    const endpoints = udp.endpoints.map((entry, index) => parseUdpHostEndpoint(entry, index, path));
    uniqueIds(endpoints.map((entry) => entry.id), `${path}.udp.endpoints`);
    if (endpoints.some((entry) => entry.source.port == null || entry.destination.port == null)) {
        throw invalid(`${path}.udp.endpoints require source and destination ports.`);
    }
    assertUdpBindCompatibility(endpoints, path);
    return Object.freeze({
        maxQueueBytesPerEnvironment,
        endpoints: Object.freeze(endpoints),
    });
}

export function resolveSensorTransportHostConfig(value, { path = "packetTransports" } = {}) {
    if (value === undefined || value === null) return null;
    exactKeys(value, ["kind", "version", "pcap", "udp"], path);
    if (value.kind !== SENSOR_TRANSPORT_HOST_CONFIG_KIND
        || value.version !== SENSOR_TRANSPORT_HOST_CONFIG_VERSION) {
        throw invalid(`${path} must be ${SENSOR_TRANSPORT_HOST_CONFIG_KIND} version ${SENSOR_TRANSPORT_HOST_CONFIG_VERSION}.`);
    }
    const hasPcap = value.pcap !== undefined && value.pcap !== null;
    const hasUdp = value.udp !== undefined && value.udp !== null;
    if (!hasPcap && !hasUdp) {
        throw invalid(`${path} must declare at least one of pcap or udp.`);
    }
    const pcap = hasPcap ? resolvePcapSection(value.pcap, path) : null;
    const udp = hasUdp ? resolveUdpSection(value.udp, path) : null;
    const ids = [
        ...(pcap?.endpoints ?? []).map((entry) => entry.id),
        ...(udp?.endpoints ?? []).map((entry) => entry.id),
    ];
    uniqueIds(ids, `${path} endpoints`);
    return Object.freeze({
        kind: SENSOR_TRANSPORT_HOST_CONFIG_KIND,
        version: SENSOR_TRANSPORT_HOST_CONFIG_VERSION,
        ...(pcap ? { pcap } : {}),
        ...(udp ? { udp } : {}),
    });
}

export function pcapEndpointProjection(endpoint) {
    if (!endpoint) return null;
    return Object.freeze({
        id: endpoint.id,
        adapter: "pcap",
        mtu: endpoint.mtu,
        maxPayloadBytes: endpoint.maxPayloadBytes,
    });
}

export function udpEndpointProjection(endpoint) {
    if (!endpoint) return null;
    return Object.freeze({
        id: endpoint.id,
        adapter: "udp",
        mtu: endpoint.mtu,
        maxPayloadBytes: endpoint.maxPayloadBytes,
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
    const adapters = [];
    const endpoints = [];
    if (resolved.pcap) {
        adapters.push("pcap");
        endpoints.push(...resolved.pcap.endpoints.map(pcapEndpointProjection));
    }
    if (resolved.udp) {
        adapters.push("udp");
        endpoints.push(...resolved.udp.endpoints.map(udpEndpointProjection));
    }
    return Object.freeze({
        adapters: Object.freeze(adapters),
        endpoints: Object.freeze(endpoints),
    });
}

export function pcapOnlyHostConfig(hostConfig) {
    if (!hostConfig?.pcap) return null;
    const resolved = hostConfig.kind === SENSOR_TRANSPORT_HOST_CONFIG_KIND
        ? hostConfig
        : resolveSensorTransportHostConfig(hostConfig);
    if (!resolved.pcap) return null;
    return Object.freeze({
        kind: SENSOR_TRANSPORT_HOST_CONFIG_KIND,
        version: SENSOR_TRANSPORT_HOST_CONFIG_VERSION,
        pcap: resolved.pcap,
    });
}

export function udpEndpointById(hostConfig, endpointId) {
    if (!hostConfig?.udp || endpointId == null) return null;
    const resolved = hostConfig.kind === SENSOR_TRANSPORT_HOST_CONFIG_KIND
        ? hostConfig
        : resolveSensorTransportHostConfig(hostConfig);
    return resolved.udp?.endpoints.find((entry) => entry.id === endpointId) ?? null;
}

export function pcapEndpointById(hostConfig, endpointId) {
    if (!hostConfig?.pcap || endpointId == null) return null;
    const resolved = hostConfig.kind === SENSOR_TRANSPORT_HOST_CONFIG_KIND
        ? hostConfig
        : resolveSensorTransportHostConfig(hostConfig);
    return resolved.pcap?.endpoints.find((entry) => entry.id === endpointId) ?? null;
}

export function combinedUdpQueueBytes(hostConfig, maxQueueBytes = 0) {
    const configured = Number(hostConfig?.udp?.maxQueueBytesPerEnvironment || 0);
    const limit = Math.max(0, Number(maxQueueBytes) || 0);
    if (configured <= 0) return limit;
    if (limit <= 0) return configured;
    return Math.min(configured, limit);
}

export function packetOffsetClockCompatible(clock) {
    return clock?.pacing === "realtime" && Number(clock?.speed) === 1;
}

export function readSensorTransportHostConfig(value) {
    return resolveSensorTransportHostConfig(value, { path: "sensor-transport-config" });
}
