import assert from "node:assert/strict";
import test from "node:test";

import { sensorTypeRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { VehicleEditorController } from "../app/vehicles/editor/VehicleEditorController.js";
import { editKinematics } from "../app/vehicles/document/vehicleCommands.js";
import { createBlankVehicleManifest } from "../app/vehicles/VehicleManifest.js";

const PACKAGE_HASH = "a".repeat(64);
const RUNTIME_HASH = "b".repeat(64);

function pluginRegistry() {
    return {
        get(type) {
            if (type === "acme.range") {
                return {
                    vehicle: {
                        normalize: (source) => source.config ?? {},
                        validate: () => [],
                    },
                    pluginSensor: {
                        ownership: { pluginId: "acme.range" },
                    },
                };
            }
            return sensorTypeRegistry.get(type);
        },
        list: () => sensorTypeRegistry.list(),
    };
}

function pluginVehicle() {
    const blank = createBlankVehicleManifest({ id: "plugin-car", name: "Plugin Car" });
    return {
        ...blank,
        sensors: [{
            id: "range",
            type: "acme.range",
            pose: { position: { x: 0, y: 1, z: 0 }, rotation: {} },
            config: { width: 4 },
        }],
        pluginLocks: [{
            pluginId: "acme.range",
            version: "1.0.0",
            packageHash: PACKAGE_HASH,
            runtimeHash: RUNTIME_HASH,
            sensorTypes: ["acme.range"],
        }],
    };
}

function clientFor(session) {
    return {
        async readVehicleStageMember() {
            return { sha256: "ab", size: 3, mediaType: "model/gltf-binary" };
        },
        async saveVehicleManifest() {
            return { revision: 2, definitionHash: "saved", id: session.snapshot.manifest.id };
        },
        async abandonVehicleStage() {
            return true;
        },
    };
}

test("an edit during save stays dirty and a digest mismatch keeps the draft", async () => {
    let now = 0;
    const controller = new VehicleEditorController({
        now: () => now,
        createOperationId: () => "c".repeat(64),
    });
    controller.open(createBlankVehicleManifest({ id: "draft-car", name: "Draft" }), { readOnly: false });
    controller.client = {
        async readVehicleStageMember() {
            return { sha256: "ab", size: 3, mediaType: "model/gltf-binary" };
        },
        async saveVehicleManifest() {
            controller.execute(editKinematics({ patch: { maxSpeed: 9 } }));
            return { revision: 5, definitionHash: "saved", id: "draft-car" };
        },
    };
    controller.execute({
        label: "Stage",
        run(context) {
            context.setStagedResources({ stageId: "stage-1", members: [{ name: "car.glb", sha256: "ab", size: 3 }] });
            context.setManifest({ ...context.manifest, description: "pending" });
            return { ok: true };
        },
    });
    const saved = await controller.save();
    assert.equal(saved.dirty, true);
    assert.equal(controller.snapshot.revision, 5);
    assert.equal(controller.snapshot.manifest.kinematics.maxSpeed, 9);
    assert.equal(controller.snapshot.manifest.description, "pending");
    assert.equal(controller.snapshot.stagedResources.stageId, "stage-1");

    const conflicted = new VehicleEditorController({ createOperationId: () => "d".repeat(64) });
    conflicted.open(createBlankVehicleManifest({ id: "draft-car", name: "Draft" }));
    conflicted.client = {
        async readVehicleStageMember() {
            return { sha256: "ff", size: 3, mediaType: "model/gltf-binary" };
        },
        async saveVehicleManifest() {
            throw new Error("should not save");
        },
    };
    conflicted.execute({
        label: "Stage",
        run(context) {
            context.setStagedResources({ stageId: "stage-1", members: [{ name: "car.glb", sha256: "ab", size: 3 }] });
            context.setManifest({ ...context.manifest, description: "keep" });
            return { ok: true };
        },
    });
    await assert.rejects(() => conflicted.save(), /does not match the server digest/);
    assert.equal(conflicted.snapshot.saveState, "expired-stage");
    assert.equal(conflicted.snapshot.manifest.description, "keep");
    assert.equal(conflicted.snapshot.stagedResources.stageId, "stage-1");
    assert.equal(conflicted.snapshot.dirty, true);
    void now;
    void clientFor;
});

test("a plugin sensor unknown to the default registry survives an edit", () => {
    const registry = pluginRegistry();
    const dropped = new VehicleEditorController();
    dropped.open(pluginVehicle());
    dropped.execute(editKinematics({ patch: { maxSpeed: 8 } }));
    assert.equal(dropped.snapshot.manifest.pluginLocks, undefined);

    const kept = new VehicleEditorController({
        resolveNormalizeOptions: () => ({ sensorRegistry: registry }),
    });
    kept.open(pluginVehicle());
    assert.equal(kept.execute(editKinematics({ patch: { maxSpeed: 8 } })).ok, true);
    assert.equal(kept.snapshot.manifest.sensors[0].type, "acme.range");
    assert.equal(kept.snapshot.manifest.pluginLocks[0].pluginId, "acme.range");
    assert.equal(kept.snapshot.manifest.kinematics.maxSpeed, 8);
});

test("field edits coalesce, raw JSON validates, and undo of a staged model restores the previous stage", () => {
    let now = 1000;
    const controller = new VehicleEditorController({ now: () => now });
    controller.open(createBlankVehicleManifest({ id: "named", name: "Named" }));
    controller.editField(["name"], "Named ");
    now = 1100;
    controller.editField(["name"], "Named again");
    assert.equal(controller.session.history.length, 1);
    assert.equal(controller.fieldValue(["name"]), "Named again");
    controller.commitField(["name"]);
    assert.equal(controller.snapshot.manifest.name, "Named again");

    controller.applyRaw("{");
    assert.match(controller.snapshot.rawError, /JSON/);
    assert.equal(controller.snapshot.manifest.name, "Named again");
    const replacement = controller.snapshot.manifest;
    controller.applyRaw(JSON.stringify({ ...replacement, description: "from json" }));
    assert.equal(controller.snapshot.rawError, null);
    assert.equal(controller.snapshot.manifest.description, "from json");

    const previous = controller.snapshot.stagedResources;
    const replaced = controller.replaceStagedModel({
        model: { asset: `${"e".repeat(64)}.glb`, dependencies: [] },
        stagedResources: { stageId: "stage-2", members: [{ name: `${"e".repeat(64)}.glb`, sha256: "e".repeat(64), size: 8 }] },
    });
    assert.equal(replaced.ok, true);
    assert.equal(controller.snapshot.stagedResources.stageId, "stage-2");
    assert.equal(controller.undo().ok, true);
    assert.equal(controller.snapshot.stagedResources, previous);
    assert.notEqual(controller.snapshot.manifest.model.asset, `${"e".repeat(64)}.glb`);
});
