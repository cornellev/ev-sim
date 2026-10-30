/** Actor footprints shared by headless observations and the browser demo export. */
export function liveOccupancyActors(resolvedRun, vehicles, egoId) {
    const actors = [];
    for (const vehicle of vehicles) {
        const id = vehicle.telemetryId || vehicle.id;
        if (!id || id === egoId) continue;
        const entry = (resolvedRun?.vehicles || []).find((candidate) => candidate.actorId === id);
        const box = entry?.manifest?.boundingBox;
        actors.push({
            id,
            x: Number(vehicle.position?.x) || 0,
            z: Number(vehicle.position?.z) || 0,
            yaw: Number(vehicle.rotation?.y) || 0,
            length: Number(box?.size?.x) || 0,
            width: Number(box?.size?.z) || 0,
            centerX: Number(box?.center?.x) || 0,
            centerZ: Number(box?.center?.z) || 0,
        });
    }
    return actors;
}
