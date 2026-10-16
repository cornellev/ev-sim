import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync, strFromU8 } from "fflate";
import { DOMParser, Document, Element } from "@xmldom/xmldom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import URDFLoader from "urdf-loader";

import { acceptUrdfImport, manifestFromUrdfImport, planUrdfImport } from "../app/vehicles/urdf/planUrdfImport.js";
import { exportVehicleUrdf } from "../app/vehicles/urdf/exportVehicleUrdf.js";
import { carPackage } from "./helpers/urdf-fixtures.js";

globalThis.DOMParser = DOMParser;
globalThis.Document = Document;
globalThis.Element = Element;

if (typeof Element.prototype.querySelector !== "function") {
    Element.prototype.querySelector = function querySelector(selector) {
        const match = /^child\[link="([^"]*)"\]$/u.exec(selector);
        if (!match) throw new Error(`Unsupported test selector ${selector}`);
        const nodes = this.getElementsByTagName("child");
        for (let index = 0; index < nodes.length; index += 1) {
            if (nodes[index].getAttribute("link") === match[1]) return nodes[index];
        }
        return null;
    };
}

function loadRobot(xml, files = new Map()) {
    const loader = new URDFLoader();
    const pending = [];
    loader.loadMeshCb = (path, _manager, _material, done) => {
        const bytes = files.get(path);
        if (!bytes) {
            done(null, new Error(`Missing ${path}`));
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
    const visuals = object.children.filter((child) => child.isURDFVisual);
    for (const visual of visuals) {
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

function forwardIndex(points, origin) {
    let selected = -1;
    let ahead = Number.NEGATIVE_INFINITY;
    points.forEach((point, index) => {
        const delta = point.x - origin.x;
        if (delta > ahead) {
            ahead = delta;
            selected = index;
        }
    });
    return selected;
}

function moved(before, after) {
    return before.distanceTo(after) > 1e-4;
}

function assertSteeringMotion(robot, wheelLinkName, steerName, spinName) {
    const link = robot.links[wheelLinkName];
    const visuals = link.children.filter((child) => child.isURDFVisual);
    assert.equal(visuals.length, 1);
    const origin = link.getWorldPosition(new THREE.Vector3());
    const rest = worldPoints(link);
    const index = forwardIndex(rest, origin);
    const forward = rest[index];
    assert.ok(forward, "wheel visual has no vertices");
    assert.ok(forward.x - origin.x > 0.05, `expected a vertex ahead of the steer axis, got ${forward.x - origin.x}`);

    const bodyBefore = worldPoints(robot.links.base_link).map((point) => point.clone());
    robot.setJointValue(steerName, 0.3);
    robot.updateMatrixWorld(true);
    const steered = worldPoints(link)[index];
    assert.ok(steered.y > forward.y + 1e-3, `positive steer should move the forward vertex toward ROS +Y (${forward.y} -> ${steered.y})`);

    robot.setJointValue(steerName, -0.3);
    robot.updateMatrixWorld(true);
    const opposite = worldPoints(link)[index];
    assert.ok(opposite.y < forward.y - 1e-3);

    robot.setJointValue(steerName, 0);
    robot.setJointValue(spinName, 0.8);
    robot.updateMatrixWorld(true);
    const spun = worldPoints(link);
    assert.ok(spun.some((point, index) => moved(rest[index], point)), "spin left the wheel visual unchanged");

    robot.updateMatrixWorld(true);
    const bodyAfter = worldPoints(robot.links.base_link);
    bodyAfter.forEach((point, index) => {
        assert.ok(point.distanceTo(bodyBefore[index]) < 1e-6, "body visual moved with a wheel joint");
    });
}

test("VEH-06e drives a generated cylinder at both steer signs and through spin", async () => {
    const manifest = {
        id: "cylinder-car",
        name: "Cylinder",
        boundingBox: { size: { x: 2, y: 0.5, z: 1 }, center: { x: 0, y: 0.25, z: 0 } },
        wheels: [
            { id: "front-left", side: "left", position: { x: 0.8, y: 0.25, z: 0.5 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "rear-left", side: "left", position: { x: -0.7, y: 0.25, z: 0.5 }, radius: 0.25, width: 0.15, steerable: false },
            { id: "rear-right", side: "right", position: { x: -0.7, y: 0.25, z: -0.5 }, radius: 0.25, width: 0.15, steerable: false },
        ],
        kinematics: { maxSteeringAngle: 0.6 },
        model: { asset: null },
    };
    const exported = exportVehicleUrdf(manifest);
    const robot = await loadRobot(new TextDecoder().decode(exported.bytes));
    assertSteeringMotion(robot, "front-left-link", "front-left-steer", "front-left-spin");
});

test("VEH-06e drives a bound wheel mesh without a second wheel visual", async () => {
    const plan = planUrdfImport(carPackage());
    const accepted = acceptUrdfImport(plan, { acceptAdjustments: true });
    assert.equal(accepted.ok, true);
    const manifest = manifestFromUrdfImport(plan, accepted, { id: "bound-car", name: "Bound" });
    const exported = exportVehicleUrdf(manifest, {
        assets: { [plan.closure.asset.name]: plan.closure.asset.bytes },
    });
    const files = unzipSync(exported.bytes);
    const xml = strFromU8(files["bound-car.urdf"]);
    const meshes = new Map();
    for (const [path, bytes] of Object.entries(files)) {
        if (path.endsWith(".glb")) meshes.set(path, bytes);
    }
    const robot = await loadRobot(xml, meshes);
    assertSteeringMotion(robot, "front-left-link", "front-left-steer", "front-left-spin");
});
