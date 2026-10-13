import assert from "node:assert/strict";
import test from "node:test";

import { readGlb } from "../app/simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { planVehicleMigration } from "../app/vehicles/migration/planVehicleMigration.js";
import {
    createVehicleModelImportPlan,
    encodeVehicleModelForMigration,
} from "../app/vehicles/model/VehicleModelImportPlan.js";
import { makePng } from "./helpers/visual-assets.js";

const encoder = new TextEncoder();

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

test("VEH-02b encodes glTF to a GLB whose identity ignores the entry filename", () => {
    const geometry = new Uint8Array([9, 8, 7, 6]);
    const png = makePng();
    const json = {
        asset: { version: "2.0" },
        nodes: [{ name: "Door" }, {}],
        buffers: [{ uri: "mesh.bin", byteLength: geometry.length }],
        images: [{ uri: "albedo.png" }],
    };
    const bytes = encoder.encode(JSON.stringify(json));
    const renamed = createVehicleModelImportPlan([
        { path: "renamed.gltf", bytes },
        { path: "mesh.bin", bytes: geometry },
        { path: "albedo.png", bytes: png },
    ], { entryPath: "renamed.gltf" });
    const original = createVehicleModelImportPlan([
        { path: "models/body.gltf", bytes },
        { path: "models/mesh.bin", bytes: geometry },
        { path: "models/albedo.png", bytes: png },
    ], { entryPath: "models/body.gltf" });
    assert.equal(renamed.mediaType, "model/gltf-binary");
    assert.equal(renamed.asset.name, `${renamed.asset.sha256}.glb`);
    assert.equal(renamed.asset.bytes[0], 0x67);
    assert.notDeepEqual([...renamed.asset.bytes], [...bytes]);
    assert.deepEqual([...renamed.asset.bytes], [...original.asset.bytes]);
    const parsed = readJson(renamed.asset.bytes);
    const text = JSON.stringify(parsed);
    assert.equal(parsed.nodes[0].name, "Door");
    assert.equal(parsed.nodes[1].name, "part-0");
    assert.equal(text.includes("renamed"), false);
    assert.equal(text.includes("body.gltf"), false);
    assert.equal(text.includes("albedo.png"), false);
    assert.deepEqual(renamed.dependencies.map((entry) => entry.name), [`${sha256ExactBytes(png)}.png`]);
});

test("VEH-02b STL and OBJ fallback names ignore the entry filename", () => {
    const stl = triangleStl();
    const left = createVehicleModelImportPlan([{ path: "models/barrier.stl", bytes: stl }], { entryPath: "models/barrier.stl" });
    const right = createVehicleModelImportPlan([{ path: "notes/other.stl", bytes: stl }], { entryPath: "notes/other.stl" });
    assert.equal(left.asset.sha256, right.asset.sha256);
    const stlJson = readJson(left.asset.bytes);
    assert.equal(stlJson.nodes[0].name, "part-0");
    assert.equal(stlJson.asset.generator, "cev-sim.vehicle-glb@1");
    assert.equal(JSON.stringify(stlJson).includes("barrier"), false);
    assert.equal(JSON.stringify(stlJson).includes("other"), false);

    const png = makePng();
    const obj = encoder.encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    const named = encoder.encode("o Wheel\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    const crate = createVehicleModelImportPlan([{ path: "crate.obj", bytes: obj }], { entryPath: "crate.obj" });
    const renamed = createVehicleModelImportPlan([{ path: "renamed.obj", bytes: obj }], { entryPath: "renamed.obj" });
    assert.deepEqual([...crate.asset.bytes], [...renamed.asset.bytes]);
    assert.equal(readJson(crate.asset.bytes).nodes[0].name, "part-0");
    assert.equal(JSON.stringify(readJson(crate.asset.bytes)).includes("crate"), false);
    const wheel = createVehicleModelImportPlan([{ path: "car.obj", bytes: named }], { entryPath: "car.obj" });
    assert.equal(readJson(wheel.asset.bytes).nodes[0].name, "Wheel");

    const textured = createVehicleModelImportPlan([
        { path: "crate.obj", bytes: encoder.encode("mtllib crate.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl paint\nf 1 2 3\n") },
        { path: "crate.mtl", bytes: encoder.encode("newmtl paint\nKd 1 0 0\nmap_Kd albedo.png\n") },
        { path: "albedo.png", bytes: png },
    ], { entryPath: "crate.obj" });
    assert.equal(textured.dependencies.length, 1);
    assert.equal(textured.dependencies[0].name, `${sha256ExactBytes(png)}.png`);
    assert.equal(readJson(textured.asset.bytes).images[0].uri, textured.dependencies[0].name);
});

test("VEH-02b rejects PLY, missing files, ambiguous paths, URLs, and traversals", () => {
    const ply = encoder.encode("ply\nformat ascii 1.0\n");
    assert.throws(() => createVehicleModelImportPlan([{ path: "post.ply", bytes: ply }], { entryPath: "post.ply" }), /gltf, \.glb, \.obj, or \.stl/);
    const model = (uri) => encoder.encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri, byteLength: 1 }] }));
    assert.throws(() => createVehicleModelImportPlan([{ path: "a.gltf", bytes: model("x.bin") }], { entryPath: "a.gltf" }), /was not selected/);
    assert.throws(() => createVehicleModelImportPlan([{ path: "a.gltf", bytes: model("https://example.test/x.bin") }], { entryPath: "a.gltf" }), /not a selected package path/);
    assert.throws(() => createVehicleModelImportPlan([{ path: "a.gltf", bytes: model("../x.bin") }], { entryPath: "a.gltf" }), /traverses outside/);
    assert.throws(() => createVehicleModelImportPlan([
        { path: "a/../model.gltf", bytes: model("data:application/octet-stream;base64,AA==") },
        { path: "model.gltf", bytes: model("data:application/octet-stream;base64,AA==") },
    ], { entryPath: "model.gltf" }), /ambiguous/);
});

test("VEH-02b migration encoder returns the canonical closure and passes files through", () => {
    const gltf = encoder.encode(JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "car.bin", byteLength: 4 }],
    }));
    const bin = new Uint8Array([9, 8, 7, 6]);
    const plan = planVehicleMigration({ version: 2, id: "local", model: { asset: "car.gltf" } }, {
        files: { "car.gltf": gltf, "car.bin": bin },
        encodeModel: encodeVehicleModelForMigration,
    });
    assert.equal(plan.ok, true);
    assert.match(plan.proposedManifest.model.asset, /^[a-f0-9]{64}\.glb$/);
    assert.deepEqual(plan.proposedManifest.model.dependencies, []);
    assert.equal(plan.assetPlan.operations[0].outputs.files[0].name, plan.proposedManifest.model.asset);
    assert.equal(plan.assetPlan.operations[0].outputs.files[0].bytes[0], 0x67);
    assert.equal(plan.snapshot.assets["car.bin"].length, 64);
    assert.equal(plan.proposedManifest.version, 3);
});
