export function fixturePcapHostConfig(overrides = {}) {
    const pcap = overrides.pcap ?? {};
    return {
        kind: "cev-sim.sensor-transport-host-config",
        version: 1,
        pcap: {
            artifacts: pcap.artifacts ?? [
                { id: "sensors", fileName: "sensors.pcap" },
            ],
            endpoints: pcap.endpoints ?? [
                {
                    id: "camera-data",
                    artifactId: "sensors",
                    mtu: 1500,
                    ethernet: {
                        sourceMac: "02:00:00:00:00:01",
                        destinationMac: "02:00:00:00:00:02",
                    },
                    ipv4: {
                        sourceAddress: "192.0.2.1",
                        destinationAddress: "192.0.2.2",
                        ttl: 64,
                    },
                    udp: { sourcePort: 5000, destinationPort: 5001 },
                },
                {
                    id: "camera-status",
                    artifactId: "sensors",
                    mtu: 1500,
                    ethernet: {
                        sourceMac: "02:00:00:00:00:03",
                        destinationMac: "02:00:00:00:00:04",
                    },
                    ipv4: {
                        sourceAddress: "192.0.2.3",
                        destinationAddress: "192.0.2.4",
                        ttl: 64,
                    },
                    udp: { sourcePort: 5002, destinationPort: 5003 },
                },
            ],
        },
    };
}

export function fixtureUdpHostConfig(overrides = {}) {
    const udp = overrides.udp ?? {};
    return {
        kind: "cev-sim.sensor-transport-host-config",
        version: 1,
        ...(overrides.pcap ? { pcap: overrides.pcap } : {}),
        udp: {
            maxQueueBytesPerEnvironment: udp.maxQueueBytesPerEnvironment ?? 16_777_216,
            endpoints: udp.endpoints ?? [
                {
                    id: "helios-data",
                    mtu: 1500,
                    source: { address: "0.0.0.0", port: 5000 },
                    destination: { address: "127.0.0.1", port: 6699 },
                    pacing: { mode: "burst" },
                },
                {
                    id: "helios-status",
                    mtu: 1500,
                    source: { address: "0.0.0.0", port: 5000 },
                    destination: { address: "127.0.0.1", port: 6700 },
                    pacing: { mode: "burst" },
                },
            ],
        },
    };
}

export function fixtureUdpBindings() {
    return {
        kind: "cev-sim.sensor-transports",
        version: 1,
        bindings: [
            {
                sensorId: "fixture",
                productId: "packets",
                streamId: "data",
                adapter: "udp",
                endpointId: "helios-data",
            },
            {
                sensorId: "fixture",
                productId: "packets",
                streamId: "status",
                adapter: "udp",
                endpointId: "helios-status",
            },
        ],
    };
}

export function fixtureCombinedHostConfig(overrides = {}) {
    const pcap = fixturePcapHostConfig(overrides).pcap;
    const udp = fixtureUdpHostConfig(overrides).udp;
    return {
        kind: "cev-sim.sensor-transport-host-config",
        version: 1,
        pcap,
        udp,
    };
}

export function fixtureCombinedBindings() {
    return {
        kind: "cev-sim.sensor-transports",
        version: 1,
        bindings: [
            ...fixturePcapBindings().bindings,
            ...fixtureUdpBindings().bindings,
        ],
    };
}

export function fixturePcapBindings() {
    return {
        kind: "cev-sim.sensor-transports",
        version: 1,
        bindings: [
            {
                sensorId: "fixture",
                productId: "packets",
                streamId: "data",
                adapter: "pcap",
                endpointId: "camera-data",
            },
            {
                sensorId: "fixture",
                productId: "packets",
                streamId: "status",
                adapter: "pcap",
                endpointId: "camera-status",
            },
        ],
    };
}

function readU16(view, offset) {
    return view.getUint16(offset, false);
}

function internetChecksum(bytes, extra = 0) {
    let sum = extra >>> 0;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let index = 0; index < view.byteLength; index += 2) {
        const high = view[index];
        const low = index + 1 < view.byteLength ? view[index + 1] : 0;
        sum += (high << 8) | low;
    }
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
    return (~sum) & 0xffff;
}

export function parseClassicPcapIndependently(bytes) {
    const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buffer.byteLength < 24) throw new Error("PCAP file is truncated.");
    const header = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (header.getUint32(0, true) !== 0xa1b2c3d4) throw new Error("PCAP magic is not classic little-endian.");
    if (header.getUint16(4, true) !== 2 || header.getUint16(6, true) !== 4) {
        throw new Error("PCAP version is not 2.4.");
    }
    if (header.getInt32(8, true) !== 0 || header.getUint32(12, true) !== 0) {
        throw new Error("PCAP timezone fields must be zero.");
    }
    if (header.getUint32(16, true) !== 65535 || header.getUint32(20, true) !== 1) {
        throw new Error("PCAP snaplen/link type must be Ethernet 65535.");
    }
    const records = [];
    let offset = 24;
    while (offset < buffer.byteLength) {
        if (offset + 16 > buffer.byteLength) throw new Error("PCAP record header is truncated.");
        const tsSec = header.getUint32(offset, true);
        const tsUsec = header.getUint32(offset + 4, true);
        const inclLen = header.getUint32(offset + 8, true);
        const origLen = header.getUint32(offset + 12, true);
        offset += 16;
        if (inclLen !== origLen) throw new Error("PCAP captured length must equal original length.");
        if (offset + inclLen > buffer.byteLength) throw new Error("PCAP record payload is truncated.");
        const frame = buffer.subarray(offset, offset + inclLen);
        offset += inclLen;
        if (frame.byteLength < 42) throw new Error("PCAP frame is shorter than Ethernet+IPv4+UDP.");
        const frameView = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        if (readU16(frameView, 12) !== 0x0800) throw new Error("EtherType must be IPv4.");
        if (frame[14] !== 0x45) throw new Error("IPv4 IHL must be 5.");
        if (frame[23] !== 17) throw new Error("IPv4 protocol must be UDP.");
        if ((readU16(frameView, 20) & 0x3fff) !== 0 || (readU16(frameView, 20) & 0x4000) === 0) {
            throw new Error("IPv4 DF must be set and fragmentation forbidden.");
        }
        const ipHeader = Uint8Array.from(frame.subarray(14, 34));
        const storedIpChecksum = (ipHeader[10] << 8) | ipHeader[11];
        ipHeader[10] = 0;
        ipHeader[11] = 0;
        if (internetChecksum(ipHeader) !== storedIpChecksum) throw new Error("IPv4 header checksum is invalid.");
        const udpLength = readU16(frameView, 38);
        const udpOffset = 34;
        if (udpOffset + udpLength !== frame.byteLength) throw new Error("UDP length does not match the frame.");
        const sourceAddress = frame.subarray(26, 30);
        const destinationAddress = frame.subarray(30, 34);
        const pseudoSum = (
            ((sourceAddress[0] << 8) | sourceAddress[1])
            + ((sourceAddress[2] << 8) | sourceAddress[3])
            + ((destinationAddress[0] << 8) | destinationAddress[1])
            + ((destinationAddress[2] << 8) | destinationAddress[3])
            + 17
            + udpLength
        );
        const udpBytes = Uint8Array.from(frame.subarray(udpOffset, udpOffset + udpLength));
        const storedUdpChecksum = (udpBytes[6] << 8) | udpBytes[7];
        udpBytes[6] = 0;
        udpBytes[7] = 0;
        let computed = internetChecksum(udpBytes, pseudoSum);
        if (computed === 0) computed = 0xffff;
        if (computed !== storedUdpChecksum) throw new Error("UDP checksum is invalid.");
        records.push({
            timestampUs: BigInt(tsSec) * 1_000_000n + BigInt(tsUsec),
            identification: readU16(frameView, 18),
            sourceMac: [...frame.subarray(6, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join(":"),
            destinationMac: [...frame.subarray(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join(":"),
            sourceAddress: [...sourceAddress].join("."),
            destinationAddress: [...destinationAddress].join("."),
            sourcePort: readU16(frameView, 34),
            destinationPort: readU16(frameView, 36),
            payload: frame.subarray(udpOffset + 8),
        });
    }
    return records;
}
