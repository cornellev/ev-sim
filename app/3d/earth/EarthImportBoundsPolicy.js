import { EARTH_IMPORT_STATUS } from "../editor/EditorState.js";
import { editorStateToGeoBounds, summarizeBounds } from "./map/GeoBoundsSelection.js";

/** Pure visibility policy for the transient Earth-import preview outline. */
export function shouldShowEarthImportBounds(editorSnapshot) {
    if (!editorSnapshot) return false;
    const earthImport = editorSnapshot.earthImport;
    if (!summarizeBounds(editorStateToGeoBounds(earthImport)).valid) return false;
    return earthImport.previewActive
        || earthImport.status === EARTH_IMPORT_STATUS.PREVIEW
        || earthImport.status === EARTH_IMPORT_STATUS.LOADING_TILES
        || earthImport.status === EARTH_IMPORT_STATUS.LOADING_ROADS;
}
