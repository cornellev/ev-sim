import assert from "node:assert/strict";
import test from "node:test";

import { parseUrdfRobot } from "../app/vehicles/urdf/parseUrdfRobot.js";
import { parseUrdfXml } from "../app/vehicles/urdf/parseUrdfXml.js";
import { planUrdfImport } from "../app/vehicles/urdf/planUrdfImport.js";
import { readUrdfPackage } from "../app/vehicles/urdf/urdfPackage.js";
import { urdfBytes, urdfPackage } from "./helpers/urdf-fixtures.js";

function codes(issues) {
    return (issues ?? []).map((entry) => entry.code);
}

function robotXml(body, name = "fixture") {
    return `<?xml version="1.0"?>\n<robot name="${name}">\n${body}\n</robot>\n`;
}

test("VEH-06a rejects a doctype and an undeclared entity before using the document", () => {
    assert.throws(
        () => parseUrdfXml(`<?xml version="1.0"?><!DOCTYPE robot [<!ENTITY ext SYSTEM "http://example.invalid/secret">]><robot/>`),
        (error) => error.code === "vehicle.urdf.entity",
    );
    assert.throws(
        () => parseUrdfXml(`<?xml version="1.0"?><robot name="&missing;"/>`),
        (error) => error.code === "vehicle.urdf.parse",
    );
});

test("VEH-06a reports malformed XML as a parse issue", () => {
    const parsed = parseUrdfRobot("<robot><link name='base'></robot>");
    assert.equal(parsed.robot, null);
    assert.ok(codes(parsed.issues).includes("vehicle.urdf.parse"));
});

test("VEH-06a rejects a path that leaves the selected package", () => {
    const pkg = readUrdfPackage({
        entryPath: "robot.urdf",
        files: [
            { path: "robot.urdf", bytes: urdfBytes(robotXml(`<link name="base_link"/>`)) },
            { path: "../secret.stl", bytes: urdfBytes("nope") },
        ],
    });
    assert.ok(codes(pkg.diagnostics).includes("vehicle.urdf.package-escape"));
    assert.equal(pkg.fileMap.has("../secret.stl"), false);
});

test("VEH-06a keeps one rooted tree and rejects two roots, a cycle, and mimic", () => {
    const rooted = parseUrdfRobot(robotXml(`
      <link name="base_link"/>
      <link name="cabin"/>
      <joint name="cabin_joint" type="fixed">
        <parent link="base_link"/><child link="cabin"/>
      </joint>
    `));
    assert.equal(rooted.robot.root, "base_link");
    assert.deepEqual(codes(rooted.issues), []);

    const two = parseUrdfRobot(robotXml(`<link name="a"/><link name="b"/>`));
    assert.ok(codes(two.issues).includes("vehicle.urdf.multiple-roots"));

    const cycle = parseUrdfRobot(robotXml(`
      <link name="a"/><link name="b"/>
      <joint name="ab" type="fixed"><parent link="a"/><child link="b"/></joint>
      <joint name="ba" type="fixed"><parent link="b"/><child link="a"/></joint>
    `));
    assert.ok(codes(cycle.issues).includes("vehicle.urdf.cycle"));

    const mimic = parseUrdfRobot(robotXml(`
      <link name="base_link"/><link name="door"/>
      <joint name="hinge" type="revolute">
        <parent link="base_link"/><child link="door"/>
        <axis xyz="0 0 1"/>
        <mimic joint="other" multiplier="1"/>
      </joint>
    `));
    assert.ok(codes(mimic.issues).includes("vehicle.urdf.mimic"));
});

test("VEH-06a rejects prismatic joints and classifies steer plus spin before any mesh is read", () => {
    const prismatic = parseUrdfRobot(robotXml(`
      <link name="base_link"/><link name="slide"/>
      <joint name="slider" type="prismatic">
        <parent link="base_link"/><child link="slide"/>
        <axis xyz="1 0 0"/>
      </joint>
    `));
    assert.ok(codes(prismatic.issues).includes("vehicle.urdf.joint-type"));

    const steered = parseUrdfRobot(robotXml(`
      <link name="base_link"/>
      <link name="fl_steer"/>
      <link name="fl_wheel">
        <visual>
          <geometry><mesh filename="http://example.invalid/not-fetched.stl"/></geometry>
        </visual>
      </link>
      <joint name="fl_steer" type="revolute">
        <parent link="base_link"/><child link="fl_steer"/>
        <origin xyz="0.8 0.5 0.25"/>
        <axis xyz="0 0 1"/>
        <limit lower="-0.4" upper="0.4" effort="1" velocity="1"/>
      </joint>
      <joint name="fl_spin" type="continuous">
        <parent link="fl_steer"/><child link="fl_wheel"/>
        <axis xyz="0 1 0"/>
      </joint>
    `));
    assert.equal(steered.robot.classification.wheels.length, 1);
    assert.equal(steered.robot.classification.wheels[0].steeringJoint, "fl_steer");
    assert.equal(steered.robot.joints.fl_spin.role, "wheel-spin");
    assert.equal(steered.robot.joints.fl_steer.role, "steering");
    assert.equal(codes(steered.issues).includes("vehicle.urdf.missing-mesh"), false);
});

test("VEH-06a rejects xacro and an external mesh URI", () => {
    const xacro = parseUrdfRobot(robotXml(`<xacro:include filename="other.urdf"/>`), { entryPath: "robot.urdf" });
    assert.equal(xacro.robot, null);
    assert.ok(codes(xacro.issues).includes("vehicle.urdf.xacro"));

    const plan = planUrdfImport(urdfPackage("robot.urdf", [{
        path: "robot.urdf",
        bytes: robotXml(`
          <link name="base_link">
            <visual><geometry><mesh filename="https://example.invalid/body.stl"/></geometry></visual>
          </link>
        `),
    }]));
    assert.equal(plan.closure, null);
    assert.ok(codes(plan.diagnostics).includes("vehicle.urdf.external-uri"));
});
