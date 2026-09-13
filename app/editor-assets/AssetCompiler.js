/** Deterministic ED-07 assembly, proxy, and metric compiler. */

import { canonicalizeSimulationValue, simulationSha256 } from "../simulation/kernel/SimulationHashes.js";
import {
    ASSET_PRIMITIVE_POLICY,
    hashGeneratedProxyInput,
    hashAssetMetric,
    normalizeAssetDefinition,
    normalizeAssetMetric,
    staleGeneratedProxyIds,
    validateAssetDefinition,
} from "./AssetDefinition.js";
import { meshFromPrimitive, simplifyVoxelMesh } from "./VoxelMeshSimplifier.js";

export const ASSET_COMPILER_VERSION = 1;

const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

export function multiplyAssetMatrices(a, b) {
    const result = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
        for (let inner = 0; inner < 4; inner += 1) result[column * 4 + row] += a[inner * 4 + row] * b[column * 4 + inner];
    }
    return result;
}

export function assetTransformMatrix(transform = {}) {
    const [x, y, z, w] = transform.quaternion ?? [0, 0, 0, 1];
    const [sx, sy, sz] = transform.scale ?? [1, 1, 1];
    const [tx, ty, tz] = transform.position ?? [0, 0, 0];
    const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
    return [
        (1-2*(yy+zz))*sx, (2*(xy+wz))*sx, (2*(xz-wy))*sx, 0,
        (2*(xy-wz))*sy, (1-2*(xx+zz))*sy, (2*(yz+wx))*sy, 0,
        (2*(xz+wy))*sz, (2*(yz-wx))*sz, (1-2*(xx+yy))*sz, 0,
        tx, ty, tz, 1,
    ];
}

export function applyAssetMatrix(matrix, point) {
    return [
        matrix[0]*point[0]+matrix[4]*point[1]+matrix[8]*point[2]+matrix[12],
        matrix[1]*point[0]+matrix[5]*point[1]+matrix[9]*point[2]+matrix[13],
        matrix[2]*point[0]+matrix[6]*point[1]+matrix[10]*point[2]+matrix[14],
    ];
}

function normalizationMatrix(normalization) {
    const scale = normalization.metersPerUnit;
    const orientation = assetTransformMatrix({ position: [0,0,0], quaternion: normalization.orientation, scale: [scale,scale,scale] });
    const pivot = identity(); pivot[12] = -normalization.pivot[0]; pivot[13] = -normalization.pivot[1]; pivot[14] = -normalization.pivot[2];
    return multiplyAssetMatrices(orientation, pivot);
}

function partMatrices(definition) {
    const byId = new Map(definition.parts.map((part) => [part.id, part]));
    const matrices = new Map();
    const visit = (part) => {
        if (matrices.has(part.id)) return matrices.get(part.id);
        const local = assetTransformMatrix(part.transform);
        const matrix = part.parentId ? multiplyAssetMatrices(visit(byId.get(part.parentId)), local) : local;
        matrices.set(part.id, matrix);
        return matrix;
    };
    definition.parts.forEach(visit);
    const root = normalizationMatrix(definition.normalization);
    for (const [id, matrix] of matrices) matrices.set(id, multiplyAssetMatrices(root, matrix));
    return matrices;
}

function geometryFor(sourceGeometries, sourceId, nodeIndex) {
    const source = sourceGeometries instanceof Map ? sourceGeometries.get(sourceId) : sourceGeometries?.[sourceId];
    const geometry = source instanceof Map ? source.get(nodeIndex) : source?.[nodeIndex] ?? source?.nodes?.[nodeIndex];
    if (!geometry || !Array.isArray(geometry.vertices) || !Array.isArray(geometry.triangles)) throw new TypeError(`Missing decoded geometry for ${sourceId} node ${nodeIndex}.`);
    return geometry;
}

function transformedMesh(mesh, matrix) {
    return {
        vertices: mesh.vertices.map((point) => applyAssetMatrix(matrix, point)),
        triangles: mesh.triangles.map((triangle) => [...triangle]),
    };
}

function transformMetricProxy(proxy, matrix, id, channel) {
    const primitive = meshFromPrimitive(proxy, ASSET_PRIMITIVE_POLICY);
    const composed = multiplyAssetMatrices(matrix, assetTransformMatrix(proxy.transform));
    return canonicalizeSimulationValue({
        id,
        kind: channel === "collision" ? "convex" : "mesh",
        ...(proxy.semantic ? { semantic: proxy.semantic } : {}),
        vertices: primitive.vertices.map((point) => applyAssetMatrix(composed, point)),
        triangles: primitive.triangles.map((triangle) => [...triangle]),
    });
}

function referencedRevision(resolvedChildren, assetId, revision) {
    const key = `${assetId}@${revision}`;
    const value = resolvedChildren instanceof Map ? resolvedChildren.get(key) : resolvedChildren?.[key];
    if (!value) throw new TypeError(`Missing pinned child revision ${key}.`);
    return value;
}

function namespaceMetricId(ancestorId, childId) {
    const ancestor = String(ancestorId);
    return `${ancestor.length}.${ancestor}.${String(childId)}`;
}

/**
 * Compile a validated definition. `sourceGeometries[sourceId][nodeIndex]`
 * contains numeric vertices/triangles. Child revisions expose their compiled
 * `modelUseHash`, flattened PBR `appearance`, and immutable `metric` snapshot.
 */
export function compileAssetDefinition(definitionInput, {
    sourceGeometries = {},
    resolvedChildren = {},
    ancestry = [],
    ceilings = { nodesPerMesh: 100_000, trianglesPerMesh: 4_000_000, graphDepth: 64 },
} = {}) {
    const rawIssues = validateAssetDefinition(definitionInput);
    if (rawIssues.some((entry) => entry.severity === "error")) throw Object.assign(new TypeError(rawIssues[0].message), { issues: rawIssues });
    const definition = normalizeAssetDefinition(definitionInput);
    const issues = validateAssetDefinition(definition);
    if (issues.some((entry) => entry.severity === "error")) throw Object.assign(new TypeError(issues[0].message), { issues });
    if (ancestry.length > ceilings.graphDepth) throw new TypeError("Asset assembly exceeds the graph-depth ceiling.");
    const matrices = partMatrices(definition);
    const geometryFingerprints = new Map();
    const appearanceParts = [];
    const materials = [];
    const collision = [];
    const lidar = [];
    let triangleCount = 0;
    for (const part of definition.parts) {
        const matrix = matrices.get(part.id);
        if (part.content.kind === "model-node") {
            const mesh = transformedMesh(geometryFor(sourceGeometries, part.content.sourceId, part.content.nodeIndex), matrix);
            triangleCount += mesh.triangles.length;
            if (mesh.vertices.length > ceilings.nodesPerMesh || triangleCount > ceilings.trianglesPerMesh) throw new TypeError("Asset assembly exceeds decoded geometry ceilings.");
            geometryFingerprints.set(part.id, simulationSha256(mesh));
            if (part.appearanceVisible) appearanceParts.push({ kind: "model-node", id: part.id, sourceId: part.content.sourceId, nodeIndex: part.content.nodeIndex, matrix, materialBindings: part.materialBindings });
        } else if (part.content.kind === "asset-reference") {
            const childKey = `${part.content.assetId}@${part.content.revision}`;
            if (ancestry.includes(childKey)) throw new TypeError(`Asset assembly dependency cycle: ${[...ancestry, childKey].join(" -> ")}.`);
            const child = referencedRevision(resolvedChildren, part.content.assetId, part.content.revision);
            geometryFingerprints.set(part.id, child.geometryHash ?? child.modelUseHash);
            if (part.appearanceVisible) appearanceParts.push({
                kind: "asset-reference", id: part.id, assetId: part.content.assetId,
                revision: part.content.revision, modelUseHash: child.modelUseHash, matrix,
            });
            for (const material of child.appearance ?? []) materials.push({ ...structuredClone(material), id: `${part.id}/${material.id}` });
            for (const entry of child.metric?.collision ?? []) collision.push(transformMetricProxy(entry, matrix, namespaceMetricId(part.id, entry.id), "collision"));
            for (const entry of child.metric?.lidar ?? []) lidar.push(transformMetricProxy(entry, matrix, namespaceMetricId(part.id, entry.id), "lidar"));
        } else {
            geometryFingerprints.set(part.id, simulationSha256({ matrix, children: definition.parts.filter((entry) => entry.parentId === part.id).map((entry) => entry.id) }));
        }
    }
    const rootNormalization = normalizationMatrix(definition.normalization);
    for (const proxy of definition.collisionProxies.filter((entry) => entry.enabled)) collision.push(transformMetricProxy(proxy, proxy.generated ? identity() : rootNormalization, proxy.id, "collision"));
    for (const proxy of definition.lidarProxies.filter((entry) => entry.enabled)) lidar.push(transformMetricProxy(proxy, proxy.generated ? identity() : rootNormalization, proxy.id, "lidar"));
    const metric = normalizeAssetMetric({ version: 1, collision, lidar });
    const staleProxyIds = staleGeneratedProxyIds(definition, geometryFingerprints);
    return {
        compilerVersion: ASSET_COMPILER_VERSION,
        definition,
        appearanceParts: canonicalizeSimulationValue(appearanceParts.sort((a, b) => a.id.localeCompare(b.id))),
        materials: canonicalizeSimulationValue([...definition.materials.map((material) => structuredClone(material)), ...materials].sort((a, b) => a.id.localeCompare(b.id))),
        metric,
        metricHash: hashAssetMetric(metric),
        geometryFingerprints,
        staleProxyIds,
    };
}

export function generateVoxelProxy(definitionInput, { id, channel = "lidar", includedPartIds, voxelSize = 0.2, semantic = "unknown", sourceGeometries = {}, resolvedChildren = {} } = {}) {
    const rawIssues = validateAssetDefinition(definitionInput);
    if (rawIssues.some((entry) => entry.severity === "error")) throw Object.assign(new TypeError(rawIssues[0].message), { issues: rawIssues });
    const definition = normalizeAssetDefinition(definitionInput);
    const compiled = compileAssetDefinition(definition, { sourceGeometries, resolvedChildren });
    const ids = [...new Set(includedPartIds?.map(String) ?? [])].sort();
    const matrices = partMatrices(definition);
    const merged = { vertices: [], triangles: [] };
    for (const partId of ids) {
        const part = definition.parts.find((entry) => entry.id === partId);
        if (!part) continue;
        const append = (geometry, matrix) => {
            const mesh = transformedMesh(geometry, matrix);
            const offset = merged.vertices.length;
            merged.vertices.push(...mesh.vertices);
            merged.triangles.push(...mesh.triangles.map((triangle) => triangle.map((index) => index + offset)));
        };
        if (part.content.kind === "model-node") append(geometryFor(sourceGeometries, part.content.sourceId, part.content.nodeIndex), matrices.get(part.id));
        else if (part.content.kind === "asset-reference") {
            const child = referencedRevision(resolvedChildren, part.content.assetId, part.content.revision);
            for (const geometry of Object.values(child.geometry ?? {})) {
                append(geometry, multiplyAssetMatrices(matrices.get(part.id), geometry.matrix ?? identity()));
            }
        }
    }
    if (merged.triangles.length === 0) throw new TypeError("Generated proxy selection contains no triangle geometry.");
    const simplified = simplifyVoxelMesh(merged, voxelSize);
    const proxy = {
        id, kind: channel === "collision" ? "convex" : "mesh", enabled: true,
        ...(channel === "lidar" ? { semantic } : {}),
        transform: { position: [0,0,0], quaternion: [0,0,0,1], scale: [1,1,1] },
        ...simplified,
        generated: {
            generator: { id: "voxel-cluster", version: 1 }, parameters: { voxelSize },
            includedPartIds: ids,
            sourceRevisions: definition.parts.filter((part) => part.content.kind === "asset-reference").map((part) => ({ assetId: part.content.assetId, revision: part.content.revision })),
            inputGeometryHash: "0".repeat(64),
        },
    };
    proxy.generated.inputGeometryHash = hashGeneratedProxyInput(proxy, compiled.geometryFingerprints);
    return canonicalizeSimulationValue(proxy);
}
