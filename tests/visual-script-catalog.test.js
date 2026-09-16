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
