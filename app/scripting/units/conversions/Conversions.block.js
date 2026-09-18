import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { GENERIC_TYPE, ROAD_ID_TYPE, TEXTURE_ID_TYPE } from "../../types/PortTypes.js";
import * as conversionMath from "./conversionMath.js";

function freezePort(port) {
    return Object.freeze({ label: port.label, type: port.type });
}

function freezePorts(inputs, outputs = [{ label: "out", type: "float64" }]) {
    return Object.freeze({
        inputs: Object.freeze(inputs.map(freezePort)),
        outputs: Object.freeze(outputs.map(freezePort)),
    });
}

function defineBlock({ type, ports, execute, valid, typeScheme }) {
    class Block extends UnitBlock {
        static blockType = type;

        register() {
            for (const port of ports.inputs) this.registerInput(port.label, port.type);
            for (const port of ports.outputs) this.registerOutput(port.label, port.type);
        }

        valid() {
            if (valid) return valid.call(this);
            return ports.inputs.every((port) => this.hasInput(port.label));
        }

        execute() {
            return execute.call(this);
        }
    }

    if (typeScheme) Block.typeScheme = typeScheme;
    try {
        Object.defineProperty(Block, "name", { value: type });
    } catch {
        // Class name is non-configurable in some engines; blockType is the authority.
    }

    return Block;
}

function out(value) {
    return new BlockOutput().set("out", value);
}

function parsed(result) {
    return new BlockOutput().set("out", result.value).set("valid", result.valid);
}

const UNARY_FLOAT_TO_INT = freezePorts(
    [{ label: "value", type: "float64" }],
    [{ label: "out", type: "int32" }],
);
const BOOL_TO_INT = freezePorts(
    [{ label: "value", type: "boolean" }],
    [{ label: "out", type: "int32" }],
);
const BOOL_TO_FLOAT = freezePorts(
    [{ label: "value", type: "boolean" }],
    [{ label: "out", type: "float64" }],
);
const INT_TO_BOOL = freezePorts(
    [{ label: "value", type: "int32" }],
    [{ label: "out", type: "boolean" }],
);
const FLOAT_TO_BOOL = freezePorts(
    [{ label: "value", type: "float64" }],
    [{ label: "out", type: "boolean" }],
);
const FLOAT_TO_STRING = freezePorts(
    [{ label: "value", type: "float64" }],
    [{ label: "out", type: "string" }],
);
const INT_TO_STRING = freezePorts(
    [{ label: "value", type: "int32" }],
    [{ label: "out", type: "string" }],
);
const BOOL_TO_STRING = freezePorts(
    [{ label: "value", type: "boolean" }],
    [{ label: "out", type: "string" }],
);
const STRING_TO_FLOAT = freezePorts(
    [{ label: "value", type: "string" }],
    [
        { label: "out", type: "float64" },
        { label: "valid", type: "boolean" },
    ],
);
const STRING_TO_INT = freezePorts(
    [{ label: "value", type: "string" }],
    [
        { label: "out", type: "int32" },
        { label: "valid", type: "boolean" },
    ],
);
const STRING_TO_BOOL = freezePorts(
    [{ label: "value", type: "string" }],
    [
        { label: "out", type: "boolean" },
        { label: "valid", type: "boolean" },
    ],
);
const PARSE_JSON = freezePorts(
    [{ label: "value", type: "string" }],
    [
        { label: "out", type: "json" },
        { label: "valid", type: "boolean" },
    ],
);
const STRINGIFY_JSON = freezePorts(
    [{ label: "value", type: "json" }],
    [
        { label: "out", type: "string" },
        { label: "valid", type: "boolean" },
    ],
);
const STRING_TO_ROAD_ID = freezePorts(
    [{ label: "value", type: "string" }],
    [{ label: "out", type: ROAD_ID_TYPE }],
);
const ROAD_ID_TO_STRING = freezePorts(
    [{ label: "value", type: ROAD_ID_TYPE }],
    [{ label: "out", type: "string" }],
);
const STRING_TO_TEXTURE_ID = freezePorts(
    [{ label: "value", type: "string" }],
    [{ label: "out", type: TEXTURE_ID_TYPE }],
);
const TEXTURE_ID_TO_STRING = freezePorts(
    [{ label: "value", type: TEXTURE_ID_TYPE }],
    [{ label: "out", type: "string" }],
);
const TO_STRING = freezePorts(
    [{ label: "value", type: GENERIC_TYPE }],
    [{ label: "out", type: "string" }],
);
const TO_STRING_SCHEME = Object.freeze({
    variables: Object.freeze({
        T: Object.freeze({
            inputs: Object.freeze(["value"]),
            outputs: Object.freeze([]),
        }),
    }),
});

export const FloorToIntBlock = defineBlock({
    type: "FloorToIntBlock",
    ports: UNARY_FLOAT_TO_INT,
    execute() {
        return out(conversionMath.floorToInt(this.getInput("value")));
    },
});

export const CeilToIntBlock = defineBlock({
    type: "CeilToIntBlock",
    ports: UNARY_FLOAT_TO_INT,
    execute() {
        return out(conversionMath.ceilToInt(this.getInput("value")));
    },
});

export const RoundToIntBlock = defineBlock({
    type: "RoundToIntBlock",
    ports: UNARY_FLOAT_TO_INT,
    execute() {
        return out(conversionMath.roundToInt(this.getInput("value")));
    },
});

export const TruncateToIntBlock = defineBlock({
    type: "TruncateToIntBlock",
    ports: UNARY_FLOAT_TO_INT,
    execute() {
        return out(conversionMath.truncToInt(this.getInput("value")));
    },
});

export const BooleanToIntBlock = defineBlock({
    type: "BooleanToIntBlock",
    ports: BOOL_TO_INT,
    execute() {
        return out(conversionMath.boolToInt(this.getInput("value")));
    },
});

export const BooleanToFloatBlock = defineBlock({
    type: "BooleanToFloatBlock",
    ports: BOOL_TO_FLOAT,
    execute() {
        return out(conversionMath.boolToFloat(this.getInput("value")));
    },
});

export const IntToBooleanBlock = defineBlock({
    type: "IntToBooleanBlock",
    ports: INT_TO_BOOL,
    execute() {
        return out(conversionMath.intToBool(this.getInput("value")));
    },
});

export const FloatToBooleanBlock = defineBlock({
    type: "FloatToBooleanBlock",
    ports: FLOAT_TO_BOOL,
    execute() {
        return out(conversionMath.floatToBool(this.getInput("value")));
    },
});

export const FloatToStringBlock = defineBlock({
    type: "FloatToStringBlock",
    ports: FLOAT_TO_STRING,
    execute() {
        return out(conversionMath.floatToString(this.getInput("value")));
    },
});

export const IntToStringBlock = defineBlock({
    type: "IntToStringBlock",
    ports: INT_TO_STRING,
    execute() {
        return out(conversionMath.intToString(this.getInput("value")));
    },
});

export const BooleanToStringBlock = defineBlock({
    type: "BooleanToStringBlock",
    ports: BOOL_TO_STRING,
    execute() {
        return out(conversionMath.boolToString(this.getInput("value")));
    },
});

export const StringToFloatBlock = defineBlock({
    type: "StringToFloatBlock",
    ports: STRING_TO_FLOAT,
    execute() {
        return parsed(conversionMath.stringToFloat(this.getInput("value")));
    },
});

export const StringToIntBlock = defineBlock({
    type: "StringToIntBlock",
    ports: STRING_TO_INT,
    execute() {
        return parsed(conversionMath.stringToInt(this.getInput("value")));
    },
});

export const StringToBooleanBlock = defineBlock({
    type: "StringToBooleanBlock",
    ports: STRING_TO_BOOL,
    execute() {
        return parsed(conversionMath.stringToBool(this.getInput("value")));
    },
});

export const ParseJsonBlock = defineBlock({
    type: "ParseJsonBlock",
    ports: PARSE_JSON,
    execute() {
        return parsed(conversionMath.parseJson(this.getInput("value")));
    },
});

export const StringifyJsonBlock = defineBlock({
    type: "StringifyJsonBlock",
    ports: STRINGIFY_JSON,
    execute() {
        return parsed(conversionMath.stringifyJson(this.getInput("value")));
    },
});

export const StringToRoadIdBlock = defineBlock({
    type: "StringToRoadIdBlock",
    ports: STRING_TO_ROAD_ID,
    execute() {
        return out(conversionMath.stringToRoadId(this.getInput("value")));
    },
});

export const RoadIdToStringBlock = defineBlock({
    type: "RoadIdToStringBlock",
    ports: ROAD_ID_TO_STRING,
    execute() {
        return out(conversionMath.roadIdToString(this.getInput("value")));
    },
});

export const StringToTextureIdBlock = defineBlock({
    type: "StringToTextureIdBlock",
    ports: STRING_TO_TEXTURE_ID,
    execute() {
        return out(conversionMath.stringToTextureId(this.getInput("value")));
    },
});

export const TextureIdToStringBlock = defineBlock({
    type: "TextureIdToStringBlock",
    ports: TEXTURE_ID_TO_STRING,
    execute() {
        return out(conversionMath.textureIdToString(this.getInput("value")));
    },
});

export const ToStringBlock = defineBlock({
    type: "ToStringBlock",
    ports: TO_STRING,
    typeScheme: TO_STRING_SCHEME,
    execute() {
        return out(conversionMath.valueToString(this.getInput("value"), this.inputType("value")));
    },
});

export const CONVERSION_BLOCKS = Object.freeze({
    FloorToIntBlock,
    CeilToIntBlock,
    RoundToIntBlock,
    TruncateToIntBlock,
    BooleanToIntBlock,
    BooleanToFloatBlock,
    IntToBooleanBlock,
    FloatToBooleanBlock,
    FloatToStringBlock,
    IntToStringBlock,
    BooleanToStringBlock,
    StringToFloatBlock,
    StringToIntBlock,
    StringToBooleanBlock,
    ParseJsonBlock,
    StringifyJsonBlock,
    StringToRoadIdBlock,
    RoadIdToStringBlock,
    StringToTextureIdBlock,
    TextureIdToStringBlock,
    ToStringBlock,
});

export const CONVERSION_BLOCK_PORTS = Object.freeze({
    FloorToIntBlock: UNARY_FLOAT_TO_INT,
    CeilToIntBlock: UNARY_FLOAT_TO_INT,
    RoundToIntBlock: UNARY_FLOAT_TO_INT,
    TruncateToIntBlock: UNARY_FLOAT_TO_INT,
    BooleanToIntBlock: BOOL_TO_INT,
    BooleanToFloatBlock: BOOL_TO_FLOAT,
    IntToBooleanBlock: INT_TO_BOOL,
    FloatToBooleanBlock: FLOAT_TO_BOOL,
    FloatToStringBlock: FLOAT_TO_STRING,
    IntToStringBlock: INT_TO_STRING,
    BooleanToStringBlock: BOOL_TO_STRING,
    StringToFloatBlock: STRING_TO_FLOAT,
    StringToIntBlock: STRING_TO_INT,
    StringToBooleanBlock: STRING_TO_BOOL,
    ParseJsonBlock: PARSE_JSON,
    StringifyJsonBlock: STRINGIFY_JSON,
    StringToRoadIdBlock: STRING_TO_ROAD_ID,
    RoadIdToStringBlock: ROAD_ID_TO_STRING,
    StringToTextureIdBlock: STRING_TO_TEXTURE_ID,
    TextureIdToStringBlock: TEXTURE_ID_TO_STRING,
    ToStringBlock: TO_STRING,
});
