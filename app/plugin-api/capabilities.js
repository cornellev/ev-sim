const READ_NAMESPACES = Object.freeze([
    "vehicles",
    "devices",
    "simulation",
    "scenario",
    "mission",
    "objects",
    "topics",
]);

export const PLUGIN_CAPABILITIES = Object.freeze([
    ...READ_NAMESPACES.map((namespace) => `signals.read.${namespace}`),
    "signals.write.debug",
    "signals.write.mission",
    "scenario.flags.write",
    "world.read",
    "controls.reference",
    "topics.subscribe",
    "topics.publish",
    "overlay.spawn",
]);

const KNOWN_CAPABILITIES = new Set(PLUGIN_CAPABILITIES);

function normalizedCapabilities(value, label) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    const normalized = value.map((entry) => String(entry ?? "").trim());
    if (normalized.some((entry) => !KNOWN_CAPABILITIES.has(entry))) {
        const unknown = normalized.find((entry) => !KNOWN_CAPABILITIES.has(entry));
        throw new Error(`Unknown plugin capability "${unknown}".`);
    }
    if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate capabilities.`);
    return normalized.sort();
}

export function validateCapabilityGrants(required = [], granted = [], available = []) {
    const requiredSet = new Set(normalizedCapabilities(required, "Required capabilities"));
    const grantedList = normalizedCapabilities(granted, "Granted capabilities");
    const grantedSet = new Set(grantedList);
    const availableSet = new Set(normalizedCapabilities(available, "Available capabilities"));
    for (const capability of requiredSet) {
        if (!grantedSet.has(capability)) throw new Error(`Required plugin capability "${capability}" was not granted.`);
    }
    for (const capability of grantedSet) {
        if (!availableSet.has(capability)) throw new Error(`Plugin capability "${capability}" is unavailable on this host.`);
    }
    return Object.freeze(grantedList);
}
