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

const TOOL_VALUES = new Set(Object.values(EDITOR_TOOLS));
const MAP_TOOL_VALUES = new Set(Object.values(MAP_TOOLS));

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
    selection: null,
});

function cloneSelection(selection) {
    return selection ? { ...selection } : null;
}

function cloneSet(set) {
    return new Set(set ?? []);
}

function cloneMapState(map) {
    return {
        ...DEFAULT_MAP_STATE,
        ...(map ?? {}),
        draft: map?.draft ? { ...map.draft } : null,
        selection: map?.selection ? { ...map.selection } : null,
    };
}

export class EditorState {
    constructor(options = {}) {
        this.activeTool = TOOL_VALUES.has(options.activeTool)
            ? options.activeTool
            : EDITOR_TOOLS.SELECT;
        this.editorMode = options.editorMode === EDITOR_MODES.MAP
            ? EDITOR_MODES.MAP
            : EDITOR_MODES.SCENE;
        this.selection = cloneSelection(options.selection);
        this.layers = {
            ...DEFAULT_LAYERS,
            ...(options.layers ?? {}),
        };
        this.hiddenEntityIds = cloneSet(options.hiddenEntityIds);
        this.activePlacement = options.activePlacement ?? null;
        this.chunkOutlinesVisible = options.chunkOutlinesVisible ?? true;
        this.map = cloneMapState(options.map);
        this.dirty = false;
        this.subscribers = new Set();
    }

    snapshot() {
        return {
            activeTool: this.activeTool,
            editorMode: this.editorMode,
            selection: cloneSelection(this.selection),
            layers: { ...this.layers },
            hiddenEntityIds: cloneSet(this.hiddenEntityIds),
            activePlacement: this.activePlacement ? { ...this.activePlacement } : null,
            chunkOutlinesVisible: this.chunkOutlinesVisible,
            map: cloneMapState(this.map),
            dirty: this.dirty,
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
        const next = mode === EDITOR_MODES.MAP ? EDITOR_MODES.MAP : EDITOR_MODES.SCENE;
        if (this.editorMode === next) return;
        this.editorMode = next;
        if (next === EDITOR_MODES.MAP) {
            this.map.activeMapTool = this.map.activeMapTool ?? MAP_TOOLS.SELECT;
        } else {
            this.map.draft = null;
            this.map.selection = null;
        }
        this.notify();

        if (next === EDITOR_MODES.MAP) {
            this.onEnterMapMode?.();
        }
    }

    setMapModeEnterHandler(handler) {
        this.onEnterMapMode = handler;
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

    selectMapItem(selection) {
        const next = selection
            ? {
                type: selection.type,
                id: selection.id,
            }
            : null;

        if (this.map.selection?.type === next?.type && this.map.selection?.id === next?.id) {
            return;
        }

        this.map.selection = next;
        this.notify();
    }

    clearMapSelection() {
        if (!this.map.selection) return;
        this.map.selection = null;
        this.notify();
    }

    setPlacementAsset(asset) {
        this.activePlacement = asset ? { ...asset } : null;
        if (asset) {
            this.activeTool = EDITOR_TOOLS.PLACE;
        }
        this.notify();
    }

    selectEntity(entity) {
        const selection = entity
            ? {
                id: entity.id,
                kind: entity.kind,
                layer: entity.layer,
            }
            : null;

        if (this.selection?.id === selection?.id && this.selection?.kind === selection?.kind) {
            return;
        }

        this.selection = selection;
        this.notify();
    }

    clearSelection() {
        if (!this.selection) return;
        this.selection = null;
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

    suppressSelection(ms = 250) {
        this.selectionSuppressedUntil = performance.now() + ms;
    }

    isSelectionSuppressed() {
        return Number.isFinite(this.selectionSuppressedUntil)
            && performance.now() < this.selectionSuppressedUntil;
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
