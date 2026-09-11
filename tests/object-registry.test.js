import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    ASSET_INSTANCE_TYPE_ID,
    BUILTIN_OBJECT_TYPE_IDS,
    BUILTIN_PROP_ASSETS,
    BUILTIN_PROP_TYPE_ID,
    DEFAULT_FEATURE_RADIUS,
    DEFAULT_MAP_COLOR,
    FEATURE_GEOMETRY_BY_TYPE,
    FEATURE_RADIUS_BY_TYPE,
    FEATURE_SEMANTIC_LABEL_BY_TYPE,
    FIELD_CONTROLS,
    OBJECT_TYPE_ERROR_CODES,
    ObjectOptions,
    ObjectTypeRegistry,
    createBuiltinObjectTypeRegistry,
    defineObjectType,
    field,
    getFieldValue,
    listObjectTypes,
    objectTypeRegistry,
    registerBuiltinObjectTypes,
    setFieldValue,
    validateFieldConstraints,
    validateObjectGraph,
} from "../app/3d/editor/objects/index.js";
import { PLACEMENT_CATALOG, fusionObjectToCatalogType, getMapColorForAsset } from "../app/3d/editor/placement/placementCatalogData.js";
import { serializeEnvironmentManifest } from "../app/3d/environment/EnvironmentManifestPolicy.js";

const root = new URL("../", import.meta.url);
const objectsDir = new URL("app/3d/editor/objects/", root);

class MarkerOptions extends ObjectOptions {
    getDefaults() {
        return { label: "marker", radius: 1 };
    }

    getFields() {
        return MARKER_FIELDS;
    }

    normalize(value = {}) {
        return {
            label: typeof value?.label === "string" ? value.label : "marker",
            radius: Number.isFinite(value?.radius) ? value.radius : 1,
        };
    }

    validate(value) {
        return validateFieldConstraints(MARKER_FIELDS, value);
    }

    fromLegacy(_legacy, context = {}) {
        return this.normalize(context.record?.components?.marker ?? {});
    }
}

const MARKER_FIELDS = Object.freeze([
    field({ path: ["label"], label: "Label", control: "text" }),
    field({ path: ["radius"], label: "Radius", control: "number", units: "m", min: 0.1, max: 10 }),
]);

function markerType() {
    return defineObjectType({
        typeId: "test.marker",
        version: 1,
        label: "Test marker",
        catalog: { label: "Test marker", kind: "marker", layer: "props" },
        legacy: null,
        options: new MarkerOptions(),
        components: ["marker"],
        compileMetric(record) {
            return { shape: "sphere", radius: record.components.marker?.radius ?? 1 };
        },
    });
}

const PINNED_PLACEMENT_CATALOG = [
    { id: "stop-sign", label: "Stop Sign", kind: "sign", mapColor: "#ef4444" },
    { id: "one-way-sign", label: "One Way", kind: "sign", mapColor: "#38bdf8" },
    { id: "barrel", label: "Barrel", kind: "barrel", mapColor: "#f97316" },
    { id: "tire", label: "Tire", kind: "tire", mapColor: "#71717a" },
    { id: "cone", label: "Cone", kind: "cone", mapColor: "#f97316" },
];

const PINNED_FEATURE_GEOMETRY = {
    barrel: { size: { x: 0.75, y: 1, z: 0.75 }, centerY: 0.5 },
    cone: { size: { x: 0.36, y: 0.7, z: 0.36 }, centerY: 0.35 },
    tire: { size: { x: 0.44, y: 0.12, z: 0.44 }, centerY: 0.06 },
    "stop-sign": { size: { x: 0.0508, y: 2.1336, z: 0.9144 }, centerY: 1.0668, directional: true },
    "one-way-sign": { size: { x: 0.0254, y: 0.3048, z: 0.6096 }, centerY: 1.9812, directional: true },
};

const PINNED_FEATURE_RADIUS = { "stop-sign": 0.4, "one-way-sign": 0.4, barrel: 0.5, tire: 0.3, cone: 0.25 };

test("ED-01 registry rejects definitions without typeId, version, options, or required methods", () => {
    const registry = new ObjectTypeRegistry();
    const base = markerType();
    const attempts = [
        [{ ...base, typeId: "" }, /typeId/],
        [{ ...base, typeId: "Bad Id" }, /lowercase/],
        [{ ...base, version: 0 }, /version/],
        [{ ...base, label: "" }, /label/],
        [{ ...base, options: { getDefaults() {}, getFields() {}, normalize() {}, validate() {} } }, /ObjectOptions/],
        [{ ...base, compileMetric: undefined }, /compileMetric/],
        [{ ...base, catalog: { label: "x", kind: "x", layer: "nowhere" } }, /catalog.layer/],
        [{ ...base, legacy: { domain: "nowhere", idField: "id" } }, /legacy.domain/],
    ];
    for (const [definition, pattern] of attempts) {
        assert.throws(() => registry.register(definition), (error) => (
            error.code === OBJECT_TYPE_ERROR_CODES.INVALID_DEFINITION && pattern.test(error.message)
        ), `expected rejection matching ${pattern}`);
    }
    assert.equal(registry.list().length, 0);
});

test("ED-01 registry rejects duplicate typeId@version and resolves latest version by default", () => {
    const registry = new ObjectTypeRegistry();
    const v1 = registry.register(markerType());
    assert.equal(Object.isFrozen(v1), true);
    assert.throws(() => registry.register(markerType()), (error) => error.code === OBJECT_TYPE_ERROR_CODES.DUPLICATE);
    const v2 = registry.register({ ...markerType(), version: 2, label: "Test marker v2" });
    assert.equal(registry.get("test.marker").version, 2);
    assert.equal(registry.get("test.marker", 1), v1);
    assert.equal(registry.get("test.marker", 2), v2);
    assert.equal(registry.get("test.marker", 3), null);
    assert.equal(registry.get("missing"), null);
    assert.throws(() => registry.require("missing"), (error) => error.code === OBJECT_TYPE_ERROR_CODES.NOT_FOUND);
    assert.deepEqual(registry.listAll().map((entry) => entry.key), ["test.marker@1", "test.marker@2"]);
});

test("ED-01 built-in registration is idempotent and lists every initial type", () => {
    const registry = createBuiltinObjectTypeRegistry();
    registerBuiltinObjectTypes(registry);
    assert.deepEqual(
        registry.list().map((entry) => entry.typeId).sort(),
        [...BUILTIN_OBJECT_TYPE_IDS].sort(),
    );
    assert.deepEqual(
        [...BUILTIN_OBJECT_TYPE_IDS].sort(),
        ["asset-instance", "building", "builtin-prop", "group", "intersection", "road", "skybox", "tile"],
    );
    // The shared singleton is populated by importing the index module.
    assert.deepEqual(listObjectTypes().map((entry) => entry.typeId).sort(), [...BUILTIN_OBJECT_TYPE_IDS].sort());
    for (const definition of registry.list()) {
        assert.ok(definition.options instanceof ObjectOptions, `${definition.typeId} options`);
        assert.equal(typeof definition.getCapabilities(null).selectable, "boolean");
        assert.ok(["props", "roads", "buildings", "environment"].includes(definition.catalog.layer));
        const fields = definition.options.getFields();
        for (const descriptor of fields) {
            assert.ok(FIELD_CONTROLS.includes(descriptor.control), `${definition.typeId}.${descriptor.path.join(".")}`);
            assert.ok(descriptor.label.length > 0);
            assert.ok(Array.isArray(descriptor.path) && descriptor.path.length > 0);
        }
        const defaults = definition.options.getDefaults();
        const issues = definition.options.validate(definition.options.normalize(defaults));
        // Asset instances have no meaningful default asset until ED-06; every other default validates clean.
        const expectedCodes = definition.typeId === ASSET_INSTANCE_TYPE_ID ? ["option.required"] : [];
        assert.deepEqual(issues.map((entry) => entry.code), expectedCodes, `${definition.typeId} defaults validate`);
    }
    assert.equal(objectTypeRegistry.get(BUILTIN_PROP_TYPE_ID).legacy.domain, "features");
    assert.equal(objectTypeRegistry.get("group").legacy, null);
});

test("ED-01 ObjectOptions subclasses must implement getDefaults, getFields, normalize, and validate", () => {
    class Partial extends ObjectOptions {
        getDefaults() {
            return {};
        }
    }
    assert.throws(() => new Partial(), /Partial must implement ObjectOptions.getFields\(\)/);
    assert.throws(() => new ObjectOptions(), /must implement/);
    assert.ok(new MarkerOptions() instanceof ObjectOptions);
});

test("ED-01 field descriptors carry path, label, control, units, constraints, and grouping", () => {
    const descriptor = field({ path: ["takram", "timeOfDay"], label: "Time", control: "number", units: "h", min: 0, max: 23.99, step: 0.1, group: "Atmosphere", advanced: true });
    assert.deepEqual(descriptor, {
        path: ["takram", "timeOfDay"],
        label: "Time",
        control: "number",
        units: "h",
        min: 0,
        max: 23.99,
        step: 0.1,
        group: "Atmosphere",
        advanced: true,
    });
    assert.equal(Object.isFrozen(descriptor), true);
    assert.throws(() => field({ path: [], label: "x" }), /non-empty string path/);
    assert.throws(() => field({ path: ["x"], label: "x", control: "dial" }), /unknown control/);
    assert.throws(() => field({ path: ["x"], label: "x", control: "enum" }), /requires options/);
    const value = setFieldValue({ takram: { haze: true } }, ["takram", "timeOfDay"], 8);
    assert.equal(getFieldValue(value, ["takram", "timeOfDay"]), 8);
    assert.equal(getFieldValue(value, ["takram", "haze"]), true);
    const issues = validateFieldConstraints([descriptor], { takram: { timeOfDay: 30 } });
    assert.deepEqual(issues.map((entry) => [entry.code, entry.path, entry.severity]), [["option.range", ["takram", "timeOfDay"], "error"]]);
    assert.deepEqual(validateFieldConstraints([descriptor], {}).map((entry) => entry.code), ["option.required"]);
});

test("ED-01 builtin-prop options project assetId from a feature and reject unknown asset ids", () => {
    const type = objectTypeRegistry.get(BUILTIN_PROP_TYPE_ID);
    const projected = type.options.fromLegacy({ id: "f", type: "cone", x: 1, z: 2, dir: 2, rotationY: 0.5, tags: ["cone"] });
    assert.deepEqual(projected, { assetId: "cone", x: 1, z: 2, dir: 2, rotationY: 0.5, tags: ["cone"] });
    assert.deepEqual(type.options.validate(projected), []);
    const invalid = type.options.validate({ assetId: "lamp", x: 0, z: 0, dir: 0, rotationY: 0 });
    assert.deepEqual(invalid.map((entry) => [entry.code, entry.path]), [["option.enum", ["assetId"]]]);
    const created = type.create({ id: "f-1", assetId: "barrel", x: 3, z: 4 });
    assert.deepEqual(created.legacy, { id: "f-1", type: "barrel", x: 3, z: 4, dir: 0, rotationY: 0, tags: ["barrel"] });
    assert.equal(created.name, "Barrel");
    assert.throws(() => type.create({ assetId: "lamp" }), /Unknown prop asset "lamp"/);
    assert.deepEqual(type.compileMetric({ id: "f" }, { legacy: { type: "cone" } }), BUILTIN_PROP_ASSETS.find((asset) => asset.id === "cone").metric);
    assert.deepEqual(type.getTransformBinding({ id: "f" }).read({ x: 5, z: 6, rotationY: 1 }), { position: { x: 5, y: 0, z: 6 }, rotationY: 1 });
});

test("ED-01 skybox and tile options reuse config defaults and report range violations", () => {
    const skybox = objectTypeRegistry.get("skybox");
    const defaults = skybox.options.getDefaults();
    assert.equal(defaults.mode, "takram");
    assert.deepEqual(skybox.options.validate(skybox.options.fromLegacy(null, { sky: { takram: { timeOfDay: 99 } } })), []);
    assert.deepEqual(
        skybox.options.validate({ ...defaults, takram: { ...defaults.takram, timeOfDay: 99 } }).map((entry) => entry.code),
        ["option.range"],
    );
    const tile = objectTypeRegistry.get("tile");
    const bad = tile.options.validate({ ...tile.options.getDefaults(), bounds: { north: 1, south: 2, east: 3, west: 1 } });
    assert.deepEqual(bad.map((entry) => entry.code), ["option.range"]);
    assert.deepEqual(tile.options.validate(tile.options.normalize({ bounds: { north: 2, south: 1, east: 3, west: 1 } })), []);
});

test("ED-01 asset-instance is contract only until the asset catalog lands", () => {
    const type = objectTypeRegistry.get(ASSET_INSTANCE_TYPE_ID);
    assert.throws(() => type.create({}), (error) => error.code === OBJECT_TYPE_ERROR_CODES.NOT_IMPLEMENTED);
    assert.deepEqual(type.options.validate(type.options.normalize({ assetId: "" })).map((entry) => entry.code), ["option.required"]);
    assert.deepEqual(type.options.validate(type.options.normalize({ assetId: "crate", revision: 2 })), []);
});

test("ED-01 a test-only object type registers and validates without touching persistence or MCP", () => {
    const registry = createBuiltinObjectTypeRegistry();
    registry.register(markerType());
    const document = {
        environmentId: "yard",
        roads: { nodes: [], edges: [] },
        buildings: [],
        features: [],
        earth: null,
        objectGraphVersion: 1,
        objects: [
            { id: "skybox", typeId: "skybox", typeVersion: 1, name: "Skybox", parentId: null, order: 0, components: {} },
            { id: "m1", typeId: "test.marker", typeVersion: 1, name: "Marker", parentId: null, order: 1, components: { marker: { label: "start", radius: 2 } } },
        ],
    };
    const local = validateObjectGraph(document, registry, { sky: {} });
    assert.deepEqual(local, { ok: true, issues: [] });
    assert.deepEqual(registry.get("test.marker").compileMetric(document.objects[1]), { shape: "sphere", radius: 2 });

    const broken = validateObjectGraph({
        ...document,
        objects: [document.objects[0], { ...document.objects[1], components: { marker: { label: "x", radius: 50 } } }],
    }, registry, { sky: {} });
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.issues.map((entry) => [entry.code, entry.optionCode, entry.path]), [
        ["object.options.invalid", "option.range", ["objects", 1, "options", "radius"]],
    ]);

    // The built-in registry does not know the type: preserved, flagged, never substituted.
    const shared = validateObjectGraph(document, objectTypeRegistry, { sky: {} });
    assert.equal(shared.ok, true);
    assert.deepEqual(shared.issues.map((entry) => [entry.code, entry.severity, entry.objectId]), [["object.type.unsupported", "warning", "m1"]]);

    const written = serializeEnvironmentManifest({ environmentId: "yard", schemaVersion: 3, document }, {
        environmentId: "yard",
        revision: 1,
        schemaVersion: 4,
    });
    assert.equal(written.schemaVersion, 4);
    assert.deepEqual(written.document.objects.find((entry) => entry.id === "m1"), {
        ...document.objects[1],
        components: { tags: [], locked: false, editorHidden: false, marker: { label: "start", radius: 2 } },
    });
});

test("ED-01 placement catalog, feature geometry, radii, and semantic labels derive from one table", () => {
    assert.deepEqual(PLACEMENT_CATALOG.map((asset) => ({ ...asset })), PINNED_PLACEMENT_CATALOG);
    assert.equal(Object.isFrozen(PLACEMENT_CATALOG), true);
    assert.deepEqual(structuredClone(FEATURE_GEOMETRY_BY_TYPE), PINNED_FEATURE_GEOMETRY);
    assert.deepEqual({ ...FEATURE_RADIUS_BY_TYPE }, PINNED_FEATURE_RADIUS);
    assert.equal(DEFAULT_FEATURE_RADIUS, 0.6);
    assert.deepEqual({ ...FEATURE_SEMANTIC_LABEL_BY_TYPE }, { "stop-sign": "sign", "one-way-sign": "sign", barrel: null, tire: null, cone: null });
    assert.equal(getMapColorForAsset("cone"), "#f97316");
    assert.equal(getMapColorForAsset("missing"), DEFAULT_MAP_COLOR);
    assert.equal(DEFAULT_MAP_COLOR, "#a1a1aa");
    class StopSign {}
    class Unknown {
        constructor() {
            this.tags = ["sign"];
        }
    }
    assert.equal(fusionObjectToCatalogType(new StopSign()), "stop-sign");
    assert.equal(fusionObjectToCatalogType(new Unknown()), "stop-sign");
    assert.equal(fusionObjectToCatalogType({ tags: ["barrel"] }), "barrel");
    assert.equal(fusionObjectToCatalogType({}), null);
});

async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
        if (entry.isDirectory()) files.push(...await walk(url));
        else if (entry.name.endsWith(".js")) files.push(url);
    }
    return files;
}

test("ED-01 authoring core import graph is kernel-safe and acyclic with the kernel", async () => {
    const files = await walk(objectsDir);
    assert.ok(files.length >= 12);
    for (const url of files) {
        const source = await readFile(url, "utf8");
        assert.doesNotMatch(source, /from ["'](?:three|react|next|node:)/, url.pathname);
        assert.doesNotMatch(source, /\b(?:window|navigator|requestAnimationFrame|WebGL)\b/, url.pathname);
        assert.doesNotMatch(source, /\bdocument\.(?:getElementById|createElement|body|querySelector)\b/, url.pathname);
        assert.doesNotMatch(source, /WorldDescription\.js|EnvironmentDocument\.js|documentGeometry\.js|documentMutations\.js|\/city\/|\/earth\//, url.pathname);
    }
    const script = `
for (const key of ["window", "document", "navigator", "requestAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error(key + " accessed"); } });
}
await import(${JSON.stringify(new URL("index.js", objectsDir).href)});
`;
    const result = spawnSync(process.execPath, ["--experimental-default-type=module", "--input-type=module", "-e", script], {
        cwd: fileURLToPath(root),
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    // Kernel consumers depend on the frozen leaf table, never the registry.
    for (const relative of ["app/simulation/world/WorldDescription.js", "app/simulation/lidar/LidarGeometry.js", "app/3d/editor/document/documentGeometry.js"]) {
        const source = await readFile(new URL(relative, root), "utf8");
        const imports = [...source.matchAll(/from ["']([^"']*\/objects\/[^"']*)["']/g)].map((match) => path.basename(match[1]));
        assert.deepEqual(imports, ["builtinProp.js"], relative);
    }
});
