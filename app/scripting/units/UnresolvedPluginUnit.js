import { UnitBlock } from "../ScriptManager.js";
import { portsForAuthoringNode } from "../../plugin/PluginGraphLocks.js";

export class UnresolvedPluginUnit extends UnitBlock {
    static unresolvedPlugin = true;
    static blockType = "UnresolvedPluginUnit";

    constructor(uuid, { type, ports } = {}) {
        super(uuid);
        this.unresolvedType = String(type || "UnresolvedPluginUnit");
        this.placeholderPorts = ports || { inputs: {}, outputs: {} };
        this.reregister();
    }

    typeId() {
        return this.unresolvedType;
    }

    register() {
        const ports = this.placeholderPorts || { inputs: {}, outputs: {} };
        for (const [label, type] of Object.entries(ports.inputs || {})) {
            this.registerInput(label, type);
        }
        for (const [label, type] of Object.entries(ports.outputs || {})) {
            this.registerOutput(label, type);
        }
    }

    valid() {
        return false;
    }

    execute() {
        throw new Error(`Unresolved plugin unit "${this.unresolvedType}" cannot execute.`);
    }
}

export function createUnresolvedPluginUnit(node, { lock = null, document = null } = {}) {
    return new UnresolvedPluginUnit(node.uuid, {
        type: node.type,
        ports: portsForAuthoringNode(node, lock, document),
    });
}
