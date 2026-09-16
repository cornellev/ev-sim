import Unit from "../Unit";
import { CONVERSION_BLOCK_PORTS } from "./Conversions.block.js";

function staticPortsUnit(title, ports) {
    function StaticUnit({ _uuid }) {
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={[...ports.inputs]}
                outputs={[...ports.outputs]}
            />
        );
    }
    StaticUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return StaticUnit;
}

export const FloorToIntUnit = staticPortsUnit("Floor to Int", CONVERSION_BLOCK_PORTS.FloorToIntBlock);
export const CeilToIntUnit = staticPortsUnit("Ceil to Int", CONVERSION_BLOCK_PORTS.CeilToIntBlock);
export const RoundToIntUnit = staticPortsUnit("Round to Int", CONVERSION_BLOCK_PORTS.RoundToIntBlock);
export const TruncateToIntUnit = staticPortsUnit("Truncate to Int", CONVERSION_BLOCK_PORTS.TruncateToIntBlock);
export const BooleanToIntUnit = staticPortsUnit("Boolean to Int", CONVERSION_BLOCK_PORTS.BooleanToIntBlock);
export const BooleanToFloatUnit = staticPortsUnit("Boolean to Float", CONVERSION_BLOCK_PORTS.BooleanToFloatBlock);
export const IntToBooleanUnit = staticPortsUnit("Int to Boolean", CONVERSION_BLOCK_PORTS.IntToBooleanBlock);
export const FloatToBooleanUnit = staticPortsUnit("Float to Boolean", CONVERSION_BLOCK_PORTS.FloatToBooleanBlock);
export const FloatToStringUnit = staticPortsUnit("Float to String", CONVERSION_BLOCK_PORTS.FloatToStringBlock);
export const IntToStringUnit = staticPortsUnit("Int to String", CONVERSION_BLOCK_PORTS.IntToStringBlock);
export const BooleanToStringUnit = staticPortsUnit("Boolean to String", CONVERSION_BLOCK_PORTS.BooleanToStringBlock);
export const StringToFloatUnit = staticPortsUnit("String to Float", CONVERSION_BLOCK_PORTS.StringToFloatBlock);
export const StringToIntUnit = staticPortsUnit("String to Int", CONVERSION_BLOCK_PORTS.StringToIntBlock);
export const StringToBooleanUnit = staticPortsUnit("String to Boolean", CONVERSION_BLOCK_PORTS.StringToBooleanBlock);
export const ParseJsonUnit = staticPortsUnit("Parse JSON", CONVERSION_BLOCK_PORTS.ParseJsonBlock);
export const StringifyJsonUnit = staticPortsUnit("Stringify JSON", CONVERSION_BLOCK_PORTS.StringifyJsonBlock);

export {
    BooleanToFloatBlock,
    BooleanToIntBlock,
    BooleanToStringBlock,
    CeilToIntBlock,
    FloatToBooleanBlock,
    FloatToStringBlock,
    FloorToIntBlock,
    IntToBooleanBlock,
    IntToStringBlock,
    ParseJsonBlock,
    RoundToIntBlock,
    StringifyJsonBlock,
    StringToBooleanBlock,
    StringToFloatBlock,
    StringToIntBlock,
    TruncateToIntBlock,
} from "./Conversions.block.js";
