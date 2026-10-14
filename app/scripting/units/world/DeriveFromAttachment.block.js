import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { freezePorts } from "../defineBlock.js";
import { hostFields, normalizeHostType, readAttachmentFields } from "./attachmentHosts.js";

function runtimeContext(unit) {
    return unit.manager?.getRuntimeContext?.() ?? {};
}

export function deriveAttachmentPorts(state = {}) {
    const fields = hostFields(normalizeHostType(state.hostType) ?? "road");
    return freezePorts([], [
        ...fields.map((field) => ({ label: field.label, type: field.type })),
        { label: "found", type: "boolean" },
    ]);
}

export class DeriveFromAttachmentBlock extends UnitBlock {
    static blockType = "DeriveFromAttachmentBlock";
    static defaults = { hostType: "road" };

    normalizeState(state = {}) {
        return { hostType: normalizeHostType(state.hostType) ?? "road" };
    }

    serializeState() {
        return { ...this.state };
    }

    hydrateState(state = {}) {
        this.state = this.normalizeState(state);
        this.reregister();
    }

    register() {
        this.state = this.normalizeState(this.state);
        const ports = deriveAttachmentPorts(this.state);
        for (const port of ports.outputs) this.registerOutput(port.label, port.type);
    }

    valid() {
        return true;
    }

    execute() {
        const read = readAttachmentFields(this.state.hostType, runtimeContext(this).attachment ?? null);
        const output = new BlockOutput().set("found", read.found);
        for (const field of hostFields(this.state.hostType)) output.set(field.label, read.values[field.label] ?? "");
        return output;
    }
}
