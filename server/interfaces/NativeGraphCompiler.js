import { BlockRegistry } from "../../app/scripting/BlockRegistry.js";
import { ScriptManager } from "../../app/scripting/ScriptManager.js";
import { registerBuiltInBlocks } from "../../app/scripting/registerBuiltInBlocks.js";
import { restoreManagerFromGraph } from "../../app/scripting/GraphDocument.js";

export function recompileNativeGraph(graph, name) {
    const registry = registerBuiltInBlocks(new BlockRegistry({ allowPlugins: false }));
    const manager = restoreManagerFromGraph(graph, (type) => registry.get(type), {
        createManager: () => new ScriptManager({ blockRegistry: registry }),
        onMissingBlock: (node) => { throw new Error(`Unknown native migration graph node ${node.type}.`); },
    });
    try {
        if (manager.restoreErrors?.length) throw new Error("Native graph connections require manual repair.");
        return manager.compile(name);
    } finally { manager.dispose?.(); }
}
