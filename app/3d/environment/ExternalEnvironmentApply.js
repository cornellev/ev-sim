/**
 * Apply one storage-originated environment update through the same guarded
 * boundary used by Scene live sync. Dependencies are injected so the race
 * between fetch, persistence suspension, and loader application is testable.
 */
export async function applyExternalEnvironmentUpdate({
    runtime,
    environmentId,
    loadManifest,
    onApplied = null,
}) {
    const persistence = runtime?.environmentPersistence;
    const loader = runtime?.environmentLoader;
    if (!runtime || !loader || typeof loadManifest !== "function") {
        return { applied: false, unavailable: true };
    }

    try {
        const manifest = await loadManifest(environmentId);
        if (!manifest || runtime.disposed) return { applied: false, unavailable: true };
        const decision = persistence
            ? await persistence.prepareExternalApply(manifest)
            : { apply: true };
        if (!decision.apply) return { applied: false, ...decision };

        await loader.apply(manifest);
        loader.manifest = manifest;
        onApplied?.(manifest);
        persistence?.adoptRevision(manifest.revision);
        return { applied: true, manifest };
    } finally {
        persistence?.resumeAutosave();
    }
}
