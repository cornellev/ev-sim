/**
 * Sky: the document's `sky` scalar is the authored value; the runtime
 * `EnvironmentSkyState` mirrors it (and keeps session-only preview state).
 * Committed, undone, and redone sky edits all arrive here as scalar changes.
 */

export function createSkyProjector() {
    return {
        id: "sky",
        apply({ changeSet, data }) {
            const scalar = changeSet.scalars?.sky;
            if (!scalar || !scalar.after) return;
            const skyState = data?.environment?.()?.sky?.() ?? data?.sky?.() ?? null;
            if (typeof skyState?.update !== "function") return;
            skyState.update(scalar.after);
        },
    };
}
