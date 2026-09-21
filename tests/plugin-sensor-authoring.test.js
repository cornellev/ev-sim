import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    buildRevisionedSensorCatalog,
    commitPluginSensorAuthoringPatch,
    normalizeVehiclePluginLocks,
    reconcileVehiclePluginLocks,
    stampManifestPluginSelectionForSensor,
    stampVehiclePluginSensorLock,
    assertVehiclePluginLocksMatchRun,
} from "../app/plugin/PluginSensorAuthoring.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { PLUGIN_ERROR_CODES } from "../app/plugin/PluginErrors.js";
import { createSensorDefinitionRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { computeSimulationSemanticHash, simulationSha256 } from "../app/simulation/kernel/SimulationHashes.js";
import {
    createDefaultVehicleManifest,
    normalizeVehicleManifest,
    validateVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";
import { listSensorCatalog } from "../server/plugins/sensorCatalog.js";
import { StorageService } from "../server/storage/StorageService.js";
import {
    createPluginPortableHeadlessBundle,
    createPluginRangeImageFixtureSensor,
    pluginSensorFixtureResource,
} from "./helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const FIXTURE_TYPE = "test.range-image-fixture.synthetic-3x4";

async function temporaryService() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-sensor-authoring-"));
    return { dir, service: new StorageService(dir) };
}

function catalogEntry(resource, document) {
    const verified = verifyPluginPackage(resource);
    return buildRevisionedSensorCatalog({
        library: {
            revision: 1,
            packages: [{
                pluginId: document.id,
                version: document.version,
                packageHash: verified.resource.packageHash,
                runtimeHash: verified.resource.runtimeHash,
                ...(verified.resource.uiHash ? { uiHash: verified.resource.uiHash } : {}),
            }],
        },
        documents: [{ document: verified.document, resource: verified.resource }],
    }).sensors.find((entry) => entry.type === FIXTURE_TYPE);
}

test("sensor catalog is revisioned, ordered, and built without executing modules", async () => {
    const { dir, service } = await temporaryService();
    try {
        const resource = await pluginSensorFixtureResource();
        await service.plugins.putPackage(resource);
        await service.plugins.installFromHash(resource.packageHash);
        const catalog = await listSensorCatalog(service);
        assert.equal(catalog.ok, true);
        assert.equal(catalog.revision, 1);
        const pluginRows = catalog.sensors.filter((entry) => entry.ownership !== "builtin");
        assert.equal(pluginRows.length, 1);
        assert.equal(pluginRows[0].type, FIXTURE_TYPE);
        assert.equal(pluginRows[0].ownership.packageHash, resource.packageHash);
        assert.equal(pluginRows[0].ui.fallback, "generic");
        const types = catalog.sensors.map((entry) => entry.type);
        const pluginIndex = types.indexOf(FIXTURE_TYPE);
        const lastBuiltin = types.findLastIndex((_, index) => catalog.sensors[index].ownership === "builtin");
        assert.ok(pluginIndex > lastBuiltin);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("vehicle plugin locks normalize, conflict, reconcile, and omit legacy empties", async () => {
    const resource = await pluginSensorFixtureResource();
    const verified = verifyPluginPackage(resource);
    const entry = catalogEntry(resource, verified.document);
    const registry = createSensorDefinitionRegistry([verified]);
    assert.equal(normalizeVehiclePluginLocks(undefined), undefined);
    assert.equal(normalizeVehicleManifest(createDefaultVehicleManifest({ id: "no-locks" })).pluginLocks, undefined);

    const stamped = stampVehiclePluginSensorLock(undefined, entry);
    assert.equal(stamped.length, 1);
    assert.equal(stamped[0].pluginId, "test.range-image-fixture");
    assert.deepEqual(stamped[0].sensorTypes, [FIXTURE_TYPE]);

    const other = {
        ...entry,
        ownership: { ...entry.ownership, packageHash: "a".repeat(64), runtimeHash: "b".repeat(64) },
    };
    assert.throws(() => stampVehiclePluginSensorLock(stamped, other), (error) => (
        error.code === PLUGIN_ERROR_CODES.REGISTRATION
    ));

    const sensor = registry.get(FIXTURE_TYPE).vehicle.normalize({});
    const vehicle = normalizeVehicleManifest({
        id: "locked-truck",
        sensors: [{ id: "custom", type: FIXTURE_TYPE, pose: {}, config: sensor }],
        pluginLocks: stamped,
    }, { sensorRegistry: registry });
    assert.equal(vehicle.pluginLocks.length, 1);
    assert.deepEqual(vehicle.sensors[0].config.products, { points: false, packets: false });

    const reconciled = reconcileVehiclePluginLocks(vehicle.pluginLocks, [], { sensorRegistry: registry });
    assert.equal(reconciled, undefined);
});

test("authoring patches reject undeclared paths and invalid layouts", async () => {
    const resource = await pluginSensorFixtureResource();
    const verified = verifyPluginPackage(resource);
    const registry = createSensorDefinitionRegistry([verified]);
    const definition = registry.get(FIXTURE_TYPE);
    const sensor = definition.run.normalize({
        calibration: { products: { points: true }, parameters: { measurementScale: 1, statusEvery: 2 } },
    });
    const patched = commitPluginSensorAuthoringPatch({
        id: "fixture",
        type: FIXTURE_TYPE,
        calibration: sensor.calibration,
        outputs: {},
    }, definition, { path: "calibration.parameters.measurementScale", value: 1.5 });
    assert.equal(patched.calibration.parameters.measurementScale, 1.5);
    const withoutRegistry = commitPluginSensorAuthoringPatch({
        id: "fixture",
        type: FIXTURE_TYPE,
        calibration: sensor.calibration,
        outputs: {},
    }, definition, { path: "calibration.parameters.measurementScale", value: 1.25 });
    assert.equal(withoutRegistry.calibration.parameters.measurementScale, 1.25);
    assert.throws(() => commitPluginSensorAuthoringPatch({
        id: "fixture",
        type: FIXTURE_TYPE,
        calibration: sensor.calibration,
        outputs: {},
    }, definition, { path: "calibration.parameters.notASetting", value: 1 }, { sensorRegistry: registry }));
    assert.throws(() => commitPluginSensorAuthoringPatch({
        id: "fixture",
        type: FIXTURE_TYPE,
        calibration: sensor.calibration,
        outputs: {},
    }, definition, { path: "id", value: "hijack" }, { sensorRegistry: registry }));
});

test("vehicle save, duplicate, export, and import embed exact packages and survive library removal", async () => {
    const { dir, service } = await temporaryService();
    try {
        const resource = await pluginSensorFixtureResource();
        const verified = verifyPluginPackage(resource);
        await service.plugins.putPackage(resource);
        await service.plugins.installFromHash(resource.packageHash);
        const registry = createSensorDefinitionRegistry([verified]);
        const entry = catalogEntry(resource, verified.document);
        const created = await service.createVehicleManifest(normalizeVehicleManifest({
            id: "plugin-truck",
            name: "Plugin Truck",
            sensors: [{
                id: "custom",
                type: FIXTURE_TYPE,
                pose: { position: { x: 0, y: 0.8, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
                config: { rateHz: 10, products: { points: true } },
            }],
            pluginLocks: stampVehiclePluginSensorLock(undefined, entry),
        }, { sensorRegistry: registry }));
        assert.equal(created.pluginLocks[0].packageHash, resource.packageHash);

        await service.plugins.removeFromLibrary("test.range-image-fixture", resource.packageHash);
        const stillReadable = await service.getVehicleManifest("plugin-truck");
        assert.equal(stillReadable.pluginLocks[0].packageHash, resource.packageHash);
        const validated = await service.validateVehicleManifest("plugin-truck");
        assert.equal(validated.ok, true);

        const duplicate = await service.duplicateVehicleManifest("plugin-truck", { id: "plugin-truck-copy" });
        assert.equal(duplicate.pluginLocks[0].runtimeHash, resource.runtimeHash);

        const bundle = await service.exportVehicleBundle("plugin-truck");
        assert.equal(bundle.pluginPackages.length, 1);
        assert.equal(bundle.pluginPackages[0].packageHash, resource.packageHash);

        const other = await temporaryService();
        try {
            const imported = await other.service.importVehicleBundle(bundle);
            assert.equal(imported.id, "plugin-truck");
            const library = await other.service.listPluginLibrary();
            assert.equal(library.packages.length, 0);
            const packed = await other.service.getPluginPackage(resource.packageHash);
            assert.equal(packed.packageHash, resource.packageHash);
        } finally {
            await fs.rm(other.dir, { recursive: true, force: true });
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("missing package, wrong runtime hash, undeclared type, and missing grants fail closed", async () => {
    const { dir, service } = await temporaryService();
    try {
        const resource = await pluginSensorFixtureResource();
        const verified = verifyPluginPackage(resource);
        const registry = createSensorDefinitionRegistry([verified]);
        const entry = catalogEntry(resource, verified.document);
        await assert.rejects(service.createVehicleManifest(normalizeVehicleManifest({
            id: "missing-pkg",
            sensors: [{ id: "custom", type: FIXTURE_TYPE, pose: {}, config: {} }],
            pluginLocks: stampVehiclePluginSensorLock(undefined, entry),
        }, { sensorRegistry: registry })), /not available|does not exist|ENOENT|package/i);

        await service.plugins.putPackage(resource);
        await service.plugins.installFromHash(resource.packageHash);
        const ok = await service.createVehicleManifest(normalizeVehicleManifest({
            id: "ok-truck",
            sensors: [{ id: "custom", type: FIXTURE_TYPE, pose: {}, config: {} }],
            pluginLocks: stampVehiclePluginSensorLock(undefined, entry),
        }, { sensorRegistry: registry }));
        ok.pluginLocks[0] = { ...ok.pluginLocks[0], runtimeHash: "c".repeat(64) };
        const wrongHash = await service.validateVehicleManifest("ok-truck", ok);
        assert.equal(wrongHash.ok, false);

        const undeclared = validateVehicleManifest(normalizeVehicleManifest({
            id: "undeclared",
            sensors: [{ id: "custom", type: FIXTURE_TYPE, pose: {}, config: {} }],
            pluginLocks: [{
                pluginId: entry.ownership.pluginId,
                version: entry.ownership.version,
                packageHash: entry.ownership.packageHash,
                runtimeHash: entry.ownership.runtimeHash,
                sensorTypes: ["not.a.sensor"],
            }],
        }, { allowUnknownSensors: true }));
        assert.equal(undeclared.ok, false);

        const stored = await service.getVehicleManifest("ok-truck");
        assert.throws(() => assertVehiclePluginLocksMatchRun({
            vehicles: [{ vehicleId: stored.id, manifest: stored }],
            plugins: [{
                pluginId: entry.ownership.pluginId,
                version: entry.ownership.version,
                packageHash: entry.ownership.packageHash,
                runtimeHash: entry.ownership.runtimeHash,
                capabilities: [],
            }],
            pluginPackages: [resource],
        }), /missing grant|range-image/i);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("UI-only package edits change full identity but preserve simulation identity", async () => {
    const original = await pluginSensorFixtureResource();
    const uiOnly = await pluginFixtureResource({
        fixture: "test.range-image-fixture",
        mutateFiles(files) {
            const current = new TextDecoder().decode(files["ui/index.js"]);
            files["ui/index.js"] = new TextEncoder().encode(`${current}\n`);
        },
    });
    assert.equal(original.runtimeHash, uiOnly.runtimeHash);
    assert.notEqual(original.packageHash, uiOnly.packageHash);
    const first = await createPluginPortableHeadlessBundle(original, {
        sensors: [createPluginRangeImageFixtureSensor()],
    });
    const second = await createPluginPortableHeadlessBundle(uiOnly, {
        sensors: [createPluginRangeImageFixtureSensor()],
    });
    assert.notEqual(first.resolvedHash, second.resolvedHash);
    assert.equal(first.simulationSemanticHash, second.simulationSemanticHash);
    assert.equal(computeSimulationSemanticHash(first.resolved), computeSimulationSemanticHash(second.resolved));
});

test("runtime and config edits change semantic identity; legacy vehicles stay byte-identical", async () => {
    const original = await pluginSensorFixtureResource();
    const runtimeEdit = await pluginFixtureResource({
        fixture: "test.range-image-fixture",
        mutateFiles(files) {
            const current = new TextDecoder().decode(files["runtime/index.js"]);
            files["runtime/index.js"] = new TextEncoder().encode(`${current}\n`);
        },
    });
    const first = await createPluginPortableHeadlessBundle(original, {
        sensors: [createPluginRangeImageFixtureSensor()],
    });
    const second = await createPluginPortableHeadlessBundle(runtimeEdit, {
        sensors: [createPluginRangeImageFixtureSensor()],
    });
    assert.notEqual(first.simulationSemanticHash, second.simulationSemanticHash);

    const scaled = createPluginRangeImageFixtureSensor({
        calibration: {
            parameters: { measurementScale: 1.5, statusEvery: 2 },
            products: { points: true, packets: true },
        },
    });
    const configEdit = await createPluginPortableHeadlessBundle(original, { sensors: [scaled] });
    assert.notEqual(first.simulationSemanticHash, configEdit.simulationSemanticHash);

    const unlocked = createDefaultVehicleManifest({ id: "stock" });
    const again = normalizeVehicleManifest(unlocked);
    assert.equal(again.pluginLocks, undefined);
    assert.equal(
        simulationSha256({ manifest: unlocked, assetHashes: {} }),
        simulationSha256({ manifest: again, assetHashes: {} }),
    );
});

test("stamping a run plugin selection adds required range-image grants", async () => {
    const resource = await pluginSensorFixtureResource();
    const verified = verifyPluginPackage(resource);
    const entry = catalogEntry(resource, verified.document);
    const selection = stampManifestPluginSelectionForSensor(undefined, entry);
    assert.equal(selection.enabled, true);
    assert.equal(selection.artifacts[0].expectedHash, resource.packageHash);
    assert.ok(selection.artifacts[0].capabilities.includes("sensors.sample.range-image"));
});
