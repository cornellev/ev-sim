/**
 * Articulated URDF export.
 * Bound wheels become their own links. Generated wheels are cylinder visuals.
 * Revolute effort and velocity are reported placeholders, not physical limits.
 */

import { zipSync, strToU8 } from "fflate";

import { multiplyMat4 } from "../../math/linalg.js";
import { createMeshDocument } from "../../editor-assets/mesh/MeshDocument.js";
import { encodeMeshDocumentGlb } from "../../editor-assets/mesh/MeshGlbEncoder.js";
import { GLB_BIN_CHUNK, readGlb } from "../../simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../../simulation/visual/VisualLayer.js";
import { measurePlacedVehicleModel } from "../model/measurePlacedVehicle.js";
import { packVehicleGltf } from "../model/packVehicleGltf.js";
import { readGlbNodeParts } from "./meshSources.js";
import {
    cevPointToRosMatrix,
    cevToRosPoint,
    determinant3,
    flipTriangleWinding,
    transformNormal,
    transformPositions,
} from "./rosCevBasis.js";
import { urdfIssue } from "./issue.js";

const ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0);

export function formatUrdfNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("URDF numbers must be finite.");
    const normalized = Object.is(number, -0) ? 0 : number;
    const text = normalized.toFixed(9).replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");
    return text === "-0" ? "0" : text;
}

function vecText(values) {
    return values.map((value) => formatUrdfNumber(value)).join(" ");
}

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function safeId(id) {
    const text = String(id ?? "vehicle");
    return /^[A-Za-z0-9._-]+$/u.test(text) ? text : "vehicle";
}

function rosVector(point) {
    const ros = cevToRosPoint(point);
    return [ros.x, ros.y, ros.z];
}

function subtree(parents, roots) {
    const children = parents.map(() => []);
    parents.forEach((parent, index) => {
        if (parent >= 0) children[parent].push(index);
    });
    const selected = new Set();
    const stack = roots.filter((index) => Number.isInteger(index) && index >= 0);
    while (stack.length > 0) {
        const current = stack.pop();
        if (selected.has(current)) continue;
        selected.add(current);
        stack.push(...children[current]);
    }
    return selected;
}

function packDocument(document) {
    const encoded = encodeMeshDocumentGlb(document);
    const parsed = readGlb(encoded.glbBytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        copyChunks: true,
        ErrorType: Error,
    });
    const bin = parsed.chunks.find((chunk) => chunk.type === GLB_BIN_CHUNK)?.bytes ?? null;
    const buffers = (parsed.json.buffers ?? []).map((buffer, index) => (
        index === 0 ? bin?.subarray(0, Number(buffer.byteLength) || bin.length) : null
    ));
    const packed = packVehicleGltf({
        json: parsed.json,
        buffers,
        imageBytes: [],
        generator: "cev-sim.vehicle-urdf-export@1",
    });
    const sha256 = sha256ExactBytes(packed.glbBytes);
    return {
        name: `${sha256}.glb`,
        bytes: packed.glbBytes,
        dependencies: packed.dependencies,
    };
}

function documentFromParts(parts) {
    const nodes = [];
    for (const part of parts) {
        let node = nodes.find((entry) => entry.name === part.name);
        if (!node) {
            node = { id: `node-${nodes.length}`, name: part.name || `part-${nodes.length}`, parentId: null, primitives: [] };
            nodes.push(node);
        }
        node.primitives.push({
            positions: part.positions,
            normals: part.normals,
            uvs: null,
            indices: part.indices,
            materialId: "urdf",
        });
    }
    return createMeshDocument({
        materials: [{ id: "urdf", kd: [0.75, 0.75, 0.78], d: 1, ns: 0 }],
        nodes,
    });
}

function placeParts(parts, matrix, origin = null) {
    const flip = determinant3(matrix) < 0;
    return parts.map((part) => ({
        name: part.name,
        positions: transformPositions(part.positions, matrix).map((point) => (
            origin ? [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]] : point
        )),
        normals: part.normals
            ? part.normals.map((normal) => {
                const transformed = transformNormal(matrix, normal);
                return [transformed.x, transformed.y, transformed.z];
            })
            : null,
        indices: flip ? flipTriangleWinding(part.indices) : part.indices.slice(),
    }));
}

function splitPlacedGlb(manifest, glbBytes) {
    const measurement = measurePlacedVehicleModel({
        glbBytes,
        model: manifest.model,
        boundingBox: manifest.boundingBox,
        hiddenNodeIndices: manifest.model?.hiddenNodeIndices ?? [],
    });
    const rosMatrix = multiplyMat4(cevPointToRosMatrix(), measurement.placement.matrix);
    const parts = readGlbNodeParts(glbBytes);
    const parents = measurement.nodeTable?.parents ?? [];
    const hidden = subtree(parents, manifest.model?.hiddenNodeIndices ?? []);
    const boundRoots = (manifest.wheels ?? [])
        .filter((wheel) => wheel.visual?.kind === "model-node")
        .map((wheel) => wheel.visual.nodeIndex);
    const bound = subtree(parents, boundRoots);
    const body = placeParts(parts.filter((part) => !hidden.has(part.nodeIndex) && !bound.has(part.nodeIndex)), rosMatrix);
    const wheels = new Map();
    for (const wheel of manifest.wheels ?? []) {
        if (wheel.visual?.kind !== "model-node") continue;
        const include = subtree(parents, [wheel.visual.nodeIndex]);
        const selected = parts.filter((part) => include.has(part.nodeIndex) && !hidden.has(part.nodeIndex));
        wheels.set(wheel.id, placeParts(selected, rosMatrix, rosVector(wheel.position)));
    }
    return { body, wheels };
}

function visualMesh(filename, indent) {
    return [
        `${indent}<visual>`,
        `${indent}  <origin xyz="0 0 0" rpy="0 0 0"/>`,
        `${indent}  <geometry>`,
        `${indent}    <mesh filename="${escapeXml(filename)}"/>`,
        `${indent}  </geometry>`,
        `${indent}</visual>`,
    ];
}

function boxElement(kind, box, indent) {
    const center = rosVector(box.center);
    const size = rosVector(box.size);
    return [
        `${indent}<${kind}>`,
        `${indent}  <origin xyz="${vecText(center)}" rpy="0 0 0"/>`,
        `${indent}  <geometry>`,
        `${indent}    <box size="${vecText(size)}"/>`,
        `${indent}  </geometry>`,
        `${indent}</${kind}>`,
    ];
}

function cylinderVisual(wheel) {
    const left = wheel.side === "left" || (wheel.side == null && Number(wheel.position?.z) > 0);
    const roll = left ? -Math.PI / 2 : Math.PI / 2;
    return [
        "    <visual>",
        `      <origin xyz="0 0 0" rpy="${vecText([roll, 0, 0])}"/>`,
        "      <geometry>",
        `        <cylinder radius="${formatUrdfNumber(wheel.radius)}" length="${formatUrdfNumber(wheel.width)}"/>`,
        "      </geometry>",
        "    </visual>",
    ];
}

function spinAxis(wheel) {
    const left = wheel.side === "left" || (wheel.side == null && Number(wheel.position?.z) >= 0);
    return left ? "0 1 0" : "0 -1 0";
}

function writeUrdf({ name, box, bodyFile, wheels, wheelFiles, limit }) {
    const lines = [
        `<?xml version="1.0"?>`,
        `<robot name="${escapeXml(name)}">`,
        `  <link name="base_link">`,
    ];
    if (bodyFile) lines.push(...visualMesh(bodyFile, "    "));
    else lines.push(...boxElement("visual", box, "    "));
    lines.push(...boxElement("collision", box, "    "));
    lines.push("  </link>");
    const joints = [];
    for (const wheel of [...wheels].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
        const origin = vecText(rosVector(wheel.position));
        const wheelLink = `${wheel.id}-link`;
        const file = wheelFiles.get(wheel.id);
        if (wheel.steerable === true) {
            const steerLink = `${wheel.id}-steer-link`;
            lines.push(`  <link name="${escapeXml(steerLink)}"/>`);
            joints.push([
                `  <joint name="${escapeXml(`${wheel.id}-steer`)}" type="revolute">`,
                `    <parent link="base_link"/>`,
                `    <child link="${escapeXml(steerLink)}"/>`,
                `    <origin xyz="${origin}" rpy="0 0 0"/>`,
                `    <axis xyz="0 0 1"/>`,
                `    <limit lower="${formatUrdfNumber(-limit)}" upper="${formatUrdfNumber(limit)}" effort="0" velocity="0"/>`,
                "  </joint>",
            ].join("\n"));
            lines.push(`  <link name="${escapeXml(wheelLink)}">`);
            if (file) lines.push(...visualMesh(file, "    "));
            else lines.push(...cylinderVisual(wheel));
            lines.push("  </link>");
            joints.push([
                `  <joint name="${escapeXml(`${wheel.id}-spin`)}" type="continuous">`,
                `    <parent link="${escapeXml(steerLink)}"/>`,
                `    <child link="${escapeXml(wheelLink)}"/>`,
                `    <origin xyz="0 0 0" rpy="0 0 0"/>`,
                `    <axis xyz="${spinAxis(wheel)}"/>`,
                "  </joint>",
            ].join("\n"));
        } else {
            lines.push(`  <link name="${escapeXml(wheelLink)}">`);
            if (file) lines.push(...visualMesh(file, "    "));
            else lines.push(...cylinderVisual(wheel));
            lines.push("  </link>");
            joints.push([
                `  <joint name="${escapeXml(`${wheel.id}-spin`)}" type="continuous">`,
                `    <parent link="base_link"/>`,
                `    <child link="${escapeXml(wheelLink)}"/>`,
                `    <origin xyz="${origin}" rpy="0 0 0"/>`,
                `    <axis xyz="${spinAxis(wheel)}"/>`,
                "  </joint>",
            ].join("\n"));
        }
    }
    lines.push(...joints);
    lines.push("</robot>", "");
    return lines.join("\n");
}

function reportFor(manifest, revolute) {
    const omissions = [];
    for (const sensor of manifest.sensors ?? []) {
        omissions.push(urdfIssue("urdf.export.sensor", `sensors.${sensor.id}`, `Sensor "${sensor.id}" is not exported.`, "info"));
    }
    if ((manifest.lidarZone?.vertices?.length ?? 0) > 0 || (manifest.lidarZone?.triangles?.length ?? 0) > 0) {
        omissions.push(urdfIssue("urdf.export.lidar-zone", "lidarZone", "The baked LiDAR zone is not exported.", "info"));
    }
    if ((manifest.pluginLocks?.length ?? 0) > 0) {
        omissions.push(urdfIssue("urdf.export.plugin-locks", "pluginLocks", "Plugin locks are not exported.", "info"));
    }
    if (manifest.dynamics?.plant) {
        omissions.push(urdfIssue("urdf.export.dynamics", "dynamics.plant", `Dynamics plant "${manifest.dynamics.plant}" is not exported.`, "info"));
    }
    omissions.push(urdfIssue("urdf.export.ackermann", "kinematics", "Inner and outer steering angles are not coupled. Each carrier uses the same symmetric limit.", "info"));
    omissions.push(urdfIssue("urdf.export.inertia", "robot", "Inertia is omitted. This export does not invent mass properties.", "info"));
    const placeholders = [];
    if (revolute) {
        placeholders.push(urdfIssue(
            "urdf.export.effort-placeholder",
            "joint/limit",
            "Revolute limit effort and velocity are 0. This export does not contain torque or inertia.",
            "info",
        ));
    }
    return { omissions, placeholders };
}

function zipFiles(entries) {
    const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const data = {};
    for (const entry of sorted) {
        data[entry.path] = [entry.bytes, { level: 0, os: 0, attrs: 0, mtime: ZIP_TIME }];
    }
    return zipSync(data);
}

/**
 * Export one vehicle as a URDF document.
 * A model-free vehicle is a single `.urdf`. A vehicle with meshes is a deterministic ZIP.
 */
export function exportVehicleUrdf(manifest, { assets = {} } = {}) {
    const id = safeId(manifest?.id);
    const assetName = manifest?.model?.asset ?? null;
    const glbBytes = assetName ? assets[assetName] : null;
    if (assetName && !glbBytes) throw new Error(`Missing vehicle asset "${assetName}".`);
    const split = glbBytes ? splitPlacedGlb(manifest, glbBytes) : { body: [], wheels: new Map() };
    const files = [];
    let bodyFile = null;
    if (split.body.length > 0) {
        const packed = packDocument(documentFromParts(split.body));
        bodyFile = `meshes/${packed.name}`;
        files.push({ path: bodyFile, bytes: packed.bytes });
        for (const dependency of packed.dependencies) {
            files.push({ path: `meshes/${dependency.name}`, bytes: dependency.bytes });
        }
    }
    const wheelFiles = new Map();
    for (const [wheelId, parts] of split.wheels) {
        if (parts.length === 0) continue;
        const packed = packDocument(documentFromParts(parts));
        const path = `meshes/${packed.name}`;
        wheelFiles.set(wheelId, path);
        if (!files.some((entry) => entry.path === path)) files.push({ path, bytes: packed.bytes });
    }
    const revolute = (manifest.wheels ?? []).some((wheel) => wheel.steerable === true);
    const urdf = writeUrdf({
        name: manifest.name || id,
        box: manifest.boundingBox,
        bodyFile,
        wheels: manifest.wheels ?? [],
        wheelFiles,
        limit: manifest.kinematics?.maxSteeringAngle ?? 0.6,
    });
    const urdfName = `${id}.urdf`;
    const report = reportFor(manifest, revolute);
    report.joints = (manifest.wheels ?? []).map((wheel) => ({
        id: wheel.id,
        steer: wheel.steerable === true,
        spin: true,
        mesh: wheelFiles.get(wheel.id) ?? null,
    }));
    if (files.length === 0) {
        return {
            kind: "cev-sim.urdf-export",
            version: 1,
            filename: urdfName,
            mediaType: "application/xml",
            bytes: strToU8(urdf),
            report,
        };
    }
    files.push({ path: urdfName, bytes: strToU8(urdf) });
    return {
        kind: "cev-sim.urdf-export",
        version: 1,
        filename: `${id}-urdf.zip`,
        mediaType: "application/zip",
        bytes: zipFiles(files),
        report,
    };
}
