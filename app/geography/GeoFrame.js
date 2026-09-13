/**
 * Pure WGS84 <-> editor-local frame math for ED-08.
 *
 * The editor frame is right handed and Y-up: +X east, +Y ellipsoid up,
 * +Z south. Matrices are column-major plain arrays so editor commands,
 * browser tile sessions, and Node authoring tools share one implementation.
 */

import { ecefToWgs84, wgs84ToEcef } from "../autonomy/Geodesy.js";

export const GEO_FRAME_VERSION = 1;
export const GEO_FRAME_PROJECTION = "wgs84-local-tangent";
export const GEO_FRAME_AXES = "east-up-south";

function finite(value, label) {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite.`);
    return result;
}

function validateOrigin(origin = {}) {
    const lat = finite(origin.lat, "Geo frame latitude");
    const lng = finite(origin.lng, "Geo frame longitude");
    const height = finite(origin.height ?? 0, "Geo frame height");
    if (lat < -90 || lat > 90) throw new RangeError("Geo frame latitude must be between -90 and 90 degrees.");
    if (lng < -180 || lng > 180) throw new RangeError("Geo frame longitude must be between -180 and 180 degrees.");
    return { lat, lng, height };
}

export function createGeoFrame(descriptor = {}) {
    const version = Number(descriptor.version ?? GEO_FRAME_VERSION);
    const projection = String(descriptor.projection ?? GEO_FRAME_PROJECTION);
    const axes = String(descriptor.axes ?? GEO_FRAME_AXES);
    if (version !== GEO_FRAME_VERSION) throw new TypeError(`Unsupported geo frame version ${String(version)}.`);
    if (projection !== GEO_FRAME_PROJECTION) throw new TypeError(`Unsupported geo frame projection "${projection}".`);
    if (axes !== GEO_FRAME_AXES) throw new TypeError(`Unsupported geo frame axes "${axes}".`);
    return { version, projection, axes, origin: validateOrigin(descriptor.origin) };
}

function basis(frame) {
    const { lat, lng, height } = createGeoFrame(frame).origin;
    const phi = lat * Math.PI / 180;
    const lambda = lng * Math.PI / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    return {
        origin: wgs84ToEcef(lat, lng, height),
        east: { x: -sinLambda, y: cosLambda, z: 0 },
        up: { x: cosPhi * cosLambda, y: cosPhi * sinLambda, z: sinPhi },
        south: { x: sinPhi * cosLambda, y: sinPhi * sinLambda, z: -cosPhi },
    };
}

function dot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function geodeticToLocal(point = {}, frame) {
    const lat = finite(point.lat, "Point latitude");
    const lng = finite(point.lng, "Point longitude");
    const height = finite(point.height ?? point.alt ?? 0, "Point height");
    const b = basis(frame);
    const ecef = wgs84ToEcef(lat, lng, height);
    const delta = {
        x: ecef.x - b.origin.x,
        y: ecef.y - b.origin.y,
        z: ecef.z - b.origin.z,
    };
    return { x: dot(delta, b.east), y: dot(delta, b.up), z: dot(delta, b.south) };
}

export function localToGeodetic(point = {}, frame) {
    const x = finite(point.x, "Local X");
    const y = finite(point.y ?? 0, "Local Y");
    const z = finite(point.z, "Local Z");
    const b = basis(frame);
    const result = ecefToWgs84({
        x: b.origin.x + b.east.x * x + b.up.x * y + b.south.x * z,
        y: b.origin.y + b.east.y * x + b.up.y * y + b.south.y * z,
        z: b.origin.z + b.east.z * x + b.up.z * y + b.south.z * z,
    });
    return { lat: result.lat, lng: result.lng, height: result.alt };
}

export function localToEcefMatrix(frame) {
    const b = basis(frame);
    return [
        b.east.x, b.east.y, b.east.z, 0,
        b.up.x, b.up.y, b.up.z, 0,
        b.south.x, b.south.y, b.south.z, 0,
        b.origin.x, b.origin.y, b.origin.z, 1,
    ];
}

export function ecefToLocalMatrix(frame) {
    const b = basis(frame);
    return [
        b.east.x, b.up.x, b.south.x, 0,
        b.east.y, b.up.y, b.south.y, 0,
        b.east.z, b.up.z, b.south.z, 0,
        -dot(b.origin, b.east), -dot(b.origin, b.up), -dot(b.origin, b.south), 1,
    ];
}
