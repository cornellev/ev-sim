function unwrapEntry(entry) {
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "value")) return entry.value;
    return entry;
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

export function simulationTimeUsFromValues(timeNsValue, timeSecondsValue) {
    const timeNs = finiteNumber(unwrapEntry(timeNsValue));
    if (timeNs !== null) return Math.max(0, Math.round(timeNs / 1000));

    const timeSeconds = finiteNumber(unwrapEntry(timeSecondsValue));
    if (timeSeconds !== null) return Math.max(0, Math.round(timeSeconds * 1e6));
    return null;
}

export function simulationTimeUsFromSnapshot(snapshot = {}) {
    return simulationTimeUsFromValues(
        snapshot?.["simulation.timeNs"],
        snapshot?.["simulation.time"],
    );
}
