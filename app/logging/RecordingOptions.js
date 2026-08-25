/**
 * Build the complete, self-contained recording request used by both the UI and
 * MCP control bridge. Keeping attachment construction here prevents the two
 * recording entry points from drifting apart.
 */
export function buildRecordingOptions({
    data,
    store,
    profile,
    name,
    runId = null,
    resolvedRun = null,
    provenance = null,
    haltSimulationOnError,
}) {
    const runtime = data?.bindings?.();
    const attachments = [
        { name: "signal-catalog.json", mime: "application/json", bytes: JSON.stringify(store.descriptors()) },
        { name: "bindings.json", mime: "application/json", bytes: JSON.stringify(runtime?.manifest || null) },
        { name: "environment.json", mime: "application/json", bytes: JSON.stringify(store.read("environment.manifest")?.value || null) },
    ];
    for (const [scriptId, script] of runtime?._scripts || []) {
        attachments.push({ name: `scripts/${scriptId}.json`, mime: "application/json", bytes: JSON.stringify(script.artifact) });
    }
    if (resolvedRun) {
        attachments.push({ name: "run-manifest.json", mime: "application/json", bytes: JSON.stringify(resolvedRun) });
    }
    return {
        name,
        profile,
        environmentId: data?.environment?.()?.environmentId || null,
        simulator: data?.simulation?.()?.getSnapshot?.(),
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0",
        gitHash: process.env.NEXT_PUBLIC_GIT_HASH || null,
        runId,
        manifestId: resolvedRun?.manifest?.id ?? null,
        manifestRevision: resolvedRun?.manifest?.revision ?? null,
        definitionHash: resolvedRun?.definitionHash ?? null,
        resolvedHash: resolvedRun?.resolvedHash ?? null,
        provenance,
        haltSimulationOnError,
        timeBase: resolvedRun ? "simulation" : "wall",
        attachments,
    };
}
