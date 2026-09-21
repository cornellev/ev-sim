const encoder = new TextEncoder();

export function compareUtf8(left, right) {
    const leftBytes = encoder.encode(String(left));
    const rightBytes = encoder.encode(String(right));
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
    }
    return leftBytes.length - rightBytes.length;
}

export function logicalEgressTimeNs(actualDeliveryStep, stepNs, offsetNs) {
    return BigInt(actualDeliveryStep) * BigInt(stepNs) + BigInt(offsetNs);
}

export function compareHostPackets(left, right) {
    const leftNs = BigInt(left.logicalEgressTimeNs);
    const rightNs = BigInt(right.logicalEgressTimeNs);
    if (leftNs !== rightNs) return leftNs < rightNs ? -1 : 1;
    return compareUtf8(left.sensorId, right.sensorId)
        || compareUtf8(left.productId, right.productId)
        || compareUtf8(left.streamId, right.streamId)
        || (Number(left.sampleIndex) - Number(right.sampleIndex))
        || (Number(left.packetIndex) - Number(right.packetIndex));
}

export function sortHostPackets(packets) {
    return [...(packets ?? [])].sort(compareHostPackets);
}
