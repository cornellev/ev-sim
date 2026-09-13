/** Pure ED-07 asset-authoring, material, and metric contracts. */

import { listPerceptionLabels, normalizePerceptionClassName } from "../autonomy/PerceptionLabelCatalog.js";
import { canonicalizeSimulationValue, simulationSha256 } from "../simulation/kernel/SimulationHashes.js";
import {
    VISUAL_ALPHA_MODES,
    VISUAL_MATERIAL_EXTENSIONS,
    VISUAL_MATERIAL_MODES,
    VISUAL_TEXTURE_SLOTS,
    normalizeVisualLayer,
} from "../simulation/visual/VisualLayer.js";

export const ASSET_DEFINITION_KIND = "cev-sim.asset-definition";
export const ASSET_DEFINITION_VERSION = 1;
export const ASSET_METRIC_VERSION = 1;
export const ASSET_PART_CONTENT_KINDS = Object.freeze(["group", "model-node", "asset-reference"]);
export const ASSET_LIDAR_PROXY_KINDS = Object.freeze(["mesh", "box", "sphere", "cylinder"]);
export const ASSET_COLLISION_PROXY_KINDS = Object.freeze(["box", "convex"]);
export const ASSET_PROXY_GENERATOR = Object.freeze({ id: "voxel-cluster", version: 1 });
export const ASSET_PRIMITIVE_POLICY = Object.freeze({ version: 1, sphereLongitude: 24, sphereLatitude: 12, cylinderRadial: 24 });

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LABELS = new Set(listPerceptionLabels().map((entry) => entry.name));
const DEFAULT_TRANSFORM = Object.freeze({
    position: Object.freeze([0, 0, 0]),
    quaternion: Object.freeze([0, 0, 0, 1]),
    scale: Object.freeze([1, 1, 1]),
});

function plain(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function text(value, fallback = "") {
    const result = typeof value === "string" ? value.trim() : "";
    return result || fallback;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : fallback;
}

function vector(value, length, fallback) {
    const source = Array.isArray(value) && value.length === length ? value : fallback;
    return source.map((entry, index) => finite(entry, fallback[index]));
}

function issue(path, code, message, severity = "error") {
    return { path: [...path], code, message, severity };
}

function normalizeTransform(value = {}) {
    return {
        position: vector(value.position, 3, DEFAULT_TRANSFORM.position),
        quaternion: vector(value.quaternion, 4, DEFAULT_TRANSFORM.quaternion),
        scale: vector(value.scale, 3, DEFAULT_TRANSFORM.scale),
    };
}

function normalizeContent(value = {}) {
    const kind = ASSET_PART_CONTENT_KINDS.includes(value.kind) ? value.kind : "group";
    if (kind === "model-node") return { kind, sourceId: text(value.sourceId), nodeIndex: Number.isInteger(value.nodeIndex) ? value.nodeIndex : 0 };
    if (kind === "asset-reference") return { kind, assetId: text(value.assetId), revision: Number.isInteger(value.revision) ? value.revision : 1 };
    return { kind: "group" };
}

function normalizePart(value = {}, index = 0) {
    return {
        id: text(value.id, `part-${index + 1}`),
        parentId: value.parentId === null || value.parentId === undefined || value.parentId === "" ? null : text(value.parentId),
        order: Number.isInteger(value.order) && value.order >= 0 ? value.order : index,
        name: text(value.name, text(value.id, `Part ${index + 1}`)),
        transform: normalizeTransform(value.transform),
        content: normalizeContent(value.content),
        appearanceVisible: value.appearanceVisible !== false,
        materialBindings: plain(value.materialBindings)
            ? Object.fromEntries(Object.entries(value.materialBindings).map(([slot, materialId]) => [String(slot), String(materialId)]).sort(([a], [b]) => a.localeCompare(b)))
            : {},
    };
}

function normalizeMaterial(value = {}, index = 0) {
    const parameters = plain(value.parameters) ? value.parameters : {};
    const defaultParameters = {
        baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1,
        emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1,
        occlusionStrength: 1, clearcoatFactor: 0, clearcoatRoughnessFactor: 0,
        sheenColorFactor: [0, 0, 0], sheenRoughnessFactor: 0,
        specularFactor: 1, specularColorFactor: [1, 1, 1],
    };
    return {
        id: text(value.id, `material-${index + 1}`),
        mode: VISUAL_MATERIAL_MODES.includes(value.mode) ? value.mode : "metallic-roughness",
        alphaMode: VISUAL_ALPHA_MODES.includes(value.alphaMode) ? value.alphaMode : "OPAQUE",
        alphaCutoff: finite(value.alphaCutoff, 0.5),
        doubleSided: value.doubleSided === true,
        parameters: Object.fromEntries(Object.entries(defaultParameters).map(([key, fallback]) => [
            key,
            Array.isArray(fallback) ? vector(parameters[key], fallback.length, fallback) : finite(parameters[key], fallback),
        ])),
        textures: (Array.isArray(value.textures) ? value.textures : []).map((entry) => ({
            slot: String(entry?.slot ?? ""),
            assetUri: String(entry?.assetUri ?? ""),
            useHash: String(entry?.useHash ?? ""),
            texCoord: Number.isInteger(entry?.texCoord) ? entry.texCoord : 0,
            transform: {
                offset: vector(entry?.transform?.offset, 2, [0, 0]),
                rotation: finite(entry?.transform?.rotation, 0),
                scale: vector(entry?.transform?.scale, 2, [1, 1]),
            },
        })).sort((left, right) => left.slot.localeCompare(right.slot)),
        extensions: [...new Set((Array.isArray(value.extensions) ? value.extensions : []).map(String))].sort(),
    };
}

function normalizeMesh(value = {}) {
    return {
        vertices: (Array.isArray(value.vertices) ? value.vertices : []).map((entry) => vector(entry, 3, [0, 0, 0])),
        triangles: (Array.isArray(value.triangles) ? value.triangles : []).map((entry) => (
            Array.isArray(entry) && entry.length === 3 ? entry.map((index) => Math.trunc(Number(index))) : [0, 0, 0]
        )),
    };
}

function normalizeProxy(value = {}, channel = "lidar", index = 0) {
    const allowed = channel === "lidar" ? ASSET_LIDAR_PROXY_KINDS : ASSET_COLLISION_PROXY_KINDS;
    const kind = allowed.includes(value.kind) ? value.kind : allowed[0];
    const result = {
        id: text(value.id, `${channel}-${index + 1}`),
        kind,
        enabled: value.enabled !== false,
        transform: normalizeTransform(value.transform),
    };
    if (channel === "lidar") result.semantic = normalizePerceptionClassName(value.semantic);
    if (kind === "mesh" || kind === "convex") Object.assign(result, normalizeMesh(value));
    if (kind === "box") result.size = vector(value.size, 3, [1, 1, 1]);
    if (kind === "sphere") result.radius = finite(value.radius, 0.5);
    if (kind === "cylinder") {
        result.radius = finite(value.radius, 0.5);
        result.height = finite(value.height, 1);
    }
    if (value.generated !== undefined && value.generated !== null) {
        result.generated = {
            generator: {
                id: text(value.generated?.generator?.id, ASSET_PROXY_GENERATOR.id),
                version: Number.isInteger(value.generated?.generator?.version) ? value.generated.generator.version : ASSET_PROXY_GENERATOR.version,
            },
            parameters: plain(value.generated?.parameters) ? clone(value.generated.parameters) : {},
            includedPartIds: [...new Set((Array.isArray(value.generated?.includedPartIds) ? value.generated.includedPartIds : []).map(String))].sort(),
            sourceRevisions: (Array.isArray(value.generated?.sourceRevisions) ? value.generated.sourceRevisions : []).map((entry) => ({
                assetId: String(entry?.assetId ?? ""), revision: Number(entry?.revision ?? 0),
            })).sort((a, b) => `${a.assetId}@${a.revision}`.localeCompare(`${b.assetId}@${b.revision}`)),
            inputGeometryHash: String(value.generated?.inputGeometryHash ?? ""),
        };
    }
    return result;
}

export function createEmptyAssetDefinition({ modelUseHash = null, name = "Model" } = {}) {
    return normalizeAssetDefinition({
        kind: ASSET_DEFINITION_KIND,
        version: ASSET_DEFINITION_VERSION,
        normalization: { metersPerUnit: 1, orientation: [0, 0, 0, 1], pivot: [0, 0, 0] },
        sources: modelUseHash ? [{ id: "source", modelUseHash }] : [],
        parts: modelUseHash ? [{ id: "root", parentId: null, order: 0, name, content: { kind: "model-node", sourceId: "source", nodeIndex: 0 } }] : [],
        materials: [], lidarProxies: [], collisionProxies: [],
    });
}

export function normalizeAssetDefinition(value = {}) {
    const source = plain(value) ? value : {};
    return {
        kind: ASSET_DEFINITION_KIND,
        version: ASSET_DEFINITION_VERSION,
        normalization: {
            metersPerUnit: finite(source.normalization?.metersPerUnit, 1),
            orientation: vector(source.normalization?.orientation, 4, [0, 0, 0, 1]),
            pivot: vector(source.normalization?.pivot, 3, [0, 0, 0]),
        },
        sources: (Array.isArray(source.sources) ? source.sources : []).map((entry, index) => ({
            id: text(entry?.id, `source-${index + 1}`), modelUseHash: String(entry?.modelUseHash ?? "").toLowerCase(),
        })).sort((left, right) => left.id.localeCompare(right.id)),
        parts: (Array.isArray(source.parts) ? source.parts : []).map(normalizePart).sort((a, b) => (a.parentId ?? "").localeCompare(b.parentId ?? "") || a.order - b.order || a.id.localeCompare(b.id)),
        materials: (Array.isArray(source.materials) ? source.materials : []).map(normalizeMaterial).sort((a, b) => a.id.localeCompare(b.id)),
        lidarProxies: (Array.isArray(source.lidarProxies) ? source.lidarProxies : []).map((entry, index) => normalizeProxy(entry, "lidar", index)).sort((a, b) => a.id.localeCompare(b.id)),
        collisionProxies: (Array.isArray(source.collisionProxies) ? source.collisionProxies : []).map((entry, index) => normalizeProxy(entry, "collision", index)).sort((a, b) => a.id.localeCompare(b.id)),
    };
}

function validateVector(value, length, path, issues, { positive = false } = {}) {
    if (!Array.isArray(value) || value.length !== length) {
        issues.push(issue(path, "asset.vector.invalid", `Expected a ${length}-element vector.`));
        return;
    }
    value.forEach((entry, index) => {
        if (!Number.isFinite(entry) || (positive && entry <= 0)) issues.push(issue([...path, index], positive ? "asset.number.positive" : "asset.number.finite", `Expected a ${positive ? "positive " : ""}finite number.`));
    });
}

function validateTransform(value, path, issues) {
    if (!plain(value)) {
        issues.push(issue(path, "asset.transform.invalid", "Transform must be an object."));
        return;
    }
    validateVector(value.position, 3, [...path, "position"], issues);
    validateVector(value.quaternion, 4, [...path, "quaternion"], issues);
    validateVector(value.scale, 3, [...path, "scale"], issues, { positive: true });
    if (Array.isArray(value.quaternion) && value.quaternion.length === 4 && value.quaternion.every(Number.isFinite)) {
        const length = Math.hypot(...value.quaternion);
        if (Math.abs(length - 1) > 1e-6) issues.push(issue([...path, "quaternion"], "asset.quaternion.normalized", "Quaternion must be normalized within 1e-6."));
    }
}

function validateMesh(value, path, issues, { convex = false } = {}) {
    if (!Array.isArray(value.vertices) || value.vertices.length < (convex ? 4 : 3)) issues.push(issue([...path, "vertices"], "asset.mesh.vertices", `Mesh requires at least ${convex ? 4 : 3} vertices.`));
    else value.vertices.forEach((entry, index) => validateVector(entry, 3, [...path, "vertices", index], issues));
    if (!Array.isArray(value.triangles) || value.triangles.length === 0) issues.push(issue([...path, "triangles"], "asset.mesh.triangles", "Mesh requires triangles."));
    else value.triangles.forEach((triangle, index) => {
        if (!Array.isArray(triangle) || triangle.length !== 3 || triangle.some((vertex) => !Number.isInteger(vertex) || vertex < 0 || vertex >= (value.vertices?.length ?? 0)) || new Set(triangle).size !== 3) {
            issues.push(issue([...path, "triangles", index], "asset.mesh.triangle", "Triangle must contain three distinct in-range vertex indices."));
        }
    });
}

function duplicateIds(values, path, issues) {
    const seen = new Set();
    values.forEach((entry, index) => {
        if (typeof entry?.id !== "string" || !ID.test(entry.id)) issues.push(issue([path, index, "id"], "asset.id.invalid", "ID must be a portable identifier."));
        else if (seen.has(entry.id)) issues.push(issue([path, index, "id"], "asset.id.duplicate", `Duplicate id "${entry.id}".`));
        seen.add(entry?.id);
    });
}

export function validateAssetDefinition(value = {}) {
    const issues = [];
    if (!plain(value)) return [issue([], "asset.definition.invalid", "Asset definition must be an object.")];
    if (value.kind !== ASSET_DEFINITION_KIND) issues.push(issue(["kind"], "asset.definition.kind", `Expected ${ASSET_DEFINITION_KIND}.`));
    if (value.version !== ASSET_DEFINITION_VERSION) issues.push(issue(["version"], "asset.definition.version", `Expected version ${ASSET_DEFINITION_VERSION}.`));
    if (!plain(value.normalization) || !Number.isFinite(value.normalization?.metersPerUnit) || value.normalization.metersPerUnit <= 0) issues.push(issue(["normalization", "metersPerUnit"], "asset.units.invalid", "metersPerUnit must be positive and finite."));
    validateVector(value.normalization?.orientation, 4, ["normalization", "orientation"], issues);
    validateVector(value.normalization?.pivot, 3, ["normalization", "pivot"], issues);
    if (Array.isArray(value.normalization?.orientation) && value.normalization.orientation.every(Number.isFinite) && Math.abs(Math.hypot(...value.normalization.orientation) - 1) > 1e-6) issues.push(issue(["normalization", "orientation"], "asset.quaternion.normalized", "Root orientation quaternion must be normalized within 1e-6."));
    for (const field of ["sources", "parts", "materials", "lidarProxies", "collisionProxies"]) if (!Array.isArray(value[field])) issues.push(issue([field], "asset.array.invalid", `${field} must be an array.`));
    const sources = Array.isArray(value.sources) ? value.sources : [];
    const parts = Array.isArray(value.parts) ? value.parts : [];
    const materials = Array.isArray(value.materials) ? value.materials : [];
    duplicateIds(sources, "sources", issues); duplicateIds(parts, "parts", issues); duplicateIds(materials, "materials", issues);
    duplicateIds(Array.isArray(value.lidarProxies) ? value.lidarProxies : [], "lidarProxies", issues);
    duplicateIds(Array.isArray(value.collisionProxies) ? value.collisionProxies : [], "collisionProxies", issues);
    const sourceIds = new Set(sources.map((entry) => entry?.id));
    sources.forEach((entry, index) => { if (!SHA256.test(entry?.modelUseHash ?? "")) issues.push(issue(["sources", index, "modelUseHash"], "asset.source.use-hash", "Source modelUseHash must be a SHA-256 digest.")); });
    const partIds = new Set(parts.map((entry) => entry?.id));
    const materialIds = new Set(materials.map((entry) => entry?.id));
    parts.forEach((part, index) => {
        const path = ["parts", index];
        if (typeof part?.name !== "string" || !part.name.trim()) issues.push(issue([...path, "name"], "asset.part.name", "Part name is required."));
        if (!Number.isInteger(part?.order) || part.order < 0) issues.push(issue([...path, "order"], "asset.part.order", "Part order must be a non-negative integer."));
        if (part?.parentId !== null && !partIds.has(part?.parentId)) issues.push(issue([...path, "parentId"], "asset.part.parent-missing", `Parent part "${part?.parentId}" does not exist.`));
        if (part?.parentId === part?.id) issues.push(issue([...path, "parentId"], "asset.part.parent-self", "Part cannot parent itself."));
        validateTransform(part?.transform, [...path, "transform"], issues);
        const content = part?.content;
        if (!plain(content) || !ASSET_PART_CONTENT_KINDS.includes(content.kind)) issues.push(issue([...path, "content"], "asset.part.content", "Part content kind is invalid."));
        else if (content.kind === "model-node" && (!sourceIds.has(content.sourceId) || !Number.isInteger(content.nodeIndex) || content.nodeIndex < 0)) issues.push(issue([...path, "content"], "asset.part.model-node", "Model-node content requires an existing source and non-negative node index."));
        else if (content.kind === "asset-reference" && (!ID.test(content.assetId ?? "") || !Number.isInteger(content.revision) || content.revision <= 0)) issues.push(issue([...path, "content"], "asset.part.asset-reference", "Asset reference requires an asset id and positive pinned revision."));
        if (typeof part?.appearanceVisible !== "boolean") issues.push(issue([...path, "appearanceVisible"], "asset.part.visibility", "appearanceVisible must be boolean."));
        if (!plain(part?.materialBindings)) issues.push(issue([...path, "materialBindings"], "asset.part.material-bindings", "materialBindings must be an object."));
        else for (const [slot, materialId] of Object.entries(part.materialBindings)) if (!slot || !materialIds.has(materialId)) issues.push(issue([...path, "materialBindings", slot], "asset.part.material-missing", `Material "${materialId}" does not exist.`));
        const visited = new Set([part?.id]); let cursor = part?.parentId;
        while (cursor) { if (visited.has(cursor)) { issues.push(issue([...path, "parentId"], "asset.part.cycle", "Part hierarchy contains a cycle.")); break; } visited.add(cursor); cursor = parts.find((entry) => entry?.id === cursor)?.parentId ?? null; }
    });
    materials.forEach((material, index) => {
        try {
            const descriptorMaterial = { ...material, textures: material.textures.map(({ useHash: _useHash, ...texture }) => texture) };
            const assets = [...new Set(descriptorMaterial.textures.map((texture) => texture.assetUri))].map((assetUri) => ({
                sha256: String(assetUri).replace(/^sha256:/, ""), mediaType: "image/png", sizeBytes: 1, role: "texture",
            }));
            normalizeVisualLayer({ kind: "cev-sim.visual-layer", version: 1, sourceWorldHash: "0".repeat(64), assetProfile: { id: "static-gltf-surface", version: 1 }, assets, materials: [descriptorMaterial], chunks: [], instances: [], bindings: [], appearanceDependencies: assets.map((asset) => `sha256:${asset.sha256}`) });
        } catch (error) { issues.push(issue(["materials", index], "asset.material.invalid", error.message)); }
        material?.textures?.forEach?.((texture, textureIndex) => {
            if (!VISUAL_TEXTURE_SLOTS.includes(texture.slot) || !SHA256.test(texture.useHash ?? "")) issues.push(issue(["materials", index, "textures", textureIndex], "asset.material.texture", "Texture requires a supported slot and source-bound use hash."));
        });
        if (material?.extensions?.some?.((entry) => !VISUAL_MATERIAL_EXTENSIONS.includes(entry))) issues.push(issue(["materials", index, "extensions"], "asset.material.extension", "Material declares an unsupported extension."));
    });
    const validateProxy = (proxy, index, channel) => {
        const path = [channel === "lidar" ? "lidarProxies" : "collisionProxies", index];
        const kinds = channel === "lidar" ? ASSET_LIDAR_PROXY_KINDS : ASSET_COLLISION_PROXY_KINDS;
        if (!kinds.includes(proxy?.kind)) issues.push(issue([...path, "kind"], "asset.proxy.kind", `Unsupported ${channel} proxy kind.`));
        if (typeof proxy?.enabled !== "boolean") issues.push(issue([...path, "enabled"], "asset.proxy.enabled", "Proxy enabled must be boolean."));
        validateTransform(proxy?.transform, [...path, "transform"], issues);
        if (proxy?.kind === "mesh") validateMesh(proxy, path, issues);
        if (proxy?.kind === "convex") validateMesh(proxy, path, issues, { convex: true });
        if (proxy?.kind === "box") validateVector(proxy.size, 3, [...path, "size"], issues, { positive: true });
        if (["sphere", "cylinder"].includes(proxy?.kind) && (!Number.isFinite(proxy.radius) || proxy.radius <= 0)) issues.push(issue([...path, "radius"], "asset.proxy.radius", "Radius must be positive and finite."));
        if (proxy?.kind === "cylinder" && (!Number.isFinite(proxy.height) || proxy.height <= 0)) issues.push(issue([...path, "height"], "asset.proxy.height", "Height must be positive and finite."));
        if (channel === "lidar" && !LABELS.has(proxy?.semantic)) issues.push(issue([...path, "semantic"], "asset.proxy.semantic", "Semantic label must be registered."));
        if (proxy?.generated) {
            if (proxy.generated.generator?.id !== ASSET_PROXY_GENERATOR.id || proxy.generated.generator?.version !== ASSET_PROXY_GENERATOR.version) issues.push(issue([...path, "generated", "generator"], "asset.proxy.generator", "Generated proxy uses an unsupported generator."));
            if (!Array.isArray(proxy.generated.includedPartIds) || proxy.generated.includedPartIds.some((id) => !partIds.has(id))) issues.push(issue([...path, "generated", "includedPartIds"], "asset.proxy.parts", "Generated proxy references missing parts."));
            if (!SHA256.test(proxy.generated.inputGeometryHash ?? "")) issues.push(issue([...path, "generated", "inputGeometryHash"], "asset.proxy.input-hash", "Generated proxy requires an input geometry hash."));
        }
    };
    (Array.isArray(value.lidarProxies) ? value.lidarProxies : []).forEach((entry, index) => validateProxy(entry, index, "lidar"));
    (Array.isArray(value.collisionProxies) ? value.collisionProxies : []).forEach((entry, index) => validateProxy(entry, index, "collision"));
    return issues;
}

export function collectAssetDefinitionDependencies(definition) {
    const normalized = normalizeAssetDefinition(definition);
    return normalized.parts.filter((part) => part.content.kind === "asset-reference")
        .map((part) => ({ partId: part.id, assetId: part.content.assetId, revision: part.content.revision }))
        .sort((a, b) => a.partId.localeCompare(b.partId));
}

export function hashAssetDefinition(definition) {
    const rawIssues = validateAssetDefinition(definition);
    if (rawIssues.some((entry) => entry.severity === "error")) throw Object.assign(new TypeError(rawIssues[0].message), { issues: rawIssues });
    const normalized = normalizeAssetDefinition(definition);
    const issues = validateAssetDefinition(normalized);
    if (issues.some((entry) => entry.severity === "error")) throw new TypeError(issues[0].message);
    return simulationSha256(normalized);
}

export function normalizeAssetMetric(value = {}) {
    const source = plain(value) ? value : {};
    const compiled = (entry, channel, index) => ({
        id: text(entry?.id, `${channel}-${index + 1}`),
        kind: channel === "collision" ? "convex" : "mesh",
        ...(channel === "lidar" ? { semantic: normalizePerceptionClassName(entry?.semantic) } : {}),
        ...normalizeMesh(entry),
    });
    return canonicalizeSimulationValue({
        version: ASSET_METRIC_VERSION,
        collision: (Array.isArray(source.collision) ? source.collision : []).filter((entry) => entry?.enabled !== false).map((entry, index) => compiled(entry, "collision", index)).sort((a, b) => a.id.localeCompare(b.id)),
        lidar: (Array.isArray(source.lidar) ? source.lidar : []).filter((entry) => entry?.enabled !== false).map((entry, index) => compiled(entry, "lidar", index)).sort((a, b) => a.id.localeCompare(b.id)),
    });
}

export function validateAssetMetric(value = {}) {
    if (!plain(value) || value.version !== ASSET_METRIC_VERSION || !Array.isArray(value.collision) || !Array.isArray(value.lidar)) return [issue([], "asset.metric.invalid", `Metric snapshot must be version ${ASSET_METRIC_VERSION}.`)];
    const issues = [];
    duplicateIds(value.collision, "collision", issues); duplicateIds(value.lidar, "lidar", issues);
    value.collision.forEach((entry, index) => { if (entry?.kind !== "convex") issues.push(issue(["collision", index, "kind"], "asset.metric.collision-kind", "Compiled collision proxy must be convex.")); validateMesh(entry, ["collision", index], issues, { convex: true }); });
    value.lidar.forEach((entry, index) => { if (entry?.kind !== "mesh") issues.push(issue(["lidar", index, "kind"], "asset.metric.lidar-kind", "Compiled LiDAR proxy must be mesh.")); validateMesh(entry, ["lidar", index], issues); if (!LABELS.has(entry?.semantic)) issues.push(issue(["lidar", index, "semantic"], "asset.proxy.semantic", "Semantic label must be registered.")); });
    return issues;
}

export function hashAssetMetric(metric) {
    const rawIssues = validateAssetMetric(metric);
    if (rawIssues.length) throw Object.assign(new TypeError(rawIssues[0].message), { issues: rawIssues });
    const normalized = normalizeAssetMetric(metric);
    const issues = validateAssetMetric(normalized);
    if (issues.length) throw new TypeError(issues[0].message);
    return simulationSha256(normalized);
}

export function hashGeneratedProxyInput(proxy, geometryHashes = new Map()) {
    const includedPartIds = [...new Set(proxy?.generated?.includedPartIds?.map(String) ?? [])].sort();
    return simulationSha256({
        generator: proxy?.generated?.generator ?? null,
        parameters: proxy?.generated?.parameters ?? {},
        includedParts: includedPartIds.map((id) => [id, geometryHashes.get(id) ?? null]),
    });
}

export function staleGeneratedProxyIds(definition, geometryHashes = new Map()) {
    const normalized = normalizeAssetDefinition(definition);
    return [...normalized.lidarProxies, ...normalized.collisionProxies]
        .filter((proxy) => proxy.enabled && proxy.generated)
        .filter((proxy) => hashGeneratedProxyInput(proxy, geometryHashes) !== proxy.generated.inputGeometryHash)
        .map((proxy) => proxy.id)
        .sort();
}
