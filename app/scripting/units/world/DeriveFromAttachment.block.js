import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { defineBlock, freezePorts } from "../defineBlock.js";
import { emptyAttachmentValue, hostFields, normalizeHostType, readAttachmentFields } from "./attachmentHosts.js";

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

function attachmentValue(field, value) {
    if (field.type === "vec3") {
        const point = value && typeof value === "object" ? value : {};
        const component = (componentValue) => Number.isFinite(Number(componentValue)) ? Number(componentValue) : 0;
        return { x: component(point.x), y: component(point.y), z: component(point.z) };
    }
    return value ?? emptyAttachmentValue(field);
}

function attachmentOutput(unit, hostType) {
    const read = readAttachmentFields(hostType, runtimeContext(unit).attachment ?? null);
    const output = new BlockOutput().set("found", read.found);
    for (const field of hostFields(hostType)) output.set(field.label, attachmentValue(field, read.values[field.label]));
    return output;
}

export function defineAttachmentBlock(type, hostType) {
    const ports = deriveAttachmentPorts({ hostType });
    return defineBlock({
        type,
        ports,
        valid: () => true,
        execute() {
            return attachmentOutput(this, hostType);
        },
    });
}

export const GeneralAttachmentBlock = defineAttachmentBlock("GeneralAttachmentBlock", "general");
export const RoadAttachmentBlock = defineAttachmentBlock("RoadAttachmentBlock", "road");
export const GroupAttachmentBlock = defineAttachmentBlock("GroupAttachmentBlock", "group");
export const BuildingAttachmentBlock = defineAttachmentBlock("BuildingAttachmentBlock", "building");
export const IntersectionAttachmentBlock = defineAttachmentBlock("IntersectionAttachmentBlock", "intersection");
export const PropAttachmentBlock = defineAttachmentBlock("PropAttachmentBlock", "builtin-prop");
export const AssetAttachmentBlock = defineAttachmentBlock("AssetAttachmentBlock", "asset-instance");
export const DriveAreaAttachmentBlock = defineAttachmentBlock("DriveAreaAttachmentBlock", "drive-area");

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
        return attachmentOutput(this, this.state.hostType);
    }
}
