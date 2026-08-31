import { simulationSha256 } from "../simulation/kernel/SimulationHashes.js";

export const PHYSICS_BACKEND_KIND = 1;
export const PHYSICS_CAPABILITY_ID = "rapier3d-swept-prism-v1";
export const RAPIER3D_VERSION = "0.19.3";

export const PHYSICS_BACKEND_CONFIG = Object.freeze({
    kind: "cev-sim.physics-backend-config",
    version: 1,
    gravity: { x: 0, y: -9.81, z: 0, units: "m/s^2" },
    vehicleCollision: {
        shape: "axis-aligned-bounding-box",
        dimensions: "vehicle-manifest.boundingBox.size",
        center: "vehicle-kinematic-origin",
    },
    contactModel: {
        id: "continuous-xz-sat-y-slab-v1",
        authoritativeFirstImpact: "shared-swept-prism",
        impactBackoff: 1e-9,
        transitionOrder: "utf8-contact-id",
    },
});

export const PHYSICS_BACKEND_CONFIG_HASH = simulationSha256(PHYSICS_BACKEND_CONFIG);

const utf8Encoder = new TextEncoder();

function compareUtf8(left, right) {
    const a = utf8Encoder.encode(String(left));
    const b = utf8Encoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

export function createPhysicsBackendSelection() {
    return {
        kind: PHYSICS_BACKEND_KIND,
        capabilityId: PHYSICS_CAPABILITY_ID,
        version: RAPIER3D_VERSION,
        configHash: PHYSICS_BACKEND_CONFIG_HASH,
    };
}

export function sortBackendSelections(entries = []) {
    return [...entries].sort((left, right) => (
        Number(left.kind) - Number(right.kind)
        || compareUtf8(left.capabilityId, right.capabilityId)
        || compareUtf8(left.version, right.version)
        || compareUtf8(left.configHash, right.configHash)
    ));
}

export function assertPhysicsBackendSelection(selection) {
    const expected = createPhysicsBackendSelection();
    if (!selection) throw new Error(`Physics backend ${PHYSICS_CAPABILITY_ID} is required.`);
    for (const field of ["kind", "capabilityId", "version", "configHash"]) {
        if (selection[field] !== expected[field]) {
            throw new Error(
                `Physics backend mismatch for ${field}: expected ${expected[field]}, received ${selection[field]}.`,
            );
        }
    }
    return expected;
}
