import { defaultBlockRegistry } from "./BlockRegistry.js";
import { CompiledProgramUnitBlock, LocalScriptProgramBlock } from "./ScriptManager.js";
import { UNIT_CATALOG_META } from "./UnitCatalog.meta.js";

const LEGACY_HIDDEN_BLOCKS = Object.freeze([
    Object.freeze({ type: "CompiledProgramUnitBlock", blockClass: CompiledProgramUnitBlock }),
    Object.freeze({ type: "LocalScriptProgramBlock", blockClass: LocalScriptProgramBlock }),
]);

export function registerBuiltInBlocks(registry = defaultBlockRegistry) {
    UNIT_CATALOG_META.forEach((entry) => {
        registry.ensureBuiltin(entry.type, entry.blockClass);
    });
    LEGACY_HIDDEN_BLOCKS.forEach((entry) => {
        registry.ensureBuiltin(entry.type, entry.blockClass);
    });
    return registry;
}
