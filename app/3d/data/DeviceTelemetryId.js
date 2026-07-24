export const DEVICE_TELEMETRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function normalizeDeviceTelemetryId(value) {
    return String(value ?? "").trim();
}

export function validateDeviceTelemetryId(value, existingIds = []) {
    const id = normalizeDeviceTelemetryId(value);
    if (!id) return { ok: false, id, error: "Telemetry ID is required." };
    if (!DEVICE_TELEMETRY_ID_PATTERN.test(id)) {
        return { ok: false, id, error: "Use 1–64 letters, numbers, dashes, or underscores." };
    }
    if (existingIds.some((existing) => normalizeDeviceTelemetryId(existing) === id)) {
        return { ok: false, id, error: `Telemetry ID “${id}” is already in use.` };
    }
    return { ok: true, id, error: null };
}
