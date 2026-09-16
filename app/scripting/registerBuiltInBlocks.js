import { registerBlockType } from "./BlockRegistry.js";
import { UNIT_CATALOG_META } from "./UnitCatalog.meta.js";
import { ROSInputBlock, ROSOutputBlock } from "./units/ROSUnit.block.js";

const LEGACY_HIDDEN_BLOCKS = Object.freeze([
    Object.freeze({ type: "ROSInputBlock", blockClass: ROSInputBlock }),
    Object.freeze({ type: "ROSOutputBlock", blockClass: ROSOutputBlock }),
]);

export function registerBuiltInBlocks() {
    UNIT_CATALOG_META.forEach((entry) => {
        registerBlockType(entry.type, entry.blockClass);
    });
    LEGACY_HIDDEN_BLOCKS.forEach((entry) => {
        registerBlockType(entry.type, entry.blockClass);
    });
}
