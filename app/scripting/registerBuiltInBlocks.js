import { defaultBlockRegistry } from "./BlockRegistry.js";
import { CompiledProgramUnitBlock, LocalScriptProgramBlock } from "./ScriptManager.js";
import { UNIT_CATALOG_META } from "./UnitCatalog.meta.js";
import { ROSInputBlock, ROSOutputBlock } from "./units/ROSUnit.block.js";

const LEGACY_HIDDEN_BLOCKS = Object.freeze([
    Object.freeze({ type: "ROSInputBlock", blockClass: ROSInputBlock }),
    Object.freeze({ type: "ROSOutputBlock", blockClass: ROSOutputBlock }),
    Object.freeze({ type: "CompiledProgramUnitBlock", blockClass: CompiledProgramUnitBlock }),
    Object.freeze({ type: "LocalScriptProgramBlock", blockClass: LocalScriptProgramBlock }),
]);

export function registerBuiltInBlocks(registry = defaultBlockRegistry) {
    UNIT_CATALOG_META.forEach((entry) => {
        registry.register(entry.type, entry.blockClass, "builtin");
    });
    LEGACY_HIDDEN_BLOCKS.forEach((entry) => {
        registry.register(entry.type, entry.blockClass, "builtin");
    });
    return registry;
}
