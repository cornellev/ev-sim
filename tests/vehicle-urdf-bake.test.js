import assert from "node:assert/strict";
import test from "node:test";

import { determinant3, mapJointAxis, cevPointToRosMatrix } from "../app/vehicles/urdf/rosCevBasis.js";
import { planUrdfImport } from "../app/vehicles/urdf/planUrdfImport.js";
import { readGlbNodeParts } from "../app/vehicles/urdf/meshSources.js";
import { triangleStl, urdfPackage } from "./helpers/urdf-fixtures.js";

function codes(issues) {
    return (issues ?? []).map((entry) => entry.code);
}

function panelUrdf(filename) {
    return `<?xml version="1.0"?>
<robot name="panel">
  <link name="base_link">
    <visual>
      <geometry><mesh filename="${filename}"/></geometry>
    </visual>
  </link>
</robot>
`;
}

function triangleNormal(positions, indices) {
    const a = positions[indices[0]];
    const b = positions[indices[1]];
    const c = positions[indices[2]];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

test("VEH-06b swaps ROS Y into vehicle +Z and reverses winding", () => {
    const basis = cevPointToRosMatrix();
    assert.ok(determinant3(basis) < 0);
    assert.deepEqual(mapJointAxis({ x: 0, y: 0, z: 1 }), { x: 0, y: -1, z: 0 });

    const plan = planUrdfImport(urdfPackage("robot.urdf", [
        { path: "robot.urdf", bytes: panelUrdf("panel.stl") },
        { path: "panel.stl", bytes: triangleStl([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 0, 1]) },
    ]));
    assert.ok(plan.closure, codes(plan.diagnostics).join(","));
    const parts = readGlbNodeParts(plan.closure.asset.bytes);
    const left = parts[0].positions.find((point) => Math.abs(point[2] - 1) < 1e-5 && Math.abs(point[0]) < 1e-5);
    assert.ok(left, `expected a ROS +Y vertex on vehicle +Z, got ${JSON.stringify(parts[0].positions)}`);
    const normal = triangleNormal(parts[0].positions, parts[0].indices);
    assert.ok(normal[1] > 0, `expected the flipped normal to point +Y, got ${normal}`);
});

test("VEH-06b ignores the mesh filename when the bytes match", () => {
    const bytes = triangleStl([[0, 0, 0], [1, 0, 0], [0, 0, 1]], [0, 1, 0]);
    const left = planUrdfImport(urdfPackage("robot.urdf", [
        { path: "robot.urdf", bytes: panelUrdf("body-a.stl") },
        { path: "body-a.stl", bytes },
    ]));
    const right = planUrdfImport(urdfPackage("robot.urdf", [
        { path: "robot.urdf", bytes: panelUrdf("body-b.stl") },
        { path: "body-b.stl", bytes },
    ]));
    assert.ok(left.closure && right.closure);
    assert.deepEqual(left.closure.asset.bytes, right.closure.asset.bytes);
});

test("VEH-06b blocks a missing mesh and a COLLADA mesh", () => {
    const missing = planUrdfImport(urdfPackage("robot.urdf", [{
        path: "robot.urdf",
        bytes: panelUrdf("missing.stl"),
    }]));
    assert.equal(missing.closure, null);
    assert.ok(codes(missing.diagnostics).includes("vehicle.urdf.missing-mesh"));

    const dae = planUrdfImport(urdfPackage("robot.urdf", [
        { path: "robot.urdf", bytes: panelUrdf("body.dae") },
        { path: "body.dae", bytes: urdfBytesUnused() },
    ]));
    assert.equal(dae.closure, null);
    assert.ok(codes(dae.diagnostics).includes("vehicle.urdf.unsupported-mesh"));
});

function urdfBytesUnused() {
    return new TextEncoder().encode("<collada/>");
}

test("VEH-06b uses collision bounds when the visual is larger", () => {
    const plan = planUrdfImport(urdfPackage("robot.urdf", [{
        path: "robot.urdf",
        bytes: `<?xml version="1.0"?>
<robot name="box">
  <link name="base_link">
    <visual><geometry><box size="4 2 1"/></geometry></visual>
    <collision><geometry><box size="1 0.4 0.2"/></geometry></collision>
  </link>
</robot>
`,
    }]));
    assert.ok(plan.closure, codes(plan.diagnostics).join(","));
    assert.deepEqual(plan.body.boundingBox.size, { x: 1, y: 0.2, z: 0.4 });
    assert.deepEqual(plan.body.boundingBox.center, { x: 0, y: 0, z: 0 });
});
