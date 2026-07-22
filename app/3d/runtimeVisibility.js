export function setVehiclesVisible(data, visible) {
    for (const vehicle of data.vehicles()?.vehicles ?? []) {
        if (vehicle.sceneObject) vehicle.sceneObject.visible = visible;
    }
}

export function setDeviceVisualsVisible(data, visible) {
    for (const device of data.devices()?.devices ?? []) {
        const roots = [
            device._mesh,
            device.pointsGroup,
            device.lines,
            device.sensorCamera,
        ];
        for (const root of roots) {
            if (root) root.visible = visible;
        }
    }
}

export function clearLaneHighlights(data) {
    const city = data.city?.();
    const laneOwners = [
        ...(city?.roads ?? []),
        ...(city?.intersections ?? []),
    ];
    for (const owner of laneOwners) {
        for (const laneMesh of owner?.laneMeshes ?? []) {
            if (laneMesh) laneMesh.visible = false;
        }
    }
}

