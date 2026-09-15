/**
 * Stable signature of editor chrome that toolbar and workspace layout use.
 * High-frequency map pan/zoom, map drafts, and road-pen cursor updates are
 * excluded so those subscribers do not re-render on every pointer move.
 */
export function editorChromeKey(snapshot) {
    if (!snapshot) return "";
    const map = snapshot.map ?? {};
    return JSON.stringify({
        editorMode: snapshot.editorMode ?? null,
        activeTool: snapshot.activeTool ?? null,
        layers: snapshot.layers ?? null,
        hiddenEntityIds: [...(snapshot.hiddenEntityIds ?? [])].map(String).sort(),
        activePlacement: snapshot.activePlacement ?? null,
        chunkOutlinesVisible: snapshot.chunkOutlinesVisible !== false,
        transformSpace: snapshot.transformSpace ?? null,
        transformSnap: snapshot.transformSnap ?? null,
        sceneGridVisible: snapshot.sceneGridVisible !== false,
        selectionBoundsVisible: snapshot.selectionBoundsVisible !== false,
        roadHandlesVisible: snapshot.roadHandlesVisible === true,
        mapTool: map.activeMapTool ?? null,
        mapSnapEnabled: map.snapEnabled === true,
        mapSnapSize: map.snapSize ?? null,
        mapGridVisible: map.gridVisible !== false,
        mapSatelliteVisible: map.satelliteVisible === true,
        workspace: snapshot.workspace ?? null,
        earthImport: snapshot.earthImport ?? null,
        dirty: snapshot.dirty === true,
    });
}
