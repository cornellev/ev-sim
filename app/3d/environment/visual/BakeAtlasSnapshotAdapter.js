/**
 * Narrow Three adapter: extract canonical world-space triangles from a frozen
 * bake-snapshot scene. The atlas core never imports Three.
 */

import {
    canonicalExactStringify,
    sha256ExactBytes,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import { isVisualPreviewObject } from "./VisualPreviewIsolation.js";
import { sortAtlasTriangles } from "./BakeAtlasCore.js";

function digestJson(value) {
    return sha256ExactUtf8(canonicalExactStringify(value));
}

function geometryDigest(geometry) {
    const position = geometry?.attributes?.position?.array;
    if (position) return sha256ExactBytes(position);
    return digestJson({
        uuid: geometry?.uuid ?? "none",
        id: geometry?.id ?? 0,
    });
}

function textureDigest(texture) {
    if (!texture) return null;
    return digestJson({
        uuid: texture.uuid ?? null,
        imageWidth: texture.image?.width ?? texture.source?.data?.width ?? 0,
        imageHeight: texture.image?.height ?? texture.source?.data?.height ?? 0,
        encoding: texture.colorSpace ?? texture.encoding ?? null,
    });
}

function materialDigest(material) {
    return digestJson({
        type: material?.type ?? "none",
        color: typeof material?.color?.getHex === "function" ? material.color.getHex() : Number(material?.color) || 0,
        opacity: Number(material?.opacity ?? 1),
        transparent: material?.transparent === true,
        alphaTest: Number(material?.alphaTest ?? 0),
        map: textureDigest(material?.map),
        side: material?.side ?? 0,
    });
}

function assignedEntityId(object) {
    let current = object;
    while (current) {
        const data = current.userData ?? {};
        if (data.cevSimVisualInstanceId) return String(data.cevSimVisualInstanceId);
        if (data.buildingId) return String(data.buildingId);
        if (data.entityId) return String(data.entityId);
        current = current.parent;
    }
    return String(object.uuid);
}

function isHidden(object) {
    let current = object;
    while (current) {
        if (current.visible === false) return true;
        current = current.parent;
    }
    return false;
}

function transformPoint(matrix, x, y, z) {
    const e = matrix.elements;
    return {
        x: e[0] * x + e[4] * y + e[8] * z + e[12],
        y: e[1] * x + e[5] * y + e[9] * z + e[13],
        z: e[2] * x + e[6] * y + e[10] * z + e[14],
    };
}

function transformNormal(matrix, x, y, z) {
    const e = matrix.elements;
    const nx = e[0] * x + e[4] * y + e[8] * z;
    const ny = e[1] * x + e[5] * y + e[9] * z;
    const nz = e[2] * x + e[6] * y + e[10] * z;
    const mag = Math.hypot(nx, ny, nz);
    if (!(mag > 0)) return { x: 0, y: 1, z: 0 };
    return { x: nx / mag, y: ny / mag, z: nz / mag };
}

function attributeAt(attribute, index) {
    if (!attribute) return null;
    const itemSize = attribute.itemSize ?? 3;
    const offset = index * itemSize;
    const array = attribute.array;
    if (!array || offset + itemSize > array.length) return null;
    const values = [];
    for (let channel = 0; channel < itemSize; channel += 1) values.push(Number(array[offset + channel]));
    return values;
}

function triangleVertices(geometry, a, b, c) {
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const ia = a;
    const ib = b;
    const ic = c;
    const pa = attributeAt(position, ia);
    const pb = attributeAt(position, ib);
    const pc = attributeAt(position, ic);
    if (!pa || !pb || !pc) return null;
    const na = attributeAt(normal, ia);
    const nb = attributeAt(normal, ib);
    const nc = attributeAt(normal, ic);
    const uva = attributeAt(uv, ia);
    const uvb = attributeAt(uv, ib);
    const uvc = attributeAt(uv, ic);
    return { pa, pb, pc, na, nb, nc, uva, uvb, uvc };
}

function emitMeshTriangles(object, triangles) {
    if (!object.isMesh || !object.geometry || object.userData?.bakeIgnore) return;
    if (isVisualPreviewObject(object) || isHidden(object)) return;
    object.updateMatrixWorld?.(true);
    const geometry = object.geometry;
    const index = geometry.index;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const entityId = assignedEntityId(object);
    const digest = geometryDigest(geometry);
    const groups = geometry.groups?.length
        ? geometry.groups
        : [{ start: 0, count: index ? index.count : Math.floor(position.count / 3) * 3, materialIndex: 0 }];
    for (let primitiveIndex = 0; primitiveIndex < groups.length; primitiveIndex += 1) {
        const group = groups[primitiveIndex];
        const material = materials[group.materialIndex ?? 0] ?? materials[0];
        const materialId = `${entityId}:${primitiveIndex}:${materialDigest(material)}`;
        const start = group.start ?? 0;
        const count = group.count ?? 0;
        const triangleCount = Math.floor(count / 3);
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
            const offset = start + triangleIndex * 3;
            const ia = index ? index.getX(offset) : offset;
            const ib = index ? index.getX(offset + 1) : offset + 1;
            const ic = index ? index.getX(offset + 2) : offset + 2;
            const verts = triangleVertices(geometry, ia, ib, ic);
            if (!verts) continue;
            const wa = transformPoint(object.matrixWorld, verts.pa[0], verts.pa[1], verts.pa[2]);
            const wb = transformPoint(object.matrixWorld, verts.pb[0], verts.pb[1], verts.pb[2]);
            const wc = transformPoint(object.matrixWorld, verts.pc[0], verts.pc[1], verts.pc[2]);
            const na = verts.na
                ? transformNormal(object.matrixWorld, verts.na[0], verts.na[1], verts.na[2])
                : null;
            const nb = verts.nb
                ? transformNormal(object.matrixWorld, verts.nb[0], verts.nb[1], verts.nb[2])
                : null;
            const nc = verts.nc
                ? transformNormal(object.matrixWorld, verts.nc[0], verts.nc[1], verts.nc[2])
                : null;
            const ab = { x: wb.x - wa.x, y: wb.y - wa.y, z: wb.z - wa.z };
            const ac = { x: wc.x - wa.x, y: wc.y - wa.y, z: wc.z - wa.z };
            const face = {
                x: ab.y * ac.z - ab.z * ac.y,
                y: ab.z * ac.x - ab.x * ac.z,
                z: ab.x * ac.y - ab.y * ac.x,
            };
            const mag = Math.hypot(face.x, face.y, face.z);
            const faceNormal = mag > 0
                ? { x: face.x / mag, y: face.y / mag, z: face.z / mag }
                : { x: 0, y: 1, z: 0 };
            const uvs = verts.uva && verts.uvb && verts.uvc
                ? [verts.uva[0], verts.uva[1], verts.uvb[0], verts.uvb[1], verts.uvc[0], verts.uvc[1]]
                : null;
            triangles.push({
                entityId,
                geometryDigest: digest,
                primitiveIndex,
                triangleIndex,
                materialId,
                positions: [wa.x, wa.y, wa.z, wb.x, wb.y, wb.z, wc.x, wc.y, wc.z],
                normals: [
                    (na ?? faceNormal).x, (na ?? faceNormal).y, (na ?? faceNormal).z,
                    (nb ?? faceNormal).x, (nb ?? faceNormal).y, (nb ?? faceNormal).z,
                    (nc ?? faceNormal).x, (nc ?? faceNormal).y, (nc ?? faceNormal).z,
                ],
                uvs,
                uvValid: Boolean(uvs && uvs.every(Number.isFinite)),
            });
        }
    }
}

export function extractBakeSnapshotTriangles(scene) {
    const triangles = [];
    if (!scene?.traverse) return triangles;
    scene.traverse((object) => {
        if (object.userData?.bakeIgnore || isVisualPreviewObject(object)) return;
        emitMeshTriangles(object, triangles);
    });
    return sortAtlasTriangles(triangles);
}
