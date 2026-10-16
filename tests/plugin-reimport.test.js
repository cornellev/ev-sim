import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { planPluginRetarget } from "../app/plugin/PluginRetarget.js";
import { stampVehiclePluginSensorLock } from "../app/plugin/PluginSensorAuthoring.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { createScriptDocument } from "../app/scripting/EditorDocument.js";
import { VISUAL_SCRIPT_KIND, VISUAL_SCRIPT_VERSION } from "../app/scripting/runtime/Artifact.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createSensorDefinitionRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { reimportDetectedPlugin } from "../server/plugins/reimportLocalPlugin.js";
import { StorageService } from "../server/storage/StorageService.js";
import { pluginFixtureFiles, pluginFixtureResource } from "./helpers/pluginFixtures.js";

const FIXTURE_TYPE = "test.range-image-fixture.synthetic-3x4";
const UNIT_TYPE = "test.range-image-fixture.ScaleBlock";
const DIRECTORY = "test.range-image-fixture";

const SCALE_UNIT = {
    type: UNIT_TYPE,
    ports: {
        inputs: { value: "float64" },
        outputs: { result: "float64" },
    },
    settings: [{ target: "state", key: "factor", valueType: "float64", default: 2 }],
    defaults: { factor: 2 },
    catalog: {
        name: "Scale",
        category: "math",
        keywords: ["scale"],
        placeable: true,
        deprecated: false,
        requiresSignals: false,
    },
};

function marketplaceOwner() {
    return {
        sourceId: "123e4567-e89b-12d3-a456-426614174001",
        itemId: "test.range-image-fixture",
        releaseVersion: "9.9.9",
        artifactSha256: "a".repeat(64),
    };
}

async function temporaryRoots(t) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-reimport-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    return {
        dataDir,
        pluginsRoot: path.join(dataDir, "local-plugins"),
        service: new StorageService(dataDir),
    };
}

async function writeLocalPlugin(pluginsRoot, { version = "1.0.0", units = [SCALE_UNIT], runtimeSuffix = "" } = {}) {
    const files = await pluginFixtureFiles("test.range-image-fixture");
    const document = JSON.parse(new TextDecoder().decode(files["plugin.json"]));
    document.version = version;
    document.units = units;
    files["plugin.json"] = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
    if (runtimeSuffix) {
        const source = new TextDecoder().decode(files["runtime/index.js"]);
        files["runtime/index.js"] = new TextEncoder().encode(`${source}${runtimeSuffix}`);
    }
    const directory = path.join(pluginsRoot, DIRECTORY);
    await fs.rm(directory, { recursive: true, force: true });
    for (const [relative, bytes] of Object.entries(files)) {
        const target = path.join(directory, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
    }
}

function requirement(metadata) {
    return {
        pluginId: metadata.pluginId,
        version: metadata.version,
        packageHash: metadata.packageHash,
        runtimeHash: metadata.runtimeHash,
        types: [UNIT_TYPE],
    };
}

function compiledProgram(metadata, nested = false) {
    const record = {
        pluginId: metadata.pluginId,
        version: metadata.version,
        runtimeHash: metadata.runtimeHash,
        types: [UNIT_TYPE],
    };
    return {
        kind: VISUAL_SCRIPT_KIND,
        version: VISUAL_SCRIPT_VERSION,
        name: nested ? "nested" : "Scale Script",
        pluginRequirements: [record],
        nodes: nested ? [] : [{
            uuid: "unit-1",
            type: UNIT_TYPE,
            state: { compiledProgram: compiledProgram(metadata, true) },
        }],
    };
}

async function saveAuthoring(service, metadata) {
    const resource = await service.getPluginPackage(metadata.packageHash);
    const verified = verifyPluginPackage(resource);
    const registry = createSensorDefinitionRegistry([verified]);
    const sensor = registry.get(FIXTURE_TYPE).vehicle.normalize({});
    const vehicle = await service.createVehicleManifest(normalizeVehicleManifest({
        id: "plugin-truck",
        name: "Plugin Truck",
        sensors: [{ id: "custom", type: FIXTURE_TYPE, pose: {}, config: sensor }],
        pluginLocks: stampVehiclePluginSensorLock(undefined, {
            type: FIXTURE_TYPE,
            ownership: {
                pluginId: metadata.pluginId,
                version: metadata.version,
                packageHash: metadata.packageHash,
                runtimeHash: metadata.runtimeHash,
            },
        }),
    }, { sensorRegistry: registry }));
    const script = await service.putScript(createScriptDocument({
        id: "scale-script",
        name: "Scale Script",
        graph: {
            head: "head-uuid",
            outputNodeConfig: { outputs: [{ id: "output", label: "output", type: "float64" }] },
            nodes: [],
            connections: [],
            pluginLocks: [requirement(metadata)],
        },
        latestValidArtifact: compiledProgram(metadata),
    }));
    const run = await service.createRunManifest(createDefaultRunManifest({
        id: "reimport-run",
        name: "Reimport Run",
        plugins: {
            enabled: true,
            artifacts: [{
                pluginId: metadata.pluginId,
                expectedHash: metadata.packageHash,
                capabilities: ["sensors.sample.range-image"],
            }],
        },
    }));
    return { vehicle, script, run };
}

test("planPluginRetarget rewrites pins and rejects a dropped unit without mutating inputs", () => {
    const oldHash = "a".repeat(64);
    const oldRuntime = "b".repeat(64);
    const next = {
        pluginId: "acme.example",
        version: "1.0.1",
        packageHash: "c".repeat(64),
        runtimeHash: "d".repeat(64),
        sensorTypes: ["acme.example.lidar"],
        plants: ["acme.example.plant"],
        unitTypes: ["acme.example.ScaleBlock"],
        capabilities: ["controls.reference"],
    };
    const superseded = [{ packageHash: oldHash, runtimeHash: oldRuntime }];
    const vehicle = {
        id: "truck",
        pluginLocks: [{
            pluginId: "acme.example",
            version: "1.0.0",
            packageHash: oldHash,
            runtimeHash: oldRuntime,
            sensorTypes: ["acme.example.lidar"],
            plants: ["acme.example.plant"],
        }],
    };
    const kept = {
        id: "other-truck",
        pluginLocks: [{
            pluginId: "other.plugin",
            version: "1.0.0",
            packageHash: oldHash,
            runtimeHash: oldRuntime,
            sensorTypes: ["other.plugin.lidar"],
        }],
    };
    const record = {
        pluginId: "acme.example",
        version: "1.0.0",
        runtimeHash: oldRuntime,
        types: ["acme.example.ScaleBlock"],
    };
    const script = {
        id: "scale",
        graph: { pluginLocks: [{ ...record, packageHash: oldHash }] },
        latestValidArtifact: {
            pluginRequirements: [{ ...record }],
            nodes: [{ state: { compiledProgram: { pluginRequirements: [{ ...record }] } } }],
        },
    };
    const run = {
        id: "run",
        plugins: {
            enabled: true,
            artifacts: [{ pluginId: "acme.example", expectedHash: oldHash, capabilities: ["controls.reference"] }],
        },
    };
    const before = structuredClone({ vehicle, kept, script, run });
    const plan = planPluginRetarget({
        vehicles: [vehicle, kept],
        scripts: [script],
        runManifests: [run],
        superseded,
        next,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.vehicles.length, 1);
    assert.equal(plan.vehicles[0].pluginLocks[0].packageHash, next.packageHash);
    assert.equal(plan.vehicles[0].pluginLocks[0].runtimeHash, next.runtimeHash);
    assert.equal(plan.vehicles[0].pluginLocks[0].version, "1.0.1");
    assert.deepEqual(plan.vehicles[0].pluginLocks[0].plants, ["acme.example.plant"]);
    assert.equal(plan.scripts[0].graph.pluginLocks[0].packageHash, next.packageHash);
    assert.equal(plan.scripts[0].latestValidArtifact.pluginRequirements[0].runtimeHash, next.runtimeHash);
    assert.equal(plan.scripts[0].latestValidArtifact.nodes[0].state.compiledProgram.pluginRequirements[0].version, "1.0.1");
    assert.equal(plan.runManifests[0].plugins.artifacts[0].expectedHash, next.packageHash);
    assert.deepEqual(plan.runManifests[0].plugins.artifacts[0].capabilities, ["controls.reference"]);
    assert.deepEqual({ vehicle, kept, script, run }, before);

    const dropped = planPluginRetarget({
        scripts: [{
            ...script,
            graph: { pluginLocks: [{ ...script.graph.pluginLocks[0], types: ["acme.example.Missing"] }] },
        }],
        superseded,
        next,
    });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.scripts.length, 0);
    assert.match(dropped.rejections[0].message, /acme.example.Missing/);
});

test("reimport of unchanged source does not rewrite saved documents", async (t) => {
    const { pluginsRoot, service } = await temporaryRoots(t);
    await writeLocalPlugin(pluginsRoot);
    const installed = await reimportDetectedPlugin(service, DIRECTORY, pluginsRoot);
    assert.equal(installed.unchanged, false);
    const saved = await saveAuthoring(service, installed.package);
    const vehicleRevision = saved.vehicle.revision;

    const again = await reimportDetectedPlugin(service, DIRECTORY, pluginsRoot);
    assert.equal(again.unchanged, true);
    assert.equal(again.package.packageHash, installed.package.packageHash);
    assert.deepEqual(again.updated, { vehicles: [], scripts: [], runManifests: [] });
    assert.equal((await service.getVehicleManifest("plugin-truck")).revision, vehicleRevision);
    assert.equal((await service.getVehicleManifest("plugin-truck")).pluginLocks[0].packageHash, installed.package.packageHash);
    assert.equal((await service.getScript("scale-script")).graph.pluginLocks[0].packageHash, installed.package.packageHash);
    assert.equal((await service.getRunManifest("reimport-run")).plugins.artifacts[0].expectedHash, installed.package.packageHash);
});

test("reimport replaces the manual package and retargets saved pins", async (t) => {
    const { pluginsRoot, service } = await temporaryRoots(t);
    await writeLocalPlugin(pluginsRoot);
    const installed = await reimportDetectedPlugin(service, DIRECTORY, pluginsRoot);
    await saveAuthoring(service, installed.package);
    const marketed = await pluginFixtureResource({
        fixture: "test.range-image-fixture",
        mutateDocument(document) {
            document.version = "9.9.9";
        },
    });
    await service.plugins.addMarketplaceOwner(marketed, marketplaceOwner());
    const marketLock = {
        pluginId: "test.range-image-fixture",
        version: "9.9.9",
        packageHash: marketed.packageHash,
        runtimeHash: marketed.runtimeHash,
        types: [UNIT_TYPE],
    };
    await service.putScript(createScriptDocument({
        id: "market-script",
        name: "Market Script",
        graph: {
            head: "head-uuid",
            outputNodeConfig: { outputs: [{ id: "output", label: "output", type: "float64" }] },
            nodes: [],
            connections: [],
            pluginLocks: [marketLock],
        },
    }));
    await writeLocalPlugin(pluginsRoot, { version: "1.0.1", runtimeSuffix: "\n// reimport\n" });

    const updated = await reimportDetectedPlugin(service, DIRECTORY, pluginsRoot);
    assert.equal(updated.unchanged, false);
    assert.equal(updated.package.version, "1.0.1");
    assert.notEqual(updated.package.packageHash, installed.package.packageHash);
    assert.deepEqual(updated.updated, {
        vehicles: ["plugin-truck"],
        scripts: ["scale-script"],
        runManifests: ["reimport-run"],
    });

    const vehicle = await service.getVehicleManifest("plugin-truck");
    assert.equal(vehicle.pluginLocks[0].version, "1.0.1");
    assert.equal(vehicle.pluginLocks[0].packageHash, updated.package.packageHash);
    assert.equal(vehicle.pluginLocks[0].runtimeHash, updated.package.runtimeHash);
    assert.deepEqual(vehicle.pluginLocks[0].sensorTypes, [FIXTURE_TYPE]);

    const script = await service.getScript("scale-script");
    assert.equal(script.graph.pluginLocks[0].packageHash, updated.package.packageHash);
    assert.equal(script.graph.pluginLocks[0].version, "1.0.1");
    assert.equal(script.latestValidArtifact.pluginRequirements[0].runtimeHash, updated.package.runtimeHash);
    assert.equal(
        script.latestValidArtifact.nodes[0].state.compiledProgram.pluginRequirements[0].runtimeHash,
        updated.package.runtimeHash,
    );
    assert.deepEqual(script.latestValidArtifact.pluginRequirements[0].types, [UNIT_TYPE]);

    const run = await service.getRunManifest("reimport-run");
    assert.equal(run.plugins.artifacts[0].expectedHash, updated.package.packageHash);
    assert.deepEqual(run.plugins.artifacts[0].capabilities, ["sensors.sample.range-image"]);

    const marketScript = await service.getScript("market-script");
    assert.equal(marketScript.graph.pluginLocks[0].packageHash, marketed.packageHash);

    const library = await service.plugins.snapshotWithOwners();
    const rows = library.packages.filter((entry) => entry.pluginId === "test.range-image-fixture");
    assert.deepEqual(rows.map((entry) => entry.packageHash).sort(), [marketed.packageHash, updated.package.packageHash].sort());
    assert.equal(rows.find((entry) => entry.packageHash === updated.package.packageHash).ownership.manual, true);
    const marketRow = rows.find((entry) => entry.packageHash === marketed.packageHash);
    assert.equal(marketRow.ownership.manual, false);
    assert.equal(marketRow.ownership.marketplace.length, 1);
    assert.equal(rows.some((entry) => entry.packageHash === installed.package.packageHash), false);
});

test("reimport aborts when a saved script loses a unit and keeps the previous library row", async (t) => {
    const { pluginsRoot, service } = await temporaryRoots(t);
    await writeLocalPlugin(pluginsRoot);
    const installed = await reimportDetectedPlugin(service, DIRECTORY, pluginsRoot);
    const saved = await saveAuthoring(service, installed.package);
    await writeLocalPlugin(pluginsRoot, { version: "1.0.1", units: [] });

    await assert.rejects(
        () => reimportDetectedPlugin(service, DIRECTORY, pluginsRoot),
        (error) => error.code === "PLUGIN_DOCUMENT_INVALID" && /ScaleBlock/.test(error.message),
    );

    const library = await service.listPluginLibrary();
    assert.equal(library.packages.some((entry) => entry.packageHash === installed.package.packageHash), true);
    assert.equal(library.packages.some((entry) => entry.version === "1.0.1"), false);
    assert.equal((await service.getVehicleManifest("plugin-truck")).revision, saved.vehicle.revision);
    assert.equal((await service.getVehicleManifest("plugin-truck")).pluginLocks[0].packageHash, installed.package.packageHash);
    assert.equal((await service.getScript("scale-script")).graph.pluginLocks[0].packageHash, installed.package.packageHash);
    assert.equal((await service.getRunManifest("reimport-run")).plugins.artifacts[0].expectedHash, installed.package.packageHash);
});
