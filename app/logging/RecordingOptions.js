/**
 * Build the complete, self-contained recording request used by both the UI and
 * MCP control bridge. Keeping attachment construction here prevents the two
 * recording entry points from drifting apart.
 */
export function buildRecordingOptions({ data, store, profile, name }) {
    const runtime = data?.bindings?.();
    const attachments = [
        { name: "signal-catalog.json", mime: "application/json", bytes: JSON.stringify(store.descriptors()) },
        { name: "bindings.json", mime: "application/json", bytes: JSON.stringify(runtime?.manifest || null) },
        { name: "environment.json", mime: "application/json", bytes: JSON.stringify(store.read("environment.manifest")?.value || null) },
    ];
    for (const [scriptId, script] of runtime?._scripts || []) {
        attachments.push({ name: `scripts/${scriptId}.json`, mime: "application/json", bytes: JSON.stringify(script.artifact) });
    }
    return {
        name,
        profile,
        environmentId: data?.environment?.()?.environmentId || null,
        simulator: data?.simulation?.()?.getSnapshot?.(),
        attachments,
    };
}
