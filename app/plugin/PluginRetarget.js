function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function declaredSet(values) {
    return new Set(asArray(values));
}

function missingDeclared(values, declared) {
    for (const value of asArray(values)) {
        if (!declared.has(value)) return value;
    }
    return null;
}

function visitPrograms(program, visit) {
    if (!program || typeof program !== "object") return;
    visit(program);
    for (const node of asArray(program.nodes)) {
        const nested = node?.state?.compiledProgram;
        if (nested && typeof nested === "object") visitPrograms(nested, visit);
    }
}

function matchingRequirements(program, pluginId, runtimeHashes) {
    const matches = [];
    visitPrograms(program, (artifact) => {
        for (const requirement of asArray(artifact?.pluginRequirements)) {
            if (requirement?.pluginId === pluginId && runtimeHashes.has(requirement.runtimeHash)) matches.push(requirement);
        }
    });
    return matches;
}

function patchRequirements(program, pluginId, runtimeHashes, next) {
    visitPrograms(program, (artifact) => {
        if (!Array.isArray(artifact.pluginRequirements)) return;
        artifact.pluginRequirements = artifact.pluginRequirements.map((requirement) => {
            if (requirement?.pluginId !== pluginId || !runtimeHashes.has(requirement.runtimeHash)) return requirement;
            return { ...requirement, version: next.version, runtimeHash: next.runtimeHash };
        });
    });
}

function documentId(document, fallback) {
    return typeof document?.id === "string" && document.id ? document.id : fallback;
}

/**
 * Plan hash rewrites for saved authoring documents. Inputs are not mutated.
 * Documents that do not pin a superseded package are omitted. A document that
 * pins one, but lost a locked sensor, plant, unit, or granted capability, is
 * rejected and no adopted copy is returned.
 *
 * @param {{
 *   vehicles?: object[],
 *   scripts?: object[],
 *   runManifests?: object[],
 *   superseded?: Array<{ packageHash: string, runtimeHash: string }>,
 *   next: {
 *     pluginId: string,
 *     version: string,
 *     packageHash: string,
 *     runtimeHash: string,
 *     sensorTypes?: string[],
 *     plants?: string[],
 *     unitTypes?: string[],
 *     capabilities?: string[],
 *   },
 * }} input
 */
export function planPluginRetarget({
    vehicles = [],
    scripts = [],
    runManifests = [],
    superseded = [],
    next,
} = {}) {
    const pluginId = next?.pluginId;
    const packageHashes = new Set(asArray(superseded).map((entry) => entry?.packageHash).filter(Boolean));
    const runtimeHashes = new Set(asArray(superseded).map((entry) => entry?.runtimeHash).filter(Boolean));
    const sensorTypes = declaredSet(next?.sensorTypes);
    const plants = declaredSet(next?.plants);
    const unitTypes = declaredSet(next?.unitTypes);
    const capabilities = declaredSet(next?.capabilities);
    const rejections = [];
    const adoptedVehicles = [];
    const adoptedScripts = [];
    const adoptedRunManifests = [];

    for (const manifest of vehicles) {
        const locks = asArray(manifest?.pluginLocks).filter((lock) => lock?.pluginId === pluginId && packageHashes.has(lock.packageHash));
        if (locks.length === 0) continue;
        const id = documentId(manifest, "vehicle");
        const missingSensor = locks.map((lock) => missingDeclared(lock.sensorTypes, sensorTypes)).find(Boolean) ?? null;
        if (missingSensor) {
            rejections.push({
                path: `vehicles/${id}`,
                message: `vehicles/${id} locks sensor type "${missingSensor}" which the new package does not declare`,
            });
            continue;
        }
        const missingPlant = locks.map((lock) => missingDeclared(lock.plants, plants)).find(Boolean) ?? null;
        if (missingPlant) {
            rejections.push({
                path: `vehicles/${id}`,
                message: `vehicles/${id} locks plant "${missingPlant}" which the new package does not declare`,
            });
            continue;
        }
        const copy = structuredClone(manifest);
        copy.pluginLocks = asArray(copy.pluginLocks).map((lock) => (
            lock?.pluginId === pluginId && packageHashes.has(lock.packageHash)
                ? { ...lock, version: next.version, packageHash: next.packageHash, runtimeHash: next.runtimeHash }
                : lock
        ));
        adoptedVehicles.push(copy);
    }

    for (const document of scripts) {
        const locks = asArray(document?.graph?.pluginLocks).filter((lock) => lock?.pluginId === pluginId && packageHashes.has(lock.packageHash));
        const requirements = matchingRequirements(document?.latestValidArtifact, pluginId, runtimeHashes);
        if (locks.length === 0 && requirements.length === 0) continue;
        const id = documentId(document, "script");
        const missingUnit = locks.map((lock) => missingDeclared(lock.types, unitTypes)).find(Boolean)
            ?? requirements.map((requirement) => missingDeclared(requirement.types, unitTypes)).find(Boolean)
            ?? null;
        if (missingUnit) {
            rejections.push({
                path: `scripts/${id}`,
                message: `scripts/${id} locks unit type "${missingUnit}" which the new package does not declare`,
            });
            continue;
        }
        const copy = structuredClone(document);
        if (copy.graph && typeof copy.graph === "object") {
            copy.graph = {
                ...copy.graph,
                pluginLocks: asArray(copy.graph.pluginLocks).map((lock) => (
                    lock?.pluginId === pluginId && packageHashes.has(lock.packageHash)
                        ? { ...lock, version: next.version, packageHash: next.packageHash, runtimeHash: next.runtimeHash }
                        : lock
                )),
            };
        }
        patchRequirements(copy.latestValidArtifact, pluginId, runtimeHashes, next);
        adoptedScripts.push(copy);
    }

    for (const manifest of runManifests) {
        const artifacts = asArray(manifest?.plugins?.artifacts).filter((entry) => entry?.pluginId === pluginId && packageHashes.has(entry.expectedHash));
        if (artifacts.length === 0) continue;
        const id = documentId(manifest, "run-manifest");
        const missingCapability = artifacts.map((entry) => missingDeclared(entry.capabilities, capabilities)).find(Boolean) ?? null;
        if (missingCapability) {
            rejections.push({
                path: `run-manifests/${id}`,
                message: `run-manifests/${id} grants "${missingCapability}" which the new package does not declare`,
            });
            continue;
        }
        const copy = structuredClone(manifest);
        copy.plugins = {
            ...copy.plugins,
            artifacts: asArray(copy.plugins?.artifacts).map((entry) => (
                entry?.pluginId === pluginId && packageHashes.has(entry.expectedHash)
                    ? { ...entry, expectedHash: next.packageHash }
                    : entry
            )),
        };
        adoptedRunManifests.push(copy);
    }

    return {
        ok: rejections.length === 0,
        rejections,
        vehicles: rejections.length === 0 ? adoptedVehicles : [],
        scripts: rejections.length === 0 ? adoptedScripts : [],
        runManifests: rejections.length === 0 ? adoptedRunManifests : [],
    };
}
