export function deviceHierarchyLabel(device) {
    const name = typeof device?.name === "string" ? device.name.trim() : "";
    if (name) return name;
    const telemetryId = typeof device?.telemetryId === "string" ? device.telemetryId.trim() : "";
    if (telemetryId) return telemetryId;
    const id = typeof device?.id === "string" ? device.id.trim() : "";
    return id;
}
