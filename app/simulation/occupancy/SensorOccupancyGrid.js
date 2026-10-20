import {
    OCCUPANCY_CELLS,
    OCCUPANCY_RESOLUTION_M,
    SENSOR_OCCUPANCY_FREE,
    SENSOR_OCCUPANCY_OCCUPIED,
    SENSOR_OCCUPANCY_UNKNOWN,
} from "./constants.js";

function applyQuaternion(quaternion, vector) {
    const { x: qx, y: qy, z: qz, w: qw } = quaternion;
    const { x, y, z } = vector;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return {
        x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
        y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
        z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
    };
}

function pointInRing(x, z, ring) {
    let inside = false;
    let previous = ring.length - 1;
    for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index];
        const prior = ring[previous];
        const span = prior.z - current.z;
        const intersects = ((current.z > z) !== (prior.z > z))
            && (x < ((prior.x - current.x) * (z - current.z)) / span + current.x);
        if (intersects) inside = !inside;
        previous = index;
    }
    return inside;
}

function scanDimensions(calibration) {
    const layout = calibration?.scanLayout;
    if (layout?.azimuthsDeg && layout?.channels) {
        return {
            width: layout.azimuthsDeg.length,
            height: layout.channels.length,
            direction(row, column) {
                const channel = layout.channels[row];
                const phi = Number(channel.elevationDeg) * Math.PI / 180;
                const theta = (Number(layout.azimuthsDeg[column]) + Number(channel.azimuthOffsetDeg || 0)) * Math.PI / 180;
                const cosPhi = Math.cos(phi);
                return {
                    x: cosPhi * Math.cos(theta),
                    y: Math.sin(phi),
                    z: cosPhi * Math.sin(theta),
                };
            },
        };
    }
    const azimuth = calibration?.azimuth || {};
    const elevation = calibration?.elevation || {};
    const width = Math.ceil((Number(azimuth.endDeg) - Number(azimuth.startDeg)) / Number(azimuth.stepDeg));
    const height = Math.ceil((Number(elevation.endDeg) - Number(elevation.startDeg)) / Number(elevation.stepDeg));
    return {
        width,
        height,
        direction(row, column) {
            const phi = (Number(elevation.startDeg) + row * Number(elevation.stepDeg)) * Math.PI / 180;
            const theta = (Number(azimuth.startDeg) + column * Number(azimuth.stepDeg)) * Math.PI / 180;
            const cosPhi = Math.cos(phi);
            return {
                x: cosPhi * Math.cos(theta),
                y: Math.sin(phi),
                z: cosPhi * Math.sin(theta),
            };
        },
    };
}

function azimuthStepRadians(calibration) {
    const layout = calibration?.scanLayout;
    if (layout?.azimuthsDeg?.length > 1) {
        let step = Infinity;
        for (let index = 1; index < layout.azimuthsDeg.length; index += 1) {
            step = Math.min(step, Math.abs(layout.azimuthsDeg[index] - layout.azimuthsDeg[index - 1]));
        }
        if (Number.isFinite(step) && step > 0) return step * Math.PI / 180;
    }
    const step = Number(calibration?.azimuth?.stepDeg);
    return step > 0 ? step * Math.PI / 180 : Math.PI / 180;
}

function walkCells(x0, z0, x1, z1, resolution, visit) {
    const endCol = Math.floor(x1 / resolution);
    const endRow = Math.floor(z1 / resolution);
    let col = Math.floor(x0 / resolution);
    let row = Math.floor(z0 / resolution);
    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepCol = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepRow = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const deltaCol = stepCol === 0 ? Infinity : Math.abs(resolution / dx);
    const deltaRow = stepRow === 0 ? Infinity : Math.abs(resolution / dz);
    let maxCol = stepCol === 0
        ? Infinity
        : ((col + (stepCol > 0 ? 1 : 0)) * resolution - x0) / dx;
    let maxRow = stepRow === 0
        ? Infinity
        : ((row + (stepRow > 0 ? 1 : 0)) * resolution - z0) / dz;
    const limit = Math.ceil(Math.hypot(dx, dz) / resolution) + 3;
    for (let step = 0; step < limit; step += 1) {
        const done = col === endCol && row === endRow;
        visit(row, col, done);
        if (done) return;
        if (maxCol < maxRow) {
            if (stepCol === 0) return;
            col += stepCol;
            maxCol += deltaCol;
        } else {
            if (stepRow === 0) return;
            row += stepRow;
            maxRow += deltaRow;
        }
    }
}

/**
 * Reduce one raw metric-v2 range image into sparse world cells.
 * 0 is not stored. 1 is free. 2 is occupied. Occupied beats free.
 * Bins use the ray's world azimuth, not the buffer column.
 */
export function reduceRangeImage({
    buffer,
    calibration,
    origin,
    quaternion = { x: 0, y: 0, z: 0, w: 1 },
    resolutionM = OCCUPANCY_RESOLUTION_M,
    groundY = 0,
    minHeightM = 0.05,
    maxHeightM = 1.5,
    egoFootprint = [],
    roadSemanticId = 4,
} = {}) {
    if (!(buffer instanceof Float32Array) || !calibration || !origin) return [];
    const scan = scanDimensions(calibration);
    if (!Number.isInteger(scan.width) || !Number.isInteger(scan.height) || scan.width < 1 || scan.height < 1) return [];
    const expected = scan.width * scan.height * 4;
    if (buffer.length < expected) return [];
    const step = azimuthStepRadians(calibration);
    const bins = new Map();
    for (let row = 0; row < scan.height; row += 1) {
        for (let column = 0; column < scan.width; column += 1) {
            const offset = (row * scan.width + column) * 4;
            const range = buffer[offset];
            if (!(range > 0) || !Number.isFinite(range)) continue;
            const local = scan.direction(row, column);
            const direction = applyQuaternion(quaternion, local);
            const length = Math.hypot(direction.x, direction.y, direction.z);
            if (!(length > 0)) continue;
            const hitX = origin.x + direction.x / length * range;
            const hitY = origin.y + direction.y / length * range;
            const hitZ = origin.z + direction.z / length * range;
            const semanticId = Math.round(buffer[offset + 2]);
            const azimuth = Math.atan2(direction.z, direction.x);
            const key = Math.round(azimuth / step);
            let bin = bins.get(key);
            if (!bin) {
                bin = { objectRange: Infinity, objectX: 0, objectZ: 0, roadRange: -1, roadX: 0, roadZ: 0 };
                bins.set(key, bin);
            }
            const horizontal = Math.hypot(hitX - origin.x, hitZ - origin.z);
            if (semanticId === roadSemanticId) {
                if (horizontal >= bin.roadRange) {
                    bin.roadRange = horizontal;
                    bin.roadX = hitX;
                    bin.roadZ = hitZ;
                }
                continue;
            }
            const height = hitY - groundY;
            if (height < minHeightM || height > maxHeightM) continue;
            if (egoFootprint.length >= 3 && pointInRing(hitX, hitZ, egoFootprint)) continue;
            if (horizontal < bin.objectRange) {
                bin.objectRange = horizontal;
                bin.objectX = hitX;
                bin.objectZ = hitZ;
            }
        }
    }
    const painted = new Map();
    const paint = (row, col, value) => {
        const key = `${row}:${col}`;
        const current = painted.get(key) || SENSOR_OCCUPANCY_UNKNOWN;
        if (value > current) painted.set(key, value);
    };
    for (const bin of bins.values()) {
        if (Number.isFinite(bin.objectRange)) {
            walkCells(origin.x, origin.z, bin.objectX, bin.objectZ, resolutionM, (row, col, end) => {
                paint(row, col, end ? SENSOR_OCCUPANCY_OCCUPIED : SENSOR_OCCUPANCY_FREE);
            });
        } else if (bin.roadRange >= 0) {
            walkCells(origin.x, origin.z, bin.roadX, bin.roadZ, resolutionM, (row, col) => {
                paint(row, col, SENSOR_OCCUPANCY_FREE);
            });
        }
    }
    const cells = [];
    for (const [key, value] of painted) {
        const [row, col] = key.split(":");
        cells.push({ row: Number(row), col: Number(col), value });
    }
    return cells;
}

export function projectSparseCells(sparse, {
    originCol,
    originRow,
    cells = OCCUPANCY_CELLS,
    into = new Uint8Array(cells * cells),
} = {}) {
    into.fill(SENSOR_OCCUPANCY_UNKNOWN);
    for (const cell of sparse || []) {
        const col = cell.col - originCol;
        const row = cell.row - originRow;
        if (col < 0 || row < 0 || col >= cells || row >= cells) continue;
        const index = row * cells + col;
        if (cell.value > into[index]) into[index] = cell.value;
    }
    return into;
}
