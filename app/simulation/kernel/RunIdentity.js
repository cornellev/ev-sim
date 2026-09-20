/** Identity selection is independent of manifest authoring normalization. */
export const WORLD_BOUND_IDENTITY = Object.freeze({ id: "world-bound", version: 2 });
export const WORLD_BOUND_IDENTITY_CAPABILITY = "world-bound@2";
export const WORLD_BOUND_PLUGINS_IDENTITY = Object.freeze({ id: "world-bound-plugins", version: 1 });
export const WORLD_BOUND_PLUGINS_IDENTITY_CAPABILITY = "world-bound-plugins@1";
export const IDENTITY_PROTOCOL_MINOR = 3;

function artifactUsesPlugins(artifact, seen = new WeakSet()) {
    if (!artifact || typeof artifact !== "object" || seen.has(artifact)) return false;
    seen.add(artifact);
    if (Array.isArray(artifact.pluginRequirements) && artifact.pluginRequirements.length > 0) return true;
    return (artifact.nodes ?? []).some((node) => artifactUsesPlugins(node?.state?.compiledProgram, seen));
}

export function resolvedUsesPlugins(resolved = {}) {
    if (resolved.manifest?.plugins?.enabled === true && (resolved.manifest.plugins.artifacts?.length ?? 0) > 0) return true;
    if ((resolved.plugins?.length ?? 0) > 0 || (resolved.pluginPackages?.length ?? 0) > 0) return true;
    if (resolved.pluginSensors?.description?.sensors?.length > 0 || resolved.dependencyHashes?.pluginSensors) return true;
    if (resolved.dependencyHashes?.plugins && Object.keys(resolved.dependencyHashes.plugins).length > 0) return true;
    return (resolved.scripts ?? []).some((entry) => artifactUsesPlugins(entry?.artifact));
}

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
        const worldBound = profile?.id === WORLD_BOUND_IDENTITY.id && profile?.version === WORLD_BOUND_IDENTITY.version;
        const pluginBound = profile?.id === WORLD_BOUND_PLUGINS_IDENTITY.id
            && profile?.version === WORLD_BOUND_PLUGINS_IDENTITY.version;
        if (!profile || Object.keys(profile).length !== 2 || (!worldBound && !pluginBound)) {
            throw new Error("Manifest v11 requires identityProfile world-bound@2 or world-bound-plugins@1.");
        }
        const usesPlugins = resolvedUsesPlugins(resolved);
        if (usesPlugins && !pluginBound) throw new Error("Resolved plugin resources require identityProfile world-bound-plugins@1.");
        if (!usesPlugins && pluginBound) throw new Error("identityProfile world-bound-plugins@1 requires an effective plugin selection.");
        assertRunIdentityCounters(resolved.manifest, resolved.scenario?.scenario);
        return 2;
    }
    if (profile !== undefined) throw new Error("Unsupported identity profile on a legacy resolved document.");
    return 1;
}
