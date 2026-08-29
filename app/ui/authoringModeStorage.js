export const ADVANCED_AUTHORING_STORAGE_KEY = "cev-sim.ui.advancedAuthoring";

export function readAdvancedAuthoringPreference(storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        if (!store?.getItem) return false;
        return store.getItem(ADVANCED_AUTHORING_STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

export function writeAdvancedAuthoringPreference(advanced, storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        store?.setItem?.(ADVANCED_AUTHORING_STORAGE_KEY, advanced ? "true" : "false");
    } catch {
        // Ignore storage failures (private mode, SSR).
    }
}

export function validationIssueRequiresAdvanced(path = "") {
    const normalized = String(path || "");
    if (!normalized) return false;
    if (normalized.startsWith("sensorRig.") && !normalized.includes(".sensors.")) return true;
    if (normalized.includes(".mountFrameId")
        || normalized.includes(".measurementFrameId")
        || normalized.includes(".syncGroupId")
        || normalized.includes(".frameId")
        || normalized.includes(".phaseNs")
        || normalized.includes(".maxQueueFrames")
        || normalized.includes(".latency")
        || normalized.includes(".noise")
        || normalized.includes(".outputs.")
        || normalized.includes(".schema.")) {
        return true;
    }
    if (/^sensorRig\.sensors\.\d+\.calibration\./.test(normalized)) return true;
    if (normalized.startsWith("clock.") && (normalized.includes("publishClock") || normalized.includes("modules"))) return true;
    if (normalized.startsWith("topics.") && (
        normalized.includes(".producer")
        || normalized.includes(".authority")
        || normalized.includes(".timeoutNs")
        || normalized.includes(".validityNs")
        || normalized.includes(".fallback")
        || normalized.includes(".direction")
        || normalized.includes(".schema")
        || normalized.includes(".type")
    )) return true;
    if (normalized.startsWith("scripts.") && (
        normalized.includes("artifacts")
        || normalized.includes("expectedBindingsHash")
        || normalized.includes("embeddedBindings")
    )) return true;
    if (normalized.startsWith("assertions.") && (
        normalized.includes(".mode")
        || normalized.includes(".tolerance")
        || normalized.includes(".window")
        || normalized.includes(".severity")
        || normalized.includes(".onFailure")
        || normalized.includes(".selector")
    )) return true;
    if (normalized.startsWith("parameters.") && normalized.includes(".target")) return true;
    return false;
}

export function validationIssuesRequireAdvanced(issues = []) {
    return issues.some((issue) => validationIssueRequiresAdvanced(issue?.path));
}
