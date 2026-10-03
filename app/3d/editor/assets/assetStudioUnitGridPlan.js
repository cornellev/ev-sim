/** Three-plane meter grid layout for the asset studio. Pure: no Three, no DOM. */

import { formatSignedUnitLabel, formatUnitLabel, nextNiceStep, selectUnitStep, visibleMetersAtTarget } from "./assetStudioUnitScale.js";

const MAX_STEP_METERS = 1000;
const PLANE_AXES = {
    xy: { fixed: "z", u: "x", v: "y" },
    xz: { fixed: "y", u: "x", v: "z" },
    yz: { fixed: "x", u: "y", v: "z" },
};

function finite(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function roundUpTo(value, step) {
    if (!(step > 0)) return 0;
    if (!(value > 0)) return step;
    return Math.ceil((value - 1e-9) / step) * step;
}

function snap(value, step) {
    if (!(step > 0)) return 0;
    return Math.round(finite(value) / step) * step;
}

function axisLineCount(halfExtent, minorMeters) {
    return Math.round(halfExtent / minorMeters) * 2 + 1;
}

/**
 * Coarsen `step` until each axis of the rounded extent stays within
 * `maxLinesPerAxis`. The extent used for the count is `halfExtent` rounded
 * up to a major step, and at least one major cell.
 */
export function raiseStepToBudget(step, halfExtent, maxLinesPerAxis = 160) {
    let minorMeters = step.minorMeters;
    let majorMeters = step.majorMeters;
    const rawHalf = finite(halfExtent) > 0 ? halfExtent : 0;
    const limit = Number.isFinite(maxLinesPerAxis) && maxLinesPerAxis >= 1 ? maxLinesPerAxis : 160;
    for (let guard = 0; guard < 80; guard += 1) {
        const extent = roundUpTo(Math.max(rawHalf, majorMeters), majorMeters);
        if (axisLineCount(extent, minorMeters) <= limit) return { minorMeters, majorMeters };
        const next = nextNiceStep(minorMeters);
        if (!(next > minorMeters) || next > MAX_STEP_METERS) break;
        minorMeters = next;
        majorMeters = minorMeters * 10;
    }
    return { minorMeters, majorMeters };
}

function axisCoordinates(origin, halfExtent, step) {
    const count = Math.max(0, Math.round(halfExtent / step));
    const coords = new Array(count * 2 + 1);
    for (let i = -count; i <= count; i += 1) coords[i + count] = origin + i * step;
    return coords;
}

function isMajorIndex(origin, step, major, offset) {
    const ratio = Math.round(major / step);
    const originIndex = Math.round(origin / step);
    if (!(ratio > 1)) return true;
    const index = originIndex + offset;
    return ((index % ratio) + ratio) % ratio === 0;
}

function pushSegment(out, coords) {
    out.push(coords.x0, coords.y0, coords.z0, coords.x1, coords.y1, coords.z1);
}

function endpoint(origin, axis, value) {
    return { x: origin.x, y: origin.y, z: origin.z, [axis]: value };
}

function planeSegments(id, origin, halfExtent, minorMeters, majorMeters) {
    const { fixed, u, v } = PLANE_AXES[id];
    const uCount = Math.max(0, Math.round(halfExtent / minorMeters));
    const vCount = uCount;
    const uCoords = axisCoordinates(origin[u], halfExtent, minorMeters);
    const vCoords = axisCoordinates(origin[v], halfExtent, minorMeters);
    const minor = [];
    const major = [];
    const fixedValue = origin[fixed];
    for (let i = 0; i < uCoords.length; i += 1) {
        const offset = i - uCount;
        if (offset === 0) continue;
        const dest = isMajorIndex(origin[u], minorMeters, majorMeters, offset) ? major : minor;
        const start = endpoint(origin, u, uCoords[i]);
        const end = endpoint(origin, u, uCoords[i]);
        start[v] = vCoords[0];
        end[v] = vCoords[vCoords.length - 1];
        start[fixed] = fixedValue;
        end[fixed] = fixedValue;
        pushSegment(dest, { x0: start.x, y0: start.y, z0: start.z, x1: end.x, y1: end.y, z1: end.z });
    }
    for (let i = 0; i < vCoords.length; i += 1) {
        const offset = i - vCount;
        if (offset === 0) continue;
        const dest = isMajorIndex(origin[v], minorMeters, majorMeters, offset) ? major : minor;
        const start = endpoint(origin, v, vCoords[i]);
        const end = endpoint(origin, v, vCoords[i]);
        start[u] = uCoords[0];
        end[u] = uCoords[uCoords.length - 1];
        start[fixed] = fixedValue;
        end[fixed] = fixedValue;
        pushSegment(dest, { x0: start.x, y0: start.y, z0: start.z, x1: end.x, y1: end.y, z1: end.z });
    }
    return { minor, major };
}

function majorCoordinates(center, halfExtent, major) {
    if (!(major > 0)) return [];
    const first = Math.ceil((center - halfExtent - 1e-9) / major);
    const last = Math.floor((center + halfExtent + 1e-9) / major);
    const coords = [];
    for (let index = first; index <= last; index += 1) coords.push(index * major);
    return coords;
}

const LABEL_OFFSET_PX = 16;

function isZeroTick(meters, major) {
    return Math.abs(meters) <= Math.max(major * 1e-6, 1e-9);
}

/** Place a tick label just off its axis so the glyph does not cover the stroke. */
function labelPosition(axis, meters, origin, offset) {
    const position = { x: origin.x, y: origin.y, z: origin.z, [axis]: meters };
    if (axis === "x") position.z -= offset;
    else position.x += offset;
    return position;
}

/**
 * One signed measurement per major tick on X, Y, and Z.
 * The three zero ticks collapse to a single `0` at the origin.
 */
export function planAxisLabels({ origin, halfExtent, majorMeters, metersPerPixel } = {}) {
    const safeOrigin = {
        x: finite(origin?.x),
        y: finite(origin?.y),
        z: finite(origin?.z),
    };
    const offset = LABEL_OFFSET_PX * (Number.isFinite(metersPerPixel) && metersPerPixel > 0 ? metersPerPixel : 0);
    const labels = [];
    let sawZero = false;
    for (const axis of ["x", "y", "z"]) {
        for (const meters of majorCoordinates(safeOrigin[axis], halfExtent, majorMeters)) {
            if (isZeroTick(meters, majorMeters)) {
                sawZero = true;
                continue;
            }
            labels.push({
                axis,
                meters,
                text: formatSignedUnitLabel(meters),
                position: labelPosition(axis, meters, safeOrigin, offset),
            });
        }
    }
    if (sawZero) {
        const atWorldZero = ["x", "y", "z"].every((axis) => Math.abs(safeOrigin[axis]) <= 1e-6);
        labels.push({
            axis: "origin",
            meters: 0,
            text: "0",
            position: atWorldZero
                ? { x: safeOrigin.x + offset, y: safeOrigin.y, z: safeOrigin.z - offset }
                : { x: offset, y: 0, z: -offset },
        });
    }
    return labels;
}

function cappedHalfExtent(rawHalf, step, maxLinesPerAxis) {
    let halfExtent = roundUpTo(Math.max(rawHalf, step.majorMeters), step.majorMeters);
    if (axisLineCount(halfExtent, step.minorMeters) <= maxLinesPerAxis) return halfExtent;
    const cells = Math.floor((maxLinesPerAxis - 1) / 2);
    const capped = cells * step.minorMeters;
    const majorCells = Math.floor(capped / step.majorMeters);
    return majorCells > 0 ? majorCells * step.majorMeters : capped;
}

/**
 * XY, XZ, and YZ grids through the orbit target.
 * Cell size follows zoom; the cross fills the view; line count stays capped.
 */
export function planAssetStudioUnitGrid({
    target = { x: 0, y: 0, z: 0 },
    distance,
    fovDegrees,
    viewportWidthPx,
    viewportHeightPx,
    maxLinesPerAxis = 160,
} = {}) {
    const visible = visibleMetersAtTarget({ distance, fovDegrees, viewportHeightPx, viewportWidthPx });
    const rawHalf = Math.max(visible.width, visible.height) * 0.75;
    const limit = Number.isFinite(maxLinesPerAxis) && maxLinesPerAxis >= 1 ? maxLinesPerAxis : 160;
    const step = raiseStepToBudget(selectUnitStep(visible.metersPerPixel), rawHalf, limit);
    const halfExtent = cappedHalfExtent(rawHalf, step, limit);
    const origin = {
        x: snap(target.x, step.minorMeters),
        y: snap(target.y, step.minorMeters),
        z: snap(target.z, step.minorMeters),
    };
    const planes = ["xy", "xz", "yz"].map((id) => ({
        id,
        ...planeSegments(id, origin, halfExtent, step.minorMeters, step.majorMeters),
    }));
    const { x, y, z } = origin;
    const metersPerPixel = visible.metersPerPixel;
    return {
        minorMeters: step.minorMeters,
        majorMeters: step.majorMeters,
        label: formatUnitLabel(step.minorMeters),
        metersPerPixel,
        origin,
        halfExtent,
        planes,
        labels: planAxisLabels({ origin, halfExtent, majorMeters: step.majorMeters, metersPerPixel }),
        axes: {
            x: [x - halfExtent, y, z, x + halfExtent, y, z],
            y: [x, y - halfExtent, z, x, y + halfExtent, z],
            z: [x, y, z - halfExtent, x, y, z + halfExtent],
        },
    };
}

/** Rebuild geometry only when the step, snapped origin, or extent changes. */
export function gridPlanSignature(plan) {
    const origin = plan?.origin ?? {};
    return `${plan?.minorMeters}|${origin.x}|${origin.y}|${origin.z}|${plan?.halfExtent}`;
}
