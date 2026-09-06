/** Identity selection is independent of manifest authoring normalization. */
export const WORLD_BOUND_IDENTITY = Object.freeze({ id: "world-bound", version: 2 });
export const WORLD_BOUND_IDENTITY_CAPABILITY = "world-bound@2";
export const IDENTITY_PROTOCOL_MINOR = 3;

export function assertRunIdentityCounters(manifest = {}, scenario = null) {
    const check = (value, name) => {
        if (value !== undefined && value !== null && !Number.isSafeInteger(value)) {
            throw new Error(`${name} must be a safe integer in run-manifest v11.`);
        }
    };
    if (typeof manifest.seed === "number") check(manifest.seed, "seed");
    for (const key of ["stepNs", "maxSteps"]) check(manifest.clock?.[key], `clock.${key}`);
    check(manifest.controls?.watchdogNs, "controls.watchdogNs");
    check(manifest.controls?.actuatorOverrides?.responseDelayNs, "controls.actuatorOverrides.responseDelayNs");
    for (const assertion of manifest.assertions ?? []) {
        for (const key of ["startStep", "endStep"]) check(assertion.window?.[key], `assertion.window.${key}`);
    }
    for (const sensor of manifest.sensorRig?.sensors ?? []) {
        for (const key of ["phaseNs", "maxQueueFrames"]) check(sensor[key], `sensor.${key}`);
        for (const key of ["fixedNs", "jitterNs"]) check(sensor.latency?.[key], `sensor.latency.${key}`);
    }
    for (const trigger of scenario?.triggers ?? []) {
        for (const key of ["timeNs", "step"]) check(trigger.condition?.[key], `scenario.trigger.condition.${key}`);
        for (const action of trigger.actions ?? []) check(action.durationNs, "scenario.trigger.action.durationNs");
    }
    for (const condition of scenario?.completion?.conditions ?? []) {
        check(condition.durationNs, "scenario.completion.durationNs");
        check(condition.cadence?.everyN, "scenario.completion.cadence.everyN");
    }
}

export function simulationIdentityVersion(resolved = {}) {
    const profile = resolved.identityProfile;
    if (resolved.kind === "cev-sim.run-manifest" && Number(resolved.version) > 11) {
        throw new Error(`Unsupported resolved manifest version ${resolved.version}.`);
    }
    if (Number(resolved.version) === 11 && resolved.kind === "cev-sim.run-manifest") {
        if (!profile || profile.id !== WORLD_BOUND_IDENTITY.id || profile.version !== 2
            || Object.keys(profile).length !== 2) {
            throw new Error("Manifest v11 requires identityProfile world-bound@2.");
        }
        assertRunIdentityCounters(resolved.manifest, resolved.scenario?.scenario);
        return 2;
    }
    if (profile !== undefined) throw new Error("Unsupported identity profile on a legacy resolved document.");
    return 1;
}
