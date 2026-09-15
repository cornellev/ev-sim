/**
 * Hold scene presentation until catalog-backed environment GLTFs are idle
 * and one compiled frame has been submitted. Incremental editor edits stay
 * fire-and-forget; only boot (and callers that opt in) await this helper.
 */
export async function waitForEnvironmentGltfPresentation({
    projector, renderer, scene, camera, simulation,
} = {}) {
    await projector?.whenAssetInstancesIdle?.();
    try {
        renderer?.compile?.(scene, camera);
    } catch (error) {
        console.warn("[environment] presentation compile failed:", error);
    }
    simulation?.render?.();
}
