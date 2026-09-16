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
    assert.equal(UNIT_CATALOG_META.find((entry) => entry.type === "ScaleBlock")?.placeable, true);
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

