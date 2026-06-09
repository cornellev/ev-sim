import NumberUnit, { NumberUnitClass } from "./units/math/Number";
import { CalculationBlock, CalculationUnit } from "./units/math/Calculation";
import { Float64ToInt32, Float64ToInt32Block, Int32ToFloat64, Int32ToFloat64Block } from "./units/conversions/NumberConversions";
import { E, EBlock, GoldenRatio, GoldenRatioBlock, PI, PIBlock, Tau, TauBlock } from "./units/math/Constants";
import { RandomNumber, RandomNumberBlock } from "./units/math/Random";
import { Noise, NoiseBlock } from "./units/math/tex/Noise";
import { MultiplyTex, MultiplyTexBlock, Scale } from "./units/math/tex/Scale";
import { Mask, MaskBlock } from "./units/math/tex/Mask";
import { IfBlock, IfUnit } from "./units/statements/If";
import { Conjugation, ConjugationBlock, Equality, EqualityBlock } from "./units/statements/Equality";
import { StringBlock, StringUnit } from "./units/objects/String";
import {
    BlendTextureBlock,
    BlendTextureUnit,
    HeightToSlopeBlock,
    HeightToSlopeUnit,
    NormalizeTextureBlock,
    NormalizeTextureUnit,
    TerrainNoiseBlock,
    TerrainNoiseUnit,
    TerraceTextureBlock,
    TerraceTextureUnit,
} from "./units/math/Terrain";
import {
    LowPassFilterBlock,
    LowPassFilterUnit,
    RateLimiterBlock,
    RateLimiterUnit,
    SampleTextureBlock,
    SampleTextureUnit,
    SensorFusionBlock,
    SensorFusionUnit,
    ThresholdGateBlock,
    ThresholdGateUnit,
} from "./units/math/SensorFlow";
import {
    GaussianNoiseBlock,
    GaussianNoiseUnit,
    JitterBlock,
    JitterUnit,
    RandomRangeBlock,
    RandomRangeUnit,
    RemapRangeBlock,
    RemapRangeUnit,
    SeededRandomBlock,
    SeededRandomUnit,
    WeightedSelectBlock,
    WeightedSelectUnit,
} from "./units/math/Randomization";
import { ProgramInputBlock, ProgramInputUnit, ProgramOutputBlock, ProgramOutputUnit } from "./units/program/ProgramIO";

function entry(category, name, Component, blockClass) {
    return {
        category,
        name,
        Component,
        blockClass,
        type: blockClass?.blockType || blockClass?.name || null
    };
}

export function createCatalogUnitUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return Math.random().toString(36).slice(2, 11);
}

export const UNIT_CATALOG = [
    entry("expressions", "Number", NumberUnit, NumberUnitClass),
    entry("expressions", "Calculation", CalculationUnit, CalculationBlock),
    entry("expressions", "Random Number", RandomNumber, RandomNumberBlock),
    entry("constants", "π (Pi)", PI, PIBlock),
    entry("constants", "e (Euler's Number)", E, EBlock),
    entry("constants", "τ (Tau)", Tau, TauBlock),
    entry("constants", "Golden Ratio (φ)", GoldenRatio, GoldenRatioBlock),
    entry("vector2", "Noise Texture (tex1d)", Noise, NoiseBlock),
    entry("vector2", "Mask Texture (tex1d)", Mask, MaskBlock),
    entry("vector2", "Multiply Textures (tex1d)", MultiplyTex, MultiplyTexBlock),
    entry("vector2", "Scale Matrix (tex1d)", Scale, null),
    entry("terrain", "Terrain Noise (tex1d)", TerrainNoiseUnit, TerrainNoiseBlock),
    entry("terrain", "Normalize Texture (tex1d)", NormalizeTextureUnit, NormalizeTextureBlock),
    entry("terrain", "Blend Texture (tex1d)", BlendTextureUnit, BlendTextureBlock),
    entry("terrain", "Terrace Texture (tex1d)", TerraceTextureUnit, TerraceTextureBlock),
    entry("terrain", "Height To Slope (tex1d)", HeightToSlopeUnit, HeightToSlopeBlock),
    entry("sensorflow", "Sample Texture (tex1d -> float64)", SampleTextureUnit, SampleTextureBlock),
    entry("sensorflow", "Low Pass Filter", LowPassFilterUnit, LowPassFilterBlock),
    entry("sensorflow", "Rate Limiter", RateLimiterUnit, RateLimiterBlock),
    entry("sensorflow", "Sensor Fusion", SensorFusionUnit, SensorFusionBlock),
    entry("sensorflow", "Threshold Gate", ThresholdGateUnit, ThresholdGateBlock),
    entry("randomization", "Random Range", RandomRangeUnit, RandomRangeBlock),
    entry("randomization", "Seeded Random", SeededRandomUnit, SeededRandomBlock),
    entry("randomization", "Gaussian Noise", GaussianNoiseUnit, GaussianNoiseBlock),
    entry("randomization", "Jitter", JitterUnit, JitterBlock),
    entry("randomization", "Weighted Select", WeightedSelectUnit, WeightedSelectBlock),
    entry("randomization", "Remap Range", RemapRangeUnit, RemapRangeBlock),
    entry("conversions", "Float64 to Int32", Float64ToInt32, Float64ToInt32Block),
    entry("conversions", "Int32 to Float64", Int32ToFloat64, Int32ToFloat64Block),
    entry("objects", "String", StringUnit, StringBlock),
    entry("statements", "If Statement", IfUnit, IfBlock),
    entry("statements", "Comparison (==, !=, >, <, >=, <=)", Equality, EqualityBlock),
    entry("statements", "Conjunction (AND, OR)", Conjugation, ConjugationBlock),
    entry("program", "Program Input", ProgramInputUnit, ProgramInputBlock),
    entry("program", "Program Output", ProgramOutputUnit, ProgramOutputBlock)
];

export const UNIT_CATALOG_BY_TYPE = new Map(
    UNIT_CATALOG
        .filter((item) => item.type)
        .map((item) => [item.type, item])
);

export function getUnitCatalogEntry(type) {
    return UNIT_CATALOG_BY_TYPE.get(type) || null;
}

export function groupedUnitCatalog() {
    return UNIT_CATALOG.reduce((groups, item) => {
        if (!groups[item.category]) groups[item.category] = [];
        groups[item.category].push(item);
        return groups;
    }, {});
}

export function catalogBlockClasses() {
    return UNIT_CATALOG
        .map((item) => item.blockClass)
        .filter(Boolean);
}
