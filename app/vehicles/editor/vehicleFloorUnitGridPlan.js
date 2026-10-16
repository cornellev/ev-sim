/** XZ floor meter grid for the vehicle studio. Pure: no Three, no DOM. */

import { raiseStepToBudget } from "../../3d/editor/assets/assetStudioUnitGridPlan.js";
import {
    formatSignedUnitLabel,
    formatUnitLabel,
    selectUnitStep,
    visibleMetersAtTarget,
} from "../../3d/editor/assets/assetStudioUnitScale.js";

const LABEL_OFFSET_PX = 16;
const MAJOR_CELLS = 10;

function finite(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function roundUpTo(value, step) {
    if (!(step > 0)) return 0;
    if (!(value > 0)) return step;
    return Math.ceil((value - 1e-9) / step) * step;
}

function axisLineCount(halfExtent, minorMeters) {
    return Math.round(halfExtent / minorMeters) * 2 + 1;
}

/** Match the asset-studio extent cap so a zoomed-out floor stays inside the line budget. */
function cappedHalfExtent(rawHalf, step, maxLinesPerAxis) {
    const halfExtent = roundUpTo(Math.max(rawHalf, step.majorMeters), step.majorMeters);
    if (axisLineCount(halfExtent, step.minorMeters) <= maxLinesPerAxis) return halfExtent;
    const cells = Math.floor((maxLinesPerAxis - 1) / 2);
    const capped = cells * step.minorMeters;
    const majorCells = Math.floor(capped / step.majorMeters);
    return majorCells > 0 ? majorCells * step.majorMeters : capped;
}

function windowRange(center, halfExtent, step) {
    if (!(step > 0) || !Number.isFinite(center) || !Number.isFinite(halfExtent)) {
        return { first: 0, last: -1, coords: [] };
    }
    const first = Math.ceil((center - halfExtent - 1e-9) / step);
    const last = Math.floor((center + halfExtent + 1e-9) / step);
    const coords = [];
    for (let index = first; index <= last; index += 1) coords.push(index * step);
    return { first, last, coords };
}

function isZero(value) {
    return Math.abs(value) <= 1e-9;
}

function isMajorIndex(index) {
    return ((index % MAJOR_CELLS) + MAJOR_CELLS) % MAJOR_CELLS === 0;
}

function pushSegment(out, x0, y, z0, x1, z1) {
    out.push(x0, y, z0, x1, y, z1);
}

/**
 * Floor grid through world (0, 0). The orbit target only chooses which
 * patch of that grid is drawn. Zoom changes the 1-2-5 step.
 */
export function planVehicleFloorUnitGrid({
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
    const centerX = finite(target?.x);
    const centerZ = finite(target?.z);
    const xWindow = windowRange(centerX, halfExtent, step.minorMeters);
    const zWindow = windowRange(centerZ, halfExtent, step.minorMeters);
    const y = 0;
    const minor = [];
    const major = [];
    const xStart = xWindow.coords[0];
    const xEnd = xWindow.coords[xWindow.coords.length - 1];
    const zStart = zWindow.coords[0];
    const zEnd = zWindow.coords[zWindow.coords.length - 1];
    const xSpan = xWindow.coords.length >= 2;
    const zSpan = zWindow.coords.length >= 2;

    if (zSpan) {
        for (let index = xWindow.first; index <= xWindow.last; index += 1) {
            if (index === 0) continue;
            const x = index * step.minorMeters;
            const dest = isMajorIndex(index) ? major : minor;
            pushSegment(dest, x, y, zStart, x, zEnd);
        }
    }
    if (xSpan) {
        for (let index = zWindow.first; index <= zWindow.last; index += 1) {
            if (index === 0) continue;
            const z = index * step.minorMeters;
            const dest = isMajorIndex(index) ? major : minor;
            pushSegment(dest, xStart, y, z, xEnd, z);
        }
    }

    const xAxisInWindow = zWindow.first <= 0 && zWindow.last >= 0 && xSpan;
    const zAxisInWindow = xWindow.first <= 0 && xWindow.last >= 0 && zSpan;
    const metersPerPixel = visible.metersPerPixel;
    const offset = LABEL_OFFSET_PX * (metersPerPixel > 0 ? metersPerPixel : 0);
    const labels = [];
    const originInWindow = xWindow.first <= 0 && xWindow.last >= 0 && zWindow.first <= 0 && zWindow.last >= 0;
    if (xAxisInWindow) {
        const majors = windowRange(centerX, halfExtent, step.majorMeters);
        for (const meters of majors.coords) {
            if (isZero(meters)) continue;
            labels.push({
                axis: "x",
                meters,
                text: formatSignedUnitLabel(meters),
                position: { x: meters, y, z: -offset },
            });
        }
    }
    if (zAxisInWindow) {
        const majors = windowRange(centerZ, halfExtent, step.majorMeters);
        for (const meters of majors.coords) {
            if (isZero(meters)) continue;
            labels.push({
                axis: "z",
                meters,
                text: formatSignedUnitLabel(meters),
                position: { x: offset, y, z: meters },
            });
        }
    }
    if (originInWindow) {
        labels.push({
            axis: "origin",
            meters: 0,
            text: "0",
            position: { x: offset, y, z: -offset },
        });
    }

    return {
        minorMeters: step.minorMeters,
        majorMeters: step.majorMeters,
        label: formatUnitLabel(step.minorMeters),
        metersPerPixel,
        origin: { x: 0, y: 0, z: 0 },
        halfExtent,
        indices: {
            firstX: xWindow.first,
            lastX: xWindow.last,
            firstZ: zWindow.first,
            lastZ: zWindow.last,
        },
        minor,
        major,
        axes: {
            x: xAxisInWindow ? [xStart, y, 0, xEnd, y, 0] : null,
            z: zAxisInWindow ? [0, y, zStart, 0, y, zEnd] : null,
        },
        labels,
    };
}

/** Rebuild geometry only when the step or the visible world-index range changes. */
export function floorGridPlanSignature(plan) {
    const indices = plan?.indices ?? {};
    return `${plan?.minorMeters}|${indices.firstX}|${indices.lastX}|${indices.firstZ}|${indices.lastZ}`;
}
