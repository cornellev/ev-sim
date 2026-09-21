const PCAP_MAGIC = 0xa1b2c3d4;
const PCAP_VERSION_MAJOR = 2;
const PCAP_VERSION_MINOR = 4;
const PCAP_SNAPLEN = 65535;
const DLT_EN10MB = 1;
const ETHERTYPE_IPV4 = 0x0800;
const IPV4_VERSION_IHL = 0x45;
const IPV4_DF = 0x4000;
const IPPROTO_UDP = 17;

function requireBytes(value, length, path) {
    if (!(value instanceof Uint8Array) || value.byteLength !== length) {
        throw new TypeError(`${path} must be a ${length}-byte Uint8Array.`);
    }
    return value;
}

export function macAddressBytes(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text)) {
        throw new TypeError(`Invalid MAC address "${value}".`);
    }
    return Uint8Array.from(text.split(":").map((part) => Number.parseInt(part, 16)));
}

export function ipv4AddressBytes(value) {
    const parts = String(value ?? "").trim().split(".");
    if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
        throw new TypeError(`Invalid IPv4 address "${value}".`);
    }
    return Uint8Array.from(parts.map((part) => Number(part)));
}

export function internetChecksum(bytes, extra = 0) {
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

export { logicalEgressTimeNs } from "./HostPacketOrdering.js";

export function pcapTimestampUs(logicalNs) {
    return BigInt(logicalNs) / 1000n;
}

export function encodePcapGlobalHeader() {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, PCAP_MAGIC, true);
    view.setUint16(4, PCAP_VERSION_MAJOR, true);
    view.setUint16(6, PCAP_VERSION_MINOR, true);
    view.setInt32(8, 0, true);
    view.setUint32(12, 0, true);
    view.setUint32(16, PCAP_SNAPLEN, true);
    view.setUint32(20, DLT_EN10MB, true);
    return bytes;
}

export function encodeEthernetIpv4Udp({
    ethernet,
    ipv4,
    udp,
    payload,
    identification = 0,
}) {
    if (!(payload instanceof Uint8Array)) throw new TypeError("PCAP payload must be a Uint8Array.");
    const sourceMac = ethernet.sourceMac instanceof Uint8Array
        ? requireBytes(ethernet.sourceMac, 6, "ethernet.sourceMac")
        : macAddressBytes(ethernet.sourceMac);
    const destinationMac = ethernet.destinationMac instanceof Uint8Array
        ? requireBytes(ethernet.destinationMac, 6, "ethernet.destinationMac")
        : macAddressBytes(ethernet.destinationMac);
    const sourceAddress = ipv4.sourceAddress instanceof Uint8Array
        ? requireBytes(ipv4.sourceAddress, 4, "ipv4.sourceAddress")
        : ipv4AddressBytes(ipv4.sourceAddress);
    const destinationAddress = ipv4.destinationAddress instanceof Uint8Array
        ? requireBytes(ipv4.destinationAddress, 4, "ipv4.destinationAddress")
        : ipv4AddressBytes(ipv4.destinationAddress);
    const ttl = Number(ipv4.ttl);
    const sourcePort = Number(udp.sourcePort);
    const destinationPort = Number(udp.destinationPort);
    const ipIdentification = Number(identification) & 0xffff;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 255) throw new TypeError("IPv4 TTL must be in [1, 255].");
    if (!Number.isSafeInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
        throw new TypeError("UDP sourcePort must be in [1, 65535].");
    }
    if (!Number.isSafeInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
        throw new TypeError("UDP destinationPort must be in [1, 65535].");
    }
    const udpLength = 8 + payload.byteLength;
    const ipTotalLength = 20 + udpLength;
    if (ipTotalLength > 65535) throw new TypeError("Native packet payload exceeds the unfragmented IPv4/UDP limit.");

    const packet = new Uint8Array(14 + ipTotalLength);
    packet.set(destinationMac, 0);
    packet.set(sourceMac, 6);
    packet[12] = ETHERTYPE_IPV4 >> 8;
    packet[13] = ETHERTYPE_IPV4 & 0xff;

    const ipOffset = 14;
    packet[ipOffset] = IPV4_VERSION_IHL;
    packet[ipOffset + 1] = 0;
    packet[ipOffset + 2] = ipTotalLength >> 8;
    packet[ipOffset + 3] = ipTotalLength & 0xff;
    packet[ipOffset + 4] = ipIdentification >> 8;
    packet[ipOffset + 5] = ipIdentification & 0xff;
    packet[ipOffset + 6] = IPV4_DF >> 8;
    packet[ipOffset + 7] = IPV4_DF & 0xff;
    packet[ipOffset + 8] = ttl;
    packet[ipOffset + 9] = IPPROTO_UDP;
    packet.set(sourceAddress, ipOffset + 12);
    packet.set(destinationAddress, ipOffset + 16);
    const ipHeader = packet.subarray(ipOffset, ipOffset + 20);
    const ipChecksum = internetChecksum(ipHeader);
    packet[ipOffset + 10] = ipChecksum >> 8;
    packet[ipOffset + 11] = ipChecksum & 0xff;

    const udpOffset = ipOffset + 20;
    packet[udpOffset] = sourcePort >> 8;
    packet[udpOffset + 1] = sourcePort & 0xff;
    packet[udpOffset + 2] = destinationPort >> 8;
    packet[udpOffset + 3] = destinationPort & 0xff;
    packet[udpOffset + 4] = udpLength >> 8;
    packet[udpOffset + 5] = udpLength & 0xff;
    packet.set(payload, udpOffset + 8);

    const pseudoSum = (
        ((sourceAddress[0] << 8) | sourceAddress[1])
        + ((sourceAddress[2] << 8) | sourceAddress[3])
        + ((destinationAddress[0] << 8) | destinationAddress[1])
        + ((destinationAddress[2] << 8) | destinationAddress[3])
        + IPPROTO_UDP
        + udpLength
    );
    let udpChecksum = internetChecksum(packet.subarray(udpOffset, udpOffset + udpLength), pseudoSum);
    if (udpChecksum === 0) udpChecksum = 0xffff;
    packet[udpOffset + 6] = udpChecksum >> 8;
    packet[udpOffset + 7] = udpChecksum & 0xff;
    return packet;
}

export function encodePcapRecord({
    timestampUs,
    identification = 0,
    ethernet,
    ipv4,
    udp,
    payload,
}) {
    const packet = encodeEthernetIpv4Udp({ ethernet, ipv4, udp, payload, identification });
    const microseconds = BigInt(timestampUs);
    if (microseconds < 0n) throw new TypeError("PCAP timestamp must be nonnegative.");
    const seconds = microseconds / 1_000_000n;
    const leftover = microseconds % 1_000_000n;
    if (seconds > 0xffffffffn) throw new TypeError("PCAP timestamp exceeds classic uint32 seconds.");
    const record = new Uint8Array(16 + packet.byteLength);
    const view = new DataView(record.buffer);
    view.setUint32(0, Number(seconds), true);
    view.setUint32(4, Number(leftover), true);
    view.setUint32(8, packet.byteLength, true);
    view.setUint32(12, packet.byteLength, true);
    record.set(packet, 16);
    return record;
}
