import * as THREE from "three";

import { ManifestVehicle } from "./ManifestVehicle.js";
import { ScenarioCar } from "./ScenarioCar.js";
import { getBuiltInVehicleManifest } from "../../vehicles/BuiltInVehicleManifests.js";

function toVector3(value = {}) {
    return new THREE.Vector3(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
}

function toEuler(value = {}) {
    return new THREE.Euler(
        Number(value.x) || 0,
        Number(value.y) || 0,
        Number(value.z) || 0,
        value.order || "XYZ",
    );
}

/**
 * Spawn the browser vehicle class for a manifest type string.
 * Built-ins (except scenario-car) use ManifestVehicle; scenario-car keeps keyframe motion.
 */
export function createBrowserVehicle(db, {
    type,
    id,
    pose,
    manifest,
    keyframes,
    skipManifestDevices = false,
} = {}) {
    const resolvedType = type || "big-car";
    const position = toVector3(pose?.position);
    const rotation = toEuler(pose?.rotation);

    if (resolvedType === "scenario-car") {
        return new ScenarioCar(db, {
            id,
            keyframes: keyframes || [{ x: position.x, y: position.z, yaw: -rotation.y }],
        });
    }

    const resolvedManifest = manifest ?? getBuiltInVehicleManifest(resolvedType);
    if (!resolvedManifest) {
        throw new Error(`Vehicle "${id || resolvedType}" references unknown type "${resolvedType}"; no built-in or saved vehicle manifest matches.`);
    }

    return new ManifestVehicle(db, resolvedManifest, position, rotation, { skipManifestDevices });
}
