function cloneRuntimeState(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function iterableUnits(units) {
    if (units instanceof Map) return units.values();
    return units || [];
}

export function captureRuntimeState(units) {
    const snapshot = {};
    for (const unit of iterableUnits(units)) {
        if (!unit?.uuid || typeof unit.serializeRuntimeState !== "function") continue;
        snapshot[unit.uuid] = cloneRuntimeState(unit.serializeRuntimeState() ?? {});
    }
    return snapshot;
}

export function restoreRuntimeState(units, snapshot = {}) {
    for (const unit of iterableUnits(units)) {
        if (!unit?.uuid || typeof unit.hydrateRuntimeState !== "function") continue;
        if (!Object.prototype.hasOwnProperty.call(snapshot, unit.uuid)) continue;
        unit.hydrateRuntimeState(cloneRuntimeState(snapshot[unit.uuid]));
    }
}
