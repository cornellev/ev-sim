import { worldToScreen } from "../../../3d/editor/map/mapCoords.js";

const COST = [null, [251, 113, 133, 115]];
const TERNARY = [null, [56, 189, 248, 46], [167, 139, 250, 178]];

/**
 * Row-major RGBA. Index 0 stays clear. `cost` paints 1 as blocked.
 * `ternary` paints 1 as free and 2 as occupied.
 */
export function paintOccupancyRgba(cells, width, height, palette, into) {
    const colors = palette === "ternary" ? TERNARY : COST;
    const count = width * height;
    const out = into?.length === count * 4 ? into : new Uint8ClampedArray(count * 4);
    out.fill(0);
    for (let index = 0; index < count; index += 1) {
        const color = colors[cells[index]];
        if (!color) continue;
        const offset = index * 4;
        out[offset] = color[0];
        out[offset + 1] = color[1];
        out[offset + 2] = color[2];
        out[offset + 3] = color[3];
    }
    return out;
}

/** Screen box of the grid's minimum corner. +Z grows down the screen, so row 0 is the top. */
export function occupancyScreenRect(sample, viewport, size) {
    const near = worldToScreen({ x: sample.originX, z: sample.originZ }, viewport, size);
    const far = worldToScreen({
        x: sample.originX + sample.width * sample.resolutionM,
        z: sample.originZ + sample.height * sample.resolutionM,
    }, viewport, size);
    return {
        x: near.x,
        y: near.y,
        width: far.x - near.x,
        height: far.y - near.y,
        rotationDeg: -(Number(sample.yawRad) || 0) * 180 / Math.PI,
    };
}

export function paintOccupancyCanvas(canvas, sample) {
    if (!canvas || !sample?.cells || !(sample.width > 0) || !(sample.height > 0)) return;
    const width = sample.width;
    const height = sample.height;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context?.createImageData) return;
    let image = canvas._occupancyImage;
    if (!image || image.width !== width || image.height !== height) {
        image = context.createImageData(width, height);
        canvas._occupancyImage = image;
    }
    paintOccupancyRgba(sample.cells, width, height, sample.palette, image.data);
    context.putImageData(image, 0, 0);
}
