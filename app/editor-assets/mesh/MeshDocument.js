/** Canonical triangle mesh used by the OBJ, STL, and PLY parsers. */

function copyVector(value, width) {
    if (!Array.isArray(value) || value.length < width) return null;
    const vector = [];
    for (let index = 0; index < width; index += 1) {
        const component = Number(value[index]);
        if (!Number.isFinite(component)) return null;
        vector.push(Object.is(component, -0) ? 0 : component);
    }
    return vector;
}

function copyVectors(values, width) {
    if (values == null) return null;
    if (!Array.isArray(values)) throw new TypeError(`Expected ${width}-vectors.`);
    return values.map((value, index) => {
        const vector = copyVector(value, width);
        if (!vector) throw new TypeError(`Vertex ${index} must be a finite ${width}-vector.`);
        return vector;
    });
}

function normalizePrimitive(value, index) {
    const positions = copyVectors(value?.positions, 3);
    if (!positions || positions.length === 0) throw new TypeError(`Primitive ${index} has no vertices.`);
    const normals = copyVectors(value?.normals, 3);
    const uvs = copyVectors(value?.uvs, 2);
    if (normals && normals.length !== positions.length) throw new TypeError(`Primitive ${index} normals do not match its vertices.`);
    if (uvs && uvs.length !== positions.length) throw new TypeError(`Primitive ${index} UVs do not match its vertices.`);
    if (!Array.isArray(value?.indices) || value.indices.length === 0 || value.indices.length % 3 !== 0) {
        throw new TypeError(`Primitive ${index} indices must be a non-empty triangle list.`);
    }
    const indices = value.indices.map((entry) => {
        const resolved = Number(entry);
        if (!Number.isInteger(resolved) || resolved < 0 || resolved >= positions.length) throw new TypeError(`Primitive ${index} has an out-of-range index.`);
        return resolved;
    });
    return {
        positions,
        normals,
        uvs,
        indices,
        materialId: value?.materialId == null || value.materialId === "" ? null : String(value.materialId),
    };
}

function normalizeMaterial(value, index) {
    const kd = copyVector(value?.kd, 3) ?? [1, 1, 1];
    const opacity = Number(value?.d ?? 1);
    const specular = Number(value?.ns ?? 0);
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new TypeError(`Material ${index} opacity must be finite and within 0..1.`);
    if (!Number.isFinite(specular)) throw new TypeError(`Material ${index} Ns must be finite.`);
    return {
        id: String(value?.id ?? `material-${index + 1}`),
        kd,
        d: opacity,
        ns: specular,
        mapKd: value?.mapKd == null || value.mapKd === "" ? null : String(value.mapKd),
    };
}

export function normalizeMeshDocument(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    const materials = (Array.isArray(source.materials) ? source.materials : []).map(normalizeMaterial);
    const materialIds = new Set(materials.map((material) => material.id));
    const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map((node, index) => ({
        id: String(node?.id ?? `object-${index + 1}`),
        name: String(node?.name ?? node?.id ?? `Object ${index + 1}`),
        parentId: node?.parentId == null || node.parentId === "" ? null : String(node.parentId),
        primitives: (Array.isArray(node?.primitives) ? node.primitives : []).map(normalizePrimitive),
    }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (nodeIds.size !== nodes.length) throw new TypeError("Mesh nodes must have unique ids.");
    for (const node of nodes) {
        if (node.parentId != null && !nodeIds.has(node.parentId)) throw new TypeError(`Mesh node "${node.id}" has a missing parent.`);
        for (const primitive of node.primitives) {
            if (primitive.materialId != null && !materialIds.has(primitive.materialId)) throw new TypeError(`Material "${primitive.materialId}" was not declared.`);
        }
    }
    const images = (Array.isArray(source.images) ? source.images : []).map((image) => {
        const bytes = image?.bytes instanceof Uint8Array ? image.bytes.slice() : Uint8Array.from(image?.bytes ?? []);
        return { path: String(image?.path ?? ""), bytes };
    });
    return { nodes, materials, images };
}

export function createMeshDocument(value = {}) {
    return normalizeMeshDocument(value);
}
