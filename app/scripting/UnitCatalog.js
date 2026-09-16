import { UNIT_CATALOG_META } from "./UnitCatalog.meta";
import NumberUnit from "./units/math/Number";
import { CalculationUnit } from "./units/math/Calculation";
import { Float64ToInt32, Int32ToFloat64 } from "./units/conversions/NumberConversions";
import { E, GoldenRatio, PI, Tau } from "./units/math/Constants";
import { RandomNumber } from "./units/math/Random";
import { Noise } from "./units/math/tex/Noise";
import { MultiplyTex, Scale } from "./units/math/tex/Scale";
import { Mask } from "./units/math/tex/Mask";
import { IfUnit } from "./units/statements/If";
import { Conjugation, Equality } from "./units/statements/Equality";
import { IgnoreUnit, NopUnit, PassthroughUnit, SequenceUnit } from "./units/statements/Unit";
import { StringUnit } from "./units/objects/String";
import {
    BlendTextureUnit,
    HeightToSlopeUnit,
    NormalizeTextureUnit,
    TerrainNoiseUnit,
    TerraceTextureUnit,
} from "./units/math/Terrain";
import {
    LowPassFilterUnit,
    RateLimiterUnit,
    SampleTextureUnit,
    SensorFusionUnit,
    ThresholdGateUnit,
} from "./units/math/SensorFlow";
import {
    GaussianNoiseUnit,
    JitterUnit,
    RandomRangeUnit,
    RemapRangeUnit,
    SeededRandomUnit,
    WeightedSelectUnit,
} from "./units/math/Randomization";
import { OutputNodeUnit, ProgramInputUnit } from "./units/program/ProgramIO";
import { MakeActorCommandUnit, SplitActorCommandUnit } from "./units/mission/ActorCommand";
import { FollowRouteSectionUnit, FollowRouteUnit, RouteSectionCountUnit } from "./units/mission/RouteBlocks";
import {
    AdvanceWaypointUnit,
    AssertSignalUnit,
    BindInputUnit,
    BindingStatusUnit,
    BindOutputUnit,
    BindTriggerUnit,
    BuildTopicMessageUnit,
    CurrentWaypointUnit,
    DeviceSnapshotUnit,
    LogSignalUnit,
    MissionStateUnit,
    ObjectSnapshotUnit,
    OnSignalUpdateUnit,
    OnTickUnit,
    OnTimerUnit,
    ProbeSignalUnit,
    ReadSignalUnit,
    ReachedWaypointUnit,
    RecordSignalUnit,
    ReplaySignalUnit,
    RouteProgressUnit,
    ScenarioFlagReadUnit,
    ScenarioFlagWriteUnit,
    ScenarioSnapshotUnit,
    SetMissionStateUnit,
    SignalAgeUnit,
    SignalChangedUnit,
    SignalDefaultUnit,
    SignalExistsUnit,
    SignalLatchUnit,
    SimulationSnapshotUnit,
    StagePublishUnit,
    StoreNamespaceUnit,
    TopicFieldUnit,
    TopicMetadataUnit,
    TopicSnapshotUnit,
    TopicStaleGateUnit,
    VehicleDimensionsUnit,
    VehiclePoseUnit,
    VehicleSnapshotUnit,
    VehicleVelocityUnit,
    WaypointListUnit,
    WriteSignalUnit,
} from "./units/signals/SignalBlocks";

const COMPONENT_BY_TYPE = new Map([
    ["NumberUnitClass", NumberUnit],
    ["CalculationBlock", CalculationUnit],
    ["RandomNumberBlock", RandomNumber],
    ["PIBlock", PI],
    ["EBlock", E],
    ["TauBlock", Tau],
    ["GoldenRatioBlock", GoldenRatio],
    ["NoiseBlock", Noise],
    ["MaskBlock", Mask],
    ["MultiplyTexBlock", MultiplyTex],
    ["ScaleBlock", Scale],
    ["TerrainNoiseBlock", TerrainNoiseUnit],
    ["NormalizeTextureBlock", NormalizeTextureUnit],
    ["BlendTextureBlock", BlendTextureUnit],
    ["TerraceTextureBlock", TerraceTextureUnit],
    ["HeightToSlopeBlock", HeightToSlopeUnit],
    ["SampleTextureBlock", SampleTextureUnit],
    ["LowPassFilterBlock", LowPassFilterUnit],
    ["RateLimiterBlock", RateLimiterUnit],
    ["SensorFusionBlock", SensorFusionUnit],
    ["ThresholdGateBlock", ThresholdGateUnit],
    ["RandomRangeBlock", RandomRangeUnit],
    ["SeededRandomBlock", SeededRandomUnit],
    ["GaussianNoiseBlock", GaussianNoiseUnit],
    ["JitterBlock", JitterUnit],
    ["WeightedSelectBlock", WeightedSelectUnit],
    ["RemapRangeBlock", RemapRangeUnit],
    ["Float64ToInt32Block", Float64ToInt32],
    ["Int32ToFloat64Block", Int32ToFloat64],
    ["StringBlock", StringUnit],
    ["IfBlock", IfUnit],
    ["EqualityBlock", Equality],
    ["ConjugationBlock", Conjugation],
    ["NopBlock", NopUnit],
    ["IgnoreBlock", IgnoreUnit],
    ["SequenceBlock", SequenceUnit],
    ["PassthroughBlock", PassthroughUnit],
    ["ProgramInputBlock", ProgramInputUnit],
    ["OutputNodeBlock", OutputNodeUnit],
    ["ReadSignalBlock", ReadSignalUnit],
    ["WriteSignalBlock", WriteSignalUnit],
    ["SignalExistsBlock", SignalExistsUnit],
    ["SignalAgeBlock", SignalAgeUnit],
    ["SignalChangedBlock", SignalChangedUnit],
    ["SignalLatchBlock", SignalLatchUnit],
    ["SignalDefaultBlock", SignalDefaultUnit],
    ["StoreNamespaceBlock", StoreNamespaceUnit],
    ["TopicSnapshotBlock", TopicSnapshotUnit],
    ["TopicFieldBlock", TopicFieldUnit],
    ["BuildTopicMessageBlock", BuildTopicMessageUnit],
    ["StagePublishBlock", StagePublishUnit],
    ["TopicStaleGateBlock", TopicStaleGateUnit],
    ["TopicMetadataBlock", TopicMetadataUnit],
    ["VehicleSnapshotBlock", VehicleSnapshotUnit],
    ["VehiclePoseBlock", VehiclePoseUnit],
    ["VehicleVelocityBlock", VehicleVelocityUnit],
    ["VehicleDimensionsBlock", VehicleDimensionsUnit],
    ["DeviceSnapshotBlock", DeviceSnapshotUnit],
    ["SimulationSnapshotBlock", SimulationSnapshotUnit],
    ["ScenarioSnapshotBlock", ScenarioSnapshotUnit],
    ["ObjectSnapshotBlock", ObjectSnapshotUnit],
    ["WaypointListBlock", WaypointListUnit],
    ["CurrentWaypointBlock", CurrentWaypointUnit],
    ["AdvanceWaypointBlock", AdvanceWaypointUnit],
    ["ReachedWaypointBlock", ReachedWaypointUnit],
    ["MissionStateBlock", MissionStateUnit],
    ["SetMissionStateBlock", SetMissionStateUnit],
    ["RouteProgressBlock", RouteProgressUnit],
    ["FollowRouteBlock", FollowRouteUnit],
    ["FollowRouteSectionBlock", FollowRouteSectionUnit],
    ["RouteSectionCountBlock", RouteSectionCountUnit],
    ["MakeActorCommandBlock", MakeActorCommandUnit],
    ["SplitActorCommandBlock", SplitActorCommandUnit],
    ["ScenarioFlagReadBlock", ScenarioFlagReadUnit],
    ["ScenarioFlagWriteBlock", ScenarioFlagWriteUnit],
    ["OnSignalUpdateBlock", OnSignalUpdateUnit],
    ["OnTickBlock", OnTickUnit],
    ["OnTimerBlock", OnTimerUnit],
    ["BindInputBlock", BindInputUnit],
    ["BindOutputBlock", BindOutputUnit],
    ["BindTriggerBlock", BindTriggerUnit],
    ["ProbeSignalBlock", ProbeSignalUnit],
    ["LogSignalBlock", LogSignalUnit],
    ["AssertSignalBlock", AssertSignalUnit],
    ["RecordSignalBlock", RecordSignalUnit],
    ["ReplaySignalBlock", ReplaySignalUnit],
    ["BindingStatusBlock", BindingStatusUnit],
]);

export function createCatalogUnitUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2, 11);
}

export const UNIT_CATALOG = UNIT_CATALOG_META.map((entry) => ({
    ...entry,
    Component: COMPONENT_BY_TYPE.get(entry.type) || null,
}));

UNIT_CATALOG.forEach((entry) => {
    if (entry.placeable && (!entry.Component || !entry.blockClass)) {
        throw new Error(`Placeable unit "${entry.type}" requires both a React component and block class.`);
    }
});

export const UNIT_CATALOG_BY_TYPE = new Map(
    UNIT_CATALOG.map((entry) => [entry.type, entry]),
);

export function getUnitCatalogEntry(type) {
    return UNIT_CATALOG_BY_TYPE.get(type) || null;
}

export function groupedUnitCatalog() {
    return UNIT_CATALOG.reduce((groups, item) => {
        if (!item.placeable) return groups;
        if (!groups[item.category]) groups[item.category] = [];
        groups[item.category].push(item);
        return groups;
    }, {});
}

export function catalogBlockClasses() {
    return UNIT_CATALOG_META.map((entry) => entry.blockClass);
}
