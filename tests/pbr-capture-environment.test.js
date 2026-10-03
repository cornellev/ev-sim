import assert from "node:assert/strict";
import test from "node:test";

import { PbrCaptureEnvironment } from "../app/3d/perception/PbrCaptureEnvironment.js";
import { readRenderTargetPixelsWithFence } from "../app/3d/util/glReadback.js";

function calibration(fx = 3) {
    return {
        kind: "test-calibration",
        image: { width: 4, height: 3 },
        intrinsics: { fx, fy: 3, cx: 1.5, cy: 1 },
        distortion: { model: "none", coefficients: [] },
    };
}

function environmentWithRecorder() {
    const seen = [];
    const runtime = {
        cameraOptions: () => ({
            captureSceneHandle: { role: "measured-appearance", generation: 1, descriptionHash: "a" },
        }),
        captureCamera: async ({ captureInput }) => {
            seen.push(captureInput.calibration);
            return {};
        },
        dispose() {},
    };
    const environment = new PbrCaptureEnvironment({ environmentKey: "test", renderer: {}, runtime });
    environment.cameras.set("front", { camera: {}, products: {} });
    const request = (value) => ({
        id: "front",
        captureInput: { captureTimeNs: 1, calibration: value },
        products: { rgb: true },
    });
    const capture = (value) => environment.capture([request(value)], { prepare: false });
    return { environment, seen, capture };
}

test("structurally equal calibration clones reuse one object so identity caches hit", async () => {
    const { seen, capture } = environmentWithRecorder();
    const first = calibration();
    await capture(first);
    await capture(structuredClone(first));
    await capture(structuredClone(first));
    assert.equal(seen.length, 3);
    assert.equal(seen[0], first);
    assert.equal(seen[1], first);
    assert.equal(seen[2], first);
});

test("a changed calibration replaces the canonical object", async () => {
    const { seen, capture } = environmentWithRecorder();
    const first = calibration(3);
    const changed = calibration(4);
    await capture(first);
    await capture(changed);
    await capture(structuredClone(changed));
    assert.equal(seen[0], first);
    assert.equal(seen[1], changed);
    assert.equal(seen[2], changed);
});

test("capture environments default to fenced readback and accept the pipelined path", () => {
    const runtime = { dispose() {} };
    const hosted = new PbrCaptureEnvironment({ environmentKey: "hosted", renderer: {}, runtime });
    const worker = new PbrCaptureEnvironment({
        environmentKey: "worker",
        renderer: {},
        runtime,
        alignedReadback: null,
    });
    assert.equal(hosted.alignedReadback, readRenderTargetPixelsWithFence);
    assert.equal(worker.alignedReadback, null);
});
