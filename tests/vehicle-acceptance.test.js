import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser, Document, Element } from "@xmldom/xmldom";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import URDFLoader from "urdf-loader";

import { readGlb, writeGlb } from "../app/simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { createMeshImportPlan } from "../app/editor-assets/MeshImportPlan.js";
import { VehicleModelLoader } from "../app/3d/vehicles/VehicleModelLoader.js";
import { attachVehiclePlant, stepVehiclePlant } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import {
    applyMigration,
    applyPlacementChange,
    assignModelWheels,
    editKinematics,
    setStagedResources,
    suppressSourceWheels,
} from "../app/vehicles/document/vehicleCommands.js";
import { VehicleEditorController } from "../app/vehicles/editor/VehicleEditorController.js";
import { planVehicleMigration } from "../app/vehicles/migration/planVehicleMigration.js";
import { encodeVehicleModelForMigration, createVehicleModelImportPlan } from "../app/vehicles/model/VehicleModelImportPlan.js";
import { describeTurnGeometry } from "../app/vehicles/plan/turnGeometry.js";
import { projectVehiclePlan } from "../app/vehicles/plan/projectVehiclePlan.js";
import { exportVehicleUrdf } from "../app/vehicles/urdf/exportVehicleUrdf.js";
import { acceptUrdfImport, manifestFromUrdfImport, planUrdfImport } from "../app/vehicles/urdf/planUrdfImport.js";
import {
    VEHICLE_MANIFEST_DOWNGRADE,
    createBlankVehicleManifest,
    createDefaultVehicleManifest,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";
import { createVehicleAcceptanceHarness } from "./helpers/vehicleAcceptanceHarness.js";
import { loadVehicleIdentityLedger } from "./helpers/vehicleIdentityLedger.js";
import { buildBoxGlb, symmetricWheelParts } from "./helpers/vehicle-wheel-glb.js";
import { carPackage } from "./helpers/urdf-fixtures.js";

globalThis.DOMParser = DOMParser;
globalThis.Document = Document;
globalThis.Element = Element;

if (typeof Element.prototype.querySelector !== "function") {
    Element.prototype.querySelector = function querySelector(selector) {
        const match = /^child\[link="([^"]*)"\]$/u.exec(selector);
        const nodes = this.getElementsByTagName("child");
        for (let index = 0; index < nodes.length; index += 1) {
            if (!match || nodes[index].getAttribute("link") === match[1]) return nodes[index];
        }
        return null;
    };
}

const encoder = new TextEncoder();
const PRE_MANIFEST = ["after-prepared", "after-promote"];
const POST_MANIFEST = ["after-manifest", "after-snapshot", "after-receipt"];

function operationId() {
    return randomBytes(32).toString("hex");
}

function fault(name) {
    return {
        vehiclePublication: {
            faults: {
                [name]: () => {
                    const error = new Error(`stop ${name}`);
                    error.code = "INJECTED_FAULT";
                    throw error;
                },
            },
        },
    };
}

function readJson(bytes) {
    return readGlb(bytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
    }).json;
}

function triangleStl() {
    const stl = new Uint8Array(84 + 50);
    const view = new DataView(stl.buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(108, 1, true);
    view.setFloat32(124, 1, true);
    return stl;
}

function standardManifest() {
    return normalizeVehicleManifest({
        version: 3,
        id: "plan-car",
        name: "Plan",
        wheels: [
            { id: "front-left", axle: "front", side: "left", position: { x: 0.8, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "front-right", axle: "front", side: "right", position: { x: 0.8, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "rear-left", axle: "rear", side: "left", position: { x: -0.7, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: false },
            { id: "rear-right", axle: "rear", side: "right", position: { x: -0.7, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: false },
        ],
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 0.6 },
    });
}

function mutableVector(source = {}, withOrder = false) {
    return {
        x: Number(source.x) || 0,
        y: Number(source.y) || 0,
        z: Number(source.z) || 0,
        ...(withOrder ? { order: source.order || "XYZ" } : {}),
        set(x, y, z, order = this.order) {
            Object.assign(this, { x, y, z });
            if (withOrder) this.order = order || "XYZ";
            return this;
        },
        copy(value) {
            return this.set(value.x, value.y, value.z, value.order);
        },
    };
}

function drive(manifest) {
    const initial = {
        id: "ego",
        type: manifest.id,
        pose: { position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0.2, z: 0, order: "XYZ" } },
        linearVelocity: { x: 3, y: 0, z: 0 },
        linearAcceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0.2,
    };
    const vehicle = {
        telemetryId: initial.id,
        position: mutableVector(initial.pose.position),
        rotation: mutableVector(initial.pose.rotation, true),
        velocity: mutableVector(initial.linearVelocity),
        acceleration: mutableVector(initial.linearAcceleration),
        steeringAngle: initial.steeringAngle,
        updatePosition(value) { this.position.copy(value); },
        updateRotation(value) { this.rotation.copy(value); },
    };
    attachVehiclePlant(vehicle, initial, { manifest });
    stepVehiclePlant(vehicle, 0.5);
    return vehicle.plant.getDeterministicState();
}

function loadRobot(xml, files = new Map()) {
    const loader = new URDFLoader();
    const pending = [];
    loader.loadMeshCb = (meshPath, _manager, _material, done) => {
        const bytes = files.get(meshPath);
        if (!bytes) {
            done(null, new Error(`Missing ${meshPath}`));
            return;
        }
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        pending.push(new Promise((resolve, reject) => {
            new GLTFLoader().parse(copy, "", (gltf) => {
                done(gltf.scene);
                resolve();
            }, (error) => {
                done(null, error);
                reject(error);
            });
        }));
    };
    const robot = loader.parse(xml);
    return Promise.all(pending).then(() => {
        robot.updateMatrixWorld(true);
        return robot;
    });
}

function worldPoints(object) {
    object.updateMatrixWorld(true);
    const points = [];
    for (const visual of object.children.filter((child) => child.isURDFVisual)) {
        visual.traverse((child) => {
            const position = child.geometry?.attributes?.position;
            if (!child.isMesh || !position) return;
            for (let index = 0; index < position.count; index += 1) {
                points.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld));
            }
        });
    }
    return points;
}

async function assertSteeringMotion(robot, wheelLinkName, steerName, spinName) {
    const link = robot.links[wheelLinkName];
    const visuals = link.children.filter((child) => child.isURDFVisual);
    assert.equal(visuals.length, 1);
    const origin = link.getWorldPosition(new THREE.Vector3());
    const rest = worldPoints(link);
    const index = rest.reduce((selected, point, pointIndex) => (
        point.x - origin.x > (rest[selected]?.x ?? Number.NEGATIVE_INFINITY) - origin.x ? pointIndex : selected
    ), 0);
    const forward = rest[index];
    const bodyBefore = worldPoints(robot.links.base_link).map((point) => point.clone());
    robot.setJointValue(steerName, 0.3);
    robot.updateMatrixWorld(true);
    const steered = worldPoints(link)[index];
    assert.ok(steered.y > forward.y + 1e-3);
    robot.setJointValue(steerName, 0);
    robot.setJointValue(spinName, 0.8);
    robot.updateMatrixWorld(true);
    const spun = worldPoints(link);
    assert.ok(spun.some((point, pointIndex) => rest[pointIndex].distanceTo(point) > 1e-4));
    const bodyAfter = worldPoints(robot.links.base_link);
    bodyAfter.forEach((point, pointIndex) => {
        assert.ok(point.distanceTo(bodyBefore[pointIndex]) < 1e-6);
    });
}

test("VEH-09c unsaved staging leaves a saved version 2 identity unchanged", async () => {
    const harness = await createVehicleAcceptanceHarness();
    try {
        const service = harness.service;
        await service.createVehicleManifest(createDefaultVehicleManifest({ id: "kept", name: "Kept" }));
        await service.putVehicleAsset("kept", "model.glb", Buffer.from("model-bytes"));
        const before = await harness.snapshotIdentity("kept");
        const stored = await service.getVehicleManifest("kept");
        const session = new VehicleDocumentSession({ manifest: stored, revision: stored.revision, definitionHash: stored.definitionHash });
        const stage = await service.vehicleStages.createStage();
        await service.vehicleStages.putMember(stage.stageId, "extra.bin", Buffer.from("extra"));
        session.execute(setStagedResources({ stageId: stage.stageId, members: [{ name: "extra.bin", sha256: "aa", size: 5 }] }));
        session.execute({
            label: "Draft",
            run(context) {
                context.setManifest({ ...context.manifest, description: "draft" });
                return { ok: true };
            },
        });
        assert.equal(session.dirty, true);
        session.discard();
        assert.equal(session.dirty, false);
        assert.equal(session.stagedResources, null);
        await service.vehicleStages.abandonStage(stage.stageId);

        const failing = harness.restart(fault("after-promote"));
        const blocked = await failing.vehicleStages.createStage();
        await failing.vehicleStages.putMember(blocked.stageId, "extra.bin", Buffer.from("extra"));
        await assert.rejects(() => failing.putVehicleManifest("kept", {
            manifest: { ...stored, description: "Changed" },
            expectedRevision: stored.revision,
            stageId: blocked.stageId,
            operationId: operationId(),
        }), /stop after-promote/);
        const after = await harness.snapshotIdentity("kept");
        assert.equal(after.definitionHash, before.definitionHash);
        assert.equal(after.bundleHash, before.bundleHash);
        assert.equal(after.resolvedHash, before.resolvedHash);
        assert.equal(after.dependencyHash, before.dependencyHash);
        assert.deepEqual(after.assetNames, ["model.glb"]);
        assert.equal((await harness.service.getVehicleManifest("kept")).description, "");
    } finally {
        await harness.dispose();
    }
});

test("VEH-09c migration planning, BigCar acknowledgement, and snapshot exclusion", async () => {
    const ledger = await loadVehicleIdentityLedger();
    const harness = await createVehicleAcceptanceHarness();
    try {
        const gltf = Buffer.from(JSON.stringify({
            asset: { version: "2.0" },
            buffers: [{ uri: "car.bin", byteLength: 4 }],
        }));
        const bin = Buffer.from([9, 8, 7, 6]);
        const encoded = planVehicleMigration({ version: 2, id: "local", model: { asset: "car.gltf" } }, {
            files: { "car.gltf": gltf, "car.bin": bin },
            encodeModel: encodeVehicleModelForMigration,
        });
        assert.equal(encoded.ok, true);
        assert.match(encoded.proposedManifest.model.asset, /^[a-f0-9]{64}\.glb$/);
        const missing = planVehicleMigration({ version: 2, id: "local", model: { asset: "car.gltf" } }, {
            files: { "car.gltf": gltf },
            encodeModel: encodeVehicleModelForMigration,
        });
        assert.equal(missing.ok, false);
        assert.equal(missing.proposedManifest, null);
        assert.equal(missing.assetPlan.operations[0].op, "missing-dependency");

        const remote = planVehicleMigration({ version: 2, id: "remote", model: { asset: "https://example.com/car.glb" } }, {
            encodeModel: encodeVehicleModelForMigration,
        });
        assert.equal(remote.assetPlan.operations[0].op, "require-local-package");
        assert.equal(remote.proposedManifest, null);

        const bigCar = getBuiltInVehicleManifest("big-car");
        const unclassified = planVehicleMigration(bigCar, {
            publicFiles: { "/shell/shell.gltf": Buffer.from(JSON.stringify({ asset: { version: "2.0" } })) },
            encodeModel: () => ({ asset: "canon.glb", dependencies: [], sha256: "abc" }),
        });
        assert.equal(unclassified.proposedManifest.kinematics.wheelbase, 1.2446);
        assert.equal(unclassified.proposedManifest.wheels.every((wheel) => wheel.axle === undefined), true);
        const blocked = planVehicleMigration(bigCar, {
            publicFiles: { "/shell/shell.gltf": Buffer.from(JSON.stringify({ asset: { version: "2.0" } })) },
            encodeModel: () => ({ asset: "canon.glb", dependencies: [], sha256: "abc" }),
            standardizeLayout: true,
        });
        assert.equal(blocked.ok, false);
        assert.equal(blocked.acknowledgements[0].before, 1.2446);
        assert.equal(blocked.acknowledgements[0].after, 1.5);
        const accepted = planVehicleMigration(bigCar, {
            publicFiles: { "/shell/shell.gltf": Buffer.from(JSON.stringify({ asset: { version: "2.0" } })) },
            encodeModel: () => ({ asset: "canon.glb", dependencies: [], sha256: "abc" }),
            standardizeLayout: true,
            acknowledgeWheelbase: true,
        });
        assert.equal(accepted.proposedManifest.kinematics.wheelbase, 1.5);
        assert.equal(computeResolvedRunHash(getBuiltInVehicleManifest("big-car")), ledger.legacy["big-car"]);

        const service = harness.service;
        await service.createVehicleManifest(createDefaultVehicleManifest({
            id: "local",
            name: "Local",
            model: { asset: "car.gltf", scale: 1, rotation: {}, offset: {} },
        }));
        await service.putVehicleAsset("local", "car.gltf", gltf);
        await service.putVehicleAsset("local", "car.bin", bin);
        const before = await service.getVehicleManifest("local");
        const session = new VehicleDocumentSession({ manifest: before });
        assert.equal(session.execute(applyMigration(missing)).ok, false);
        assert.equal((await service.getVehicleManifest("local")).version, 2);

        const stage = await service.vehicleStages.createStage();
        for (const file of encoded.assetPlan.operations[0].outputs.files) {
            await service.vehicleStages.putMember(stage.stageId, file.name, file.bytes);
        }
        const published = await service.publishVehicleMigration({
            vehicleId: "local",
            manifest: { ...encoded.proposedManifest, id: "local" },
            expectedRevision: before.revision,
            operationId: operationId(),
            stageId: stage.stageId,
        });
        assert.equal(published.version, 3);
        const snapshotPath = path.join(harness.dir, "vehicle-migrations", "local.pre-v3.json");
        const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
        assert.equal(snapshot.kind, "cev-sim.vehicle-pre-migration");
        const identity = await harness.snapshotIdentity("local");
        assert.equal(Object.hasOwn(identity.assetHashes, "local.pre-v3.json"), false);
        assert.equal(Object.hasOwn(identity.assetHashes, published.model.asset), true);
        assert.equal(Object.hasOwn(identity.assetHashes, "car.gltf"), true);
        await assert.rejects(
            () => harness.service.putVehicleManifest("local", {
                manifest: createDefaultVehicleManifest({ id: "local", name: "Local" }),
                expectedRevision: published.revision,
            }),
            (error) => error.code === VEHICLE_MANIFEST_DOWNGRADE,
        );
    } finally {
        await harness.dispose();
    }
});

test("VEH-09c publication faults recover on both sides of the manifest write", async () => {
    const harness = await createVehicleAcceptanceHarness();
    try {
        for (const name of PRE_MANIFEST) {
            const vehicleId = `pre-${name}`;
            const manifest = createBlankVehicleManifest({ id: vehicleId, name: vehicleId });
            const failing = harness.restart(fault(name));
            await assert.rejects(
                () => failing.createVehicleManifest({ manifest, operationId: operationId() }),
                new RegExp(name),
            );
            const rolled = harness.restart();
            assert.equal(await rolled.getVehicleManifest(vehicleId), null);
            assert.deepEqual(await rolled.listVehicleAssets(vehicleId), []);
        }
        for (const name of POST_MANIFEST) {
            const vehicleId = `post-${name}`;
            const manifest = createBlankVehicleManifest({ id: vehicleId, name: vehicleId });
            const op = operationId();
            const failing = harness.restart(fault(name));
            await assert.rejects(
                () => failing.createVehicleManifest({ manifest, operationId: op }),
                new RegExp(name),
            );
            const restarted = harness.restart();
            const stored = await restarted.createVehicleManifest({ manifest, operationId: op });
            assert.equal(stored.revision, 1);
            assert.equal(stored.definitionHash, computeResolvedRunHash(manifest));
            const again = await restarted.createVehicleManifest({ manifest, operationId: op });
            assert.equal(again.revision, stored.revision);
            assert.equal(again.definitionHash, stored.definitionHash);
        }

        await harness.service.createVehicleManifest(createDefaultVehicleManifest({
            id: "portable-truck",
            name: "Portable",
            model: { asset: "model.glb", scale: 0.5, rotation: {}, offset: {} },
        }));
        await harness.service.putVehicleAsset("portable-truck", "model.glb", Buffer.from("model-bytes"));
        const bundle = await harness.service.exportVehicleBundle("portable-truck");
        const target = await createVehicleAcceptanceHarness();
        try {
            for (const name of [...PRE_MANIFEST, ...POST_MANIFEST]) {
                const op = operationId();
                const failing = target.restart(fault(name));
                await assert.rejects(() => failing.importVehicleBundle({ ...bundle, operationId: op }), new RegExp(name));
                const restarted = target.restart();
                if (PRE_MANIFEST.includes(name)) {
                    assert.equal(await restarted.getVehicleManifest("portable-truck"), null);
                    assert.deepEqual(await restarted.listVehicleAssets("portable-truck"), []);
                } else {
                    const imported = await restarted.importVehicleBundle({ ...bundle, operationId: op });
                    assert.equal(imported.id, "portable-truck");
                    assert.equal((await restarted.exportVehicleBundle("portable-truck")).bundleHash, bundle.bundleHash);
                    await restarted.deleteVehicleManifest("portable-truck", imported.revision);
                }
            }

            await target.service.createVehicleManifest(createDefaultVehicleManifest({
                id: "portable-truck",
                name: "Portable",
                model: { asset: "model.glb", scale: 0.5, rotation: {}, offset: {} },
            }));
            await target.service.putVehicleAsset("portable-truck", "model.glb", Buffer.from("model-bytes"));
            const sourceHash = (await target.snapshotIdentity("portable-truck")).dependencyHash;
            for (const name of ["after-prepared", "after-promote"]) {
                const op = operationId();
                const failing = target.restart(fault(name));
                await assert.rejects(() => failing.duplicateVehicleManifest("portable-truck", {
                    id: "portable-copy",
                    operationId: op,
                }), new RegExp(name));
                const rolled = target.restart();
                assert.equal(await rolled.getVehicleManifest("portable-copy"), null);
                assert.equal((await target.snapshotIdentity("portable-truck")).dependencyHash, sourceHash);
            }
            const duplicateOp = operationId();
            const duplicating = target.restart(fault("after-manifest"));
            await assert.rejects(() => duplicating.duplicateVehicleManifest("portable-truck", {
                id: "portable-copy",
                operationId: duplicateOp,
            }), /after-manifest/);
            const copied = await target.restart().duplicateVehicleManifest("portable-truck", {
                id: "portable-copy",
                operationId: duplicateOp,
            });
            assert.equal(copied.id, "portable-copy");
            const replay = await target.service.duplicateVehicleManifest("portable-truck", {
                id: "portable-copy",
                operationId: duplicateOp,
            });
            assert.equal(replay.revision, copied.revision);

            const marketBytes = Buffer.from("market-bytes");
            const digest = sha256ExactBytes(marketBytes);
            const parked = await target.service.commitMarketplaceVehicleAsset({
                vehicleId: "market-truck",
                fileName: "model.glb",
                bytes: marketBytes,
                sha256: digest,
                expectedVehicleRevision: 0,
                expectedVehicleContentHash: null,
            });
            assert.equal(parked.reused, false);
            assert.deepEqual(await target.service.listVehicleAssets("market-truck"), []);
            const candidate = normalizeVehicleManifest(createDefaultVehicleManifest({
                id: "market-truck",
                model: { asset: "model.glb", scale: 1, rotation: {}, offset: {} },
            }));
            const contentHash = computeResolvedRunHash(candidate);
            const marketFault = target.restart(fault("after-promote"));
            await assert.rejects(() => marketFault.commitMarketplaceVehicle({
                vehicleId: "market-truck",
                manifest: candidate,
                expectedRevision: 0,
                contentHash,
            }), /after-promote/);
            const market = target.restart();
            assert.equal(await market.getVehicleManifest("market-truck"), null);
            const committed = await market.commitMarketplaceVehicle({
                vehicleId: "market-truck",
                manifest: candidate,
                expectedRevision: 0,
                contentHash,
            });
            assert.equal(committed.reused, false);
            const reused = await market.commitMarketplaceVehicle({
                vehicleId: "market-truck",
                manifest: candidate,
                expectedRevision: 0,
                contentHash,
            });
            assert.equal(reused.reused, true);
            assert.equal(reused.revision, committed.revision);
        } finally {
            await target.dispose();
        }

        const mover = await createVehicleAcceptanceHarness();
        try {
            await mover.service.createVehicleManifest(createDefaultVehicleManifest({
                id: "move-me",
                name: "Move",
                model: { asset: "model.glb", scale: 1, rotation: {}, offset: {} },
            }));
            await mover.service.putVehicleAsset("move-me", "model.glb", Buffer.from("model-bytes"));
            const current = await mover.service.getVehicleManifest("move-me");
            const op = operationId();
            for (const name of ["after-id-prepared", "after-id-assets"]) {
                const failing = mover.restart(fault(name));
                await assert.rejects(() => failing.changeVehicleId("move-me", {
                    id: "move-next",
                    expectedRevision: current.revision,
                    operationId: op,
                }), new RegExp(name));
                const rolled = mover.restart();
                assert.equal(await rolled.getVehicleManifest("move-next"), null);
                assert.deepEqual(await rolled.listVehicleAssets("move-next"), []);
                assert.equal(await rolled.getVehicleManifest("move-me") != null, true);
            }
            const published = mover.restart(fault("after-id-manifest"));
            await assert.rejects(() => published.changeVehicleId("move-me", {
                id: "move-next",
                expectedRevision: current.revision,
                operationId: op,
            }), /after-id-manifest/);
            const finished = await mover.restart().changeVehicleId("move-me", {
                id: "move-next",
                expectedRevision: current.revision,
                operationId: op,
            });
            assert.equal(finished.id, "move-next");
            assert.equal(finished.revision, 1);
            assert.equal(await mover.service.getVehicleManifest("move-me"), null);
        } finally {
            await mover.dispose();
        }
    } finally {
        await harness.dispose();
    }
});

test("VEH-09c a bound URDF wheel steers and spins on its own joint", async () => {
    const plan = planUrdfImport(carPackage());
    const accepted = acceptUrdfImport(plan, { acceptAdjustments: true });
    assert.equal(accepted.ok, true);
    const manifest = manifestFromUrdfImport(plan, accepted, { id: "bound-car", name: "Bound" });
    const exported = exportVehicleUrdf(manifest, {
        assets: { [plan.closure.asset.name]: plan.closure.asset.bytes },
    });
    const files = unzipSync(exported.bytes);
    const xml = strFromU8(files["bound-car.urdf"]);
    const meshes = new Map(Object.entries(files).filter(([name]) => name.endsWith(".glb")));
    const robot = await loadRobot(xml, meshes);
    await assertSteeringMotion(robot, "front-left-link", "front-left-steer", "front-left-spin");
});

test("VEH-09c detachment survives undo, reload, bundle import, and URDF export", async () => {
    const harness = await createVehicleAcceptanceHarness();
    const imported = await createVehicleAcceptanceHarness();
    try {
        const glb = buildBoxGlb(symmetricWheelParts());
        const assetName = `${sha256ExactBytes(glb)}.glb`;
        const manifest = normalizeVehicleManifest({
            ...createBlankVehicleManifest({ id: "detach-car", name: "Detach" }),
            model: {
                asset: assetName,
                dependencies: [],
                hiddenNodeIndices: [],
                scale: 1,
                rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
                offset: { x: 0, y: 0, z: 0 },
            },
        });
        const stage = await harness.service.vehicleStages.createStage();
        await harness.service.vehicleStages.putMember(stage.stageId, assetName, glb);
        const created = await harness.service.createVehicleManifest({
            manifest,
            operationId: operationId(),
            stageId: stage.stageId,
        });
        const session = new VehicleDocumentSession({
            manifest: created,
            revision: created.revision,
            definitionHash: created.definitionHash,
        });
        const assigned = session.execute(assignModelWheels({
            axle: "front",
            leftNodeIndex: 0,
            rightNodeIndex: 1,
            acceptAdjustments: true,
            glbBytes: glb,
        }));
        assert.equal(assigned.ok, true);
        const detached = session.execute(suppressSourceWheels({ nodeIndices: [0], glbBytes: glb }));
        assert.equal(detached.ok, true);
        const hidden = session.draft.snapshot();
        assert.deepEqual(hidden.model.hiddenNodeIndices, [0]);
        assert.equal(hidden.wheels.find((wheel) => wheel.visual?.nodeIndex === 0), undefined);
        assert.equal(hidden.wheels.some((wheel) => wheel.id === "generated-0"), true);
        session.undo();
        assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, []);
        assert.equal(session.draft.snapshot().wheels.some((wheel) => wheel.visual?.nodeIndex === 0), true);
        session.redo();
        const saved = await harness.service.putVehicleManifest("detach-car", {
            manifest: session.draft.snapshot(),
            expectedRevision: created.revision,
        });
        const reloaded = await harness.service.getVehicleManifest("detach-car");
        assert.deepEqual(reloaded.model.hiddenNodeIndices, [0]);
        assert.equal(reloaded.revision, saved.revision);
        const bundle = await harness.service.exportVehicleBundle("detach-car");
        const copy = await imported.service.importVehicleBundle(bundle);
        assert.deepEqual((await imported.service.getVehicleManifest(copy.id)).model.hiddenNodeIndices, [0]);
        const urdf = exportVehicleUrdf(reloaded, { assets: { [assetName]: glb } });
        const entries = unzipSync(urdf.bytes);
        const xml = strFromU8(entries[`${reloaded.id}.urdf`] ?? Object.values(entries).find((bytes) => strFromU8(bytes).includes("<robot")));
        assert.match(xml, /<cylinder/);
        assert.equal(xml.includes("wheel-left"), false);
        const generated = urdf.report.joints.find((joint) => joint.id === "generated-0");
        assert.equal(generated.mesh, null);
    } finally {
        await harness.dispose();
        await imported.dispose();
    }
});

test("VEH-09c canonical GLB bytes ignore entry filenames and leave editor-asset import unchanged", () => {
    const stl = triangleStl();
    const left = createVehicleModelImportPlan([{ path: "models/barrier.stl", bytes: stl }], { entryPath: "models/barrier.stl" });
    const right = createVehicleModelImportPlan([{ path: "notes/other.stl", bytes: stl }], { entryPath: "notes/other.stl" });
    assert.deepEqual([...left.asset.bytes], [...right.asset.bytes]);
    assert.equal(readJson(left.asset.bytes).nodes[0].name, "part-0");
    assert.equal(left.asset.bytes[0], 0x67);

    const named = encoder.encode("o Wheel\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    const unnamed = encoder.encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    const wheel = createVehicleModelImportPlan([{ path: "car.obj", bytes: named }], { entryPath: "car.obj" });
    const crate = createVehicleModelImportPlan([{ path: "crate.obj", bytes: unnamed }], { entryPath: "crate.obj" });
    const renamed = createVehicleModelImportPlan([{ path: "renamed.obj", bytes: unnamed }], { entryPath: "renamed.obj" });
    assert.equal(readJson(wheel.asset.bytes).nodes[0].name, "Wheel");
    assert.deepEqual([...crate.asset.bytes], [...renamed.asset.bytes]);
    assert.equal(readJson(crate.asset.bytes).nodes[0].name, "part-0");

    const json = encoder.encode(JSON.stringify({
        asset: { version: "2.0" },
        nodes: [{ name: "Door" }, {}],
        buffers: [{ uri: "mesh.bin", byteLength: 4 }],
    }));
    const geometry = new Uint8Array([9, 8, 7, 6]);
    const editor = createMeshImportPlan([
        { path: "body.gltf", bytes: json },
        { path: "mesh.bin", bytes: geometry },
    ], { entryPath: "body.gltf" });
    const vehicle = createVehicleModelImportPlan([
        { path: "body.gltf", bytes: json },
        { path: "mesh.bin", bytes: geometry },
    ], { entryPath: "body.gltf" });
    assert.equal(editor.mediaType, "model/gltf+json");
    assert.equal(editor.modelBytes[0], 0x7b);
    assert.equal(vehicle.asset.bytes[0], 0x67);
    assert.equal(readJson(vehicle.asset.bytes).nodes[0].name, "Door");
    assert.equal(readJson(vehicle.asset.bytes).nodes[1].name, "part-0");
});

test("VEH-09c wheel alignment accepts tolerance and blocks a larger asymmetry", () => {
    const glb = buildBoxGlb(symmetricWheelParts());
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "align-car",
        model: { asset: `${"ab".repeat(32)}.glb`, dependencies: [], hiddenNodeIndices: [] },
    });
    const session = new VehicleDocumentSession({ manifest });
    const preview = session.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        acceptAdjustments: false,
        glbBytes: glb,
    }));
    assert.equal(preview.ok, false);
    assert.equal(preview.review.withinTolerance, true);
    assert.equal(session.draft.snapshot().wheels.some((wheel) => wheel.visual), false);
    assert.equal(session.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        acceptAdjustments: true,
        glbBytes: glb,
    })).ok, true);

    const noisy = symmetricWheelParts();
    noisy[1] = { ...noisy[1], center: { ...noisy[1].center, x: 0.7504 } };
    const noisySession = new VehicleDocumentSession({ manifest });
    const noisyPreview = noisySession.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        acceptAdjustments: false,
        glbBytes: buildBoxGlb(noisy),
    }));
    assert.equal(noisyPreview.ok, false);
    assert.equal(noisyPreview.review.withinTolerance, true);
    assert.equal(noisySession.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        acceptAdjustments: true,
        glbBytes: buildBoxGlb(noisy),
    })).ok, true);

    const skewed = symmetricWheelParts();
    skewed[1] = { ...skewed[1], center: { ...skewed[1].center, x: 0.85 } };
    const skewSession = new VehicleDocumentSession({ manifest });
    const rejected = skewSession.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        acceptAdjustments: true,
        glbBytes: buildBoxGlb(skewed),
    }));
    assert.equal(rejected.ok, false);
    assert.equal(skewSession.draft.snapshot().wheels.some((wheel) => wheel.visual), false);

    const bound = session.draft.snapshot();
    const blockedPlacement = session.execute(applyPlacementChange({
        model: { scale: 1.2 },
        glbBytes: glb,
        acceptAdjustments: false,
    }));
    assert.equal(blockedPlacement.ok, false);
    assert.equal(session.draft.snapshot().model.scale, bound.model.scale);
    const nudged = session.execute(applyPlacementChange({
        model: { scale: 1.0005 },
        glbBytes: glb,
        acceptAdjustments: false,
    }));
    if (nudged.ok === false) assert.equal(session.draft.snapshot().model.scale, bound.model.scale);
    const acceptedPlacement = session.execute(applyPlacementChange({
        model: { scale: 1.0005 },
        glbBytes: glb,
        acceptAdjustments: true,
    }));
    assert.equal(acceptedPlacement.ok, true);
});

test("VEH-09c turn geometry keeps the plant on the origin and Ackermann on the rear axle", () => {
    const manifest = standardManifest();
    const positive = describeTurnGeometry(manifest, 0.2);
    assert.equal(positive.simulator.center.x, 0);
    assert.equal(positive.simulator.center.z, -positive.simulator.radius);
    assert.equal(positive.simulator.radius, manifest.kinematics.wheelbase / Math.tan(0.2));
    assert.equal(positive.ackermann.center.x, -0.7);
    assert.ok(positive.ackermann.available);
    const negative = describeTurnGeometry(manifest, -0.2);
    assert.ok(negative.simulator.radius < 0);
    assert.equal(negative.simulator.center.z, -negative.simulator.radius);
    assert.equal(negative.ackermann.center.x, -0.7);
    const straight = describeTurnGeometry(manifest, 0);
    assert.equal(straight.simulator.straight, true);
    assert.equal(straight.simulator.center, null);
    assert.equal(projectVehiclePlan(manifest, { steeringAngle: 0 }).diagnostics.some((entry) => entry.code === "vehicle.plan.straight"), true);
    const clamped = describeTurnGeometry(manifest, Math.PI);
    assert.equal(clamped.simulator.extreme, false);
    assert.equal(projectVehiclePlan(manifest, { steeringAngle: Math.PI }).diagnostics.some((entry) => entry.code === "vehicle.plan.steering-clamped"), true);
    const uncapped = standardManifest();
    uncapped.kinematics.maxSteeringAngle = Math.PI * 0.49;
    const extreme = describeTurnGeometry(uncapped, Math.PI);
    assert.equal(extreme.simulator.extreme, true);
    assert.equal(extreme.simulator.appliedAngle, Math.PI * 0.49);
    assert.equal(projectVehiclePlan(uncapped, { steeringAngle: Math.PI }).diagnostics.some((entry) => entry.code === "vehicle.plan.extreme-angle"), true);

    const shifted = structuredClone(manifest);
    shifted.wheels[0].position.x = 0.2;
    shifted.wheels[1].position.x = 0.2;
    shifted.id = "shifted-car";
    const left = drive(manifest);
    const right = drive(shifted);
    assert.equal(left.rotation.y, right.rotation.y);
    assert.equal(left.position.x, right.position.x);
    assert.equal(left.position.z, right.position.z);

    const shortBase = getBuiltInVehicleManifest("big-car");
    shortBase.id = "short-car";
    const longBase = getBuiltInVehicleManifest("big-car");
    longBase.id = "long-car";
    longBase.kinematics.wheelbase = 1.5;
    const shortYaw = drive(shortBase).rotation.y;
    const longYaw = drive(longBase).rotation.y;
    const shortDelta = shortYaw - 0.2;
    const longDelta = longYaw - 0.2;
    assert.ok(Math.abs((longDelta / shortDelta) - (1.2446 / 1.5)) < 1e-9);
});

test("VEH-09c a stale model load cannot replace a newer selection", async () => {
    const pending = [];
    const loader = new VehicleModelLoader({
        THREE,
        parseGltf() {
            return new Promise((resolve) => {
                pending.push((name) => {
                    const root = new THREE.Group();
                    root.name = name;
                    resolve({
                        scene: root,
                        parser: { associations: new Map(), json: { nodes: [{ name }] } },
                    });
                });
            });
        },
    });
    const bytes = writeGlb({ asset: { version: "2.0" } }, new Uint8Array([1, 2, 3, 4]));
    const name = `${sha256ExactBytes(bytes)}.glb`;
    const request = {
        slotId: "studio",
        source: {
            kind: "bytes",
            asset: { name, bytes, mediaType: "model/gltf-binary", sha256: sha256ExactBytes(bytes), size: bytes.byteLength },
            dependencies: [],
        },
        model: { scale: 1 },
    };
    const first = loader.load(request);
    await Promise.resolve();
    const second = loader.load(request);
    await Promise.resolve();
    pending[0]("old");
    const oldLease = await first;
    assert.equal(oldLease.stale, true);
    assert.equal(oldLease.root, null);
    pending[1]("new");
    const current = await second;
    assert.equal(current.stale, false);
    assert.equal(current.root.name, "new");
    current.dispose();
    loader.dispose();
});

test("VEH-09c an edit during save and an expired stage keep the draft", async () => {
    const controller = new VehicleEditorController({ createOperationId: () => "c".repeat(64) });
    controller.open(createBlankVehicleManifest({ id: "draft-car", name: "Draft" }));
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
    assert.equal(controller.snapshot.manifest.description, "pending");
    assert.equal(controller.snapshot.manifest.kinematics.maxSpeed, 9);

    const conflicted = new VehicleEditorController({ createOperationId: () => "d".repeat(64) });
    conflicted.open(createBlankVehicleManifest({ id: "draft-car", name: "Keep" }));
    conflicted.execute(editKinematics({ patch: { maxSpeed: 4 } }));
    conflicted.client = {
        async saveVehicleManifest() {
            throw new Error("revision conflict");
        },
    };
    await assert.rejects(() => conflicted.save(), /revision conflict/);
    assert.equal(conflicted.snapshot.saveState, "conflict");
    assert.equal(conflicted.snapshot.manifest.kinematics.maxSpeed, 4);
    assert.equal(conflicted.snapshot.dirty, true);

    const expired = new VehicleEditorController({ createOperationId: () => "e".repeat(64) });
    expired.open(createBlankVehicleManifest({ id: "draft-car", name: "Draft" }));
    expired.client = {
        async readVehicleStageMember() {
            return { sha256: "ff", size: 3, mediaType: "model/gltf-binary" };
        },
        async saveVehicleManifest() {
            throw new Error("should not save");
        },
    };
    expired.execute({
        label: "Stage",
        run(context) {
            context.setStagedResources({ stageId: "stage-1", members: [{ name: "car.glb", sha256: "ab", size: 3 }] });
            context.setManifest({ ...context.manifest, description: "keep" });
            return { ok: true };
        },
    });
    await assert.rejects(() => expired.save(), /does not match the server digest/);
    assert.equal(expired.snapshot.saveState, "expired-stage");
    assert.equal(expired.snapshot.manifest.description, "keep");
    assert.equal(expired.snapshot.stagedResources.stageId, "stage-1");
});
