import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { collectRunTemplateClosure, recheckRunTemplateSnapshot } from "../server/marketplace/RunTemplateClosure.js";
import {
    RUN_TEMPLATE_PACKAGE_MANIFEST,
    exportRunTemplatePackage,
    verifyRunTemplatePackage,
} from "../server/marketplace/RunTemplatePackage.js";
import { StorageService } from "../server/storage/StorageService.js";

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-run-template-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const service = new StorageService(directory);
    const environment = await service.createEnvironment({
        id: "template-yard",
        name: "Template Yard",
        supportedEditorSourceVersions: [1],
    });
    const manifest = await service.createRunManifest(createDefaultRunManifest({
        id: "portable-template",
        name: "Portable Template",
        environment: { id: environment.environmentId, expectedHash: null },
    }));
    return { directory, service, manifest };
}

async function writeExport(service, manifest, destination) {
    const exported = await exportRunTemplatePackage({
        storageService: service,
        manifestId: manifest.id,
        expectedRevision: manifest.revision,
    });
    await pipeline(exported.stream, (await fs.open(destination, "wx")).createWriteStream());
    await exported.completion;
    return fs.readFile(destination);
}

test("MKT-11 run-template export is deterministic and verifies an exact authoring closure", async (t) => {
    const { directory, service, manifest } = await fixture(t);
    const first = await writeExport(service, manifest, path.join(directory, "first.tar"));
    const second = await writeExport(service, manifest, path.join(directory, "second.tar"));
    assert.deepEqual(first, second);
    const verified = await verifyRunTemplatePackage(first, { retainStaging: true });
    t.after(() => verified.cleanup());
    assert.equal(verified.entries[0].name, RUN_TEMPLATE_PACKAGE_MANIFEST);
    assert.equal(verified.manifest.root.manifestId, manifest.id);
    assert.equal(verified.manifest.environmentClosure.environment.environmentId, "template-yard");
    assert.deepEqual(verified.manifest.scenarios, []);
    assert.deepEqual(verified.manifest.scripts, []);
    assert.deepEqual(verified.manifest.plugins, []);
    assert.deepEqual(verified.bindings.bindings, []);
});

test("MKT-11 rejects an empty frozen binding set being supplemented by destination globals", async (t) => {
    const { service, manifest } = await fixture(t);
    await service.putBindings({
        kind: "cev-sim.script-bindings",
        version: 2,
        enabled: true,
        updatedAt: new Date().toISOString(),
        folders: [],
        bindings: [{ id: "destination-global", name: "Destination", scope: "global", scriptId: "missing", enabled: true }],
    });
    await assert.rejects(service.resolveRunManifest(manifest.id), /Script "missing"/u);
    const updated = await service.putRunManifest(manifest.id, {
        manifest: {
            ...manifest,
            scripts: { ...manifest.scripts, bindingSource: "embedded", embeddedBindings: [], bindingIds: [] },
        },
        expectedRevision: manifest.revision,
    });
    const resolved = await service.resolveRunManifest(updated.id);
    assert.deepEqual(resolved.bindings.entries, []);
});

test("MKT-11 represents built-in environments and vehicles by exact contract descriptors", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-run-template-builtins-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const service = new StorageService(directory);
    const manifest = await service.createRunManifest(createDefaultRunManifest({ id: "built-in-template" }));
    const bytes = await writeExport(service, manifest, path.join(directory, "built-ins.tar"));
    const verified = await verifyRunTemplatePackage(bytes, { retainStaging: true });
    t.after(() => verified.cleanup());
    assert.equal(verified.manifest.environmentClosure, null);
    assert.ok(verified.manifest.builtIns.some((entry) => entry.resourceKind === "environment" && entry.resourceId === "igvc"));
    assert.ok(verified.manifest.builtIns.some((entry) => entry.resourceKind === "vehicle"));
});

test("MKT-11 packages every custom vehicle asset and detects edits after closure capture", async (t) => {
    const { directory, service } = await fixture(t);
    const vehicle = await service.createVehicleManifest({
        ...createDefaultVehicleManifest({ id: "custom-rover", name: "Custom Rover" }),
        model: { ...createDefaultVehicleManifest().model, asset: "rover.glb" },
    });
    await service.putVehicleAsset(vehicle.id, "rover.glb", Buffer.from("glb-model"));
    await service.putVehicleAsset(vehicle.id, "calibration.bin", Buffer.from("calibration"));
    const manifest = await service.createRunManifest({
        ...createDefaultRunManifest({ id: "vehicle-template", environment: { id: "template-yard", expectedHash: null } }),
        initialState: {
            vehicles: [{ ...createDefaultRunManifest().initialState.vehicles[0], type: vehicle.id }],
            signals: {},
        },
    });
    const bytes = await writeExport(service, manifest, path.join(directory, "vehicle.tar"));
    const verified = await verifyRunTemplatePackage(bytes, { retainStaging: true });
    t.after(() => verified.cleanup());
    assert.deepEqual(verified.manifest.vehicles[0].assets.map((entry) => entry.name), ["calibration.bin", "rover.glb"]);

    const captured = await collectRunTemplateClosure({ storageService: service, manifestId: manifest.id, expectedRevision: manifest.revision });
    await service.putVehicleAsset(vehicle.id, "rover.glb", Buffer.from("changed"));
    await assert.rejects(recheckRunTemplateSnapshot({ storageService: service, captured }), /changed while its template was captured/u);
});
