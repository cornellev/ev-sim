/**
 * Server-safe unit catalog metadata (no React components).
 * Used by /api/scripting/units and MCP tooling.
 */
import { NumberUnitClass } from "./units/math/Number.block.js";
import { CalculationBlock } from "./units/math/Calculation.block.js";
import { Float64ToInt32Block, Int32ToFloat64Block } from "./units/conversions/NumberConversions.block.js";
import { EBlock, GoldenRatioBlock, PIBlock, TauBlock } from "./units/math/Constants.block.js";
import { RandomNumberBlock } from "./units/math/Random.block.js";
import { NoiseBlock } from "./units/math/tex/Noise.block.js";
import { MultiplyTexBlock, ScaleBlock } from "./units/math/tex/Scale.block.js";
import { MaskBlock } from "./units/math/tex/Mask.block.js";
import { IfBlock } from "./units/statements/If.block.js";
import { ConjugationBlock, EqualityBlock } from "./units/statements/Equality.block.js";
import {
    IgnoreBlock,
    NopBlock,
    PassthroughBlock,
    SequenceBlock,
} from "./units/statements/Unit.block.js";
import { StringBlock } from "./units/objects/String.block.js";
import {
    BlendTextureBlock,
    HeightToSlopeBlock,
    NormalizeTextureBlock,
    TerrainNoiseBlock,
    TerraceTextureBlock,
} from "./units/math/Terrain.block.js";
import {
    LowPassFilterBlock,
    RateLimiterBlock,
    SampleTextureBlock,
    SensorFusionBlock,
    ThresholdGateBlock,
} from "./units/math/SensorFlow.block.js";
import {
    GaussianNoiseBlock,
    JitterBlock,
    RandomRangeBlock,
    RemapRangeBlock,
    SeededRandomBlock,
    WeightedSelectBlock,
} from "./units/math/Randomization.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "./units/program/ProgramIO.block.js";
import {
    MakeActorCommandBlock,
    SplitActorCommandBlock,
} from "./units/mission/ActorCommand.block.js";
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
    SignalAgeBlock,
    SignalChangedBlock,
    SignalDefaultBlock,
    SignalExistsBlock,
    SignalLatchBlock,
    SimulationSnapshotBlock,
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

const NO_SETTINGS = Object.freeze([]);

const NUMBER_SETTINGS = Object.freeze([
    Object.freeze({ target: "storedData", key: null, valueType: "float64", default: 0 }),
]);
const STRING_SETTINGS = Object.freeze([
    Object.freeze({ target: "storedData", key: null, valueType: "string", default: "" }),
]);
const EQUALITY_SETTINGS = Object.freeze([
    Object.freeze({
        target: "storedData",
        key: null,
        valueType: "enum",
        default: "eq",
        options: ["eq", "neq", "gt", "lt", "gte", "lte"],
    }),
]);
const CONJUGATION_SETTINGS = Object.freeze([
    Object.freeze({
        target: "storedData",
        key: null,
        valueType: "enum",
        default: "and",
        options: ["and", "or", "xor"],
    }),
]);
const PROGRAM_INPUT_SETTINGS = Object.freeze([
    Object.freeze({ target: "storedData", key: "label", valueType: "string", default: "input" }),
    Object.freeze({ target: "storedData", key: "type", valueType: "port_type", default: "float64" }),
    Object.freeze({ target: "storedData", key: "defaultValue", valueType: "string", default: "0" }),
]);
const OUTPUT_NODE_SETTINGS = Object.freeze([
    Object.freeze({ target: "state", key: "outputs", valueType: "json", default: [] }),
]);

function entry(type, name, category, blockClass, keywords, options = {}) {
    return {
        type,
        name,
        category,
        keywords: [...keywords],
        placeable: options.placeable !== false,
        deprecated: options.deprecated === true,
        settings: options.settings || NO_SETTINGS,
        requiresSignals: options.requiresSignals === true,
        blockClass,
        notes: options.notes || null,
    };
}

/** @type {{ type: string, name: string, category: string, keywords: string[], placeable: boolean, deprecated: boolean, settings: object[], requiresSignals: boolean, blockClass: Function, notes: string|null }[]} */
export const UNIT_CATALOG_META = [
    entry("NumberUnitClass", "Number", "expressions", NumberUnitClass, ["number", "float", "constant"], { settings: NUMBER_SETTINGS }),
    entry("CalculationBlock", "Calculation", "expressions", CalculationBlock, ["calculate", "arithmetic", "legacy"], { placeable: false, deprecated: true }),
    entry("RandomNumberBlock", "Random Number", "expressions", RandomNumberBlock, ["random", "rng", "uniform"]),
    entry("PIBlock", "π (Pi)", "constants", PIBlock, ["pi", "circle", "3.14159"]),
    entry("EBlock", "e (Euler's Number)", "constants", EBlock, ["euler", "exponential"]),
    entry("TauBlock", "τ (Tau)", "constants", TauBlock, ["tau", "circle", "2 pi"]),
    entry("GoldenRatioBlock", "Golden Ratio (φ)", "constants", GoldenRatioBlock, ["phi", "golden ratio"]),
    entry("NoiseBlock", "Noise Texture (tex1d)", "texture1d", NoiseBlock, ["noise", "texture", "tex1d"]),
    entry("MaskBlock", "Mask Texture (tex1d)", "texture1d", MaskBlock, ["mask", "texture", "tex1d"]),
    entry("MultiplyTexBlock", "Multiply Textures (tex1d)", "texture1d", MultiplyTexBlock, ["multiply", "texture", "tex1d"]),
    entry("ScaleBlock", "Scale Matrix (tex1d)", "texture1d", ScaleBlock, ["scale", "texture", "tex1d", "scalar"]),
    entry("TerrainNoiseBlock", "Terrain Noise (tex1d)", "terrain", TerrainNoiseBlock, ["terrain", "noise", "heightmap"]),
    entry("NormalizeTextureBlock", "Normalize Texture (tex1d)", "terrain", NormalizeTextureBlock, ["normalize", "texture"]),
    entry("BlendTextureBlock", "Blend Texture (tex1d)", "terrain", BlendTextureBlock, ["blend", "mix", "texture"]),
    entry("TerraceTextureBlock", "Terrace Texture (tex1d)", "terrain", TerraceTextureBlock, ["terrace", "steps", "texture"]),
    entry("HeightToSlopeBlock", "Height To Slope (tex1d)", "terrain", HeightToSlopeBlock, ["height", "slope", "texture"]),
    entry("SampleTextureBlock", "Sample Texture (tex1d → float64)", "sensorflow", SampleTextureBlock, ["sample", "texture", "sensor"]),
    entry("LowPassFilterBlock", "Low Pass Filter", "sensorflow", LowPassFilterBlock, ["filter", "smooth", "ema"]),
    entry("RateLimiterBlock", "Rate Limiter", "sensorflow", RateLimiterBlock, ["rate", "limit", "slew"]),
    entry("SensorFusionBlock", "Sensor Fusion", "sensorflow", SensorFusionBlock, ["sensor", "fusion", "weighted"]),
    entry("ThresholdGateBlock", "Threshold Gate", "sensorflow", ThresholdGateBlock, ["threshold", "range", "gate"]),
    entry("RandomRangeBlock", "Random Range", "randomization", RandomRangeBlock, ["random", "range", "rng"]),
    entry("SeededRandomBlock", "Seeded Random", "randomization", SeededRandomBlock, ["seed", "random", "deterministic"]),
    entry("GaussianNoiseBlock", "Gaussian Noise", "randomization", GaussianNoiseBlock, ["gaussian", "normal", "noise"]),
    entry("JitterBlock", "Jitter", "randomization", JitterBlock, ["jitter", "noise", "random"]),
    entry("WeightedSelectBlock", "Weighted Select", "randomization", WeightedSelectBlock, ["weighted", "select", "probability"]),
    entry("RemapRangeBlock", "Remap Range", "randomization", RemapRangeBlock, ["remap", "range", "map"]),
    entry("Float64ToInt32Block", "Float64 to Int32", "conversions", Float64ToInt32Block, ["convert", "float", "integer"]),
    entry("Int32ToFloat64Block", "Int32 to Float64", "conversions", Int32ToFloat64Block, ["convert", "integer", "float"]),
    entry("StringBlock", "String", "objects", StringBlock, ["string", "text", "constant"], { settings: STRING_SETTINGS }),
    entry("IfBlock", "If Statement", "statements", IfBlock, ["if", "condition", "select"]),
    entry("EqualityBlock", "Comparison (==, !=, >, <, >=, <=)", "statements", EqualityBlock, ["compare", "equality", "legacy"], { placeable: false, deprecated: true, settings: EQUALITY_SETTINGS }),
    entry("ConjugationBlock", "Conjunction (AND, OR)", "statements", ConjugationBlock, ["and", "or", "xor", "legacy"], { placeable: false, deprecated: true, settings: CONJUGATION_SETTINGS }),
    entry("NopBlock", "Nop", "statements", NopBlock, ["nop", "unit", "sequence"]),
    entry("IgnoreBlock", "Ignore", "statements", IgnoreBlock, ["ignore", "discard", "unit"]),
    entry("SequenceBlock", "Sequence", "statements", SequenceBlock, ["sequence", "then", "control"]),
    entry("PassthroughBlock", "Passthrough", "statements", PassthroughBlock, ["passthrough", "identity", "unit"]),
    entry("ProgramInputBlock", "Program Input", "program", ProgramInputBlock, ["program", "input", "parameter"], { settings: PROGRAM_INPUT_SETTINGS }),
    entry("OutputNodeBlock", "OutputNode", "program", OutputNodeBlock, ["program", "output", "head"], {
        placeable: false,
        settings: OUTPUT_NODE_SETTINGS,
        notes: "Graph head output node. Configure via graph.outputNodeConfig / script_update_unit on the head uuid (default head-uuid). Do not script_add_unit this type.",
    }),
    entry("ReadSignalBlock", "Read Signal", "signals", ReadSignalBlock, ["read", "signal", "value"]),
    entry("WriteSignalBlock", "Write Signal", "signals", WriteSignalBlock, ["write", "signal", "publish"]),
    entry("SignalExistsBlock", "Signal Exists", "signals", SignalExistsBlock, ["signal", "exists", "available"]),
    entry("SignalAgeBlock", "Signal Age", "signals", SignalAgeBlock, ["signal", "age", "stale"]),
    entry("SignalChangedBlock", "Signal Changed", "signals", SignalChangedBlock, ["signal", "changed", "revision"]),
    entry("SignalLatchBlock", "Signal Latch", "signals", SignalLatchBlock, ["signal", "latch", "hold"]),
    entry("SignalDefaultBlock", "Signal Default", "signals", SignalDefaultBlock, ["signal", "default", "fallback"]),
    entry("StoreNamespaceBlock", "Store Namespace", "signals", StoreNamespaceBlock, ["signal", "namespace", "path"]),
    entry("TopicSnapshotBlock", "Topic Snapshot", "topics", TopicSnapshotBlock, ["topic", "snapshot", "message"], { requiresSignals: true }),
    entry("TopicFieldBlock", "Topic Field", "topics", TopicFieldBlock, ["topic", "field", "message"]),
    entry("BuildTopicMessageBlock", "Build Topic Message", "topics", BuildTopicMessageBlock, ["topic", "build", "message"]),
    entry("StagePublishBlock", "Stage Publish", "topics", StagePublishBlock, ["topic", "publish", "stage"]),
    entry("TopicStaleGateBlock", "Topic Stale Gate", "topics", TopicStaleGateBlock, ["topic", "stale", "gate"]),
    entry("TopicMetadataBlock", "Topic Metadata", "topics", TopicMetadataBlock, ["topic", "metadata", "status"]),
    entry("VehicleSnapshotBlock", "Vehicle Snapshot", "simulator", VehicleSnapshotBlock, ["vehicle", "snapshot", "ego"], { requiresSignals: true }),
    entry("VehiclePoseBlock", "Vehicle Pose", "simulator", VehiclePoseBlock, ["vehicle", "pose", "ego"], { requiresSignals: true }),
    entry("VehicleVelocityBlock", "Vehicle Velocity", "simulator", VehicleVelocityBlock, ["vehicle", "velocity", "speed"], { requiresSignals: true }),
    entry("VehicleDimensionsBlock", "Vehicle Dimensions", "simulator", VehicleDimensionsBlock, ["vehicle", "dimensions", "size"], { requiresSignals: true }),
    entry("DeviceSnapshotBlock", "Device Snapshot", "simulator", DeviceSnapshotBlock, ["device", "sensor", "snapshot"], { requiresSignals: true }),
    entry("SimulationSnapshotBlock", "Simulation Snapshot", "simulator", SimulationSnapshotBlock, ["simulation", "snapshot", "clock"], { requiresSignals: true }),
    entry("ScenarioSnapshotBlock", "Scenario Snapshot", "simulator", ScenarioSnapshotBlock, ["scenario", "snapshot", "status"], { requiresSignals: true }),
    entry("ObjectSnapshotBlock", "Object Snapshot", "simulator", ObjectSnapshotBlock, ["object", "snapshot", "target"], { requiresSignals: true }),
    entry("WaypointListBlock", "Waypoint List", "mission", WaypointListBlock, ["waypoint", "route", "list"]),
    entry("CurrentWaypointBlock", "Current Waypoint", "mission", CurrentWaypointBlock, ["waypoint", "current", "mission"]),
    entry("AdvanceWaypointBlock", "Advance Waypoint", "mission", AdvanceWaypointBlock, ["waypoint", "advance", "mission"]),
    entry("ReachedWaypointBlock", "Reached Waypoint", "mission", ReachedWaypointBlock, ["waypoint", "reached", "distance"]),
    entry("MissionStateBlock", "Mission State", "mission", MissionStateBlock, ["mission", "state", "status"]),
    entry("SetMissionStateBlock", "Set Mission State", "mission", SetMissionStateBlock, ["mission", "state", "set"]),
    entry("RouteProgressBlock", "Route Progress", "mission", RouteProgressBlock, ["route", "progress", "mission"]),
    entry("FollowRouteBlock", "Follow Route", "mission", FollowRouteBlock, ["route", "follow", "command"]),
    entry("FollowRouteSectionBlock", "Follow Route Section", "mission", FollowRouteSectionBlock, ["route", "section", "follow"]),
    entry("RouteSectionCountBlock", "Route Section Count", "mission", RouteSectionCountBlock, ["route", "section", "count"]),
    entry("MakeActorCommandBlock", "Make Actor Command", "mission", MakeActorCommandBlock, ["actor", "command", "vehicle"], {
        notes: "actorId is optional; omitted values become empty string.",
    }),
    entry("SplitActorCommandBlock", "Split Actor Command", "mission", SplitActorCommandBlock, ["actor", "command", "split"]),
    entry("ScenarioFlagReadBlock", "Scenario Flag Read", "mission", ScenarioFlagReadBlock, ["scenario", "flag", "read"]),
    entry("ScenarioFlagWriteBlock", "Scenario Flag Write", "mission", ScenarioFlagWriteBlock, ["scenario", "flag", "write"]),
    entry("OnSignalUpdateBlock", "On Signal Update", "bindings", OnSignalUpdateBlock, ["signal", "update", "trigger"]),
    entry("OnTickBlock", "On Tick", "bindings", OnTickBlock, ["tick", "frame", "trigger"]),
    entry("OnTimerBlock", "On Timer", "bindings", OnTimerBlock, ["timer", "interval", "trigger"]),
    entry("BindInputBlock", "Bind Input", "bindings", BindInputBlock, ["bind", "input", "signal"]),
    entry("BindOutputBlock", "Bind Output", "bindings", BindOutputBlock, ["bind", "output", "signal"]),
    entry("BindTriggerBlock", "Bind Trigger", "bindings", BindTriggerBlock, ["bind", "trigger", "signal"]),
    entry("ProbeSignalBlock", "Probe Signal", "diagnostics", ProbeSignalBlock, ["probe", "signal", "debug"]),
    entry("LogSignalBlock", "Log Signal", "diagnostics", LogSignalBlock, ["log", "signal", "debug"]),
    entry("AssertSignalBlock", "Assert Signal", "diagnostics", AssertSignalBlock, ["assert", "signal", "test"]),
    entry("RecordSignalBlock", "Record Signal", "diagnostics", RecordSignalBlock, ["record", "signal", "history"]),
    entry("ReplaySignalBlock", "Replay Signal", "diagnostics", ReplaySignalBlock, ["replay", "signal", "history"]),
    entry("BindingStatusBlock", "Binding Status", "diagnostics", BindingStatusBlock, ["binding", "status", "diagnostic"]),
];
