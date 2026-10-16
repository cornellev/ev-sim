import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync, strFromU8 } from "fflate";

import { createMeshDocument } from "../app/editor-assets/mesh/MeshDocument.js";
import { encodeMeshDocumentGlb } from "../app/editor-assets/mesh/MeshGlbEncoder.js";
import { readGlb } from "../app/simulation/visual/GlbContainer.js";
import { packVehicleGltf } from "../app/vehicles/model/packVehicleGltf.js";
import { acceptUrdfImport, manifestFromUrdfImport, planUrdfImport } from "../app/vehicles/urdf/planUrdfImport.js";
import { exportVehicleUrdf, formatUrdfNumber } from "../app/vehicles/urdf/exportVehicleUrdf.js";
import { readGlbNodeParts } from "../app/vehicles/urdf/meshSources.js";
import { carPackage } from "./helpers/urdf-fixtures.js";

function codes(issues) {
    return (issues ?? []).map((entry) => entry.code);
}

function modelFreeManifest() {
    return {
        id: "city-car",
        name: "City car",
        boundingBox: {
            size: { x: 2, y: 0.5, z: 1 },
            center: { x: 0, y: 0.25, z: 0 },
        },
        wheels: [
            { id: "front-left", side: "left", position: { x: 0.8, y: 0.25, z: 0.5 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "front-right", side: "right", position: { x: 0.8, y: 0.25, z: -0.5 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "rear-left", side: "left", position: { x: -0.7, y: 0.25, z: 0.5 }, radius: 0.25, width: 0.15, steerable: false },
            { id: "rear-right", side: "right", position: { x: -0.7, y: 0.25, z: -0.5 }, radius: 0.25, width: 0.15, steerable: false },
        ],
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 0.4, maxSpeed: 15 },
        sensors: [{ id: "roof-lidar" }],
        lidarZone: { vertices: [0, 0, 0], triangles: [0, 1, 2] },
        pluginLocks: ["lock-a"],
        dynamics: { plant: "example.plant" },
        model: { asset: null },
    };
}

function nodeNames(bytes) {
    const json = readGlb(bytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
    }).json;
    return (json.nodes ?? []).map((node) => node.name);
}

function triangle() {
    return {
        positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        normals: null,
        uvs: null,
        indices: [0, 1, 2],
        materialId: "paint",
    };
}

test("VEH-06d repeats a model-free URDF and reports every omitted behavior", () => {
    assert.equal(formatUrdfNumber(Math.PI / 2), "1.570796327");
    const manifest = modelFreeManifest();
    const first = exportVehicleUrdf(manifest);
    const second = exportVehicleUrdf(manifest);
    assert.equal(first.filename, "city-car.urdf");
    assert.equal(first.mediaType, "application/xml");
    assert.deepEqual(first.bytes, second.bytes);
    const xml = new TextDecoder().decode(first.bytes);
    assert.match(xml, /<cylinder radius="0.25" length="0.15"\/>/);
    assert.match(xml, /<joint name="front-left-steer" type="revolute">/);
    assert.match(xml, /<axis xyz="0 0 1"\/>/);
    assert.match(xml, /effort="0" velocity="0"/);
    assert.match(xml, /<joint name="front-left-spin" type="continuous">[\s\S]*<axis xyz="0 1 0"\/>/);
    assert.match(xml, /<joint name="front-right-spin" type="continuous">[\s\S]*<axis xyz="0 -1 0"\/>/);
    assert.match(xml, /name="front-left-link"[\s\S]*rpy="-1.570796327 0 0"/);
    assert.match(xml, /name="front-right-link"[\s\S]*rpy="1.570796327 0 0"/);
    const reported = codes([...first.report.omissions, ...first.report.placeholders]);
    for (const code of [
        "urdf.export.sensor",
        "urdf.export.lidar-zone",
        "urdf.export.plugin-locks",
        "urdf.export.dynamics",
        "urdf.export.ackermann",
        "urdf.export.inertia",
        "urdf.export.effort-placeholder",
    ]) assert.ok(reported.includes(code), reported.join(","));
});

test("VEH-06d keeps bound and hidden nodes out of the body mesh", () => {
    const document = createMeshDocument({
        materials: [{ id: "paint", kd: [0.2, 0.2, 0.2], d: 1, ns: 0 }],
        nodes: [
            { id: "cab", name: "cab", parentId: null, primitives: [triangle()] },
            { id: "spare", name: "spare", parentId: null, primitives: [triangle()] },
            { id: "wheel", name: "front_left_wheel", parentId: null, primitives: [triangle()] },
        ],
    });
    const encoded = encodeMeshDocumentGlb(document);
    const parsed = readGlb(encoded.glbBytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        copyChunks: true,
    });
    const bin = parsed.chunks.find((chunk) => chunk.type === 0x004e4942)?.bytes;
    const packed = packVehicleGltf({
        json: parsed.json,
        buffers: [bin],
        imageBytes: [],
        generator: "cev-sim.vehicle-urdf-export@1",
    });
    const names = new Map(packed.nodes.map((node) => [node.name, node.index]));
    const manifest = modelFreeManifest();
    manifest.model = {
        asset: "body.glb",
        dependencies: [],
        hiddenNodeIndices: [names.get("spare")],
        scale: 1,
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        offset: { x: 0, y: 0, z: 0 },
    };
    manifest.boundingBox = { size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0 } };
    manifest.wheels[0].visual = { kind: "model-node", nodeIndex: names.get("front_left_wheel") };
    const exported = exportVehicleUrdf(manifest, { assets: { "body.glb": packed.glbBytes } });
    assert.equal(exported.mediaType, "application/zip");
    const repeat = exportVehicleUrdf(manifest, { assets: { "body.glb": packed.glbBytes } });
    assert.deepEqual(exported.bytes, repeat.bytes);
    const files = unzipSync(exported.bytes);
    const urdf = strFromU8(files["city-car.urdf"]);
    const frontLeft = urdf.match(/<link name="front-left-link">[\s\S]*?<\/link>/)[0];
    assert.match(frontLeft, /<mesh filename="meshes\/[a-f0-9]{64}\.glb"\/>/);
    assert.doesNotMatch(frontLeft, /<cylinder /);
    const bodyName = urdf.match(/<link name="base_link">[\s\S]*?<mesh filename="([^"]+)"/)[1];
    const bodyNodes = nodeNames(files[bodyName]);
    assert.ok(bodyNodes.includes("cab"));
    assert.equal(bodyNodes.includes("spare"), false);
    assert.equal(bodyNodes.includes("front_left_wheel"), false);
    assert.equal(readGlbNodeParts(files[bodyName]).some((part) => part.name === "spare"), false);
});

test("VEH-06d exports an imported bound wheel as its own mesh", () => {
    const plan = planUrdfImport(carPackage());
    const accepted = acceptUrdfImport(plan, { acceptAdjustments: true });
    assert.equal(accepted.ok, true, codes(accepted.issues).join(","));
    const manifest = manifestFromUrdfImport(plan, accepted, { id: "imported-car", name: "Imported" });
    const exported = exportVehicleUrdf(manifest, {
        assets: { [plan.closure.asset.name]: plan.closure.asset.bytes },
    });
    const files = unzipSync(exported.bytes);
    const urdf = strFromU8(files["imported-car.urdf"]);
    const bodyName = urdf.match(/<link name="base_link">[\s\S]*?<mesh filename="([^"]+)"/)[1];
    const bodyNodes = nodeNames(files[bodyName]);
    assert.equal(bodyNodes.includes("fl_wheel"), false);
    assert.match(urdf, /<link name="front-left-link">[\s\S]*<mesh filename="meshes\/[a-f0-9]{64}\.glb"\/>/);
    assert.doesNotMatch(urdf, /<link name="front-left-link">[\s\S]*<cylinder /);
});
