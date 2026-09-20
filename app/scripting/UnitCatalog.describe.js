import { UNIT_CATALOG_META } from "./UnitCatalog.meta.js";
import { serializeTypeScheme } from "./types/TypeScheme.js";

const BUILTIN_SETTINGS_HINTS = Object.freeze({
    storedData: "Optional constant / UI value stored via ScriptManager.storeData(uuid, value).",
    state: "Block-specific serialized state from serializeState()/hydrateState().",
});

const PLUGIN_SETTINGS_HINTS = Object.freeze({
    storedData: "Plugin units do not use storedData. Settings target authored state.",
    state: "Block-specific serialized state from serializeState()/hydrateState().",
});

function portList(map) {
    return Object.entries(map || {}).map(([name, type]) => ({ name, type }));
}

export function describeBuiltInCatalogEntry(entry) {
    const BlockClass = entry.blockClass;
    const type = entry.type;
    let instance;
    try {
        instance = new BlockClass(`meta-${type}`);
        if (typeof instance.register === "function") instance.register();
        if (typeof instance.hydrateState === "function") {
            try {
                instance.hydrateState(instance.serializeState?.() ?? {});
            } catch {
                // Some blocks need richer state; ports from register() are enough.
            }
        }
    } catch (error) {
        return {
            type,
            category: entry.category,
            name: entry.name,
            error: error?.message || String(error),
            inputs: [],
            outputs: [],
            programNodeRole: null,
            placeable: entry.placeable !== false,
            deprecated: entry.deprecated === true,
            keywords: entry.keywords || [],
            settings: entry.settings || [],
            requiresSignals: entry.requiresSignals === true,
            defaultState: null,
            notes: entry.notes || "Could not instantiate block for metadata.",
            ownership: "builtin",
            capabilities: [],
            ui: { available: true, fallback: "builtin" },
            settingsHints: BUILTIN_SETTINGS_HINTS,
        };
    }

    let programPort = null;
    const programNodeRole = instance.programNodeRole || BlockClass.programNodeRole || null;
    if (typeof instance.getProgramPortDefinition === "function") {
        try {
            programPort = instance.getProgramPortDefinition();
        } catch {
            programPort = null;
        }
    }

    let defaultState = null;
    try {
        defaultState = typeof instance.serializeState === "function"
            ? instance.serializeState()
            : (BlockClass.defaults ? { ...BlockClass.defaults } : null);
    } catch {
        defaultState = BlockClass.defaults ? { ...BlockClass.defaults } : null;
    }

    return {
        type,
        category: entry.category,
        name: entry.name,
        inputs: portList(instance.typeMap?.inputs),
        outputs: portList(instance.typeMap?.outputs),
        programNodeRole,
        programPort,
        placeable: entry.placeable !== false,
        deprecated: entry.deprecated === true,
        keywords: entry.keywords || [],
        settings: entry.settings || [],
        requiresSignals: entry.requiresSignals === true,
        notes: entry.notes || null,
        typeScheme: serializeTypeScheme(BlockClass.typeScheme),
        defaultState,
        settingsHints: BUILTIN_SETTINGS_HINTS,
        ownership: "builtin",
        capabilities: [],
        ui: { available: true, fallback: "builtin" },
    };
}

export function describeBuiltInCatalog() {
    return UNIT_CATALOG_META
        .filter((entry) => entry.blockClass)
        .map((entry) => describeBuiltInCatalogEntry(entry))
        .filter(Boolean);
}

export function describePluginCatalogUnit(unit, metadata, document) {
    return {
        type: unit.type,
        category: unit.catalog.category,
        name: unit.catalog.name,
        inputs: portList(unit.ports.inputs),
        outputs: portList(unit.ports.outputs),
        programNodeRole: null,
        programPort: null,
        placeable: unit.catalog.placeable !== false,
        deprecated: unit.catalog.deprecated === true,
        keywords: [...(unit.catalog.keywords || [])],
        settings: unit.settings || [],
        requiresSignals: unit.catalog.requiresSignals === true,
        notes: null,
        typeScheme: null,
        defaultState: unit.defaults ?? {},
        settingsHints: PLUGIN_SETTINGS_HINTS,
        ownership: {
            pluginId: metadata.pluginId,
            version: metadata.version,
            packageHash: metadata.packageHash,
            runtimeHash: metadata.runtimeHash,
            ...(metadata.uiHash ? { uiHash: metadata.uiHash } : {}),
        },
        capabilities: [...(document.capabilities || [])],
        ui: {
            available: Boolean(document.entry?.ui),
            ...(document.entry?.ui ? { entry: document.entry.ui } : {}),
            fallback: "generic",
        },
    };
}
