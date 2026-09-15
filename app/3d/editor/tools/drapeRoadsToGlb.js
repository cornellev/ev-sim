import { drapeRoadControlPoints } from "../commands/roadCommands.js";
import { createGlbElevationSampler } from "./sampleGlbElevation.js";

/**
 * Browser entry: sample projected GLB meshes and execute `road.drape-to-glb`
 * with the session offset / include-connected flags.
 */
export function executeDrapeRoadsToGlb(data, overrides = {}) {
    const editor = data?.editor?.();
    const selection = data?.selection?.()?.snapshot?.() ?? {};
    const snapshot = editor?.snapshot?.() ?? {};
    const sampleElevation = typeof overrides.sampleElevation === "function"
        ? overrides.sampleElevation
        : createGlbElevationSampler(data?.environment?.()?.objects?.());
    const result = data?.commands?.()?.execute?.(drapeRoadControlPoints({
        objectIds: overrides.objectIds ?? selection.ids ?? [],
        sub: overrides.sub !== undefined ? overrides.sub : selection.sub ?? null,
        offset: overrides.offset ?? snapshot.roadGlbSnapOffset ?? 0,
        includeConnected: overrides.includeConnected ?? snapshot.roadGlbSnapIncludeConnected === true,
        sampleElevation,
    }));
    data?.simulation?.()?.render?.();
    return result;
}
