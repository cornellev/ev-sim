import { registerBlockType } from "./BlockRegistry.js";
import { ROSInputBlock, ROSOutputBlock } from "./units/ROSUnit";
import { Float64ToInt32Block, Int32ToFloat64Block } from "./units/conversions/NumberConversions";
import { NumberUnitClass } from "./units/math/Number";
import { CalculationBlock } from "./units/math/Calculation";
import { EBlock, GoldenRatioBlock, PIBlock, TauBlock } from "./units/math/Constants";
import { RandomNumberBlock } from "./units/math/Random";
import {
    GaussianNoiseBlock,
    JitterBlock,
    RandomRangeBlock,
    RemapRangeBlock,
    SeededRandomBlock,
    WeightedSelectBlock,
} from "./units/math/Randomization";
import {
    LowPassFilterBlock,
    RateLimiterBlock,
    SampleTextureBlock,
    SensorFusionBlock,
    ThresholdGateBlock,
} from "./units/math/SensorFlow";
import {
    BlendTextureBlock,
    HeightToSlopeBlock,
    NormalizeTextureBlock,
    TerrainNoiseBlock,
    TerraceTextureBlock,
} from "./units/math/Terrain";
import { MaskBlock } from "./units/math/tex/Mask";
import { NoiseBlock } from "./units/math/tex/Noise";
import { MultiplyTexBlock } from "./units/math/tex/Scale";
import { StringBlock } from "./units/objects/String";
import { OutputNodeBlock, ProgramInputBlock, ProgramOutputBlock } from "./units/program/ProgramIO";
import { ConjugationBlock, EqualityBlock } from "./units/statements/Equality";
import { IfBlock } from "./units/statements/If";

let registered = false;

export function registerBuiltInBlocks() {
    if (registered) return;

    [
        NumberUnitClass,
        CalculationBlock,
        RandomNumberBlock,
        PIBlock,
        EBlock,
        TauBlock,
        GoldenRatioBlock,
        NoiseBlock,
        MaskBlock,
        MultiplyTexBlock,
        TerrainNoiseBlock,
        NormalizeTextureBlock,
        BlendTextureBlock,
        TerraceTextureBlock,
        HeightToSlopeBlock,
        SampleTextureBlock,
        LowPassFilterBlock,
        RateLimiterBlock,
        SensorFusionBlock,
        ThresholdGateBlock,
        RandomRangeBlock,
        SeededRandomBlock,
        GaussianNoiseBlock,
        JitterBlock,
        WeightedSelectBlock,
        RemapRangeBlock,
        Float64ToInt32Block,
        Int32ToFloat64Block,
        StringBlock,
        IfBlock,
        EqualityBlock,
        ConjugationBlock,
        ROSInputBlock,
        ROSOutputBlock,
        ProgramInputBlock,
        ProgramOutputBlock,
        OutputNodeBlock
    ].forEach((blockClass) => registerBlockType(blockClass.name, blockClass));

    registered = true;
}
