export const PROFILE_KIND = "fusion-log-profile";
export const PROFILE_VERSION = 1;

export const SIMULATION_RUN_SENSOR_PROFILE = Object.freeze({
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    id: "simulation-run-full-sensors",
    name: "Simulation Run: Full Sensors",
    mode: "replay-safe",
    // Canonical heavy samples are devices.<sensor>.<signal> encoded bytes.
    // Raw topic/oracle/active Image/PointCloud aliases are skipped when that
    // canonical path is enabled (see shouldSkipHeavyAlias).
    rules: [
        { pattern: "**", enabled: true, sampling: "on-change", rateHz: null },
        { pattern: "simulation.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "vehicles.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "devices.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "candidate.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "active.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "oracle.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "diagnostics.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "visualization.**", enabled: true, sampling: "every-update", rateHz: null },
    ],
});

const HEAVY_ALIAS_PREFIXES = Object.freeze([
    "topics.",
    "active.topics.",
    "oracle.topics.",
    "candidate.topics.",
    "reference.topics.",
]);

const DEVICE_HEAVY_SUFFIX_BLOCKLIST = Object.freeze([
    "output",
    "health",
    "summary",
    "droppedFrames",
    "errors",
    "diagnostics",
]);

export function isCanonicalDeviceHeavyPath(path) {
    const parts = String(path || "").split(".");
    if (parts.length < 3 || parts[0] !== "devices") return false;
    const suffix = parts[parts.length - 1];
    return !DEVICE_HEAVY_SUFFIX_BLOCKLIST.includes(suffix);
}

export function isHeavyAliasPath(path) {
    const normalized = String(path || "");
    return HEAVY_ALIAS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function shouldSkipHeavyAlias(profileValue, descriptor, { isHeavy = false } = {}) {
    if (!isHeavy && descriptor?.logClass !== "heavy" && descriptor?.type !== "bytes") return false;
    const path = descriptor?.path;
    if (!path || isCanonicalDeviceHeavyPath(path)) return false;
    if (!isHeavyAliasPath(path) && descriptor?.type !== "bytes" && descriptor?.logClass !== "heavy") return false;
    const canonical = descriptor?.metadata?.canonicalSignalPath;
    if (!canonical || !isCanonicalDeviceHeavyPath(canonical)) {
        // Full-sensor profile: skip raw heavy topic/oracle/active aliases by default
        // whenever any devices.** rule is enabled.
        if (!isHeavyAliasPath(path)) return false;
        const devicesRule = resolveProfileRule(profileValue, { path: "devices.__canonical__", replayRole: "derived", logClass: "heavy" });
        return devicesRule.enabled;
    }
    const canonicalRule = resolveProfileRule(profileValue, {
        path: canonical,
        type: "bytes",
        logClass: "heavy",
        replayRole: "derived",
    });
    return canonicalRule.enabled;
}

export const DEFAULT_REPLAY_PROFILE = Object.freeze({
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    id: "replay-safe-default",
    name: "Replay Safe",
    mode: "replay-safe",
    rules: [
        { pattern: "**", enabled: true, sampling: "on-change", rateHz: null },
        { pattern: "simulation.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "vehicles.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "candidate.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "diagnostics.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "visualization.**", enabled: true, sampling: "every-update", rateHz: null },
        { pattern: "devices.**", enabled: false, sampling: "on-change", rateHz: null },
    ],
});

export const DEFAULT_TELEMETRY_PROFILE = Object.freeze({
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    id: "telemetry-default",
    name: "Telemetry",
    mode: "telemetry",
    rules: [
        { pattern: "**", enabled: true, sampling: "on-change", rateHz: null },
        { pattern: "devices.**", enabled: false, sampling: "on-change", rateHz: null },
    ],
});

export function builtInProfile(id) {
    if (id === SIMULATION_RUN_SENSOR_PROFILE.id) return SIMULATION_RUN_SENSOR_PROFILE;
    if (id === DEFAULT_TELEMETRY_PROFILE.id) return DEFAULT_TELEMETRY_PROFILE;
    return DEFAULT_REPLAY_PROFILE;
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globMatches(pattern, path) {
    const marker = "__DOUBLE_STAR__";
    const regex = escapeRegExp(String(pattern || "**"))
        .replace(/\*\*/g, marker)
        .replace(/\*/g, "[^.]*")
        .replaceAll(marker, ".*");
    return new RegExp(`^${regex}$`).test(String(path || ""));
}

export function normalizeProfile(profile = DEFAULT_REPLAY_PROFILE) {
    return {
        kind: PROFILE_KIND,
        version: PROFILE_VERSION,
        id: String(profile.id || "custom-profile"),
        name: String(profile.name || "Custom Profile"),
        mode: profile.mode === "telemetry" ? "telemetry" : "replay-safe",
        rules: (Array.isArray(profile.rules) ? profile.rules : []).map((rule) => ({
            pattern: String(rule.pattern || "**"),
            enabled: rule.enabled !== false,
            sampling: ["every-update", "on-change", "fixed-rate", "disabled"].includes(rule.sampling)
                ? rule.sampling
                : "on-change",
            rateHz: Number.isFinite(Number(rule.rateHz)) && Number(rule.rateHz) > 0 ? Number(rule.rateHz) : null,
        })),
    };
}

export function resolveProfileRule(profileValue, descriptor) {
    const profile = normalizeProfile(profileValue);
    let resolved = { enabled: false, sampling: "disabled", rateHz: null, locked: false };
    for (const rule of profile.rules) {
        if (!globMatches(rule.pattern, descriptor.path)) continue;
        resolved = { ...rule, locked: false };
    }
    const replayRequired = profile.mode === "replay-safe"
        && (descriptor.replayRole === "input" || (descriptor.replayRole === "state" && descriptor.logClass === "core"));
    if (replayRequired) {
        return { enabled: true, sampling: "every-update", rateHz: null, locked: true };
    }
    if (!resolved.enabled || resolved.sampling === "disabled") return { ...resolved, enabled: false, sampling: "disabled" };
    return resolved;
}
