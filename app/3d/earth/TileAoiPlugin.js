import { wgs84ToEcef } from "../../autonomy/Geodesy.js";

function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
        }
    }
    return out;
}

function transformPoint(matrix, point) {
    return {
        x: matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12],
        y: matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13],
        z: matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14],
    };
}

function transformVector(matrix, point) {
    return {
        x: matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z,
        y: matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z,
        z: matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z,
    };
}

function length(value) { return Math.hypot(value.x, value.y, value.z); }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

function aoiSphere(bounds) {
    const center = { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2, height: 0 };
    const centerEcef = wgs84ToEcef(center.lat, center.lng, center.height);
    const corners = [
        [bounds.south, bounds.west], [bounds.south, bounds.east],
        [bounds.north, bounds.west], [bounds.north, bounds.east],
    ].map(([lat, lng]) => wgs84ToEcef(lat, lng, 1000));
    return { center: centerEcef, radius: Math.max(...corners.map((point) => distance(point, centerEcef))) };
}

function regionDisjoint(region, bounds) {
    const [west, south, east, north] = region;
    const degrees = { west: west * 180 / Math.PI, south: south * 180 / Math.PI, east: east * 180 / Math.PI, north: north * 180 / Math.PI };
    return degrees.east < bounds.west || degrees.west > bounds.east
        || degrees.north < bounds.south || degrees.south > bounds.north;
}

function volumeSphere(volume, matrix) {
    if (Array.isArray(volume?.sphere) && volume.sphere.length >= 4) {
        const center = transformPoint(matrix, { x: volume.sphere[0], y: volume.sphere[1], z: volume.sphere[2] });
        const scales = [
            length(transformVector(matrix, { x: 1, y: 0, z: 0 })),
            length(transformVector(matrix, { x: 0, y: 1, z: 0 })),
            length(transformVector(matrix, { x: 0, y: 0, z: 1 })),
        ];
        return { center, radius: volume.sphere[3] * Math.max(...scales) };
    }
    if (Array.isArray(volume?.box) && volume.box.length >= 12) {
        const center = transformPoint(matrix, { x: volume.box[0], y: volume.box[1], z: volume.box[2] });
        const radius = [3, 6, 9].reduce((sum, index) => sum + length(transformVector(matrix, {
            x: volume.box[index], y: volume.box[index + 1], z: volume.box[index + 2],
        })), 0);
        return { center, radius };
    }
    return null;
}

/** Conservatively removes only child hierarchies provably disjoint from an AOI. */
export class TileAoiPlugin {
    constructor(bounds) {
        this.name = "ED08_TILE_AOI";
        this.priority = -100;
        this.bounds = structuredClone(bounds);
        this.sphere = aoiSphere(bounds);
    }

    preprocessNode(tile, _tilesetDir, parentTile = null) {
        const parentMatrix = parentTile?.internal?.ed08AccumulatedTransform ?? identity();
        const matrix = multiply(parentMatrix, Array.isArray(tile.transform) ? tile.transform : identity());
        tile.internal.ed08AccumulatedTransform = matrix;
        const volume = tile.boundingVolume;
        let disjoint = false;
        if (Array.isArray(volume?.region)) disjoint = regionDisjoint(volume.region, this.bounds);
        else {
            const sphere = volumeSphere(volume, matrix);
            if (sphere) disjoint = distance(sphere.center, this.sphere.center) > sphere.radius + this.sphere.radius;
        }
        tile.internal.ed08AoiDisjoint = disjoint;
        if (disjoint && Array.isArray(tile.children)) tile.children.length = 0;
    }

    calculateTileViewError(tile, target) {
        if (tile.internal?.ed08AoiDisjoint !== true) return false;
        target.inView = false;
        target.error = 0;
        target.distanceFromCamera = Infinity;
        return true;
    }
}
