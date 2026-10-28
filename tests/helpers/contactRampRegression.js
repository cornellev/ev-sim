import { readFile } from "node:fs/promises";
import { Euler, Vector3 } from "three";

import { applyManualDrive, attachVehiclePlant, stepVehiclePlant } from "../../app/3d/vehicles/VehiclePlantAdapter.js";
import { ControlRuntime } from "../../app/autonomy/ControlRuntime.js";
import { createPhysicsBackendSelection } from "../../app/physics/PhysicsBackend.js";
import { PhysicsEngine } from "../../app/physics/PhysicsEngine.js";
import { createKeyboardDriveState, stepKeyboardDrive } from "../../app/simulation/keyboardDrive.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../../app/simulation/vehicles/KinematicVehiclePlant.js";
import { sampleContactSupport, settleContactVehicles } from "../../app/simulation/vehicles/contactBicycle.js";
import { createRoadGroundSampler } from "../../app/simulation/vehicles/roadGroundSampler.js";
import { CONTACT_BICYCLE_MODEL, normalizeVehicleManifest } from "../../app/vehicles/VehicleManifest.js";

export async function replayContactRamp({ browser = false, manifest = null, stepper = null, fixture: recording = null, releaseSeconds = 5, axle = null } = {}) {
    const fixture = recording ?? JSON.parse(await readFile(new URL("../fixtures/headless/contact-ramp-regression.v1.json", import.meta.url)));
    const source = manifest ?? normalizeVehicleManifest({ ...fixture.vehicle, dynamics: { model: CONTACT_BICYCLE_MODEL } });
    const options = { plantModel: CONTACT_BICYCLE_MODEL, stepper };
    let vehicle;
    if (browser) {
        vehicle = {
            telemetryId: "ego", position: new Vector3(0, 10, 0), rotation: new Euler(),
            velocity: new Vector3(), acceleration: new Vector3(), steeringAngle: 0,
            updatePosition(value) { this.position.copy(value); },
            updateRotation(value) { this.rotation.set(value.x, value.y, value.z, value.order); },
        };
        attachVehiclePlant(vehicle, fixture.initial, { manifest: source }, options);
    } else {
        vehicle = new KinematicVehiclePlant(createVehiclePlantDefinition(fixture.initial, { manifest: source }, options), { stepper });
        vehicle.telemetryId = "ego";
    }
    const body = vehicle.plant ?? vehicle;
    if (axle) body.definition.axle = { ...axle };
    const ground = createRoadGroundSampler(fixture.world);
    body.setGroundSampler((x, z, yaw) => ground.sample(x, z, yaw));
    const physics = new PhysicsEngine({ vehicles: () => ({ vehicles: [vehicle] }) });
    await physics.configureRun({ manifest: {}, worldDescription: fixture.world, backendSelection: createPhysicsBackendSelection(fixture.world) });
    const control = new ControlRuntime();
    control.configure({ controls: fixture.controls, vehicleLimits: { ego: source.kinematics } });
    const down = new Set();
    let keyboard = createKeyboardDriveState();
    const states = [];
    let maxLateralSpeed = 0;
    let floorSteps = 0;
    const dt = fixture.stepNs / 1e9;
    try {
        for (let step = 1; step <= fixture.steps + Math.ceil(releaseSeconds / dt); step += 1) {
            for (const event of fixture.keyboard.filter((event) => event.step === step)) {
                if (event.down) down.add(event.key);
                else down.delete(event.key);
            }
            const drive = stepKeyboardDrive(keyboard, { down, dt, enabled: true });
            keyboard = drive.state;
            if (drive.command) control.submitSiSpeedSteer("ego", {
                ...drive.command, captureTimeNs: (step - 1) * fixture.stepNs, producer: "candidate", source: "keyboard",
            });
            const applied = control.step({ step, timeNs: step * fixture.stepNs, dt }).get("ego");
            if (applied && !applied.passthrough) applyManualDrive(vehicle, {
                mode: applied.command.mode, speedMps: applied.speedMps,
                accelerationX: applied.accelerationMps2, steeringRad: applied.steeringRadThree,
            });
            physics.beginStep();
            if (browser) stepVehiclePlant(vehicle, dt);
            else body.update(dt);
            physics.step(dt);
            settleContactVehicles([vehicle]);
            control.sampleAchieved("ego", { speedMps: body.velocity.x, steeringRadThree: body.steeringAngle, accelerationMps2: body.acceleration.x });
            maxLateralSpeed = Math.max(maxLateralSpeed, Math.abs(body.lateralVelocity));
            const support = sampleContactSupport(body);
            if (support?.source === "floor" && body.onRoad) floorSteps += 1;
            states.push(body.getDeterministicState());
        }
        return { states, maxLateralSpeed, floorSteps };
    } finally {
        physics.disposeRun();
    }
}
