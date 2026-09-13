import {
    getRoadAuthoringHandleStemsGroup,
    getRoadAuthoringHandlesGroup,
} from "./editor/projection/roadRuntimeEntities.js";

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

export function setRoadAuthoringHandlesVisible(data, visible) {
    const environment = data?.environment?.();
    if (environment) environment.authoringHelpersVisible = Boolean(visible);
    const scene = data?.three?.()?.scene ?? environment?.scene ?? null;
    const shown = Boolean(visible);
    const group = getRoadAuthoringHandlesGroup(scene);
    if (group) group.visible = shown;
    const stems = getRoadAuthoringHandleStemsGroup(scene);
    if (stems) stems.visible = shown;
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

