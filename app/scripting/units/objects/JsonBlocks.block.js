import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { cloneValue, deleteByPath, getByPath, setByPath } from "../../runtime/SignalStore.js";
import { parseValueByType } from "../program/ProgramTypes.js";
import { normalizeItemType } from "../valueOps.js";

import { freezePorts } from "../defineBlock.js";
const PATH_MISSING = Symbol("json-path-missing");

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeJsonPath(path) {
    return String(path ?? "");
}

export function jsonGetPorts(state = {}) {
    const valueType = normalizeItemType(state.valueType, "json");
    return freezePorts(
        [{ label: "document", type: "json" }],
        [
            { label: "value", type: valueType },
            { label: "exists", type: "boolean" },
        ],
    );
}

export function jsonSetPorts(state = {}) {
    const valueType = normalizeItemType(state.valueType, "json");
    return freezePorts(
        [
            { label: "document", type: "json" },
            { label: "value", type: valueType },
        ],
        [{ label: "document", type: "json" }],
    );
}

export function mergeJson(a, b) {
    if (isPlainObject(a) && isPlainObject(b)) {
        return { ...cloneValue(a), ...cloneValue(b) };
    }
    if (isPlainObject(b) || Array.isArray(b)) return cloneValue(b);
    return cloneValue(a);
}

function applyPorts(unit, ports) {
    for (const port of ports.inputs) unit.registerInput(port.label, port.type);
    for (const port of ports.outputs) unit.registerOutput(port.label, port.type);
}

function defineConfiguredBlock({ type, defaults, normalizeState, register, execute, valid }) {
    class Block extends UnitBlock {
        static blockType = type;
        static defaults = defaults;

        normalizeState(state = {}) {
            return normalizeState.call(this, state);
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
            register.call(this);
        }

        valid() {
            if (valid) return valid.call(this);
            return true;
        }

        execute() {
            return execute.call(this);
        }
    }

    try {
        Object.defineProperty(Block, "name", { value: type });
    } catch {
        // Class name is non-configurable in some engines; blockType is the authority.
    }

    return Block;
}

function defineBlock({ type, ports, execute, valid }) {
    class Block extends UnitBlock {
        static blockType = type;

        register() {
            applyPorts(this, ports);
        }

        valid() {
            if (valid) return valid.call(this);
            return ports.inputs.every((port) => this.hasInput(port.label));
        }

        execute() {
            return execute.call(this);
        }
    }

    try {
        Object.defineProperty(Block, "name", { value: type });
    } catch {
        // Class name is non-configurable in some engines; blockType is the authority.
    }

    return Block;
}

const HAS_PORTS = freezePorts(
    [{ label: "document", type: "json" }],
    [{ label: "exists", type: "boolean" }],
);
const DELETE_PORTS = freezePorts(
    [{ label: "document", type: "json" }],
    [
        { label: "document", type: "json" },
        { label: "deleted", type: "boolean" },
    ],
);
const MERGE_PORTS = freezePorts(
    [
        { label: "a", type: "json" },
        { label: "b", type: "json" },
    ],
    [{ label: "out", type: "json" }],
);

export const JsonGetBlock = defineConfiguredBlock({
    type: "JsonGetBlock",
    defaults: { path: "", valueType: "json", fallback: null },
    normalizeState(state = {}) {
        return {
            path: normalizeJsonPath(state.path),
            valueType: normalizeItemType(state.valueType, "json"),
            fallback: Object.prototype.hasOwnProperty.call(state, "fallback") ? state.fallback : null,
        };
    },
    register() {
        applyPorts(this, jsonGetPorts(this.state));
    },
    valid() {
        return this.hasInput("document");
    },
    execute() {
        const document = this.getInput("document");
        const raw = getByPath(document, this.state.path, PATH_MISSING);
        const exists = raw !== PATH_MISSING;
        const source = exists ? raw : this.state.fallback;
        const value = parseValueByType(cloneValue(source), this.state.valueType);
        return new BlockOutput().set("value", value).set("exists", exists);
    },
});

export const JsonSetBlock = defineConfiguredBlock({
    type: "JsonSetBlock",
    defaults: { path: "", valueType: "json" },
    normalizeState(state = {}) {
        return {
            path: normalizeJsonPath(state.path),
            valueType: normalizeItemType(state.valueType, "json"),
        };
    },
    register() {
        applyPorts(this, jsonSetPorts(this.state));
    },
    valid() {
        return this.hasInput("document") && this.hasInput("value");
    },
    execute() {
        return new BlockOutput().set(
            "document",
            setByPath(this.getInput("document") ?? {}, this.state.path, this.getInput("value")),
        );
    },
});

export const JsonHasBlock = defineConfiguredBlock({
    type: "JsonHasBlock",
    defaults: { path: "" },
    normalizeState(state = {}) {
        return { path: normalizeJsonPath(state.path) };
    },
    register() {
        applyPorts(this, HAS_PORTS);
    },
    valid() {
        return this.hasInput("document");
    },
    execute() {
        const exists = getByPath(this.getInput("document"), this.state.path, PATH_MISSING) !== PATH_MISSING;
        return new BlockOutput().set("exists", exists);
    },
});

export const JsonDeleteBlock = defineConfiguredBlock({
    type: "JsonDeleteBlock",
    defaults: { path: "" },
    normalizeState(state = {}) {
        return { path: normalizeJsonPath(state.path) };
    },
    register() {
        applyPorts(this, DELETE_PORTS);
    },
    valid() {
        return this.hasInput("document");
    },
    execute() {
        const result = deleteByPath(this.getInput("document"), this.state.path);
        return new BlockOutput().set("document", result.value).set("deleted", result.deleted);
    },
});

export const JsonMergeBlock = defineBlock({
    type: "JsonMergeBlock",
    ports: MERGE_PORTS,
    execute() {
        return new BlockOutput().set("out", mergeJson(this.getInput("a"), this.getInput("b")));
    },
});

export const JSON_BLOCKS = Object.freeze({
    JsonGetBlock,
    JsonSetBlock,
    JsonHasBlock,
    JsonDeleteBlock,
    JsonMergeBlock,
});

export const JSON_BLOCK_PORTS = Object.freeze({
    JsonGetBlock: jsonGetPorts({ valueType: "json" }),
    JsonSetBlock: jsonSetPorts({ valueType: "json" }),
    JsonHasBlock: HAS_PORTS,
    JsonDeleteBlock: DELETE_PORTS,
    JsonMergeBlock: MERGE_PORTS,
});
