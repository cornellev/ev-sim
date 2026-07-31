import { registerBlockType } from "./BlockRegistry.js";
import { ROSInputBlock, ROSOutputBlock } from "./units/ROSUnit.block.js";
import { Float64ToInt32Block, Int32ToFloat64Block } from "./units/conversions/NumberConversions.block.js";
import { NumberUnitClass } from "./units/math/Number.block.js";
import { CalculationBlock } from "./units/math/Calculation.block.js";
import { EBlock, GoldenRatioBlock, PIBlock, TauBlock } from "./units/math/Constants.block.js";
import { RandomNumberBlock } from "./units/math/Random.block.js";
import {
    GaussianNoiseBlock,
    JitterBlock,
    RandomRangeBlock,
    RemapRangeBlock,
    SeededRandomBlock,
    WeightedSelectBlock,
} from "./units/math/Randomization.block.js";
import {
    LowPassFilterBlock,
    RateLimiterBlock,
    SampleTextureBlock,
    SensorFusionBlock,
    ThresholdGateBlock,
} from "./units/math/SensorFlow.block.js";
import {
    BlendTextureBlock,
    HeightToSlopeBlock,
    NormalizeTextureBlock,
    TerrainNoiseBlock,
    TerraceTextureBlock,
} from "./units/math/Terrain.block.js";
import { MaskBlock } from "./units/math/tex/Mask.block.js";
import { NoiseBlock } from "./units/math/tex/Noise.block.js";
import { MultiplyTexBlock } from "./units/math/tex/Scale.block.js";
import { StringBlock } from "./units/objects/String.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "./units/program/ProgramIO.block.js";
import {
    FollowRouteBlock,
    FollowRouteSectionBlock,
    RouteSectionCountBlock,
} from "./units/mission/RouteBlocks.block.js";
import {
    AdvanceWaypointBlock,
    AssertSignalBlock,
    BindInputBlock,
    BindingStatusBlock,
    BindOutputBlock,
    BindTriggerBlock,
    BuildTopicMessageBlock,
    CurrentWaypointBlock,
    DeviceSnapshotBlock,
    LogSignalBlock,
    MissionStateBlock,
    ObjectSnapshotBlock,
    OnSignalUpdateBlock,
    OnTickBlock,
    OnTimerBlock,
    ProbeSignalBlock,
    ReadSignalBlock,
    ReachedWaypointBlock,
    RecordSignalBlock,
    ReplaySignalBlock,
    RouteProgressBlock,
    ScenarioFlagReadBlock,
    ScenarioFlagWriteBlock,
    ScenarioSnapshotBlock,
    SetMissionStateBlock,
    SimulationSnapshotBlock,
    SignalAgeBlock,
    SignalChangedBlock,
    SignalDefaultBlock,
    SignalExistsBlock,
    SignalLatchBlock,
    StagePublishBlock,
    StoreNamespaceBlock,
    TopicFieldBlock,
    TopicMetadataBlock,
    TopicSnapshotBlock,
    TopicStaleGateBlock,
    VehicleDimensionsBlock,
    VehiclePoseBlock,
    VehicleSnapshotBlock,
    VehicleVelocityBlock,
    WaypointListBlock,
    WriteSignalBlock,
} from "./units/signals/SignalBlocks.block.js";
import { ConjugationBlock, EqualityBlock } from "./units/statements/Equality.block.js";
import { IfBlock } from "./units/statements/If.block.js";

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
        OutputNodeBlock,
        ReadSignalBlock,
        WriteSignalBlock,
        SignalExistsBlock,
        SignalAgeBlock,
        SignalChangedBlock,
        SignalLatchBlock,
        SignalDefaultBlock,
        StoreNamespaceBlock,
        TopicSnapshotBlock,
        TopicFieldBlock,
        BuildTopicMessageBlock,
        StagePublishBlock,
        TopicStaleGateBlock,
        TopicMetadataBlock,
        VehicleSnapshotBlock,
        VehiclePoseBlock,
        VehicleVelocityBlock,
        VehicleDimensionsBlock,
        DeviceSnapshotBlock,
        SimulationSnapshotBlock,
        ScenarioSnapshotBlock,
        ObjectSnapshotBlock,
        WaypointListBlock,
        CurrentWaypointBlock,
        AdvanceWaypointBlock,
        ReachedWaypointBlock,
        MissionStateBlock,
        SetMissionStateBlock,
        RouteProgressBlock,
        FollowRouteBlock,
        FollowRouteSectionBlock,
        RouteSectionCountBlock,
        ScenarioFlagReadBlock,
        ScenarioFlagWriteBlock,
        OnSignalUpdateBlock,
        OnTickBlock,
        OnTimerBlock,
        BindInputBlock,
        BindOutputBlock,
        BindTriggerBlock,
        ProbeSignalBlock,
        LogSignalBlock,
        AssertSignalBlock,
        RecordSignalBlock,
        ReplaySignalBlock,
        BindingStatusBlock
    ].forEach((blockClass) => registerBlockType(blockClass.name, blockClass));

    registered = true;
}
