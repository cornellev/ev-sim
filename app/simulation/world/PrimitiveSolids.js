/**
 * Deterministic solid meshes for scene primitives. Sphere and cylinder reuse
 * the asset primitive policy. Cone uses that same radial count. Pyramid is
 * five vertices. A mesh that fails the outward-convex predicate is replaced
 * by the convex hull of its vertices so collision and LiDAR share one solid.
 */

import { ASSET_PRIMITIVE_POLICY } from "../../editor-assets/AssetDefinition.js";
import { canonicalFiniteNumber } from "../kernel/SimulationHashes.js";
import { meshFromPrimitive } from "../../editor-assets/VoxelMeshSimplifier.js";
import { buildOutwardConvexMesh, proxyMeshFailure } from "./ConvexMesh.js";
import { normalizePrimitiveRecord } from "./PrimitiveRecords.js";

export const SCENE_PRIMITIVE_POLICY = Object.freeze({
    id: "scene-primitive",
    version: 1,
    sphereLongitude: ASSET_PRIMITIVE_POLICY.sphereLongitude,
    sphereLatitude: ASSET_PRIMITIVE_POLICY.sphereLatitude,
    cylinderRadial: ASSET_PRIMITIVE_POLICY.cylinderRadial,
    coneRadial: ASSET_PRIMITIVE_POLICY.cylinderRadial,
});

function finitePoint(point) {
    return point.map((value) => canonicalFiniteNumber(value));
}

function coneMesh(size, radial) {
    const radius = size.x * 0.5;
    const half = size.y * 0.5;
    const vertices = [];
    for (let segment = 0; segment < radial; segment += 1) {
        const theta = Math.PI * 2 * segment / radial;
        vertices.push([radius * Math.cos(theta), -half, radius * Math.sin(theta)]);
    }
    const apex = vertices.length;
    vertices.push([0, half, 0]);
    const base = vertices.length;
    vertices.push([0, -half, 0]);
    const triangles = [];
    for (let segment = 0; segment < radial; segment += 1) {
        const next = (segment + 1) % radial;
        triangles.push([segment, next, apex]);
        triangles.push([base, next, segment]);
    }
    return {
        vertices: vertices.map(finitePoint),
        triangles,
    };
}

function pyramidMesh(size) {
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    const vertices = [
        [-hx, -hy, -hz],
        [hx, -hy, -hz],
        [hx, -hy, hz],
        [-hx, -hy, hz],
        [0, hy, 0],
    ].map(finitePoint);
    return {
        vertices,
        triangles: [
            [0, 1, 2],
            [0, 2, 3],
            [0, 4, 1],
            [1, 4, 2],
            [2, 4, 3],
            [3, 4, 0],
        ],
    };
}

/** Local mesh centered on the origin, before yaw and translation. */
export function localPrimitiveMesh(record, policy = SCENE_PRIMITIVE_POLICY) {
    const primitive = normalizePrimitiveRecord(record);
    const { size } = primitive;
    let mesh;
    if (primitive.shape === "box") {
        mesh = meshFromPrimitive({ kind: "box", size: [size.x, size.y, size.z] }, policy);
    } else if (primitive.shape === "sphere") {
        mesh = meshFromPrimitive({ kind: "sphere", radius: size.x * 0.5 }, policy);
    } else if (primitive.shape === "cylinder") {
        mesh = meshFromPrimitive({ kind: "cylinder", radius: size.x * 0.5, height: size.y }, policy);
    } else if (primitive.shape === "cone") {
        mesh = coneMesh(size, policy.coneRadial);
    } else {
        mesh = pyramidMesh(size);
    }
    if (proxyMeshFailure(mesh.vertices, mesh.triangles, { convex: true }) === null) return mesh;
    return buildOutwardConvexMesh(mesh.vertices);
}

function transformPoint(point, primitive) {
    const c = Math.cos(primitive.rotationY);
    const s = Math.sin(primitive.rotationY);
    const x = point[0];
    const y = point[1];
    const z = point[2];
    return [
        canonicalFiniteNumber(primitive.position.x + c * x + s * z),
        canonicalFiniteNumber(primitive.position.y + y),
        canonicalFiniteNumber(primitive.position.z - s * x + c * z),
    ];
}

function meshBounds(vertices) {
    return {
        min: {
            x: Math.min(...vertices.map((point) => point[0])),
            y: Math.min(...vertices.map((point) => point[1])),
            z: Math.min(...vertices.map((point) => point[2])),
        },
        max: {
            x: Math.max(...vertices.map((point) => point[0])),
            y: Math.max(...vertices.map((point) => point[1])),
            z: Math.max(...vertices.map((point) => point[2])),
        },
    };
}

/**
 * World-space convex solid. Color is not copied. `semantic` is the perception
 * class already chosen by the caller.
 */
export function compilePrimitiveSolid(record, semantic = "unknown") {
    const primitive = normalizePrimitiveRecord(record);
    const local = localPrimitiveMesh(primitive);
    const vertices = local.vertices.map((point) => transformPoint(point, primitive));
    return {
        id: `primitive:${primitive.id}`,
        sourceId: primitive.id,
        shape: primitive.shape,
        semantic: String(semantic || "unknown"),
        vertices,
        triangles: local.triangles.map((triangle) => [...triangle]),
        bounds: meshBounds(vertices),
    };
}
