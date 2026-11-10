import assert from "node:assert/strict";
import test from "node:test";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";

import {
    ORTHOGONAL_FAR,
    ORTHOGONAL_NEAR,
    orthographicFrustum,
    orthogonalZoomLimits,
    perspectiveDistanceForZoom,
} from "../app/vehicles/editor/orthogonalView.js";

const FOV = 50;
const MIN_DISTANCE = 0.5;
const MAX_DISTANCE = 60;

function close(actual, expected, epsilon = 1e-6) {
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should be near ${expected}`);
}

test("the orthographic frustum matches a 50 degree perspective view at the same distance", () => {
    const distance = 8;
    const aspect = 4 / 3;
    const frustum = orthographicFrustum({ distance, fovDegrees: FOV, aspect });
    const halfHeight = distance * Math.tan((FOV * Math.PI) / 360);
    close(frustum.top, halfHeight);
    close(frustum.bottom, -halfHeight);
    close(frustum.right, halfHeight * aspect);
    close(frustum.left, -halfHeight * aspect);
    assert.equal(frustum.near, ORTHOGONAL_NEAR);
    assert.equal(frustum.far, ORTHOGONAL_FAR);
    assert.equal(frustum.zoom, 1);

    const perspective = new PerspectiveCamera(FOV, aspect, ORTHOGONAL_NEAR, ORTHOGONAL_FAR);
    perspective.position.set(0, 0, distance);
    perspective.lookAt(0, 0, 0);
    perspective.updateProjectionMatrix();
    perspective.updateMatrixWorld();

    const ortho = new OrthographicCamera(frustum.left, frustum.right, frustum.top, frustum.bottom, frustum.near, frustum.far);
    ortho.zoom = frustum.zoom;
    ortho.position.copy(perspective.position);
    ortho.up.copy(perspective.up);
    ortho.lookAt(0, 0, 0);
    ortho.updateProjectionMatrix();
    ortho.updateMatrixWorld();

    const top = new Vector3(0, halfHeight, 0);
    const side = new Vector3(halfHeight * aspect, 0, 0);
    const projectedTop = top.clone().project(perspective);
    const orthoTop = top.clone().project(ortho);
    const projectedSide = side.clone().project(perspective);
    const orthoSide = side.clone().project(ortho);
    close(projectedTop.y, 1, 1e-5);
    close(orthoTop.y, 1, 1e-5);
    close(projectedTop.y, orthoTop.y, 1e-5);
    close(projectedSide.x, 1, 1e-5);
    close(orthoSide.x, projectedSide.x, 1e-5);
});

test("zoom limits recover the 0.5 m to 60 m orbit range", () => {
    const distance = 6;
    const limits = orthogonalZoomLimits({ distance, minDistance: MIN_DISTANCE, maxDistance: MAX_DISTANCE });
    assert.equal(limits.minZoom, distance / MAX_DISTANCE);
    assert.equal(limits.maxZoom, distance / MIN_DISTANCE);
    close(perspectiveDistanceForZoom({ distance, zoom: 2, minDistance: MIN_DISTANCE, maxDistance: MAX_DISTANCE }), 3);
    close(perspectiveDistanceForZoom({
        distance,
        zoom: limits.minZoom,
        minDistance: MIN_DISTANCE,
        maxDistance: MAX_DISTANCE,
    }), MAX_DISTANCE);
    close(perspectiveDistanceForZoom({
        distance,
        zoom: limits.maxZoom,
        minDistance: MIN_DISTANCE,
        maxDistance: MAX_DISTANCE,
    }), MIN_DISTANCE);
    close(perspectiveDistanceForZoom({
        distance,
        zoom: limits.maxZoom * 4,
        minDistance: MIN_DISTANCE,
        maxDistance: MAX_DISTANCE,
    }), MIN_DISTANCE);
    close(perspectiveDistanceForZoom({
        distance,
        zoom: limits.minZoom / 4,
        minDistance: MIN_DISTANCE,
        maxDistance: MAX_DISTANCE,
    }), MAX_DISTANCE);
});

test("an orthographic zoom frames the same height as the restored perspective distance", () => {
    const distance = 10;
    const aspect = 1.5;
    const zoom = 2;
    const frustum = orthographicFrustum({ distance, fovDegrees: FOV, aspect });
    const restored = perspectiveDistanceForZoom({
        distance,
        zoom,
        minDistance: MIN_DISTANCE,
        maxDistance: MAX_DISTANCE,
    });
    assert.equal(restored, 5);
    const halfHeight = frustum.top / zoom;

    const perspective = new PerspectiveCamera(FOV, aspect, ORTHOGONAL_NEAR, ORTHOGONAL_FAR);
    perspective.position.set(0, 0, restored);
    perspective.lookAt(0, 0, 0);
    perspective.updateProjectionMatrix();
    perspective.updateMatrixWorld();

    const ortho = new OrthographicCamera(frustum.left, frustum.right, frustum.top, frustum.bottom, frustum.near, frustum.far);
    ortho.zoom = zoom;
    ortho.position.set(0, 0, distance);
    ortho.lookAt(0, 0, 0);
    ortho.updateProjectionMatrix();
    ortho.updateMatrixWorld();

    const point = new Vector3(0, halfHeight, 0);
    const projected = point.clone().project(perspective);
    const orthoProjected = point.clone().project(ortho);
    close(projected.y, 1, 1e-5);
    close(orthoProjected.y, projected.y, 1e-5);
});
