import {
    VISUAL_ALPHA_MODES,
    VISUAL_MATERIAL_EXTENSIONS,
    parseExactJson,
    sha256FromUri,
} from "../../../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../StorageErrors.js";
import { graphError, mediaError } from "./mediaInspectors.js";

const ALLOWED_EXTENSIONS = new Set(VISUAL_MATERIAL_EXTENSIONS);
const FORBIDDEN_URI = /^(?:[a-z][a-z0-9+.-]*:|\/\/|[\\/]|[a-zA-Z]:[\\/]|\.\.(?:[\\/]|$))/i;

export function gltfJsonFromChunk(jsonBytes) {
    let end = jsonBytes.length;
    while (end > 0 && (jsonBytes[end - 1] === 0x00 || jsonBytes[end - 1] === 0x20 || jsonBytes[end - 1] === 0x09
        || jsonBytes[end - 1] === 0x0a || jsonBytes[end - 1] === 0x0d)) {
        end -= 1;
    }
    try {
        return parseExactJson(Buffer.from(jsonBytes.subarray(0, end)).toString("utf8"));
    } catch (error) {
        throw graphError(error.message || "glTF JSON is invalid.");
    }
}

export function preflightGltf({ json, binBytes = null, limits, declaredDependencies = {}, deadline = Infinity }) {
    if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw graphError("glTF JSON must be an object.");
    }
    if (json.asset?.version !== "2.0") throw graphError("Only glTF 2.0 assets are accepted.");
    assertRestrictedGraphObjects(json, { limits, deadline });
    if (hasItems(json.animations)) throw graphError("Animation is not permitted in visual profile v1.");
    if (hasItems(json.skins)) throw graphError("Skins are not permitted in visual profile v1.");
    for (const [index, mesh] of enumerate(json.meshes)) {
        for (const [primitiveIndex, primitive] of enumerate(mesh?.primitives)) {
            if (hasItems(primitive?.targets)) {
                throw graphError(`meshes.${index}.primitives.${primitiveIndex} morph targets are not permitted.`);
            }
        }
    }
    for (const [index, node] of enumerate(json.nodes)) {
        if (node?.skin !== undefined) throw graphError(`nodes.${index}.skin is not permitted.`);
        if (hasItems(node?.weights)) throw graphError(`nodes.${index}.weights morph weights are not permitted.`);
        assertNodeTransform(node, `nodes.${index}`);
    }
    for (const [index, material] of enumerate(json.materials)) {
        const alphaMode = material?.alphaMode ?? "OPAQUE";
        if (!VISUAL_ALPHA_MODES.includes(alphaMode)) {
            throw graphError(`materials.${index}.alphaMode ${JSON.stringify(alphaMode)} is not permitted.`);
        }
    }
    for (const extension of [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]) {
        if (!ALLOWED_EXTENSIONS.has(extension)) {
            throw graphError(`glTF extension ${JSON.stringify(extension)} is not permitted.`);
        }
    }

    const discovered = [];
    let embeddedBytes = 0;
    for (const [index, buffer] of enumerate(json.buffers)) {
        assertDeadline(deadline);
        const uri = buffer?.uri;
        if (uri) {
            discovered.push({ field: `buffers.${index}.uri`, uri });
            embeddedBytes += estimateDataUriBytes(uri);
        } else if (index === 0 && binBytes) {
            embeddedBytes += binBytes.length;
        } else if (index === 0 && buffer?.byteLength) {
            embeddedBytes += Number(buffer.byteLength) || 0;
        }
        assertSafeCount(buffer?.byteLength, `buffers.${index}.byteLength`);
    }
    for (const [index, image] of enumerate(json.images)) {
        assertDeadline(deadline);
        if (image?.uri) {
            discovered.push({ field: `images.${index}.uri`, uri: image.uri });
            embeddedBytes += estimateDataUriBytes(image.uri);
        }
    }

    const expected = new Set(Object.keys(declaredDependencies));
    const seen = new Set();
    for (const entry of discovered) {
        assertDeadline(deadline);
        const digest = classifyUri(entry.uri, entry.field);
        if (!digest) continue;
        const key = `sha256:${digest}`;
        if (!expected.has(key)) {
            throw graphError(`${entry.field} references ${key} without a dependency-use record.`);
        }
        seen.add(key);
    }
    for (const key of expected) {
        if (!seen.has(key)) throw graphError(`Dependency ${key} is not referenced by the glTF graph.`);
    }

    const accessors = json.accessors ?? [];
    const bufferViews = json.bufferViews ?? [];
    const buffers = json.buffers ?? [];
    for (const [index, view] of enumerate(bufferViews)) {
        const buffer = buffers[view?.buffer];
        if (!buffer) throw graphError(`bufferViews.${index} references a missing buffer.`);
        const offset = Number(view.byteOffset) || 0;
        const length = Number(view.byteLength) || 0;
        assertSafeCount(offset, `bufferViews.${index}.byteOffset`);
        assertSafeCount(length, `bufferViews.${index}.byteLength`);
        if (offset + length > (Number(buffer.byteLength) || 0)) {
            throw graphError(`bufferViews.${index} overflows its buffer.`);
        }
        if (binBytes && view.buffer === 0 && !buffer.uri && offset + length > binBytes.length) {
            throw graphError(`bufferViews.${index} overflows the GLB BIN chunk.`);
        }
    }
    for (const [index, accessor] of enumerate(accessors)) {
        assertDeadline(deadline);
        assertSafeCount(accessor?.count, `accessors.${index}.count`);
        if (accessor?.bufferView !== undefined) {
            const view = bufferViews[accessor.bufferView];
            if (!view) throw graphError(`accessors.${index}.bufferView is missing.`);
            const buffer = buffers[view.buffer];
            if (!buffer) throw graphError(`bufferViews.${view.buffer} references a missing buffer.`);
            const viewEnd = (Number(view.byteOffset) || 0) + (Number(view.byteLength) || 0);
            const bufferLength = Number(buffer.byteLength) || 0;
            if (viewEnd > bufferLength) throw graphError(`bufferViews.${view.buffer} overflows its buffer.`);
            if (binBytes && view.buffer === 0 && !buffer.uri && viewEnd > binBytes.length) {
                throw graphError(`bufferViews.${view.buffer} overflows the GLB BIN chunk.`);
            }
        }
    }

    let triangles = 0;
    let vertices = 0;
    for (const [meshIndex, mesh] of enumerate(json.meshes)) {
        assertDeadline(deadline);
        let meshTriangles = 0;
        let meshVertices = 0;
        for (const [primitiveIndex, primitive] of enumerate(mesh?.primitives)) {
            const mode = primitive?.mode ?? 4;
            if (mode !== 4) {
                throw graphError(`meshes.${meshIndex}.primitives.${primitiveIndex} must use TRIANGLES topology.`);
            }
            const position = primitive?.attributes?.POSITION;
            if (position === undefined) throw graphError(`meshes.${meshIndex}.primitives.${primitiveIndex} is missing POSITION.`);
            const count = Number(accessors[position]?.count) || 0;
            meshVertices += count;
            if (primitive.indices !== undefined) {
                const indexCount = Number(accessors[primitive.indices]?.count) || 0;
                if (indexCount % 3 !== 0) throw graphError("Indexed triangle accessors must be a multiple of 3.");
                meshTriangles += indexCount / 3;
            } else {
                if (count % 3 !== 0) throw graphError("Unindexed triangle accessors must be a multiple of 3.");
                meshTriangles += count / 3;
            }
        }
        if (meshVertices > limits.nodesPerMesh) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `Mesh ${meshIndex} has ${meshVertices} vertices, exceeding the ${limits.nodesPerMesh} ceiling.`,
            );
        }
        if (meshTriangles > limits.trianglesPerMesh) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `Mesh ${meshIndex} has ${meshTriangles} triangles, exceeding the ${limits.trianglesPerMesh} ceiling.`,
            );
        }
        triangles += meshTriangles;
        vertices += meshVertices;
    }

    const nodeCount = (json.nodes ?? []).length;
    if (nodeCount > limits.nodesPerMesh) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
            `glTF node count ${nodeCount} exceeds the ${limits.nodesPerMesh} ceiling.`,
        );
    }
    const depth = sceneGraphDepth(json, limits.graphDepth, deadline);

    return {
        uris: discovered,
        depth,
        nodeCount,
        vertices,
        triangles,
        embeddedBytes,
        decodedBytesEstimate: embeddedBytes,
    };
}

function assertRestrictedGraphObjects(value, { limits, deadline }) {
    const maxObjects = Math.max(4096, limits.nodesPerMesh * 16);
    const maxDepth = limits.graphDepth + 16;
    const pending = [{ value, path: "gltf", depth: 0 }];
    let visited = 0;
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current.value || typeof current.value !== "object") continue;
        visited += 1;
        if ((visited & 1023) === 0) assertDeadline(deadline);
        if (visited > maxObjects || current.depth > maxDepth) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                "glTF object graph exceeds the bounded validation profile.",
            );
        }
        if (Array.isArray(current.value)) {
            for (let index = current.value.length - 1; index >= 0; index -= 1) {
                pending.push({
                    value: current.value[index],
                    path: `${current.path}.${index}`,
                    depth: current.depth + 1,
                });
            }
            continue;
        }
        if (Object.hasOwn(current.value, "extras")) {
            throw graphError(`${current.path}.extras is not permitted in visual profile v1.`);
        }
        if (current.value.extensions !== undefined) {
            if (!current.value.extensions || typeof current.value.extensions !== "object"
                || Array.isArray(current.value.extensions)) {
                throw graphError(`${current.path}.extensions must be an object.`);
            }
            for (const extension of Object.keys(current.value.extensions)) {
                if (!ALLOWED_EXTENSIONS.has(extension)) {
                    throw graphError(`${current.path}.extensions.${extension} is not permitted.`);
                }
            }
        }
        for (const [key, child] of Object.entries(current.value)) {
            pending.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
        }
    }
}

function assertDeadline(deadline) {
    if (Date.now() > deadline) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.VALIDATION_TIMEOUT,
            "glTF preflight validation exceeded its time limit.",
        );
    }
}

function classifyUri(uri, field) {
    if (typeof uri !== "string" || uri.length === 0) throw graphError(`${field} must be a non-empty URI.`);
    if (uri.startsWith("data:")) return null;
    const digest = sha256FromUri(uri);
    if (digest) return digest;
    if (FORBIDDEN_URI.test(uri) || uri.includes("\\") || uri.includes("/") || uri.includes("%") || uri.includes("..")) {
        throw graphError(`${field} must be a sha256:<digest> reference; network, file, blob, and relative URIs are forbidden.`);
    }
    throw graphError(`${field} must be a sha256:<digest> reference; network, file, blob, and relative URIs are forbidden.`);
}

function estimateDataUriBytes(uri) {
    if (typeof uri !== "string" || !uri.startsWith("data:")) return 0;
    const comma = uri.indexOf(",");
    if (comma < 0) throw mediaError("Embedded data URI is malformed.");
    const header = uri.slice(5, comma);
    const data = uri.slice(comma + 1);
    if (header.includes("base64")) {
        const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
    }
    return Buffer.byteLength(data, "utf8");
}

function assertNodeTransform(node, path) {
    if (node?.matrix) {
        if (!Array.isArray(node.matrix) || node.matrix.length !== 16) {
            throw graphError(`${path}.matrix must be a 16-number affine matrix.`);
        }
        for (const [index, entry] of node.matrix.entries()) {
            if (typeof entry !== "number" || !Number.isFinite(entry)) {
                throw graphError(`${path}.matrix.${index} must be finite.`);
            }
        }
        if (node.matrix[3] !== 0 || node.matrix[7] !== 0 || node.matrix[11] !== 0 || node.matrix[15] !== 1) {
            throw graphError(`${path}.matrix must be a column-major affine matrix.`);
        }
    }
    for (const field of ["translation", "rotation", "scale"]) {
        const values = node?.[field];
        if (!values) continue;
        if (!Array.isArray(values)) throw graphError(`${path}.${field} must be an array.`);
        for (const [index, entry] of values.entries()) {
            if (typeof entry !== "number" || !Number.isFinite(entry)) {
                throw graphError(`${path}.${field}.${index} must be finite.`);
            }
        }
    }
}

function sceneGraphDepth(json, limit, deadline) {
    const nodes = json.nodes ?? [];
    const indegree = new Uint32Array(nodes.length);
    const depth = new Uint32Array(nodes.length);
    for (const [index, node] of nodes.entries()) {
        if ((index & 1023) === 0) assertDeadline(deadline);
        for (const child of node?.children ?? []) {
            if (!Number.isInteger(child) || child < 0 || child >= nodes.length) {
                throw graphError(`nodes.${index} contains an out-of-range child.`);
            }
            indegree[child] += 1;
        }
    }
    const queue = [];
    for (let index = 0; index < nodes.length; index += 1) {
        if (indegree[index] === 0) {
            queue.push(index);
            depth[index] = 1;
        }
    }
    let processed = 0;
    let max = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        if ((cursor & 1023) === 0) assertDeadline(deadline);
        const index = queue[cursor];
        processed += 1;
        max = Math.max(max, depth[index]);
        if (depth[index] > limit) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `glTF scene graph depth exceeds the ${limit} ceiling.`,
            );
        }
        for (const child of nodes[index]?.children ?? []) {
            depth[child] = Math.max(depth[child], depth[index] + 1);
            indegree[child] -= 1;
            if (indegree[child] === 0) queue.push(child);
        }
    }
    if (processed !== nodes.length) throw graphError("glTF node graph contains a cycle.");
    return max;
}

function hasItems(value) {
    return Array.isArray(value) && value.length > 0;
}

function enumerate(value) {
    return Array.isArray(value) ? value.entries() : [];
}

function assertSafeCount(value, path) {
    if (value === undefined || value === null) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw graphError(`${path} must be a non-negative safe integer.`);
    }
}
