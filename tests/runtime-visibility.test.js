import assert from "node:assert/strict";
import test from "node:test";

import {
    applyOriginMarkersVisible,
    applySensorMarkersVisible,
    clearLaneHighlights,
    originMarkerShown,
    sensorMarkerShown,
    setDeviceVisualsVisible,
    setRoadAuthoringHandlesVisible,
    setVehiclesVisible,
} from "../app/3d/runtimeVisibility.js";
import { ROAD_AUTHORING_HANDLE_STEMS_NAME, ROAD_AUTHORING_HANDLES_NAME } from "../app/3d/editor/projection/roadRuntimeEntities.js";
import { PhysicsEngine } from "../app/physics/PhysicsEngine.js";
import { Settings } from "../app/3d/data/Settings.js";

test("camera control locks release only their matching stable id", () => {
    const settings = new Settings();
    settings.disableControls("hierarchy");
    settings.disableControls("device-panel");
    assert.equal(settings.cameraControlsEnabled, false);

    settings.enableControls("hierarchy");
    assert.equal(settings.cameraControlsEnabled, false);
    settings.enableControls("device-panel");
    assert.equal(settings.cameraControlsEnabled, true);
});

test("camera controls recover when UI event callbacks are passed directly", () => {
    const settings = new Settings();

    settings.disableControls({ type: "pointerdown" });
    assert.equal(settings.cameraControlsEnabled, false);

    settings.enableControls({ type: "pointerup" });
    assert.equal(settings.cameraControlsEnabled, true);
});

test("physics startup waits for Rapier initialization instead of timing out", async () => {
    let resolvePhysics;
    const loadPhysics = () => new Promise((resolve) => {
        resolvePhysics = resolve;
    });
    const physics = new PhysicsEngine({}, { loadPhysics });
    const start = physics.start();
    class World {
        constructor(gravity) {
            this.gravity = gravity;
        }
    }

    resolvePhysics({ World });
    await start;

    assert.ok(physics.world);
});

test("editor mode visibility hides vehicle and detached device visuals", () => {
    const vehicleRoot = { visible: true };
    const deviceRoots = [
        { visible: true },
        { visible: true },
        { visible: true },
        { visible: true },
    ];
    const laneMeshes = [{ visible: true }, { visible: true }];
    const data = {
        vehicles: () => ({ vehicles: [{ sceneObject: vehicleRoot }] }),
        devices: () => ({
            devices: [{
                _mesh: deviceRoots[0],
                pointsGroup: deviceRoots[1],
                lines: deviceRoots[2],
                sensorCamera: deviceRoots[3],
            }],
        }),
        city: () => ({
            roads: [{ laneMeshes: [laneMeshes[0]] }],
            intersections: [{ laneMeshes: [laneMeshes[1]] }],
        }),
    };

    setVehiclesVisible(data, false);
    setDeviceVisualsVisible(data, false);
    clearLaneHighlights(data);

    assert.equal(vehicleRoot.visible, false);
    assert.deepEqual(deviceRoots.map((root) => root.visible), [false, false, false, false]);
    assert.deepEqual(laneMeshes.map((mesh) => mesh.visible), [false, false]);
});

test("sensor marker switch hides lidar meshes and leaves the capture camera", () => {
    const pointsGroup = { visible: true };
    const lines = { visible: true };
    const mesh = { visible: true };
    const sensorCamera = { visible: true };
    const disabledPoints = { visible: true };
    const data = {
        devices: () => ({
            devices: [
                { enabled: true, pointsGroup, lines, _mesh: mesh, sensorCamera },
                { enabled: false, pointsGroup: disabledPoints },
            ],
        }),
    };

    applySensorMarkersVisible(data, false);
    assert.equal(pointsGroup.visible, false);
    assert.equal(lines.visible, false);
    assert.equal(mesh.visible, false);
    assert.equal(sensorCamera.visible, true);
    assert.equal(disabledPoints.visible, false);

    applySensorMarkersVisible(data, true);
    assert.equal(pointsGroup.visible, true);
    assert.equal(disabledPoints.visible, false);
});

test("origin marker switch toggles only the debug plate", () => {
    const marker = { visible: true };
    const data = {
        vehicles: () => ({
            vehicles: [
                { sceneObject: { getObjectByName: (name) => (name === "vehicle-origin-debug" ? marker : null) } },
                { sceneObject: null },
            ],
        }),
    };

    applyOriginMarkersVisible(data, false);
    assert.equal(marker.visible, false);
    applyOriginMarkersVisible(data, true);
    assert.equal(marker.visible, true);
});

test("marker helpers stay shown when the simulation has no preference", () => {
    assert.equal(sensorMarkerShown(null, { enabled: true }), true);
    assert.equal(sensorMarkerShown({ simulation: () => ({}) }, { enabled: false }), false);
    assert.equal(originMarkerShown(null), true);
    assert.equal(originMarkerShown({ simulation: () => ({ debugVisuals: { originMarker: false } }) }), false);
});

test("simulation mode hides the road authoring handle group", () => {
    const group = { name: ROAD_AUTHORING_HANDLES_NAME, visible: true };
    const stems = { name: ROAD_AUTHORING_HANDLE_STEMS_NAME, visible: true };
    const scene = {
        getObjectByName(name) {
            if (name === ROAD_AUTHORING_HANDLES_NAME) return group;
            if (name === ROAD_AUTHORING_HANDLE_STEMS_NAME) return stems;
            return null;
        },
    };
    const environment = { authoringHelpersVisible: undefined, scene };
    const data = {
        environment: () => environment,
        three: () => ({ scene }),
    };

    setRoadAuthoringHandlesVisible(data, false);
    assert.equal(environment.authoringHelpersVisible, false);
    assert.equal(group.visible, false);
    assert.equal(stems.visible, false);

    setRoadAuthoringHandlesVisible(data, true);
    assert.equal(environment.authoringHelpersVisible, true);
    assert.equal(group.visible, true);
    assert.equal(stems.visible, true);
});
