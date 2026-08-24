import * as THREE from "three";

export const REPLAY_VEHICLE_SIZE = Object.freeze({
    length: 3.4,
    height: 0.8,
    width: 1.8,
});

/**
 * Simulation vehicle poses use local +X as forward, so the replay body's
 * longitudinal axis must also be X for recorded yaw to render correctly.
 */
export function createReplayVehicleGeometry() {
    return new THREE.BoxGeometry(
        REPLAY_VEHICLE_SIZE.length,
        REPLAY_VEHICLE_SIZE.height,
        REPLAY_VEHICLE_SIZE.width,
    );
}
