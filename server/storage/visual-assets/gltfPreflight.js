import {
    VISUAL_ALPHA_MODES,
    VISUAL_MATERIAL_EXTENSIONS,
    parseExactJson,
    sha256FromUri,
} from "../../../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../StorageErrors.js";
import { graphError, mediaError } from "./mediaInspectors.js";

const ALLOWED_REQUIRED_EXTENSIONS = new Set(VISUAL_MATERIAL_EXTENSIONS);
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

export function preflightGltf({ json, binBytes = null, limits, declaredDependencies = {} }) {
    if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw graphError("glTF JSON must be an object.");
    }
    if (json.asset?.version !== "2.0") throw graphError("Only glTF 2.0 assets are accepted.");
    assertNoExtras(json, "gltf");
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
    for (const extension of json.extensionsRequired ?? []) {
        if (!ALLOWED_REQUIRED_EXTENSIONS.has(extension)) {
            throw graphError(`Required glTF extension ${JSON.stringify(extension)} is not permitted.`);
        }
    }

    const discovered = [];
    let embeddedBytes = 0;
    for (const [index, buffer] of enumerate(json.buffers)) {
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
        if (image?.uri) {
            discovered.push({ field: `images.${index}.uri`, uri: image.uri });
            embeddedBytes += estimateDataUriBytes(image.uri);
        }
    }

    const expected = new Set(Object.keys(declaredDependencies));
    const seen = new Set();
    for (const entry of discovered) {
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
    for (const [index, accessor] of enumerate(accessors)) {
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

    const depth = sceneGraphDepth(json, limits.graphDepth);
    const nodeCount = (json.nodes ?? []).length;
    if (nodeCount > limits.nodesPerMesh) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
            `glTF node count ${nodeCount} exceeds the ${limits.nodesPerMesh} ceiling.`,
        );
    }

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

function assertNoExtras(value, path) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertNoExtras(entry, `${path}.${index}`));
        return;
    }
    if (Object.prototype.hasOwnProperty.call(value, "extras")) {
        throw graphError(`${path}.extras is not permitted in visual profile v1.`);
    }
    for (const [key, child] of Object.entries(value)) assertNoExtras(child, `${path}.${key}`);
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

function sceneGraphDepth(json, limit) {
    const nodes = json.nodes ?? [];
    let max = 0;
    const visit = (index, depth, stack) => {
        if (!Number.isInteger(index) || index < 0 || index >= nodes.length) {
            throw graphError("glTF node index is out of range.");
        }
        if (stack.has(index)) throw graphError("glTF node graph contains a cycle.");
        if (depth > limit) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `glTF scene graph depth exceeds the ${limit} ceiling.`,
            );
        }
        max = Math.max(max, depth);
        stack.add(index);
        for (const child of nodes[index]?.children ?? []) visit(child, depth + 1, stack);
        stack.delete(index);
    };
    for (const scene of json.scenes ?? []) {
        for (const root of scene?.nodes ?? []) visit(root, 1, new Set());
    }
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
