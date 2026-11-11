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

export function sensorMarkerShown(data, device) {
    return device?.enabled !== false && data?.simulation?.()?.debugVisuals?.sensorMarkers !== false;
}

export function originMarkerShown(data) {
    return data?.simulation?.()?.debugVisuals?.originMarker !== false;
}

export function applySensorMarkersVisible(data, visible) {
    const shown = visible !== false;
    for (const device of data.devices()?.devices ?? []) {
        const show = shown && device.enabled !== false;
        for (const root of [device._mesh, device.pointsGroup, device.lines]) {
            if (root) root.visible = show;
        }
    }
}

export function applyOriginMarkersVisible(data, visible) {
    const shown = visible !== false;
    for (const vehicle of data.vehicles()?.vehicles ?? []) {
        const marker = vehicle.sceneObject?.getObjectByName?.("vehicle-origin-debug");
        if (marker) marker.visible = shown;
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

