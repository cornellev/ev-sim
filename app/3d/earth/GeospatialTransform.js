import * as THREE from "three";
import { convertFromLatLng } from "../../util/Location.js";
import {
    ecefToWgs84,
    enuOffsetToWgs84 as enuOffsetToWgs84Pure,
    localEnuToEcefBasis,
    WGS84_A,
    wgs84ToEcef,
} from "../../autonomy/Geodesy.js";

/**
 * Convert WGS84 lat/lng (degrees) and height (meters) to ECEF coordinates.
 * @param {number} latDeg
 * @param {number} lngDeg
 * @param {number} [heightMeters]
 * @param {THREE.Vector3} [target]
 */
export function latLngHeightToECEF(latDeg, lngDeg, heightMeters = 0, target = new THREE.Vector3()) {
    const ecef = wgs84ToEcef(latDeg, lngDeg, heightMeters);
    return target.set(ecef.x, ecef.y, ecef.z);
}

function applyLocalEnuBasis(positionECEF, result) {
    const { east, up, north } = localEnuToEcefBasis(positionECEF);
    result.makeBasis(
        new THREE.Vector3(east.x, east.y, east.z),
        new THREE.Vector3(up.x, up.y, up.z),
        new THREE.Vector3(north.x, north.y, north.z),
    );
    result.setPosition(positionECEF);
    return result;
}

/**
 * Build a matrix mapping local Y-up X/Z ground plane to ECEF at anchor.
 * @param {number} latDeg
 * @param {number} lngDeg
 * @param {THREE.Matrix4} [result]
 */
export function makeLocalToECEFMatrix(latDeg, lngDeg, result = new THREE.Matrix4()) {
    return applyLocalEnuBasis(latLngHeightToECEF(latDeg, lngDeg, 0), result);
}

/**
 * Scene-local ground coordinates relative to anchor using Web Mercator (matches legacy GeoJSON import).
 * @param {number} latDeg
 * @param {number} lngDeg
 * @param {{ lat: number, lng: number }} anchor
 */
export function latLngToLocal(latDeg, lngDeg, anchor) {
    const point = convertFromLatLng(latDeg, lngDeg);
    const origin = convertFromLatLng(anchor.lat, anchor.lng);
    return {
        x: point.x - origin.x,
        z: point.z - origin.z,
    };
}

/**
 * Inverse of {@link latLngToLocal}.
 * @param {number} x
 * @param {number} z
 * @param {{ lat: number, lng: number }} anchor
 */
export function localToLatLng(x, z, anchor) {
    const origin = convertFromLatLng(anchor.lat, anchor.lng);
    const mercator = new THREE.Vector3(x + origin.x, 0, z + origin.z);

    const lngRad = mercator.x / WGS84_A;
    const latRad = 2 * Math.atan(Math.exp(mercator.z / WGS84_A)) - Math.PI / 2;
    return {
        lat: THREE.MathUtils.radToDeg(latRad),
        lng: THREE.MathUtils.radToDeg(lngRad),
    };
}

/**
 * Douglas-Peucker simplification for lat/lng polylines projected to local meters.
 * @param {Array<{ lat: number, lng: number }>} points
 * @param {{ lat: number, lng: number }} anchor
 * @param {number} toleranceMeters
 */
export function simplifyLatLngPolyline(points, anchor, toleranceMeters) {
    if (points.length <= 2) return points.slice();

    const localPoints = points.map((point) => ({
        ...point,
        ...latLngToLocal(point.lat, point.lng, anchor),
    }));

    const keep = new Array(localPoints.length).fill(false);
    keep[0] = true;
    keep[localPoints.length - 1] = true;

    const stack = [[0, localPoints.length - 1]];
    while (stack.length) {
        const [start, end] = stack.pop();
        let maxDistance = 0;
        let index = -1;
        const startPoint = localPoints[start];
        const endPoint = localPoints[end];

        for (let i = start + 1; i < end; i += 1) {
            const distance = perpendicularDistance(localPoints[i], startPoint, endPoint);
            if (distance > maxDistance) {
                maxDistance = distance;
                index = i;
            }
        }

        if (maxDistance > toleranceMeters && index !== -1) {
            keep[index] = true;
            stack.push([start, index], [index, end]);
        }
    }

    return localPoints.filter((_, index) => keep[index]).map(({ lat, lng }) => ({ lat, lng }));
}

/**
 * Convert ENU offset (meters) from a WGS84 datum to geodetic coordinates.
 * Map/odom REP-103 axes are treated as East (x), North (y), Up (z).
 * @param {number} east
 * @param {number} north
 * @param {number} up
 * @param {{ lat: number, lng: number, altitude?: number }} datum
 */
export function enuOffsetToWgs84(east, north, up, datum) {
    return enuOffsetToWgs84Pure(east, north, up, datum);
}

/**
 * @param {THREE.Vector3} ecef
 */
export function ecefToLatLngHeight(ecef) {
    return ecefToWgs84(ecef);
}

function perpendicularDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dz = lineEnd.z - lineStart.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq === 0) {
        return Math.hypot(point.x - lineStart.x, point.z - lineStart.z);
    }
    const t = ((point.x - lineStart.x) * dx + (point.z - lineStart.z) * dz) / lengthSq;
    const projX = lineStart.x + t * dx;
    const projZ = lineStart.z + t * dz;
    return Math.hypot(point.x - projX, point.z - projZ);
}
