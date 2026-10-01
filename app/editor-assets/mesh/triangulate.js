/** Fan-triangulate a polygon. `face` entries are returned unchanged. */

export function triangulatePolygon(face) {
    if (!Array.isArray(face) || face.length < 3) throw new Error("Polygon face must have at least 3 vertices.");
    const triangles = [];
    for (let index = 1; index < face.length - 1; index += 1) triangles.push([face[0], face[index], face[index + 1]]);
    return triangles;
}
