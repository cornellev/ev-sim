import { BlockOutput } from "../../ScriptManager.js";
import { finiteInt32 } from "../../types/PortTypes.js";
import { asArray } from "../valueOps.js";
import * as stringOps from "./stringOps.js";

import { createBlockHelpers } from "../defineBlock.js";
const { freezePorts, defineBlock } = createBlockHelpers({ defaultOutputType: "string" });
function out(value) {
    return new BlockOutput().set("out", value);
}

const BINARY_STRING = freezePorts([
    { label: "a", type: "string" },
    { label: "b", type: "string" },
]);
const UNARY_STRING = freezePorts([{ label: "value", type: "string" }]);
const LENGTH_PORTS = freezePorts(
    [{ label: "value", type: "string" }],
    [{ label: "length", type: "int32" }],
);
const SEARCH_PORTS = freezePorts([
    { label: "value", type: "string" },
    { label: "search", type: "string" },
], [{ label: "out", type: "boolean" }]);
const SLICE_PORTS = freezePorts([
    { label: "value", type: "string" },
    { label: "start", type: "int32" },
    { label: "end", type: "int32" },
]);
const REPLACE_PORTS = freezePorts([
    { label: "value", type: "string" },
    { label: "search", type: "string" },
    { label: "replacement", type: "string" },
]);
const SPLIT_PORTS = freezePorts(
    [
        { label: "value", type: "string" },
        { label: "separator", type: "string" },
    ],
    [{ label: "out", type: "array[string]" }],
);
const JOIN_PORTS = freezePorts(
    [
        { label: "values", type: "array[string]" },
        { label: "separator", type: "string" },
    ],
    [{ label: "out", type: "string" }],
);

export const ConcatStringBlock = defineBlock({
    type: "ConcatStringBlock",
    ports: BINARY_STRING,
    execute() {
        return out(stringOps.concatString(this.getInput("a"), this.getInput("b")));
    },
});

export const StringLengthBlock = defineBlock({
    type: "StringLengthBlock",
    ports: LENGTH_PORTS,
    execute() {
        return new BlockOutput().set("length", finiteInt32(stringOps.stringLength(this.getInput("value"))));
    },
});

export const StringContainsBlock = defineBlock({
    type: "StringContainsBlock",
    ports: SEARCH_PORTS,
    execute() {
        return out(stringOps.stringContains(this.getInput("value"), this.getInput("search")));
    },
});

export const StringStartsWithBlock = defineBlock({
    type: "StringStartsWithBlock",
    ports: SEARCH_PORTS,
    execute() {
        return out(stringOps.stringStartsWith(this.getInput("value"), this.getInput("search")));
    },
});

export const StringEndsWithBlock = defineBlock({
    type: "StringEndsWithBlock",
    ports: SEARCH_PORTS,
    execute() {
        return out(stringOps.stringEndsWith(this.getInput("value"), this.getInput("search")));
    },
});

export const TrimStringBlock = defineBlock({
    type: "TrimStringBlock",
    ports: UNARY_STRING,
    execute() {
        return out(stringOps.trimString(this.getInput("value")));
    },
});

export const LowercaseStringBlock = defineBlock({
    type: "LowercaseStringBlock",
    ports: UNARY_STRING,
    execute() {
        return out(stringOps.lowercaseString(this.getInput("value")));
    },
});

export const UppercaseStringBlock = defineBlock({
    type: "UppercaseStringBlock",
    ports: UNARY_STRING,
    execute() {
        return out(stringOps.uppercaseString(this.getInput("value")));
    },
});

export const SliceStringBlock = defineBlock({
    type: "SliceStringBlock",
    ports: SLICE_PORTS,
    execute() {
        return out(stringOps.sliceString(
            this.getInput("value"),
            finiteInt32(this.getInput("start")),
            finiteInt32(this.getInput("end")),
        ));
    },
});

export const ReplaceStringBlock = defineBlock({
    type: "ReplaceStringBlock",
    ports: REPLACE_PORTS,
    execute() {
        return out(stringOps.replaceString(
            this.getInput("value"),
            this.getInput("search"),
            this.getInput("replacement"),
        ));
    },
});

export const SplitStringBlock = defineBlock({
    type: "SplitStringBlock",
    ports: SPLIT_PORTS,
    execute() {
        return out(stringOps.splitString(this.getInput("value"), this.getInput("separator")));
    },
});

export const JoinStringBlock = defineBlock({
    type: "JoinStringBlock",
    ports: JOIN_PORTS,
    execute() {
        return out(stringOps.joinString(
            asArray(this.getInput("values"), "string"),
            this.getInput("separator"),
        ));
    },
});

export const STRING_BLOCKS = Object.freeze({
    ConcatStringBlock,
    StringLengthBlock,
    StringContainsBlock,
    StringStartsWithBlock,
    StringEndsWithBlock,
    TrimStringBlock,
    LowercaseStringBlock,
    UppercaseStringBlock,
    SliceStringBlock,
    ReplaceStringBlock,
    SplitStringBlock,
    JoinStringBlock,
});

export const STRING_BLOCK_PORTS = Object.freeze({
    ConcatStringBlock: BINARY_STRING,
    StringLengthBlock: LENGTH_PORTS,
    StringContainsBlock: SEARCH_PORTS,
    StringStartsWithBlock: SEARCH_PORTS,
    StringEndsWithBlock: SEARCH_PORTS,
    TrimStringBlock: UNARY_STRING,
    LowercaseStringBlock: UNARY_STRING,
    UppercaseStringBlock: UNARY_STRING,
    SliceStringBlock: SLICE_PORTS,
    ReplaceStringBlock: REPLACE_PORTS,
    SplitStringBlock: SPLIT_PORTS,
    JoinStringBlock: JOIN_PORTS,
});
