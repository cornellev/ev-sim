import {
    DEFAULT_EARTH_IMPORT_CONFIG,
    EARTH_IMPORT_STATUS,
    normalizeEarthImportEditorState,
} from "../earth/EarthImportConfig.js";

/**
 * @typedef {ReturnType<typeof normalizeEarthImportEditorState>} EarthImportEditorState
 */

export const EDITOR_TOOLS = Object.freeze({
    SELECT: "select",
    TRANSLATE: "translate",
    ROTATE: "rotate",
    SCALE: "scale",
    PLACE: "place",
});

export const MAP_TOOLS = Object.freeze({
    SELECT: "map-select",
    PAN: "map-pan",
    ROAD_PEN: "road-pen",
    INTERSECTION: "intersection",
    BUILDING_RECT: "building-rect",
    FEATURE_PLACE: "feature-place",
});

export const MAP_SELECTION_TYPES = Object.freeze({
    BUILDING: "building",
    FEATURE: "feature",
    ROAD: "road",
    INTERSECTION: "intersection",
});

export const EDITOR_MODES = Object.freeze({
    SCENE: "scene",
    MAP: "map",
    EARTH_IMPORT: "earth-import",
});

export const EDITOR_LAYERS = Object.freeze({
    BUILDINGS: "buildings",
    ROADS: "roads",
    PROPS: "props",
});

const DEFAULT_LAYERS = Object.freeze({
    [EDITOR_LAYERS.BUILDINGS]: true,
    [EDITOR_LAYERS.ROADS]: true,
    [EDITOR_LAYERS.PROPS]: true,
});

export const TRANSFORM_SPACES = Object.freeze({ WORLD: "world", LOCAL: "local" });

export const DEFAULT_TRANSFORM_SNAP = Object.freeze({
    enabled: false,
    translation: 0.5,
    rotationDeg: 15,
    scale: 0.1,
});

/** Session view options mirrored to a localStorage preference (never persisted with the environment). */
export const VIEW_OPTION_KEYS = Object.freeze(["transformSpace", "transformSnap", "sceneGridVisible", "selectionBoundsVisible", "chunkOutlinesVisible"]);

/** Normalize a snap patch over `base`; invalid or non-positive steps keep the base value. */
function normalizeTransformSnap(snap, base = DEFAULT_TRANSFORM_SNAP) {
    const source = snap && typeof snap === "object" ? snap : {};
    const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
    return {
        enabled: source.enabled === undefined ? base.enabled === true : source.enabled === true,
        translation: positive(source.translation, base.translation),
        rotationDeg: positive(source.rotationDeg, base.rotationDeg),
        scale: positive(source.scale, base.scale),
    };
}

const TOOL_VALUES = new Set(Object.values(EDITOR_TOOLS));
const MAP_TOOL_VALUES = new Set(Object.values(MAP_TOOLS));
const EDITOR_MODE_VALUES = new Set(Object.values(EDITOR_MODES));

const DEFAULT_MAP_STATE = Object.freeze({
    centerX: 0,
    centerZ: 0,
    zoom: 1,
    snapEnabled: true,
    snapSize: 1,
    gridVisible: true,
    activeMapTool: MAP_TOOLS.SELECT,
    activeFeatureType: null,
    draft: null,
});

function cloneSet(set) {
    return new Set(set ?? []);
}

function cloneMapState(map) {
    return {
        ...DEFAULT_MAP_STATE,
        ...(map ?? {}),
        draft: map?.draft ? { ...map.draft } : null,
    };
}

function cloneEarthImportState(earthImport) {
    return normalizeEarthImportEditorState(earthImport);
}

function normalizeEditorMode(mode) {
    return EDITOR_MODE_VALUES.has(mode) ? mode : EDITOR_MODES.SCENE;
}

export class EditorState {
    constructor(options = {}) {
        this.activeTool = TOOL_VALUES.has(options.activeTool)
            ? options.activeTool
            : EDITOR_TOOLS.SELECT;
        this.editorMode = normalizeEditorMode(options.editorMode);
        this.layers = {
            ...DEFAULT_LAYERS,
            ...(options.layers ?? {}),
        };
        this.hiddenEntityIds = cloneSet(options.hiddenEntityIds);
        this.activePlacement = options.activePlacement ?? null;
        this.chunkOutlinesVisible = options.chunkOutlinesVisible ?? true;
        // ED-03 view options: gizmo axis space, scene snapping, working grid,
        // and selection bounds. Session state, remembered as a preference.
        this.transformSpace = options.transformSpace === TRANSFORM_SPACES.LOCAL ? TRANSFORM_SPACES.LOCAL : TRANSFORM_SPACES.WORLD;
        this.transformSnap = normalizeTransformSnap(options.transformSnap);
        this.sceneGridVisible = options.sceneGridVisible !== false;
        this.selectionBoundsVisible = options.selectionBoundsVisible !== false;
        this.map = cloneMapState(options.map);
        this.earthImport = cloneEarthImportState(options.earthImport);
        this.dirty = false;
        this.subscribers = new Set();
    }

    snapshot() {
        return {
            activeTool: this.activeTool,
            editorMode: this.editorMode,
            layers: { ...this.layers },
            hiddenEntityIds: cloneSet(this.hiddenEntityIds),
            activePlacement: this.activePlacement ? { ...this.activePlacement } : null,
            chunkOutlinesVisible: this.chunkOutlinesVisible,
            transformSpace: this.transformSpace,
            transformSnap: { ...this.transformSnap },
            sceneGridVisible: this.sceneGridVisible,
            selectionBoundsVisible: this.selectionBoundsVisible,
            map: cloneMapState(this.map),
            earthImport: cloneEarthImportState(this.earthImport),
            dirty: this.dirty,
        };
    }

    /** The view options remembered as an editor preference (not in the manifest). */
    viewOptionsSnapshot() {
        return {
            transformSpace: this.transformSpace,
            transformSnap: { ...this.transformSnap },
            sceneGridVisible: this.sceneGridVisible,
            selectionBoundsVisible: this.selectionBoundsVisible,
            chunkOutlinesVisible: this.chunkOutlinesVisible,
        };
    }

    /** Apply stored view options in one notification. */
    applyViewOptions(options = {}) {
        if (!options || typeof options !== "object") return;
        let changed = false;
        if (options.transformSpace !== undefined) {
            const next = options.transformSpace === TRANSFORM_SPACES.LOCAL ? TRANSFORM_SPACES.LOCAL : TRANSFORM_SPACES.WORLD;
            if (next !== this.transformSpace) { this.transformSpace = next; changed = true; }
        }
        if (options.transformSnap !== undefined) {
            const next = normalizeTransformSnap(options.transformSnap, this.transformSnap);
            if (JSON.stringify(next) !== JSON.stringify(this.transformSnap)) { this.transformSnap = next; changed = true; }
        }
        for (const key of ["sceneGridVisible", "selectionBoundsVisible", "chunkOutlinesVisible"]) {
            if (options[key] === undefined) continue;
            const next = options[key] !== false;
            if (next !== this[key]) { this[key] = next; changed = true; }
        }
        if (changed) this.notify();
    }

    /**
     * The subset of editor state that persists with the environment manifest.
     * Selection, tools, drafts, and dirtiness are session state and excluded.
     */
    persistedSnapshot() {
        const map = cloneMapState(this.map);
        return {
            layers: { ...this.layers },
            hiddenEntityIds: [...this.hiddenEntityIds].sort(),
            editorMode: this.editorMode,
            map: {
                centerX: map.centerX,
                centerZ: map.centerZ,
                zoom: map.zoom,
                snapEnabled: map.snapEnabled,
                snapSize: map.snapSize,
                gridVisible: map.gridVisible,
            },
            earthImport: cloneEarthImportState(this.earthImport),
        };
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.snapshot());
        return () => {
            this.subscribers.delete(callback);
        };
    }

    notify() {
        const snapshot = this.snapshot();
        this.subscribers.forEach((callback) => callback(snapshot));
    }

    markDirty(value = true, notify = true) {
        if (this.dirty === value) return;
        this.dirty = value;
        if (notify) this.notify();
    }

    setEditorMode(mode) {
        const next = normalizeEditorMode(mode);
        if (this.editorMode === next) return;
        const previous = this.editorMode;
        this.editorMode = next;

        if (next !== EDITOR_MODES.MAP) {
            this.map.draft = null;
        }

        if (next === EDITOR_MODES.MAP) {
            this.map.activeMapTool = this.map.activeMapTool ?? MAP_TOOLS.SELECT;
        }

        if (next !== EDITOR_MODES.EARTH_IMPORT) {
            this.earthImport.previewActive = false;
            if (this.earthImport.status === EARTH_IMPORT_STATUS.PREVIEW) {
                this.earthImport.status = EARTH_IMPORT_STATUS.IDLE;
                this.earthImport.statusMessage = null;
            }
        }

        this.notify();

        if (next === EDITOR_MODES.MAP) {
            this.onEnterMapMode?.();
        } else if (previous === EDITOR_MODES.MAP) {
            this.onExitMapMode?.();
        }

        if (next === EDITOR_MODES.EARTH_IMPORT) {
            this.onEnterEarthImportMode?.();
        } else if (previous === EDITOR_MODES.EARTH_IMPORT) {
            this.onExitEarthImportMode?.();
        }
    }

    setMapModeEnterHandler(handler) {
        this.onEnterMapMode = handler;
    }

    setMapModeExitHandler(handler) {
        this.onExitMapMode = handler;
    }

    setEarthImportModeEnterHandler(handler) {
        this.onEnterEarthImportMode = handler;
    }

    setEarthImportModeExitHandler(handler) {
        this.onExitEarthImportMode = handler;
    }

    patchEarthImport(patch = {}) {
        const next = cloneEarthImportState({
            ...this.earthImport,
            ...patch,
        });

        const changed = JSON.stringify(next) !== JSON.stringify(this.earthImport);
        if (!changed) return;

        this.earthImport = next;
        this.notify();
    }

    setEarthImportStatus(status, message = null) {
        this.patchEarthImport({
            status,
            statusMessage: message,
        });
    }

    setActiveTool(tool) {
        if (!TOOL_VALUES.has(tool) || this.activeTool === tool) return;
        this.activeTool = tool;
        if (tool !== EDITOR_TOOLS.PLACE) {
            this.activePlacement = null;
        }
        this.notify();
    }

    setActiveMapTool(tool) {
        if (!MAP_TOOL_VALUES.has(tool) || this.map.activeMapTool === tool) return;
        this.map.activeMapTool = tool;
        this.map.draft = null;
        if (tool !== MAP_TOOLS.FEATURE_PLACE) {
            this.map.activeFeatureType = null;
        }
        this.notify();
    }

    setMapFeatureType(featureType) {
        this.map.activeFeatureType = featureType ?? null;
        if (featureType) {
            this.map.activeMapTool = MAP_TOOLS.FEATURE_PLACE;
        }
        this.notify();
    }

    setMapViewport({ centerX, centerZ, zoom } = {}) {
        let changed = false;
        if (Number.isFinite(centerX) && this.map.centerX !== centerX) {
            this.map.centerX = centerX;
            changed = true;
        }
        if (Number.isFinite(centerZ) && this.map.centerZ !== centerZ) {
            this.map.centerZ = centerZ;
            changed = true;
        }
        if (Number.isFinite(zoom) && zoom > 0 && this.map.zoom !== zoom) {
            this.map.zoom = zoom;
            changed = true;
        }
        if (changed) this.notify();
    }

    setMapSnapEnabled(enabled) {
        const next = Boolean(enabled);
        if (this.map.snapEnabled === next) return;
        this.map.snapEnabled = next;
        this.notify();
    }

    setMapSnapSize(size) {
        const next = Math.max(0.1, Number(size) || 1);
        if (this.map.snapSize === next) return;
        this.map.snapSize = next;
        this.notify();
    }

    setMapGridVisible(visible) {
        const next = Boolean(visible);
        if (this.map.gridVisible === next) return;
        this.map.gridVisible = next;
        this.notify();
    }

    setMapDraft(draft) {
        this.map.draft = draft ? { ...draft } : null;
        this.notify();
    }

    clearMapDraft() {
        if (!this.map.draft) return;
        this.map.draft = null;
        this.notify();
    }


    setPlacementAsset(asset) {
        this.activePlacement = asset ? { ...asset } : null;
        if (asset) {
            this.activeTool = EDITOR_TOOLS.PLACE;
        }
        this.notify();
    }


    setLayerVisible(layer, visible) {
        if (!(layer in this.layers) || this.layers[layer] === visible) return;
        this.layers[layer] = Boolean(visible);
        this.notify();
    }

    setChunkOutlinesVisible(visible) {
        const next = Boolean(visible);
        if (this.chunkOutlinesVisible === next) return;
        this.chunkOutlinesVisible = next;
        this.notify();
    }

    setTransformSpace(space) {
        const next = space === TRANSFORM_SPACES.LOCAL ? TRANSFORM_SPACES.LOCAL : TRANSFORM_SPACES.WORLD;
        if (this.transformSpace === next) return;
        this.transformSpace = next;
        this.notify();
    }

    setTransformSnapEnabled(enabled) {
        this.setTransformSnap({ enabled: Boolean(enabled) });
    }

    setTransformSnap(patch = {}) {
        const next = normalizeTransformSnap(patch, this.transformSnap);
        if (JSON.stringify(next) === JSON.stringify(this.transformSnap)) return;
        this.transformSnap = next;
        this.notify();
    }

    setSceneGridVisible(visible) {
        const next = Boolean(visible);
        if (this.sceneGridVisible === next) return;
        this.sceneGridVisible = next;
        this.notify();
    }

    setSelectionBoundsVisible(visible) {
        const next = Boolean(visible);
        if (this.selectionBoundsVisible === next) return;
        this.selectionBoundsVisible = next;
        this.notify();
    }


    setEntityHidden(entityId, hidden) {
        if (!entityId) return;

        const hasEntity = this.hiddenEntityIds.has(entityId);
        if (hidden && hasEntity) return;
        if (!hidden && !hasEntity) return;

        if (hidden) {
            this.hiddenEntityIds.add(entityId);
        } else {
            this.hiddenEntityIds.delete(entityId);
        }

        this.markDirty(true);
        this.notify();
    }
}

export { EARTH_IMPORT_STATUS, DEFAULT_EARTH_IMPORT_CONFIG };
