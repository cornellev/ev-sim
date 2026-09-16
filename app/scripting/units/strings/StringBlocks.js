import Unit from "../Unit";
import { STRING_BLOCK_PORTS } from "./StringBlocks.block.js";

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

export const ConcatStringUnit = staticPortsUnit("Concat String", STRING_BLOCK_PORTS.ConcatStringBlock);
export const StringLengthUnit = staticPortsUnit("String Length", STRING_BLOCK_PORTS.StringLengthBlock);
export const StringContainsUnit = staticPortsUnit("String Contains", STRING_BLOCK_PORTS.StringContainsBlock);
export const StringStartsWithUnit = staticPortsUnit("String Starts With", STRING_BLOCK_PORTS.StringStartsWithBlock);
export const StringEndsWithUnit = staticPortsUnit("String Ends With", STRING_BLOCK_PORTS.StringEndsWithBlock);
export const TrimStringUnit = staticPortsUnit("Trim String", STRING_BLOCK_PORTS.TrimStringBlock);
export const LowercaseStringUnit = staticPortsUnit("Lowercase String", STRING_BLOCK_PORTS.LowercaseStringBlock);
export const UppercaseStringUnit = staticPortsUnit("Uppercase String", STRING_BLOCK_PORTS.UppercaseStringBlock);
export const SliceStringUnit = staticPortsUnit("Slice String", STRING_BLOCK_PORTS.SliceStringBlock);
export const ReplaceStringUnit = staticPortsUnit("Replace String", STRING_BLOCK_PORTS.ReplaceStringBlock);
export const SplitStringUnit = staticPortsUnit("Split String", STRING_BLOCK_PORTS.SplitStringBlock);
export const JoinStringUnit = staticPortsUnit("Join String", STRING_BLOCK_PORTS.JoinStringBlock);

export {
    ConcatStringBlock,
    JoinStringBlock,
    LowercaseStringBlock,
    ReplaceStringBlock,
    SliceStringBlock,
    SplitStringBlock,
    StringContainsBlock,
    StringEndsWithBlock,
    StringLengthBlock,
    StringStartsWithBlock,
    TrimStringBlock,
    UppercaseStringBlock,
} from "./StringBlocks.block.js";
