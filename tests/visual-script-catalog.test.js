import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { clearBlockTypeRegistryForTests, getRegisteredBlockType } from "../app/scripting/BlockRegistry.js";
import { UNIT_CATALOG_META } from "../app/scripting/UnitCatalog.meta.js";
import { registerBuiltInBlocks } from "../app/scripting/registerBuiltInBlocks.js";

const REQUIRED_FIELDS = [
    "type",
    "name",
    "category",
    "keywords",
    "placeable",
    "deprecated",
    "settings",
    "requiresSignals",
    "blockClass",
];

test("catalog metadata is explicit, unique, JSON-safe, and registry-authoritative", () => {
    const types = new Set();
    for (const entry of UNIT_CATALOG_META) {
        REQUIRED_FIELDS.forEach((field) => assert.equal(Object.hasOwn(entry, field), true, `${entry.type}.${field}`));
        assert.equal(typeof entry.type, "string");
        assert.equal(typeof entry.name, "string");
        assert.equal(typeof entry.category, "string");
        assert.equal(typeof entry.placeable, "boolean");
        assert.equal(typeof entry.deprecated, "boolean");
        assert.equal(typeof entry.requiresSignals, "boolean");
        assert.ok(Array.isArray(entry.keywords) && entry.keywords.length > 0, entry.type);
        assert.ok(Array.isArray(entry.settings), entry.type);
        assert.doesNotThrow(() => JSON.stringify(entry.settings));
        assert.equal(types.has(entry.type), false, entry.type);
        types.add(entry.type);
    }

    clearBlockTypeRegistryForTests();
    registerBuiltInBlocks();
    UNIT_CATALOG_META.forEach((entry) => {
        assert.equal(getRegisteredBlockType(entry.type), entry.blockClass, entry.type);
        assert.equal(entry.blockClass.blockType, entry.type, entry.type);
    });
    assert.ok(getRegisteredBlockType("ROSInputBlock"));
    assert.ok(getRegisteredBlockType("ROSOutputBlock"));
});

test("legacy composites remain registered but are not placeable", () => {
    for (const type of ["CalculationBlock", "EqualityBlock", "ConjugationBlock"]) {
        const entry = UNIT_CATALOG_META.find((candidate) => candidate.type === type);
        assert.equal(entry?.placeable, false);
        assert.equal(entry?.deprecated, true);
    }
    const output = UNIT_CATALOG_META.find((entry) => entry.type === "OutputNodeBlock");
    assert.equal(output?.placeable, false);
    assert.equal(output?.deprecated, false);
    const scale = UNIT_CATALOG_META.find((entry) => entry.type === "ScaleBlock");
    assert.equal(scale?.placeable, false);
    assert.equal(scale?.deprecated, true);
    assert.equal(UNIT_CATALOG_META.some((entry) => entry.type.startsWith("ROS")), false);
});

test("snapshot signal dependencies and React component mappings cover the catalog", async () => {
    const signalTypes = new Set([
        "TopicSnapshotBlock",
        "VehicleSnapshotBlock",
        "VehiclePoseBlock",
        "VehicleVelocityBlock",
        "VehicleDimensionsBlock",
        "DeviceSnapshotBlock",
        "SimulationSnapshotBlock",
        "ScenarioSnapshotBlock",
        "ObjectSnapshotBlock",
        "VehicleStateBlock",
        "DeviceStateBlock",
        "SimulationClockBlock",
        "ScenarioStatusBlock",
    ]);
    UNIT_CATALOG_META.forEach((entry) => {
        assert.equal(entry.requiresSignals, signalTypes.has(entry.type), entry.type);
    });

    const source = await readFile(new URL("../app/scripting/UnitCatalog.js", import.meta.url), "utf8");
    UNIT_CATALOG_META.forEach((entry) => {
        assert.match(source, new RegExp(`\\[\\"${entry.type}\\",`), entry.type);
    });
    assert.match(source, /if \(!item\.placeable\) return groups/);

    const menuSource = await readFile(new URL("../app/scripting/AddMenu.js", import.meta.url), "utf8");
    for (const category of ["math", "logic", "strings", "collections", "geometry", "control"]) {
        assert.match(menuSource, new RegExp(`\\b${category}:`), category);
    }
    assert.match(menuSource, /\.\.\.\(unit\.keywords \|\| \[\]\)/);
});

test("atomic math and logic blocks are placeable and searchable", () => {
    const math = UNIT_CATALOG_META.filter((entry) => entry.category === "math" && entry.placeable);
    const logic = UNIT_CATALOG_META.filter((entry) => entry.category === "logic" && entry.placeable);
    assert.ok(math.some((entry) => entry.type === "AddBlock"));
    assert.ok(math.some((entry) => entry.type === "IntegerBlock"));
    assert.equal(math.some((entry) => entry.type === "CalculationBlock"), false);
    assert.ok(logic.some((entry) => entry.type === "AndBlock"));
    assert.ok(logic.some((entry) => entry.type === "BooleanBlock"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "AddBlock").keywords.includes("add"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "AndBlock").keywords.includes("and"));
    assert.equal(UNIT_CATALOG_META.find((entry) => entry.type === "JsonBlock")?.category, "objects");
});

test("conversion string json and array blocks are placeable and searchable", () => {
    const conversions = UNIT_CATALOG_META.filter((entry) => entry.category === "conversions" && entry.placeable);
    const strings = UNIT_CATALOG_META.filter((entry) => entry.category === "strings" && entry.placeable);
    const collections = UNIT_CATALOG_META.filter((entry) => entry.category === "collections" && entry.placeable);
    assert.ok(conversions.some((entry) => entry.type === "FloorToIntBlock"));
    assert.ok(conversions.some((entry) => entry.type === "Float64ToInt32Block"));
    assert.equal(UNIT_CATALOG_META.find((entry) => entry.type === "Float64ToInt32Block")?.placeable, true);
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "FloorToIntBlock").keywords.includes("floor"));
    assert.ok(conversions.some((entry) => entry.type === "StringToRoadIdBlock"));
    assert.ok(conversions.some((entry) => entry.type === "ToStringBlock"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "ToStringBlock").keywords.includes("stringify"));
    assert.ok(conversions.some((entry) => entry.type === "RoadIdToStringBlock"));
    assert.ok(conversions.some((entry) => entry.type === "StringToTextureIdBlock"));
    assert.ok(conversions.some((entry) => entry.type === "TextureIdToStringBlock"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "StringToRoadIdBlock").keywords.includes("road"));
    assert.ok(strings.some((entry) => entry.type === "ConcatStringBlock"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "ConcatStringBlock").keywords.includes("concat"));
    assert.ok(collections.some((entry) => entry.type === "ArrayGetBlock"));
    assert.equal(UNIT_CATALOG_META.find((entry) => entry.type === "JsonGetBlock")?.category, "objects");
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "JsonGetBlock").keywords.includes("get"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "ArrayLiteralBlock").keywords.includes("array"));
});

test("geometry and route helper blocks are placeable and searchable", () => {
    const geometry = UNIT_CATALOG_META.filter((entry) => entry.category === "geometry" && entry.placeable);
    assert.ok(geometry.some((entry) => entry.type === "MakeVec2Block"));
    assert.ok(geometry.some((entry) => entry.type === "CrossVec3Block"));
    assert.ok(geometry.some((entry) => entry.type === "MakePose3DBlock"));
    assert.equal(geometry.length, 23);
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "MakeVec2Block").keywords.includes("vec2"));
    assert.equal(UNIT_CATALOG_META.find((entry) => entry.type === "WaypointAtIndexBlock")?.category, "mission");
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "RouteLengthBlock").keywords.includes("length"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "RouteTangentBlock").keywords.includes("tangent"));
});

test("control temporal and controller blocks are placeable and searchable", () => {
    const control = UNIT_CATALOG_META.filter((entry) => entry.category === "control" && entry.placeable);
    assert.equal(control.length, 14);
    assert.ok(control.some((entry) => entry.type === "PreviousBlock"));
    assert.ok(control.some((entry) => entry.type === "IntegratorBlock"));
    assert.ok(control.some((entry) => entry.type === "PidControllerBlock"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "PreviousBlock").keywords.includes("z1"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "IntegratorBlock").keywords.includes("integrator"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "PidControllerBlock").keywords.includes("pid"));
});

test("simulator adapters and texture ops are placeable and searchable", () => {
    const simulator = UNIT_CATALOG_META.filter((entry) => entry.category === "simulator" && entry.placeable);
    assert.equal(simulator.length, 16);
    assert.ok(simulator.some((entry) => entry.type === "VehicleStateBlock"));
    assert.ok(simulator.some((entry) => entry.type === "SpawnPropBlock"));
    assert.ok(simulator.some((entry) => entry.type === "ScatterFeaturesBlock"));
    assert.ok(simulator.some((entry) => entry.type === "SampleRoadBlock"));
    assert.ok(simulator.some((entry) => entry.type === "GetNearestRoadBlock"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "GetNearestRoadBlock").keywords.includes("nearest"));
    assert.equal(UNIT_CATALOG_META.find((entry) => entry.type === "TextureImportBlock")?.category, "objects");
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "TextureImportBlock").keywords.includes("texture"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "LogMessageBlock").keywords.includes("print"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "LinspaceBlock")?.category === "collections");
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "RepeatProgramBlock")?.category === "statements");
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "FrameAlongPathBlock")?.category === "mission");
    assert.ok(simulator.some((entry) => entry.type === "SimulationClockBlock"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "VehicleStateBlock").keywords.includes("adapter"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "SimulationClockBlock").keywords.includes("clock"));
    assert.equal(UNIT_CATALOG_META.find((entry) => entry.type === "VehicleStateBlock")?.requiresSignals, true);

    const texture = UNIT_CATALOG_META.filter((entry) => entry.category === "texture1d" && entry.placeable);
    assert.equal(texture.length, 8);
    assert.ok(texture.some((entry) => entry.type === "ScaleTextureBlock"));
    assert.ok(texture.some((entry) => entry.type === "InvertTextureBlock"));
    assert.equal(texture.some((entry) => entry.type === "ScaleBlock"), false);
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "ScaleTextureBlock").keywords.includes("scale"));
    assert.ok(UNIT_CATALOG_META.find((entry) => entry.type === "InvertTextureBlock").keywords.includes("invert"));
});

