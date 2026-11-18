export const SIMULATION_VISIBILITY_GROUPS = [
    { id: "panels", title: "Panels", options: ["vehicleHierarchy", "sensorPanel"] },
    { id: "autonomy", title: "Autonomy & estimates", options: ["oracle", "candidate", "ekf", "estimateClone"] },
    { id: "roads", title: "Roads & trajectories", options: ["lanes", "controls", "pastTrajectories"] },
    { id: "occupancy", title: "Occupancy", options: ["oracleOccupancy", "lidarOccupancy", "stackOccupancy"] },
    { id: "diagnostics", title: "Diagnostics", options: ["scenarioDiagnostics", "sensorMarkers", "originMarker"] },
];

export function focusSimulationVisibility(body, keyboard, categoryId = null) {
    const selector = categoryId ? `[data-visibility-category="${categoryId}"]` : '[role="switch"]';
    const target = keyboard ? body?.querySelector(selector) : body;
    target?.focus();
}
