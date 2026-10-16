import assert from "node:assert/strict";
import test from "node:test";

import { planUrdfImport } from "../app/vehicles/urdf/planUrdfImport.js";
import { collectUrdfClosure } from "../app/vehicles/urdf/github/collectUrdfClosure.js";
import { readUrdfPackage } from "../app/vehicles/urdf/urdfPackage.js";
import { GitHubUrdfService } from "../server/vehicles/GitHubUrdfService.js";
import { createGitHubFixture } from "./helpers/github-urdf-fixtures.js";
import { triangleStl } from "./helpers/urdf-fixtures.js";

const encoder = new TextEncoder();
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);

function panel(filename) {
    return `<?xml version="1.0"?>
<robot name="panel">
  <link name="base_link">
    <visual><geometry><mesh filename="${filename}"/></geometry></visual>
  </link>
</robot>
`;
}

function asBytes(value) {
    return value instanceof Uint8Array ? value : encoder.encode(value);
}

function localPackage(entryPath, files) {
    return readUrdfPackage({
        entryPath,
        files: Object.entries(files).map(([filePath, bytes]) => ({ path: filePath, bytes: asBytes(bytes) })),
    });
}

function fileHex(pkg) {
    return pkg.files.map((file) => [file.path, Buffer.from(file.bytes).toString("hex")]);
}

function indexOf(files) {
    const entries = new Map();
    const bytes = new Map();
    for (const [path, value] of Object.entries(files)) {
        const data = value instanceof Uint8Array ? value : encoder.encode(value);
        bytes.set(path, data);
        entries.set(path, { path, mode: "100644", type: "blob", sha: path, size: data.byteLength });
    }
    return {
        entries,
        readFile: async (path) => bytes.get(path),
    };
}

async function acquired(files, url) {
    const fixture = createGitHubFixture({ files });
    const service = new GitHubUrdfService({ fetchImpl: fixture.fetchImpl });
    const result = await service.fetch({ url });
    return result;
}

test("VEH-07c downloads the same STL closure as a local selection", async () => {
    const stl = triangleStl([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 0, 1]);
    const urdf = panel("meshes/panel.stl");
    const files = { "robot.urdf": urdf, "meshes/panel.stl": stl, "notes.txt": "ignore" };
    const result = await acquired(files, "https://github.com/acme/robot/blob/main/robot.urdf");
    assert.equal(result.ok, true, result.diagnostics.map((entry) => entry.message).join("\n"));
    assert.equal(result.package.source.kind, "github");
    assert.equal(result.package.source.commitSha === result.package.source.treeSha, false);
    const local = localPackage("robot.urdf", {
        "robot.urdf": urdf,
        "meshes/panel.stl": stl,
    });
    assert.deepEqual(fileHex(result.package), fileHex(local));
    const remotePlan = planUrdfImport(result.package);
    const localPlan = planUrdfImport(local);
    assert.ok(remotePlan.closure, remotePlan.diagnostics.map((entry) => entry.message).join("\n"));
    assert.deepEqual(remotePlan.closure.asset.bytes, localPlan.closure.asset.bytes);
});

test("VEH-07c downloads an OBJ material texture through the existing parsers", async () => {
    const obj = "mtllib panel.mtl\no body\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl mat\nf 1 2 3\n";
    const mtl = "newmtl mat\nKd 1 0 0\nmap_Kd panel.png\n";
    const urdf = panel("panel.obj");
    const files = {
        "robot.urdf": urdf,
        "panel.obj": obj,
        "panel.mtl": mtl,
        "panel.png": PNG,
    };
    const result = await acquired(files, "https://raw.githubusercontent.com/acme/robot/main/robot.urdf");
    assert.equal(result.ok, true, result.diagnostics.map((entry) => entry.message).join("\n"));
    const local = localPackage("robot.urdf", {
        "robot.urdf": urdf,
        "panel.obj": obj,
        "panel.mtl": mtl,
        "panel.png": PNG,
    });
    assert.deepEqual(fileHex(result.package), fileHex(local));
    const remotePlan = planUrdfImport(result.package);
    const localPlan = planUrdfImport(local);
    assert.ok(remotePlan.closure, remotePlan.diagnostics.map((entry) => entry.message).join("\n"));
    assert.deepEqual(remotePlan.closure.asset.bytes, localPlan.closure.asset.bytes);
});

test("VEH-07c resolves package:// through package.xml in the same repository", async () => {
    const stl = triangleStl([[0, 0, 0], [1, 0, 0], [0, 0, 1]], [0, 1, 0]);
    const urdf = panel("package://body_pkg/panel.stl");
    const manifest = "<?xml version=\"1.0\"?><package><name>body_pkg</name></package>";
    const files = {
        "robot.urdf": urdf,
        "meshes_pkg/package.xml": manifest,
        "meshes_pkg/panel.stl": stl,
        "other/package.xml": "<?xml version=\"1.0\"?><package><name>other</name></package>",
        "other/secret.stl": stl,
    };
    const fixture = createGitHubFixture({ files });
    const service = new GitHubUrdfService({ fetchImpl: fixture.fetchImpl });
    const result = await service.fetch({ url: "https://github.com/acme/robot/blob/main/robot.urdf" });
    assert.equal(result.ok, true, result.diagnostics.map((entry) => entry.message).join("\n"));
    assert.deepEqual(result.package.files.map((file) => file.path), [
        "meshes_pkg/package.xml",
        "meshes_pkg/panel.stl",
        "robot.urdf",
    ]);
    const local = localPackage("robot.urdf", {
        "robot.urdf": urdf,
        "meshes_pkg/package.xml": manifest,
        "meshes_pkg/panel.stl": stl,
    });
    const remotePlan = planUrdfImport(result.package);
    const localPlan = planUrdfImport(local);
    assert.deepEqual(remotePlan.closure.asset.bytes, localPlan.closure.asset.bytes);
    assert.equal(fixture.calls.some((call) => call.url.includes("/git/blobs/") && call.url.endsWith(fixture.tree.find((entry) => entry.path === "other/secret.stl").sha)), false);
});

test("VEH-07c follows glTF buffer and image URIs from the shared dependency list", async () => {
    const gltf = JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "body.bin", byteLength: 4 }],
        images: [{ uri: "body.png" }],
    });
    const urdf = panel("body.gltf");
    const files = {
        "robot.urdf": urdf,
        "body.gltf": gltf,
        "body.bin": new Uint8Array([1, 2, 3, 4]),
        "body.png": PNG,
        "unused.png": PNG,
    };
    const result = await acquired(files, "https://github.com/acme/robot/tree/main");
    assert.equal(result.ok, true, result.diagnostics.map((entry) => entry.message).join("\n"));
    assert.deepEqual(result.package.files.map((file) => file.path), ["body.bin", "body.gltf", "body.png", "robot.urdf"]);
});

test("VEH-07c returns no files when depth, count, or package bytes are exceeded", async () => {
    const urdf = panel("panel.stl");
    const files = { "robot.urdf": urdf, "panel.stl": triangleStl([[0, 0, 0], [1, 0, 0], [0, 1, 0]]) };
    const depth = indexOf(files);
    const tooDeep = await collectUrdfClosure({
        entryPath: "robot.urdf",
        index: depth.entries,
        readFile: depth.readFile,
        limits: { maxFiles: 256, maxFileBytes: 1024, maxPackageBytes: 1024, maxXmlBytes: 1024, maxDependencyDepth: 0 },
    });
    assert.equal(tooDeep.package, null);
    assert.equal(tooDeep.diagnostics[0].code, "vehicle.github.depth");

    const counted = indexOf(files);
    const tooMany = await collectUrdfClosure({
        entryPath: "robot.urdf",
        index: counted.entries,
        readFile: counted.readFile,
        limits: { maxFiles: 1, maxFileBytes: 1024, maxPackageBytes: 10_000, maxXmlBytes: 1024, maxDependencyDepth: 32 },
    });
    assert.equal(tooMany.package, null);
    assert.equal(tooMany.diagnostics[0].code, "vehicle.github.file-limit");

    const heavy = indexOf(files);
    const tooBig = await collectUrdfClosure({
        entryPath: "robot.urdf",
        index: heavy.entries,
        readFile: heavy.readFile,
        limits: { maxFiles: 256, maxFileBytes: 1024, maxPackageBytes: 8, maxXmlBytes: 1024, maxDependencyDepth: 32 },
    });
    assert.equal(tooBig.package, null);
    assert.equal(tooBig.diagnostics[0].code, "vehicle.github.package-bytes");
});
