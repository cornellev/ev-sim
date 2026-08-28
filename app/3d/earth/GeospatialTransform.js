import * as THREE from "three";
import { convertFromLatLng } from "../../util/Location.js";

const WGS84_A = 6378137;
const WGS84_E2 = 0.00669437999014;
const ECEF_Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Convert WGS84 lat/lng (degrees) and height (meters) to ECEF coordinates.
 * @param {number} latDeg
 * @param {number} lngDeg
 * @param {number} [heightMeters]
 * @param {THREE.Vector3} [target]
 */
export function latLngHeightToECEF(latDeg, lngDeg, heightMeters = 0, target = new THREE.Vector3()) {
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lng = THREE.MathUtils.degToRad(lngDeg);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLng = Math.sin(lng);
    const cosLng = Math.cos(lng);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

    return target.set(
        (n + heightMeters) * cosLat * cosLng,
        (n + heightMeters) * cosLat * sinLng,
        (n * (1 - WGS84_E2) + heightMeters) * sinLat,
    );
}

/**
 * Build a matrix mapping local Y-up X/Z ground plane to ECEF at anchor.
 * @param {number} latDeg
 * @param {number} lngDeg
 * @param {THREE.Matrix4} [result]
 */
export function makeLocalToECEFMatrix(latDeg, lngDeg, result = new THREE.Matrix4()) {
    const positionECEF = latLngHeightToECEF(latDeg, lngDeg, 0);
    const up = positionECEF.clone().normalize();
    const east = ECEF_Z_AXIS.clone().cross(up).normalize();
    const north = up.clone().cross(east).normalize();

    result.makeBasis(east, up, north);
    result.setPosition(positionECEF);
    return result;
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
    const matrix = makeLocalToECEFMatrix(datum.lat, datum.lng);
    const local = new THREE.Vector3(Number(east) || 0, Number(up) || 0, Number(north) || 0);
    const ecef = local.applyMatrix4(matrix);
    return ecefToLatLngHeight(ecef);
}

/**
 * @param {THREE.Vector3} ecef
 */
export function ecefToLatLngHeight(ecef) {
    const x = ecef.x;
    const y = ecef.y;
    const z = ecef.z;
    const b = WGS84_A * Math.sqrt(1 - WGS84_E2);
    const ep = Math.sqrt((WGS84_A * WGS84_A - b * b) / (b * b));
    const p = Math.hypot(x, y);
    const th = Math.atan2(WGS84_A * z, b * p);
    const sinTh = Math.sin(th);
    const cosTh = Math.cos(th);
    const lat = Math.atan2(z + ep * ep * b * sinTh * sinTh * sinTh, p - WGS84_E2 * WGS84_A * cosTh * cosTh * cosTh);
    const lng = Math.atan2(y, x);
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const alt = p / Math.cos(lat) - n;
    return {
        lat: THREE.MathUtils.radToDeg(lat),
        lng: THREE.MathUtils.radToDeg(lng),
        alt,
    };
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
