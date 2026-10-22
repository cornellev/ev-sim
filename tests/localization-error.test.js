import assert from "node:assert/strict";
import test from "node:test";

import { eulerToQuaternion } from "../app/autonomy/CoordinateFrames.js";
import {
    formatHeadingError,
    formatPositionError,
    localizationError,
} from "../app/autonomy/AutonomyVisualizationModel.js";

function pose(position, yaw = 0, pitch = 0) {
    return {
        position,
        orientation: eulerToQuaternion({ x: 0, y: pitch, z: yaw }),
        captureTimeNs: 10,
    };
}

test("heading error is the wrapped REP-103 yaw difference", () => {
    const flat = localizationError(
        pose({ x: 1, y: 0, z: 0 }, 0.4),
        pose({ x: 0, y: 0, z: 0 }, 0),
    );
    assert.ok(Math.abs(flat.headingRad - 0.4) < 1e-9);
    assert.equal(flat.positionM, 1);

    const pitched = localizationError(
        pose({ x: 0, y: 0, z: 0 }, 0.2, 0.3),
        pose({ x: 0, y: 0, z: 0 }, 0.2, 0.3),
    );
    assert.equal(pitched.headingRad, 0);
    assert.equal(pitched.positionM, 0);

    const vertical = localizationError(
        pose({ x: 4, y: -2, z: 3 }, 0.1),
        pose({ x: 4, y: -2, z: 1 }, 0.1),
    );
    assert.equal(vertical.horizontalM, 0);
    assert.equal(vertical.positionM, 2);
    assert.ok(Math.abs(vertical.headingRad) < 1e-9);

    const wrapped = localizationError(
        pose({ x: 0, y: 0, z: 0 }, -3),
        pose({ x: 0, y: 0, z: 0 }, 3),
    );
    assert.ok(Math.abs(wrapped.headingRad - ((-6 + Math.PI * 2))) < 1e-9);
    assert.equal(formatPositionError(vertical), "2.000 m");
    assert.equal(formatHeadingError(flat), "22.9°");
    assert.equal(formatPositionError(null), "—");
    assert.equal(formatHeadingError(null), "—");
});
