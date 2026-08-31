const WGS84_A = 6378137;
const WGS84_E2 = 0.00669437999014;

function radians(value) {
    return Number(value) * Math.PI / 180;
}

function degrees(value) {
    return Number(value) * 180 / Math.PI;
}

export function wgs84ToEcef(latitudeDeg, longitudeDeg, altitudeMeters = 0) {
    const latitude = radians(latitudeDeg);
    const longitude = radians(longitudeDeg);
    const sinLatitude = Math.sin(latitude);
    const cosLatitude = Math.cos(latitude);
    const sinLongitude = Math.sin(longitude);
    const cosLongitude = Math.cos(longitude);
    const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
    const altitude = Number(altitudeMeters) || 0;
    return {
        x: (radius + altitude) * cosLatitude * cosLongitude,
        y: (radius + altitude) * cosLatitude * sinLongitude,
        z: (radius * (1 - WGS84_E2) + altitude) * sinLatitude,
    };
}

export function ecefToWgs84(ecef = {}) {
    const x = Number(ecef.x) || 0;
    const y = Number(ecef.y) || 0;
    const z = Number(ecef.z) || 0;
    const semiMinor = WGS84_A * Math.sqrt(1 - WGS84_E2);
    const secondEccentricity = Math.sqrt(
        (WGS84_A * WGS84_A - semiMinor * semiMinor) / (semiMinor * semiMinor),
    );
    const planar = Math.hypot(x, y);
    const theta = Math.atan2(WGS84_A * z, semiMinor * planar);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const latitude = Math.atan2(
        z + secondEccentricity * secondEccentricity * semiMinor * sinTheta ** 3,
        planar - WGS84_E2 * WGS84_A * cosTheta ** 3,
    );
    const longitude = Math.atan2(y, x);
    const sinLatitude = Math.sin(latitude);
    const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
    const altitude = planar / Math.cos(latitude) - radius;
    return {
        lat: degrees(latitude),
        lng: degrees(longitude),
        alt: altitude,
    };
}

/**
 * Convert an REP-103 ENU offset from a WGS84 datum to geodetic coordinates.
 * This implementation is deliberately allocation-light and graphics-free so
 * localization sensor models can run in Node without importing Three.js.
 */
export function enuOffsetToWgs84(east, north, up, datum = {}) {
    const latitude = radians(datum.lat ?? datum.latitude ?? 0);
    const longitude = radians(datum.lng ?? datum.longitude ?? 0);
    const origin = wgs84ToEcef(
        datum.lat ?? datum.latitude ?? 0,
        datum.lng ?? datum.longitude ?? 0,
        datum.altitude ?? datum.alt ?? 0,
    );
    const sinLatitude = Math.sin(latitude);
    const cosLatitude = Math.cos(latitude);
    const sinLongitude = Math.sin(longitude);
    const cosLongitude = Math.cos(longitude);
    const eastMeters = Number(east) || 0;
    const northMeters = Number(north) || 0;
    const upMeters = Number(up) || 0;

    return ecefToWgs84({
        x: origin.x
            - sinLongitude * eastMeters
            - sinLatitude * cosLongitude * northMeters
            + cosLatitude * cosLongitude * upMeters,
        y: origin.y
            + cosLongitude * eastMeters
            - sinLatitude * sinLongitude * northMeters
            + cosLatitude * sinLongitude * upMeters,
        z: origin.z + cosLatitude * northMeters + sinLatitude * upMeters,
    });
}

export { WGS84_A, WGS84_E2 };
