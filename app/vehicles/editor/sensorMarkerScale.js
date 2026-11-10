import * as THREE from "three";

/** Stock 2D LiDAR preview diameter. Fitted scale is a fraction of this. */
export const SENSOR_MARKER_REFERENCE_DIAMETER_M = 0.32;
export const SENSOR_MARKER_LENGTH_FRACTION = 0.12;
export const SENSOR_MARKER_MIN_DIAMETER_M = 0.04;
export const SENSOR_MARKER_SCALE_MIN = 0.05;
export const SENSOR_MARKER_SCALE_MAX = 2;
export const SENSOR_MARKER_PICK_RADIUS_M = 0.04;

const PICK_NAME = "sensor-marker-pick";

/**
 * Scale that keeps the stock 2D LiDAR disc at 12% of body length.
 * Never enlarges a passenger-car glyph, and never shrinks the disc below 4 cm.
 * A missing length stays at 1.
 */
export function fitSensorMarkerScale(lengthM) {
    const length = Number(lengthM);
    if (!(length > 0)) return 1;
    const diameter = Math.min(
        SENSOR_MARKER_REFERENCE_DIAMETER_M,
        Math.max(SENSOR_MARKER_MIN_DIAMETER_M, SENSOR_MARKER_LENGTH_FRACTION * length),
    );
    return diameter / SENSOR_MARKER_REFERENCE_DIAMETER_M;
}

/** Manual slider range. A non-finite value is rejected. */
export function clampSensorMarkerScale(scale) {
    const value = Number(scale);
    if (!Number.isFinite(value)) return null;
    return Math.min(SENSOR_MARKER_SCALE_MAX, Math.max(SENSOR_MARKER_SCALE_MIN, value));
}

/**
 * Per-vehicle display preference. Unknown modes and bad scales become fit,
 * which is stored by omitting that id.
 */
export function normalizeSensorMarkerScaleMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const next = {};
    for (const [id, entry] of Object.entries(value)) {
        if (!id || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (entry.mode === "fit") {
            next[id] = { mode: "fit" };
            continue;
        }
        if (entry.mode !== "manual") continue;
        const scale = clampSensorMarkerScale(entry.scale);
        if (scale == null) continue;
        next[id] = { mode: "manual", scale };
    }
    return next;
}

/** Manual scale wins. Anything else follows the body length. */
export function appliedSensorMarkerScale(entry, lengthM) {
    if (entry?.mode === "manual") {
        const scale = clampSensorMarkerScale(entry.scale);
        if (scale != null) return scale;
    }
    return fitSensorMarkerScale(lengthM);
}

/**
 * Unscaled root so the mount stays in meters. The preview child carries the scale.
 * @param {import("three").Object3D} preview
 * @param {number} scale
 */
export function mountSensorMarker(preview, scale) {
    const root = new THREE.Group();
    const visual = preview ?? new THREE.Group();
    root.userData.sensorVisual = visual;
    root.add(visual);
    syncSensorMarkerScale(root, scale);
    return root;
}

/**
 * Update the visual scale in place. A scale below 1 adds an opacity-0 pick
 * sphere, because `visible: false` is not raycast. Scale 1 removes it so
 * passenger-car picking stays on the glyph itself.
 */
export function syncSensorMarkerScale(root, scale) {
    const visual = root?.userData?.sensorVisual;
    if (visual) visual.scale.setScalar(scale);
    if (!root?.getObjectByName) return;
    const existing = root.getObjectByName(PICK_NAME);
    if (!(scale < 1)) {
        if (!existing) return;
        root.remove(existing);
        existing.geometry?.dispose?.();
        existing.material?.dispose?.();
        return;
    }
    const pick = existing ?? new THREE.Mesh(
        new THREE.SphereGeometry(SENSOR_MARKER_PICK_RADIUS_M, 8, 6),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    pick.name = PICK_NAME;
    if (root.userData?.pick) pick.userData.pick = root.userData.pick;
    if (!existing) root.add(pick);
}
