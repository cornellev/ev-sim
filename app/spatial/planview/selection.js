export function planActorId(vehicle, index) {
    return String(vehicle?.telemetryId || vehicle?.id || `vehicle-${index + 1}`);
}

const listeners = new Set();
let actorId = null;

export function getPlanSelection() {
    return actorId;
}

export function setPlanSelection(id) {
    const next = id ? String(id) : null;
    if (next === actorId) return;
    actorId = next;
    for (const listener of listeners) listener(actorId);
}

export function subscribePlanSelection(listener) {
    listeners.add(listener);
    listener(actorId);
    return () => listeners.delete(listener);
}
