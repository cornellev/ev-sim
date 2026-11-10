import { PLANT_CONTACT_BICYCLE_MODEL } from "../../plugin/PlantModule.js";
import { HeadlessEpisodeError } from "../headless/HeadlessErrors.js";
import { resolveVehiclePhysicsConfig } from "./VehiclePhysicsConfig.js";

export const CONTACT_HOST_VERSION = 3;

/** Plants must come from verified, exactly locked package declarations. */
export function contactHostForVehicle(manifest, plants) {
    const plant = plants?.get(manifest?.dynamics?.plant);
    return plant?.model === PLANT_CONTACT_BICYCLE_MODEL ? CONTACT_HOST_VERSION : undefined;
}

/** Check received execution identity without applying authoring migration. */
export function assertResolvedContactHosts(resolved, plants = new Map()) {
    assertZeroSpeedResponse(resolved, plants);
    for (const [path, vehicles] of [
        ["vehicles", resolved.vehicles ?? []],
        ["scenario.vehicles", resolved.scenario?.vehicles ?? []],
    ]) {
        for (const [index, record] of vehicles.entries()) {
            const vehiclePath = `${path}.${index}`;
            const actorId = record.actorId ?? record.vehicleId;
            const reject = (reason) => {
                throw new HeadlessEpisodeError(
                    "UNSUPPORTED_CAPABILITY",
                    `${vehiclePath} (${actorId}): ${reason}; re-resolve this run.`,
                    { path: vehiclePath, actorId, expectedContactHost: CONTACT_HOST_VERSION },
                );
            };
            if (record.manifest?.dynamics?.model === "contact-bicycle-v1") {
                reject("contact-bicycle-v1 execution is no longer supported");
            }
            const plantId = record.manifest?.dynamics?.plant;
            if (plantId && !plants.has(plantId)) reject(`plant "${plantId}" is not in the selected package declarations`);
            try {
                resolveVehiclePhysicsConfig(record.manifest, plants.get(plantId));
            } catch (error) {
                reject(error.message);
            }
            const expected = contactHostForVehicle(record.manifest, plants);
            if (expected !== undefined) {
                if (record.contactHost !== expected) reject(`contact plugins require numeric contactHost: ${expected}`);
            } else if (Object.hasOwn(record, "contactHost")) {
                reject("contactHost is only valid for a contact-plugin vehicle");
            }
        }
    }
}

export function assertZeroSpeedResponse(resolved, plants = new Map()) {
    const controls = resolved.manifest?.controls;
    if (controls?.zeroSpeedResponse === undefined) return;
    const targetId = controls.targetVehicleId || "ego";
    const record = resolved.vehicles?.find((entry) => entry.actorId === targetId);
    const vehicle = record?.manifest;
    const limits = { ...vehicle?.kinematics, ...controls.actuatorOverrides };
    if (controls.zeroSpeedResponse !== "brake-v1"
        || !(vehicle?.dynamics?.model === "contact-bicycle-v2" || (contactHostForVehicle(vehicle, plants) === CONTACT_HOST_VERSION && record.contactHost === CONTACT_HOST_VERSION))
        || !Number.isFinite(limits.maxDeceleration) || limits.maxDeceleration <= 0
        || !Number.isFinite(limits.maxJerk) || limits.maxJerk <= 0) {
        throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", `controls.zeroSpeedResponse: brake-v1 requires a contact-v2 target and positive deceleration/jerk limits (${targetId}).`);
    }
}
