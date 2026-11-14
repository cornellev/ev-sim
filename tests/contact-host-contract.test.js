import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PLANT_ABI_VERSION, PLANT_CONTACT_BICYCLE_MODEL, PLANT_STATE_LENGTH } from "../app/plugin/PlantModule.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { computeEpisodeHash, defaultEpisodeIdentity, simulationSemanticProjection, simulationSha256 } from "../app/simulation/kernel/SimulationHashes.js";
import { assertResolvedContactHosts, CONTACT_HOST_VERSION } from "../app/simulation/vehicles/ContactHostContract.js";
import { createVehiclePlantDefinition } from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { isContactBicycle } from "../app/simulation/vehicles/contactBicycle.js";
import { CONTACT_BICYCLE_MODEL, DEFAULT_DYNAMIC_BICYCLE, normalizeVehicleDynamics, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { verifyRunBundle, verifyRunBundleBytes, verifyRunBundleIntegrity } from "../server/headless/RunBundle.js";
import { StorageService } from "../server/storage/StorageService.js";
import { contactHostBundle } from "./helpers/contactHostBundle.js";
import { rehashRunBundle } from "./helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const baseline = JSON.parse(await fs.readFile(new URL("fixtures/headless/contact-host-identity.v1.json", import.meta.url)));
const recordFor = (bundle, nested = false) => (nested ? bundle.resolved.scenario.vehicles : bundle.resolved.vehicles)[0];
const needsResolution = (error) => error.code === "UNSUPPORTED_CAPABILITY" && /re-resolve this run/.test(error.message);

function upgrade(bundle, nested = false) {
    const next = structuredClone(bundle);
    const record = recordFor(next, nested);
    if (record.manifest.dynamics?.plant) record.contactHost = CONTACT_HOST_VERSION;
    else {
        record.manifest.dynamics = normalizeVehicleDynamics(record.manifest.dynamics);
        record.hash = computeResolvedRunHash({ manifest: record.manifest, assetHashes: record.assetHashes });
        const envelope = nested ? next.resolved.scenario : next.resolved;
        envelope.dependencyHashes.vehicles[record.vehicleId] = record.hash;
    }
    return rehashRunBundle(next);
}

async function historicalStorage(t, bundle) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-contact-host-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const service = new StorageService(directory);
    for (const resource of bundle.resolved.pluginPackages ?? []) await service.plugins.putPackage(resource);
    const record = recordFor(bundle);
    const vehiclePath = path.join(directory, "vehicles", `${record.vehicleId}.json`);
    await fs.mkdir(path.dirname(vehiclePath), { recursive: true });
    await fs.writeFile(vehiclePath, `${JSON.stringify(record.manifest)}\n`);
    return { service, vehiclePath };
}

test("RZ-01 preserves all eight historical bundle and episode identities for integrity inspection", async () => {
    for (const expected of baseline.cases) {
        const bundle = await contactHostBundle(expected.options);
        const received = structuredClone(bundle);
        verifyRunBundleIntegrity(bundle);
        assert.equal(bundle.resolvedHash, expected.resolvedHash, expected.id);
        assert.equal(bundle.simulationSemanticHash, expected.simulationSemanticHash, expected.id);
        assert.equal(computeEpisodeHash(defaultEpisodeIdentity(bundle.resolved)), expected.episodeHash, expected.id);
        assert.equal(recordFor(bundle, expected.options.nested).hash, expected.vehicleHash, expected.id);
        assert.throws(() => verifyRunBundle(bundle), /reviewed native migration/);
        assert.deepEqual(bundle, received);
    }
});

test("RZ-01 authoring migration preserves physical parameters and is idempotent", () => {
    assert.equal(CONTACT_BICYCLE_MODEL, "contact-bicycle-v2");
    assert.equal(PLANT_CONTACT_BICYCLE_MODEL, "contact-bicycle-v1");
    assert.equal(PLANT_ABI_VERSION, 1);
    assert.equal(PLANT_STATE_LENGTH, 13);
    for (const version of [1, 2, 3]) {
        const migrated = normalizeVehicleManifest({
            id: "legacy-contact", version,
            dynamics: { model: "contact-bicycle-v1", mass: 750, frictionMu: 0.7, rollingResistance: 0 },
        });
        assert.deepEqual(migrated.dynamics, {
            model: CONTACT_BICYCLE_MODEL, ...DEFAULT_DYNAMIC_BICYCLE,
            mass: 750, frictionMu: 0.7, rollingResistance: 0,
        });
        assert.deepEqual(normalizeVehicleManifest(migrated), migrated);
        assert.equal(simulationSha256(normalizeVehicleManifest(migrated)), simulationSha256(migrated));
    }
    for (const model of ["contact-bicycle-v1", CONTACT_BICYCLE_MODEL]) {
        assert.throws(() => normalizeVehicleDynamics({ model, plant: "test.plant-fixture.bicycle" }), /cannot be combined/);
        assert.throws(() => normalizeVehicleDynamics({ model, mass: 0 }), /dynamics.mass/);
    }
    assert.throws(() => normalizeVehicleDynamics({ model: "contact-bicycle-v3" }), /not a known motion model/);
    assert.equal(normalizeVehicleManifest({ id: "legacy-contact" }).dynamics, undefined);
});

test("RZ-01 distinguishes the contact vehicle identity and the plugin force ABI at dispatch", async () => {
    const old = await contactHostBundle({ model: "contact-bicycle-v1" });
    const builtIn = createVehiclePlantDefinition({}, { manifest: recordFor(old).manifest });
    assert.equal(builtIn.dynamics.model, CONTACT_BICYCLE_MODEL);
    assert.equal(isContactBicycle(builtIn), true);
    const plugin = await contactHostBundle({ plugin: true, model: PLANT_CONTACT_BICYCLE_MODEL });
    const definition = createVehiclePlantDefinition({}, { manifest: recordFor(plugin).manifest }, {
        plantModel: PLANT_CONTACT_BICYCLE_MODEL,
    });
    assert.ok(definition.contactWheels.length > 0);
    const plant = { motionModel: "plugin", definition };
    assert.equal(isContactBicycle(plant), true);
    assert.equal(isContactBicycle({ plant }), true);
});

test("RZ-01 versions contact identities and both semantic dependency maps without changing plugin content", async () => {
    for (const nested of [false, true]) {
        for (const plugin of [false, true]) {
            const old = await contactHostBundle({ model: "contact-bicycle-v1", nested, plugin });
            const next = upgrade(old, nested);
            verifyRunBundleIntegrity(next);
            assert.notEqual(next.resolvedHash, old.resolvedHash);
            assert.notEqual(next.simulationSemanticHash, old.simulationSemanticHash);
            assert.notEqual(computeEpisodeHash(defaultEpisodeIdentity(next.resolved)), computeEpisodeHash(defaultEpisodeIdentity(old.resolved)));
            assert.equal(next.resolved.world.hash, old.resolved.world.hash);
            assert.deepEqual(next.resolved.backendSelections, old.resolved.backendSelections);
            if (plugin) {
                assert.deepEqual(next.resolved.pluginPackages, old.resolved.pluginPackages);
                assert.deepEqual(recordFor(next, nested).manifest, recordFor(old, nested).manifest);
                assert.equal(recordFor(next, nested).hash, recordFor(old, nested).hash);
                const projection = simulationSemanticProjection(next.resolved).resolved;
                const envelope = nested ? projection.scenario : projection;
                const projected = envelope.vehicles[0];
                assert.equal(projected.contactHost, CONTACT_HOST_VERSION);
                assert.equal(projected.hash, simulationSha256({ manifest: projected.manifest, assetHashes: {}, contactHost: CONTACT_HOST_VERSION }));
                assert.equal(envelope.dependencyHashes.vehicles[projected.vehicleId], projected.hash);
            }
        }
    }
});

test("RZ-01 rejects unsupported or misplaced host markers in root and nested records", async () => {
    for (const nested of [false, true]) {
        const old = await contactHostBundle({ plugin: true, model: PLANT_CONTACT_BICYCLE_MODEL, nested });
        for (const value of [undefined, 1, 2, "3", 4, null]) {
            const changed = structuredClone(old);
            if (value !== undefined) recordFor(changed, nested).contactHost = value;
            const bundle = rehashRunBundle(changed);
            verifyRunBundleIntegrity(bundle);
            const plants = new Map(bundle.resolved.pluginPackages.flatMap((resource) => verifyPluginPackage(resource).document.plants.map((plant) => [plant.id, plant])));
            assert.throws(() => assertResolvedContactHosts(bundle.resolved, plants), (error) => (
                needsResolution(error) && error.details.path === `${nested ? "scenario." : ""}vehicles.0`
            ));
        }
    }
    for (const options of [{}, { model: "dynamic-bicycle-v1" }, { plugin: true }, { plugin: true, model: "dynamic-bicycle-v1" }, { model: CONTACT_BICYCLE_MODEL }]) {
        const bundle = await contactHostBundle(options);
        recordFor(bundle).contactHost = 2;
        const plants = new Map((bundle.resolved.pluginPackages ?? []).flatMap((resource) => verifyPluginPackage(resource).document.plants.map((plant) => [plant.id, plant])));
        assert.throws(() => assertResolvedContactHosts(rehashRunBundle(bundle).resolved, plants), needsResolution);
    }
});

test("RZ-01 host marker and portable package tampering retain integrity failures", async () => {
    const bundle = upgrade(await contactHostBundle({ plugin: true, model: PLANT_CONTACT_BICYCLE_MODEL }));
    recordFor(bundle).contactHost = 1;
    assert.throws(() => verifyRunBundleIntegrity(bundle), { code: "BUNDLE_HASH_MISMATCH" });
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    assert.throws(() => verifyRunBundleBytes(bytes, { expectedBundleBytesHash: "0".repeat(64) }), { code: "BUNDLE_HASH_MISMATCH" });
    bundle.resolved.pluginPackages[0].packageHash = "0".repeat(64);
    assert.throws(() => verifyRunBundleIntegrity(rehashRunBundle(bundle)), { code: "BUNDLE_HASH_MISMATCH" });
});

test("RZ-01 kernel admission disposes rejected candidates and preserves the active run", async () => {
    for (const nested of [false, true]) {
        for (const plugin of [false, true]) {
            const bundle = await contactHostBundle({ model: "contact-bicycle-v1", plugin, nested });
            const plants = new Map((bundle.resolved.pluginPackages ?? []).flatMap((resource) => (
                verifyPluginPackage(resource).document.plants.map((plant) => [plant.id, plant])
            )));
            let disposed = 0;
            let activated = 0;
            const kernel = new SimulationKernel({ telemetry: null, plugins: {
                prepare: async () => ({ plants, dispose() { disposed += 1; } }),
                activate() { activated += 1; },
            } });
            const active = { marker: "active" };
            kernel.resolvedRun = active;
            await assert.rejects(kernel.prepare(bundle.resolved), needsResolution);
            assert.equal(kernel.resolvedRun, active);
            assert.equal(disposed, 1);
            assert.equal(activated, 0);
        }
    }
});

test("RZ-01 authoring import and re-resolution upgrade unsaved historical vehicles without rewriting them", async (t) => {
    for (const plugin of [false, true]) {
        const bundle = await contactHostBundle({ model: "contact-bicycle-v1", plugin });
        const original = structuredClone(bundle);
        const { service, vehiclePath } = await historicalStorage(t, bundle);
        const savedBytes = await fs.readFile(vehiclePath);
        const imported = await service.importRunBundle(bundle);
        const resolved = await service.resolveRunManifest(imported.id);
        const record = resolved.vehicles[0];
        if (plugin) {
            assert.equal(record.contactHost, CONTACT_HOST_VERSION);
            assert.deepEqual(record.manifest.pluginLocks, recordFor(bundle).manifest.pluginLocks);
        } else {
            assert.equal(record.manifest.dynamics.model, CONTACT_BICYCLE_MODEL);
            assert.equal(Object.hasOwn(record, "contactHost"), false);
        }
        const exported = await service.exportRunManifest(imported.id);
        verifyRunBundleIntegrity(exported);
        assert.equal((await service.resolveRunManifest(imported.id)).resolvedHash, resolved.resolvedHash);
        assert.deepEqual(await fs.readFile(vehiclePath), savedBytes);
        assert.deepEqual(bundle, original);
    }
});

test("RZ-01 resolution preserves non-contact manifests and vehicle hashes without adding a marker", async (t) => {
    for (const options of [{}, { model: "dynamic-bicycle-v1" }, { plugin: true }, { plugin: true, model: "dynamic-bicycle-v1" }]) {
        const bundle = await contactHostBundle(options);
        const old = recordFor(bundle);
        const { service } = await historicalStorage(t, bundle);
        const record = await service._resolveVehicleDependency(old.actorId, old.vehicleId);
        assert.deepEqual(record.manifest, old.manifest);
        assert.equal(Object.hasOwn(record, "contactHost"), false);
        assert.equal(record.hash, computeResolvedRunHash({ manifest: old.manifest, assetHashes: record.assetHashes }));
    }
});

test("RZ-01 scenario resolution stamps nested contact plugins and keeps kinematic ego unmarked", async (t) => {
    const bundle = await contactHostBundle({ model: PLANT_CONTACT_BICYCLE_MODEL, plugin: true });
    const { service } = await historicalStorage(t, bundle);
    const imported = await service.importRunBundle(bundle);
    const scenario = createDefaultScenario({
        ...bundle.resolved.scenario.scenario,
        actors: [{ id: "ego", role: "ego" }, { id: "other", vehicleId: recordFor(bundle).vehicleId }],
        routes: [
            bundle.resolved.scenario.scenario.routes[0],
            { ...bundle.resolved.scenario.scenario.routes[0], id: "other-route", actorId: "other" },
        ],
        completion: { conditions: [{ id: "timeout", kind: "max-duration", durationNs: 1_000_000_000 }] },
    });
    for (const route of scenario.routes) {
        const verified = await service.verifyScenarioRoute(scenario.id, { scenario, routeId: route.id });
        assert.equal(verified.ok, true);
        route.waypoints = verified.waypoints;
        route.verification = verified.verification;
    }
    await service.createScenario(scenario);
    const source = await service.getRunManifest(imported.id);
    await service._writeRunManifest(imported.id, {
        ...source, scenario: { id: scenario.id, egoVehicleId: "big-car" },
    });
    const exported = await service.exportRunManifest(imported.id);
    verifyRunBundleIntegrity(exported);
    assert.equal(exported.resolved.scenario.vehicles[0].contactHost, CONTACT_HOST_VERSION);
    assert.equal(exported.resolved.vehicles.find((record) => record.actorId === "other").contactHost, CONTACT_HOST_VERSION);
    assert.equal(Object.hasOwn(exported.resolved.vehicles.find((record) => record.actorId === "ego"), "contactHost"), false);
});

test("RZ-01 UI-only contact package edits preserve semantic identity with the host marker", async () => {
    const original = await pluginFixtureResource({ fixture: "test.plant-fixture", mutateDocument(document) {
        document.plants[0].model = PLANT_CONTACT_BICYCLE_MODEL;
        document.entry = { runtime: "runtime/index.js", ui: "ui/index.js" };
    }, mutateFiles(files) {
        files["runtime/index.js"] = new TextEncoder().encode("export function registerRuntime() {}\n");
        files["ui/index.js"] = new TextEncoder().encode("export function registerUi() {}\n");
    } });
    const uiOnly = await pluginFixtureResource({ fixture: "test.plant-fixture", mutateDocument(document) {
        document.plants[0].model = PLANT_CONTACT_BICYCLE_MODEL;
        document.entry = { runtime: "runtime/index.js", ui: "ui/index.js" };
    }, mutateFiles(files) {
        files["runtime/index.js"] = new TextEncoder().encode("export function registerRuntime() {}\n");
        files["ui/index.js"] = new TextEncoder().encode("export function registerUi() {}\n// UI-only edit.\n");
    } });
    assert.equal(original.runtimeHash, uiOnly.runtimeHash);
    const first = upgrade(await contactHostBundle({ resource: original }));
    const second = upgrade(await contactHostBundle({ resource: uiOnly }));
    verifyRunBundleIntegrity(first);
    verifyRunBundleIntegrity(second);
    assert.notEqual(first.resolvedHash, second.resolvedHash);
    assert.equal(first.simulationSemanticHash, second.simulationSemanticHash);
});
