import { BlockOutput } from "./BlockOutput.js";
import { UnitBlock } from "./UnitBlock.js";
import { ports } from "./ports.js";

export { BlockOutput, UnitBlock, ports };
export { PLUGIN_CAPABILITIES, validateCapabilityGrants } from "./capabilities.js";

export const PLUGIN_API_VERSION = 1;

export function createRegistrationApi({
    plugin,
    capabilities = [],
    contributeUnit,
    contributeSystem,
    contributeSensorType = () => {},
    log = () => {},
}) {
    const identity = Object.freeze({
        id: String(plugin?.id ?? ""),
        version: String(plugin?.version ?? ""),
        runtimeHash: String(plugin?.runtimeHash ?? ""),
    });
    return Object.freeze({
        pluginApi: PLUGIN_API_VERSION,
        plugin: identity,
        capabilities: Object.freeze([...capabilities].sort()),
        UnitBlock,
        BlockOutput,
        ports,
        contributeUnit: (definition) => contributeUnit(definition),
        contributeSystem: (definition) => contributeSystem(definition),
        contributeSensorType: (definition) => contributeSensorType(definition),
        log: (level, message, details) => log(level, message, details),
    });
}
