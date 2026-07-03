import * as THREE from "three";
import { DEFAULT_EARTH_IMPORT_CONFIG } from "../EarthImportConfig.js";
import { latLngToLocal } from "../GeospatialTransform.js";

/** @typedef {{ north: number, south: number, east: number, west: number }} GeoBounds */
/** @typedef {{ lat: number, lng: number }} LatLng */
/** @typedef {{ x: number, z: number }} LocalCorner */
/** @typedef {{ baseY: number, topY: number }} OutlineVerticalRange */

const GRID_STEP_METERS = 5;
const OUTLINE_COLOR = 0xef4444;
const OUTLINE_OPACITY = 0.55;
const FALLBACK_TOP_METERS = 300;

/**
 * @param {GeoBounds} bounds
 * @param {LatLng} anchor
 * @returns {{ sw: LocalCorner, se: LocalCorner, ne: LocalCorner, nw: LocalCorner }}
 */
export function geoBoundsToLocalCorners(bounds, anchor) {
    return {
        sw: latLngToLocal(bounds.south, bounds.west, anchor),
        se: latLngToLocal(bounds.south, bounds.east, anchor),
        ne: latLngToLocal(bounds.north, bounds.east, anchor),
        nw: latLngToLocal(bounds.north, bounds.west, anchor),
    };
}

/**
 * @param {{ sw: LocalCorner, se: LocalCorner, ne: LocalCorner, nw: LocalCorner }} corners
 */
export function cornersToSamplePoints(corners) {
    const { sw, se, ne, nw } = corners;
    return [
        sw,
        se,
        ne,
        nw,
        {
            x: (sw.x + ne.x) / 2,
            z: (sw.z + ne.z) / 2,
        },
    ];
}

/**
 * @param {{ minY?: number, maxY?: number, sampled?: boolean }} tileElevation
 * @param {number} [clearanceMeters]
 * @returns {OutlineVerticalRange}
 */
export function computeOutlineVerticalRange(
    tileElevation = {},
    clearanceMeters = DEFAULT_EARTH_IMPORT_CONFIG.boundsOutlineClearanceMeters,
) {
    const baseY = tileElevation.sampled ? Math.min(0, tileElevation.minY ?? 0) : 0;
    const maxTileY = tileElevation.sampled ? (tileElevation.maxY ?? 0) : 0;
    const topY = tileElevation.sampled
        ? maxTileY + clearanceMeters
        : FALLBACK_TOP_METERS;

    return {
        baseY,
        topY: Math.max(topY, baseY + clearanceMeters),
    };
}

/**
 * @param {LocalCorner} a
 * @param {LocalCorner} b
 */
function localCornerDistance(a, b) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.hypot(dx, dz);
}

/**
 * @param {LocalCorner} a
 * @param {LocalCorner} b
 * @param {number} t
 */
function lerpCorner(a, b, t) {
    return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
    };
}

/**
 * @param {THREE.Vector3[]} points
 */
function pushLine(points, ax, ay, az, bx, by, bz) {
    points.push(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz));
}

/**
 * Build a vertical red boundary grid for the selected import bounds.
 * Mirrors the environment chunk outline style but in scene-local coordinates.
 *
 * @param {{ sw: LocalCorner, se: LocalCorner, ne: LocalCorner, nw: LocalCorner }} corners
 * @param {OutlineVerticalRange} verticalRange
 */
export function createGeoBoundsOutlineLines(corners, verticalRange) {
    const { sw, se, ne, nw } = corners;
    const { baseY, topY } = verticalRange;
    const height = Math.max(1, topY - baseY);
    const points = [];
    const perimeter = [sw, se, ne, nw];

    for (const corner of perimeter) {
        pushLine(points, corner.x, baseY, corner.z, corner.x, topY, corner.z);
    }

    for (let index = 0; index < perimeter.length; index += 1) {
        const a = perimeter[index];
        const b = perimeter[(index + 1) % perimeter.length];
        pushLine(points, a.x, baseY, a.z, b.x, baseY, b.z);
        pushLine(points, a.x, topY, a.z, b.x, topY, b.z);
    }

    const maxEdge = Math.max(
        localCornerDistance(sw, se),
        localCornerDistance(se, ne),
        localCornerDistance(ne, nw),
        localCornerDistance(nw, sw),
    );
    const planarDivisions = Math.max(1, Math.round(maxEdge / GRID_STEP_METERS));
    const yDivisions = Math.max(1, Math.round(height / GRID_STEP_METERS));

    for (let index = 0; index <= planarDivisions; index += 1) {
        const t = index / planarDivisions;
        const south = lerpCorner(sw, se, t);
        const north = lerpCorner(nw, ne, t);
        const west = lerpCorner(sw, nw, t);
        const east = lerpCorner(se, ne, t);

        pushLine(points, south.x, baseY, south.z, south.x, topY, south.z);
        pushLine(points, north.x, baseY, north.z, north.x, topY, north.z);
        pushLine(points, west.x, baseY, west.z, west.x, topY, west.z);
        pushLine(points, east.x, baseY, east.z, east.x, topY, east.z);
    }

    for (let yi = 0; yi <= yDivisions; yi += 1) {
        const y = baseY + (height * yi) / yDivisions;
        for (let index = 0; index < perimeter.length; index += 1) {
            const a = perimeter[index];
            const b = perimeter[(index + 1) % perimeter.length];
            pushLine(points, a.x, y, a.z, b.x, y, b.z);
        }
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
        color: OUTLINE_COLOR,
        transparent: true,
        opacity: OUTLINE_OPACITY,
        depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = "EarthImportBoundsOutline";
    lines.renderOrder = 999;
    lines.userData.skipEnvironmentSelection = true;
    lines.userData.earthImportLayer = true;
    lines.userData.preserveInEarthImportMode = true;
    return lines;
}

/**
 * @param {GeoBounds} bounds
 * @param {LatLng} anchor
 * @param {OutlineVerticalRange} verticalRange
 */
export function createGeoBoundsOutlineGroup(bounds, anchor, verticalRange) {
    const corners = geoBoundsToLocalCorners(bounds, anchor);
    const group = new THREE.Group();
    group.name = "EarthImportBoundsOutline";
    group.userData.skipEnvironmentSelection = true;
    group.userData.earthImportLayer = true;
    group.userData.preserveInEarthImportMode = true;
    group.add(createGeoBoundsOutlineLines(corners, verticalRange));
    return group;
}
