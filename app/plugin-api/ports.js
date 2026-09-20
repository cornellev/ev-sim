import { SUPPORTED_TYPES } from "../scripting/units/program/ProgramTypes.js";
import { UNIT } from "../scripting/types/PortTypes.js";

export const PLUGIN_PORT_TYPES = Object.freeze(
    SUPPORTED_TYPES.filter((type) => type !== "generic"),
);

export const ports = Object.freeze({
    types: PLUGIN_PORT_TYPES,
    UNIT,
});
