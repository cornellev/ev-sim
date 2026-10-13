/**
 * Measure a canonical vehicle GLB in the placed vehicle frame.
 * Placement uses the full in-scene geometry. Hidden nodes are not an input.
 */

import { mat4FromTrs, multiplyMat4, transformPointMat4 } from "../../math/linalg.js";
import { readGlb } from "../../simulation/visual/GlbContainer.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const COMPONENT_BYTES = Object.freeze({
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
});

function boundsError(message) {
    const error = new Error(message);
    error.code = "vehicle.wheel.bounds-unavailable";
    return error;
}

function finiteVector(value, size, label) {
    if (!Array.isArray(value) || value.length !== size || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
        throw boundsError(`${label} must be ${size} finite numbers.`);
    }
    return value;
}

function nodeLocalMatrix(node) {
    if (Array.isArray(node?.matrix)) return finiteVector(node.matrix, 16, "glTF node matrix");
    const translation = node?.translation ? finiteVector(node.translation, 3, "glTF node translation") : [0, 0, 0];
    const rotation = node?.rotation ? finiteVector(node.rotation, 4, "glTF node rotation") : [0, 0, 0, 1];
    const scale = node?.scale ? finiteVector(node.scale, 3, "glTF node scale") : [1, 1, 1];
    return mat4FromTrs(translation, rotation, scale);
}

function emptyBounds() {
    return {
        min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    };
}

function hasBounds(bounds) {
    return Boolean(bounds) && Number.isFinite(bounds.min[0]) && Number.isFinite(bounds.max[0]);
}

function expand(bounds, point) {
    for (let index = 0; index < 3; index += 1) {
        bounds.min[index] = Math.min(bounds.min[index], point[index]);
        bounds.max[index] = Math.max(bounds.max[index], point[index]);
    }
}

function unionBounds(target, source) {
    if (!hasBounds(source)) return target;
    expand(target, source.min);
    expand(target, source.max);
    return target;
}

function pointArray(point) {
    return [point.x, point.y, point.z];
}

function toVec(values) {
    return { x: values[0], y: values[1], z: values[2] };
}

function vec3(value, fallback = 0) {
    return {
        x: Number.isFinite(value?.x) ? value.x : fallback,
        y: Number.isFinite(value?.y) ? value.y : fallback,
        z: Number.isFinite(value?.z) ? value.z : fallback,
    };
}

/** XYZ Euler, matching THREE.Euler order XYZ. */
export function eulerXyzQuaternion(x = 0, y = 0, z = 0) {
    const c1 = Math.cos(x / 2);
    const c2 = Math.cos(y / 2);
    const c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2);
    const s2 = Math.sin(y / 2);
    const s3 = Math.sin(z / 2);
    return {
        x: s1 * c2 * c3 + c1 * s2 * s3,
        y: c1 * s2 * c3 - s1 * c2 * s3,
        z: c1 * c2 * s3 + s1 * s2 * c3,
        w: c1 * c2 * c3 - s1 * s2 * s3,
    };
}

function readVehicleGlb(bytes) {
    try {
        return readGlb(bytes, {
            requireTotalLength: true,
            requireAligned: true,
            requireLeadingJson: true,
            json: "last",
            jsonPadding: "whitespace",
            copyChunks: true,
            ErrorType: Error,
            headerMessage: "Vehicle measurement requires a glTF 2.0 binary.",
            chunkMessage: "Vehicle measurement GLB has an invalid chunk table.",
        });
    } catch (error) {
        throw boundsError(error.message);
    }
}

function parentTable(nodes) {
    const parents = Array.from({ length: nodes.length }, () => -1);
    nodes.forEach((node, index) => {
        for (const child of node?.children ?? []) {
            if (!Number.isInteger(child) || child < 0 || child >= nodes.length) {
                throw boundsError(`nodes.${index} contains an out-of-range child.`);
            }
            if (parents[child] === -1) parents[child] = index;
        }
    });
    return parents;
}

function sceneWorlds(json) {
    const nodes = json.nodes ?? [];
    const scene = json.scenes?.[json.scene ?? 0];
    const worlds = new Map();
    const visit = (index, parent, stack) => {
        if (!Number.isInteger(index) || index < 0 || index >= nodes.length) {
            throw boundsError("glTF scene references a missing node.");
        }
        if (stack.has(index)) throw boundsError("glTF node hierarchy contains a cycle.");
        stack.add(index);
        const world = multiplyMat4(parent, nodeLocalMatrix(nodes[index]));
        if (!worlds.has(index)) worlds.set(index, world);
        for (const child of nodes[index].children ?? []) visit(child, world, stack);
        stack.delete(index);
    };
    for (const root of scene?.nodes ?? []) visit(root, IDENTITY, new Set());
    return worlds;
}

function pathOf(index, parents, nodes) {
    const names = [];
    const seen = new Set();
    let cursor = index;
    while (cursor >= 0 && !seen.has(cursor)) {
        seen.add(cursor);
        names.push(String(nodes[cursor]?.name ?? ""));
        cursor = parents[cursor];
    }
    return names.reverse();
}

export function vehicleNodeCatalog(json) {
    if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw boundsError("glTF JSON must be an object.");
    }
    const nodes = json.nodes ?? [];
    const parents = parentTable(nodes);
    const worlds = sceneWorlds(json);
    return {
        parents,
        worlds,
        nodes: nodes.map((node, index) => ({
            nodeIndex: index,
            name: String(node?.name ?? ""),
            path: pathOf(index, parents, nodes),
            parentIndex: parents[index],
            inScene: worlds.has(index),
            mesh: Number.isInteger(node?.mesh) ? node.mesh : null,
        })),
    };
}

function readComponent(view, offset, type, normalized) {
    switch (type) {
        case 5120: {
            const value = view.getInt8(offset);
            return normalized ? Math.max(value / 127, -1) : value;
        }
        case 5121: {
            const value = view.getUint8(offset);
            return normalized ? value / 255 : value;
        }
        case 5122: {
            const value = view.getInt16(offset, true);
            return normalized ? Math.max(value / 32767, -1) : value;
        }
        case 5123: {
            const value = view.getUint16(offset, true);
            return normalized ? value / 65535 : value;
        }
        case 5125: {
            const value = view.getUint32(offset, true);
            return normalized ? value / 4294967295 : value;
        }
        case 5126:
            return view.getFloat32(offset, true);
        default:
            throw boundsError(`Unsupported accessor component type ${type}.`);
    }
}

function readPositions(json, bin, accessorIndex) {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor) throw boundsError(`POSITION accessor ${accessorIndex} is missing.`);
    if (accessor.sparse) throw boundsError("Sparse position accessors cannot be measured.");
    if (accessor.type !== "VEC3") throw boundsError("POSITION accessors must be VEC3.");
    if (!Number.isInteger(accessor.bufferView)) throw boundsError("POSITION accessors must reference a bufferView.");
    const bufferView = json.bufferViews?.[accessor.bufferView];
    if (!bufferView) throw boundsError(`bufferView ${accessor.bufferView} is missing.`);
    if ((bufferView.buffer ?? 0) !== 0) throw boundsError("Vehicle measurement requires positions in buffer 0.");
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    if (!componentBytes) throw boundsError(`Unsupported accessor component type ${accessor.componentType}.`);
    const count = accessor.count;
    if (!Number.isInteger(count) || count < 0) throw boundsError("POSITION accessor count is invalid.");
    const elementBytes = componentBytes * 3;
    const stride = bufferView.byteStride || elementBytes;
    if (stride < elementBytes) throw boundsError("POSITION bufferView stride is smaller than one VEC3.");
    const start = (Number(bufferView.byteOffset) || 0) + (Number(accessor.byteOffset) || 0);
    const end = count === 0 ? start : start + (count - 1) * stride + elementBytes;
    if (!bin || end > bin.byteLength) throw boundsError("POSITION accessor exceeds the GLB BIN chunk.");
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const normalized = accessor.normalized === true;
    const points = new Float64Array(count * 3);
    for (let index = 0; index < count; index += 1) {
        const offset = start + index * stride;
        points[index * 3] = readComponent(view, offset, accessor.componentType, normalized);
        points[index * 3 + 1] = readComponent(view, offset + componentBytes, accessor.componentType, normalized);
        points[index * 3 + 2] = readComponent(view, offset + componentBytes * 2, accessor.componentType, normalized);
    }
    return points;
}

function boundsOfPoints(points) {
    const bounds = emptyBounds();
    for (let index = 0; index < points.length; index += 3) {
        expand(bounds, [points[index], points[index + 1], points[index + 2]]);
    }
    return bounds;
}

function transformBounds(matrix, bounds) {
    const result = emptyBounds();
    for (const x of [bounds.min[0], bounds.max[0]]) {
        for (const y of [bounds.min[1], bounds.max[1]]) {
            for (const z of [bounds.min[2], bounds.max[2]]) {
                expand(result, pointArray(transformPointMat4(matrix, [x, y, z])));
            }
        }
    }
    return result;
}

function transformPointBounds(matrix, points) {
    const bounds = emptyBounds();
    for (let index = 0; index < points.length; index += 3) {
        expand(bounds, pointArray(transformPointMat4(matrix, [points[index], points[index + 1], points[index + 2]])));
    }
    return bounds;
}

function publicBounds(bounds) {
    return { min: toVec(bounds.min), max: toVec(bounds.max) };
}

/** Center, size, radius, and width of one measured AABB. */
export function wheelShapeFromBounds(bounds) {
    const min = bounds?.min;
    const max = bounds?.max;
    if (!min || !max) throw boundsError("Wheel bounds require a minimum and a maximum.");
    const size = {
        x: max.x - min.x,
        y: max.y - min.y,
        z: max.z - min.z,
    };
    if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value >= 0)) {
        throw boundsError("Wheel bounds must be finite.");
    }
    return {
        bounds: {
            min: { x: min.x, y: min.y, z: min.z },
            max: { x: max.x, y: max.y, z: max.z },
        },
        center: {
            x: (min.x + max.x) / 2,
            y: (min.y + max.y) / 2,
            z: (min.z + max.z) / 2,
        },
        size,
        radius: Math.max(size.x, size.y) / 2,
        width: size.z,
        radialDelta: Math.abs(size.x - size.y),
    };
}

function shapeOrNull(bounds) {
    if (!hasBounds(bounds)) return null;
    return wheelShapeFromBounds(publicBounds(bounds));
}

function rotationBasis(model) {
    const scaleValue = Number(model?.scale);
    const scale = Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 1;
    const rotation = model?.rotation ?? {};
    if (rotation.order && rotation.order !== "XYZ") {
        throw boundsError(`Vehicle placement rotation order ${rotation.order} is not supported.`);
    }
    const euler = {
        x: Number.isFinite(rotation.x) ? rotation.x : 0,
        y: Number.isFinite(rotation.y) ? rotation.y : 0,
        z: Number.isFinite(rotation.z) ? rotation.z : 0,
        order: "XYZ",
    };
    const quaternion = eulerXyzQuaternion(euler.x, euler.y, euler.z);
    return {
        scale,
        rotation: euler,
        offset: vec3(model?.offset),
        rotated: mat4FromTrs([0, 0, 0], quaternion, [scale, scale, scale]),
    };
}

function unionMeshBounds(localBounds, worlds, matrix) {
    const result = emptyBounds();
    for (const [nodeIndex, bounds] of localBounds) {
        unionBounds(result, transformBounds(multiplyMat4(matrix, worlds.get(nodeIndex)), bounds));
    }
    return result;
}

function alignmentFor(boundingBox, rotatedUnion) {
    if (!boundingBox?.center || !hasBounds(rotatedUnion)) return { x: 0, y: 0, z: 0 };
    const target = vec3(boundingBox.center);
    return {
        x: target.x - (rotatedUnion.min[0] + rotatedUnion.max[0]) / 2,
        y: target.y - (rotatedUnion.min[1] + rotatedUnion.max[1]) / 2,
        z: target.z - (rotatedUnion.min[2] + rotatedUnion.max[2]) / 2,
    };
}

function describeBounds(bounds) {
    if (!hasBounds(bounds)) return null;
    const shape = wheelShapeFromBounds(publicBounds(bounds));
    return {
        min: shape.bounds.min,
        max: shape.bounds.max,
        center: shape.center,
        size: shape.size,
    };
}

/**
 * Decode POSITION vertices and place them in the vehicle frame.
 * `hiddenNodeIndices` and `fileName` do not affect the result.
 */
export function measurePlacedVehicleModel({
    glbBytes,
    model = {},
    boundingBox = null,
    hiddenNodeIndices = undefined,
    fileName = undefined,
} = {}) {
    if (hiddenNodeIndices != null && !Array.isArray(hiddenNodeIndices)) {
        throw boundsError("hiddenNodeIndices must be an array.");
    }
    if (fileName != null && typeof fileName !== "string") {
        throw boundsError("fileName must be a string.");
    }
    const parsed = readVehicleGlb(glbBytes);
    const json = parsed.json;
    const catalog = vehicleNodeCatalog(json);
    const meshPoints = new Map();
    const localBounds = new Map();
    for (const entry of catalog.nodes) {
        if (!entry.inScene || entry.mesh == null) continue;
        const mesh = json.meshes?.[entry.mesh];
        if (!mesh) throw boundsError(`nodes.${entry.nodeIndex} references a missing mesh.`);
        const points = [];
        for (const primitive of mesh.primitives ?? []) {
            const accessorIndex = primitive?.attributes?.POSITION;
            if (!Number.isInteger(accessorIndex)) {
                throw boundsError(`meshes.${entry.mesh} is missing POSITION.`);
            }
            const decoded = readPositions(json, parsed.bin, accessorIndex);
            points.push(decoded);
        }
        const count = points.reduce((sum, entryPoints) => sum + entryPoints.length, 0);
        const combined = new Float64Array(count);
        let cursor = 0;
        for (const entryPoints of points) {
            combined.set(entryPoints, cursor);
            cursor += entryPoints.length;
        }
        if (combined.length === 0) continue;
        meshPoints.set(entry.nodeIndex, combined);
        localBounds.set(entry.nodeIndex, boundsOfPoints(combined));
    }
    const basis = rotationBasis(model);
    const rotatedUnion = unionMeshBounds(localBounds, catalog.worlds, basis.rotated);
    const alignment = alignmentFor(boundingBox, rotatedUnion);
    const translation = mat4FromTrs(
        [alignment.x + basis.offset.x, alignment.y + basis.offset.y, alignment.z + basis.offset.z],
        { x: 0, y: 0, z: 0, w: 1 },
        [1, 1, 1],
    );
    const placement = {
        scale: basis.scale,
        rotation: basis.rotation,
        alignment,
        offset: basis.offset,
        matrix: multiplyMat4(translation, basis.rotated),
    };
    const own = new Map();
    for (const [nodeIndex, points] of meshPoints) {
        const matrix = multiplyMat4(placement.matrix, catalog.worlds.get(nodeIndex));
        own.set(nodeIndex, transformPointBounds(matrix, points));
    }
    const nodes = json.nodes ?? [];
    const measuredNodes = catalog.nodes.filter((entry) => entry.inScene).map((entry) => {
        const bounds = emptyBounds();
        const seen = new Set();
        const visit = (index) => {
            if (seen.has(index) || !catalog.worlds.has(index)) return;
            seen.add(index);
            if (own.has(index)) unionBounds(bounds, own.get(index));
            for (const child of nodes[index]?.children ?? []) visit(child);
        };
        visit(entry.nodeIndex);
        const shape = shapeOrNull(bounds);
        return {
            nodeIndex: entry.nodeIndex,
            name: entry.name,
            path: entry.path,
            bounds: shape?.bounds ?? null,
            center: shape?.center ?? null,
            size: shape?.size ?? null,
            radius: shape?.radius ?? null,
            width: shape?.width ?? null,
            radialDelta: shape?.radialDelta ?? null,
        };
    });
    return {
        placement: {
            scale: placement.scale,
            rotation: placement.rotation,
            alignment: placement.alignment,
            offset: placement.offset,
            matrix: placement.matrix,
        },
        sceneBounds: describeBounds(unionMeshBounds(localBounds, catalog.worlds, placement.matrix)),
        nodes: measuredNodes,
        catalog: catalog.nodes,
        nodeTable: { count: nodes.length, parents: catalog.parents },
    };
}
