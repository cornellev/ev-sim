import { applyManualDrive } from "../../app/3d/vehicles/VehiclePlantAdapter.js";
import { createPhysicsBackendSelection } from "../../app/physics/PhysicsBackend.js";
import { PhysicsEngine } from "../../app/physics/PhysicsEngine.js";

export function rampSurface(pitch, length = 60) {
    const rise = Math.tan(pitch) * length;
    const start = -Math.tan(pitch) * 5;
    return {
        id: "ramp",
        kind: "road-mesh",
        vertices: [
            { x: -5, y: start, z: -10 }, { x: length, y: rise, z: -10 },
            { x: length, y: rise, z: 10 }, { x: -5, y: start, z: 10 },
        ],
        indices: [0, 1, 2, 0, 2, 3],
    };
}

export async function startChassis(world, vehicles) {
    const events = [];
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: { emitTelemetryEvent: (event) => events.push(event) } }),
    });
    await physics.configureRun({
        manifest: {},
        worldDescription: world,
        backendSelection: createPhysicsBackendSelection(world),
    });
    return { physics, events };
}

/** Put the Rapier body back on the plant. Pose-only changes already do this on the next step; velocity does not. */
export function placeChassis(physics, vehicle) {
    const plant = vehicle.plant ?? vehicle;
    const state = physics.vehicleStates.find((entry) => entry.chassis?.plant === plant);
    if (!state) throw new Error("contact chassis is missing");
    physics._placeChassis(state.body, state.chassis);
}

export function runChassis(physics, vehicles, steps, command = null, options = {}) {
    const dt = options.dt ?? 0.01;
    for (let index = 0; index < steps; index += 1) {
        for (const vehicle of vehicles) if (command) applyManualDrive(vehicle, command);
        physics.beginStep();
        for (const vehicle of vehicles) (vehicle.plant ?? vehicle).update(dt);
        physics.step(dt, options);
        physics.syncAndPublishContacts({ step: index + 1, timeNs: (index + 1) * dt * 1e9 });
        options.each?.(index);
    }
}
