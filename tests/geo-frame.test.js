import assert from "node:assert/strict";
import test from "node:test";

import {
    createGeoFrame,
    ecefToLocalMatrix,
    geodeticToLocal,
    localToEcefMatrix,
    localToGeodetic,
} from "../app/3d/earth/GeoFrame.js";

function multiply(a, b) {
    const result = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
        for (let k = 0; k < 4; k += 1) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
    return result;
}

function determinant3(matrix) {
    const [a, d, g, , b, e, h, , c, f, i] = matrix;
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

test("ED-08 GeoFrame uses east-up-south signs and a right-handed basis", () => {
    const frame = createGeoFrame({ origin: { lat: 42.443, lng: -76.502, height: 100 } });
    const east = geodeticToLocal({ lat: 42.443, lng: -76.5019, height: 100 }, frame);
    const north = geodeticToLocal({ lat: 42.4431, lng: -76.502, height: 100 }, frame);
    const up = geodeticToLocal({ lat: 42.443, lng: -76.502, height: 101 }, frame);
    assert.ok(east.x > 8 && Math.abs(east.z) < 0.001);
    assert.ok(north.z < -11 && Math.abs(north.x) < 0.001);
    assert.ok(up.y > 0.999 && up.y < 1.001);
    assert.ok(determinant3(localToEcefMatrix(frame)) > 0.999999);
});

test("ED-08 GeoFrame point and matrix transforms are inverses", () => {
    const frame = createGeoFrame({ origin: { lat: -33.86, lng: 151.2, height: 14 } });
    const point = { lat: -33.8591, lng: 151.2012, height: 37 };
    const roundTrip = localToGeodetic(geodeticToLocal(point, frame), frame);
    assert.ok(Math.abs(roundTrip.lat - point.lat) < 1e-10);
    assert.ok(Math.abs(roundTrip.lng - point.lng) < 1e-10);
    assert.ok(Math.abs(roundTrip.height - point.height) < 1e-6);
    const identity = multiply(ecefToLocalMatrix(frame), localToEcefMatrix(frame));
    identity.forEach((value, index) => assert.ok(Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-7, `matrix entry ${index}`));
});

test("ED-08 GeoFrame rejects unsupported descriptors", () => {
    assert.throws(() => createGeoFrame({ version: 2, origin: { lat: 0, lng: 0 } }), /Unsupported geo frame version/);
    assert.throws(() => createGeoFrame({ origin: { lat: 91, lng: 0 } }), /latitude/);
    assert.throws(() => createGeoFrame({ projection: "mercator", origin: { lat: 0, lng: 0 } }), /projection/);
});
