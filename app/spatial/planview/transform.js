/** Vehicle-local XZ (+X forward, +Z left) into world XZ. Matches `vehicleGroundFootprint`. */
export function localToWorld(origin, yaw, local) {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const lx = Number(local?.x) || 0;
    const lz = Number(local?.z) || 0;
    return {
        x: (Number(origin?.x) || 0) + lx * cos + lz * sin,
        z: (Number(origin?.z) || 0) - lx * sin + lz * cos,
    };
}

/** Sector polygon. `startDeg`/`endDeg` are device-local, 0 along +X, matching LiDAR theta. */
export function sectorPoints(origin, yaw, range, startDeg, endDeg, steps = 18) {
    const radius = Math.max(0, Number(range) || 0);
    const start = (Number(startDeg) || 0) * Math.PI / 180;
    const end = (Number(endDeg) || 0) * Math.PI / 180;
    const count = Math.max(2, Math.floor(steps));
    const points = [{ x: Number(origin?.x) || 0, z: Number(origin?.z) || 0 }];
    for (let index = 0; index <= count; index += 1) {
        const angle = start + ((end - start) * index) / count;
        points.push(localToWorld(origin, yaw, {
            x: radius * Math.cos(angle),
            z: radius * Math.sin(angle),
        }));
    }
    return points;
}
