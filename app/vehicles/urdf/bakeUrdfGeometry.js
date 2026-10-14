/**
 * Bake a URDF rest pose into a canonical vehicle GLB in the vehicle frame.
 * Hidden-node suppression is not applied; placement uses the full source.
 */

import { createMeshDocument } from "../../editor-assets/mesh/MeshDocument.js";
import { encodeMeshDocumentGlb } from "../../editor-assets/mesh/MeshGlbEncoder.js";
import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";
import { GLB_BIN_CHUNK, readGlb } from "../../simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../../simulation/visual/VisualLayer.js";
import { measurePlacedVehicleModel } from "../model/measurePlacedVehicle.js";
import { packVehicleGltf } from "../model/packVehicleGltf.js";
import { validateVehicleModelClosure } from "../model/validateVehicleModel.js";
import { loadMeshPrimitives } from "./meshSources.js";
import {
    composeMatrix,
    determinant3,
    flipTriangleWinding,
    originMatrix,
    rosFrameToCev,
    transformNormal,
    transformPositions,
} from "./rosCevBasis.js";
import { resolveUrdfResource } from "./urdfPackage.js";
import { hasUrdfError, urdfIssue } from "./issue.js";

const GENERATOR = "cev-sim.vehicle-urdf@1";
const CYLINDER_SEGMENTS = 24;

function emptyBounds() {
    return {
        min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    };
}

function expandBounds(bounds, points) {
    for (const point of points) {
        for (let axis = 0; axis < 3; axis += 1) {
            bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
            bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
        }
    }
}

function boundsReady(bounds) {
    return Number.isFinite(bounds.min[0]) && Number.isFinite(bounds.max[0]);
}

function canonicalBox(bounds) {
    return {
        size: {
            x: canonicalFiniteNumber(bounds.max[0] - bounds.min[0]),
            y: canonicalFiniteNumber(bounds.max[1] - bounds.min[1]),
            z: canonicalFiniteNumber(bounds.max[2] - bounds.min[2]),
        },
        center: {
            x: canonicalFiniteNumber((bounds.min[0] + bounds.max[0]) / 2),
            y: canonicalFiniteNumber((bounds.min[1] + bounds.max[1]) / 2),
            z: canonicalFiniteNumber((bounds.min[2] + bounds.max[2]) / 2),
        },
    };
}

function placePart(part, matrix) {
    const flip = determinant3(matrix) < 0;
    return {
        name: part.name,
        positions: transformPositions(part.positions, matrix),
        normals: part.normals
            ? part.normals.map((normal) => {
                const transformed = transformNormal(matrix, normal);
                return [transformed.x, transformed.y, transformed.z];
            })
            : null,
        indices: flip ? flipTriangleWinding(part.indices) : part.indices.slice(),
    };
}

function boxPart(size) {
    const hx = size[0] / 2;
    const hy = size[1] / 2;
    const hz = size[2] / 2;
    const corners = [
        [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
        [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const faces = [
        [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [2, 6, 7, 3], [0, 3, 7, 4], [1, 5, 6, 2],
    ];
    const indices = [];
    for (const face of faces) indices.push(face[0], face[1], face[2], face[0], face[2], face[3]);
    return { name: "box", positions: corners, normals: null, indices };
}

function cylinderPart(radius, length) {
    const positions = [];
    const indices = [];
    const half = length / 2;
    for (let index = 0; index < CYLINDER_SEGMENTS; index += 1) {
        const theta = (index / CYLINDER_SEGMENTS) * Math.PI * 2;
        const x = radius * Math.cos(theta);
        const y = radius * Math.sin(theta);
        positions.push([x, y, half], [x, y, -half]);
    }
    for (let index = 0; index < CYLINDER_SEGMENTS; index += 1) {
        const next = (index + 1) % CYLINDER_SEGMENTS;
        const top = index * 2;
        const bottom = top + 1;
        const nextTop = next * 2;
        const nextBottom = nextTop + 1;
        indices.push(top, nextTop, bottom, bottom, nextTop, nextBottom);
    }
    const topCenter = positions.length;
    positions.push([0, 0, half]);
    const bottomCenter = positions.length;
    positions.push([0, 0, -half]);
    for (let index = 0; index < CYLINDER_SEGMENTS; index += 1) {
        const next = (index + 1) % CYLINDER_SEGMENTS;
        indices.push(topCenter, index * 2, next * 2);
        indices.push(bottomCenter, next * 2 + 1, index * 2 + 1);
    }
    return { name: "cylinder", positions, normals: null, indices };
}

function spherePart(radius) {
    const stacks = 8;
    const slices = 12;
    const positions = [];
    const indices = [];
    for (let stack = 0; stack <= stacks; stack += 1) {
        const phi = Math.PI * (stack / stacks);
        for (let slice = 0; slice <= slices; slice += 1) {
            const theta = 2 * Math.PI * (slice / slices);
            positions.push([
                radius * Math.sin(phi) * Math.cos(theta),
                radius * Math.sin(phi) * Math.sin(theta),
                radius * Math.cos(phi),
            ]);
        }
    }
    for (let stack = 0; stack < stacks; stack += 1) {
        for (let slice = 0; slice < slices; slice += 1) {
            const first = stack * (slices + 1) + slice;
            const second = first + slices + 1;
            indices.push(first, second, first + 1, first + 1, second, second + 1);
        }
    }
    return { name: "sphere", positions, normals: null, indices };
}

function localParts(pkg, geometry, entryPath, issues) {
    if (!geometry || geometry.kind === "unknown") return [];
    if (geometry.kind === "box") return [boxPart(geometry.size)];
    if (geometry.kind === "cylinder") return [cylinderPart(geometry.radius, geometry.length)];
    if (geometry.kind === "sphere") return [spherePart(geometry.radius)];
    if (geometry.kind !== "mesh") return [];
    const resolved = resolveUrdfResource(pkg, entryPath, geometry.filename);
    if (resolved.error) {
        issues.push(resolved.error);
        return [];
    }
    const loaded = loadMeshPrimitives(pkg, resolved.path);
    issues.push(...loaded.issues);
    return loaded.parts;
}

function frameMatrix(robot, linkName, origin, scale) {
    const frame = robot.frames[linkName];
    if (!frame) return null;
    return rosFrameToCev(composeMatrix(frame.matrix, originMatrix(origin, scale)));
}

function ensureNode(nodes, id, name, parentId) {
    let node = nodes.find((entry) => entry.id === id);
    if (!node) {
        node = { id, name, parentId, primitives: [] };
        nodes.push(node);
    }
    return node;
}

function addParts(node, parts) {
    for (const part of parts) {
        if (!part.positions?.length || !part.indices?.length) continue;
        node.primitives.push({
            positions: part.positions,
            normals: part.normals,
            uvs: null,
            indices: part.indices,
            materialId: "urdf",
        });
    }
}

function owningWheel(robot, linkName, wheelLinks, carrierLinks) {
    let link = linkName;
    const seen = new Set();
    while (link && !seen.has(link)) {
        seen.add(link);
        if (wheelLinks.has(link)) return link;
        if (carrierLinks.has(link)) return carrierLinks.get(link);
        const parent = Object.values(robot.joints).find((joint) => joint.child === link);
        if (!parent) return null;
        link = parent.parent;
    }
    return null;
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
    const imageBytes = (parsed.json.images ?? []).map((image) => {
        const match = encoded.images.find((entry) => entry.path === image.uri);
        if (!match) throw new Error(`Mesh image "${image.uri}" was not declared.`);
        return match.bytes;
    });
    return packVehicleGltf({
        json: parsed.json,
        buffers,
        imageBytes,
        generator: GENERATOR,
    });
}

function closureFromPacked(packed) {
    validateVehicleModelClosure({ glbBytes: packed.glbBytes, dependencies: packed.dependencies });
    const sha256 = sha256ExactBytes(packed.glbBytes);
    return {
        asset: {
            name: `${sha256}.glb`,
            mediaType: "model/gltf-binary",
            sha256,
            size: packed.glbBytes.byteLength,
            bytes: packed.glbBytes,
        },
        dependencies: packed.dependencies,
        nodes: packed.nodes,
    };
}

/**
 * @returns geometry, a canonical closure, and the placed measurement.
 * Wheel role review is applied by `planUrdfImport`.
 */
export function bakeUrdfGeometry(robot, pkg) {
    const issues = [];
    const wheelLinks = new Map((robot.classification?.wheels ?? []).map((wheel) => [wheel.link, wheel]));
    const carrierLinks = new Map();
    for (const wheel of wheelLinks.values()) {
        if (!wheel.steeringJoint) continue;
        const carrier = robot.joints[wheel.steeringJoint]?.child;
        if (carrier) carrierLinks.set(carrier, wheel.link);
    }
    const nodes = [];
    const visualBounds = emptyBounds();
    const collisionBounds = emptyBounds();
    const placedVisuals = [];

    for (const link of Object.values(robot.links)) {
        const wheel = owningWheel(robot, link.name, wheelLinks, carrierLinks);
        for (const visual of link.visuals) {
            const scale = visual.geometry?.kind === "mesh" ? visual.geometry.scale : [1, 1, 1];
            const matrix = frameMatrix(robot, link.name, visual.origin, scale);
            if (!matrix) continue;
            const parts = localParts(pkg, visual.geometry, pkg.entryPath, issues).map((part) => placePart(part, matrix));
            for (const part of parts) expandBounds(visualBounds, part.positions);
            placedVisuals.push({ link: link.name, wheel, parts });
        }
        for (const collision of link.collisions) {
            const scale = collision.geometry?.kind === "mesh" ? collision.geometry.scale : [1, 1, 1];
            const matrix = frameMatrix(robot, link.name, collision.origin, scale);
            if (!matrix) continue;
            const parts = localParts(pkg, collision.geometry, pkg.entryPath, issues).map((part) => placePart(part, matrix));
            for (const part of parts) expandBounds(collisionBounds, part.positions);
        }
    }

    for (const wheel of [...wheelLinks.keys()].sort()) ensureNode(nodes, wheel, wheel, null);
    for (const placed of placedVisuals) {
        const parentId = placed.wheel ?? placed.link;
        const parentName = placed.wheel ?? placed.link;
        const parent = ensureNode(nodes, parentId, parentName, null);
        const authored = placed.parts.some((part) => part.name && !/^(?:part-\d+|box|cylinder|sphere)$/u.test(part.name));
        if (!authored) {
            addParts(parent, placed.parts);
            continue;
        }
        for (const part of placed.parts) {
            const childId = `${parentId}/${part.name}`;
            const child = ensureNode(nodes, childId, part.name, parentId);
            addParts(child, [part]);
        }
    }

    const drawable = nodes.some((node) => node.primitives.length > 0);
    let closure = null;
    let measurement = null;
    let model = { scale: 1, rotation: { x: 0, y: 0, z: 0, order: "XYZ" }, offset: { x: 0, y: 0, z: 0 } };
    let boundingBox = null;
    if (hasUrdfError(issues)) {
        return { closure, measurement, model, boundingBox, wheelLinks: [...wheelLinks.values()], issues };
    }
    if (drawable) {
        try {
            const document = createMeshDocument({
                materials: [{ id: "urdf", kd: [0.75, 0.75, 0.78], d: 1, ns: 0 }],
                nodes,
            });
            closure = closureFromPacked(packDocument(document));
            const open = measurePlacedVehicleModel({ glbBytes: closure.asset.bytes, model: { scale: 1, rotation: model.rotation, offset: { x: 0, y: 0, z: 0 } } });
            const sourceBounds = boundsReady(collisionBounds) ? collisionBounds : null;
            const visualCenter = open.sceneBounds?.center;
            if (sourceBounds) boundingBox = canonicalBox(sourceBounds);
            else if (visualCenter && open.sceneBounds) {
                boundingBox = {
                    size: {
                        x: canonicalFiniteNumber(open.sceneBounds.size.x),
                        y: canonicalFiniteNumber(open.sceneBounds.size.y),
                        z: canonicalFiniteNumber(open.sceneBounds.size.z),
                    },
                    center: {
                        x: canonicalFiniteNumber(visualCenter.x),
                        y: canonicalFiniteNumber(visualCenter.y),
                        z: canonicalFiniteNumber(visualCenter.z),
                    },
                };
            }
            if (boundingBox && visualCenter) {
                model = {
                    ...model,
                    offset: {
                        x: canonicalFiniteNumber(visualCenter.x - boundingBox.center.x),
                        y: canonicalFiniteNumber(visualCenter.y - boundingBox.center.y),
                        z: canonicalFiniteNumber(visualCenter.z - boundingBox.center.z),
                    },
                };
            }
            measurement = measurePlacedVehicleModel({
                glbBytes: closure.asset.bytes,
                model,
                boundingBox,
            });
        } catch (error) {
            issues.push(urdfIssue("vehicle.urdf.unsupported-mesh", "model", error.message));
            closure = null;
            measurement = null;
        }
    } else if (boundsReady(collisionBounds)) {
        boundingBox = canonicalBox(collisionBounds);
    } else {
        issues.push(urdfIssue("vehicle.urdf.unsupported-mesh", "robot", "The URDF has no supported visual or collision geometry."));
    }
    return {
        closure,
        measurement,
        model,
        boundingBox,
        wheelLinks: [...wheelLinks.values()],
        issues,
    };
}
