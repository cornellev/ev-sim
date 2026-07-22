import { UNIT_CATALOG_META } from "@/app/scripting/UnitCatalog.meta";
import { registerBuiltInBlocks } from "@/app/scripting/registerBuiltInBlocks";

export const runtime = "nodejs";

let cachedUnits = null;

/**
 * GET /api/scripting/units
 * Returns unit-type metadata (ports + settings hints) for MCP / tooling.
 * Imports only React-free block modules.
 */
export async function GET() {
    try {
        if (!cachedUnits) {
            registerBuiltInBlocks();
            cachedUnits = buildUnitCatalogMetadata();
        }
        return Response.json({ ok: true, units: cachedUnits });
    } catch (error) {
        return Response.json({
            ok: false,
            error: error?.message || String(error),
            units: [],
        }, { status: 500 });
    }
}

function buildUnitCatalogMetadata() {
    return UNIT_CATALOG_META
        .filter((entry) => entry.blockClass)
        .map((entry) => describeBlockClass(entry))
        .filter(Boolean);
}

function describeBlockClass(entry) {
    const BlockClass = entry.blockClass;
    const type = entry.type || BlockClass.name;
    let instance;
    try {
        instance = new BlockClass(`meta-${type}`);
        if (typeof instance.register === "function") {
            instance.register();
        }
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
            defaultState: null,
            notes: entry.notes || "Could not instantiate block for metadata.",
        };
    }

    const inputs = Object.entries(instance.typeMap?.inputs || {}).map(([name, portType]) => ({
        name,
        type: portType,
    }));
    const outputs = Object.entries(instance.typeMap?.outputs || {}).map(([name, portType]) => ({
        name,
        type: portType,
    }));

    let programPort = null;
    let programNodeRole = instance.programNodeRole || BlockClass.programNodeRole || null;
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
        inputs,
        outputs,
        programNodeRole,
        programPort,
        placeable: entry.placeable !== false,
        notes: entry.notes || null,
        defaultState,
        settingsHints: {
            storedData: "Optional constant / UI value stored via ScriptManager.storeData(uuid, value).",
            state: "Block-specific serialized state from serializeState()/hydrateState().",
        },
    };
}
