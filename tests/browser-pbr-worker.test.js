import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
    BrowserPbrWorkerRuntime,
    serializePbrActors,
} from "../app/3d/perception/BrowserPbrWorkerRuntime.js";
import { ManifestCamera } from "../app/3d/devices/ManifestCamera.js";
import { resolvedPbrRun } from "./helpers/pbrResolved.js";

function fakeWorker({ failMethod = null } = {}) {
    const listeners = new Map();
    const calls = [];
    let terminated = false;
    const emit = (type, event) => {
        for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const worker = {
        calls,
        get terminated() { return terminated; },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        postMessage(message) {
            calls.push(message);
            queueMicrotask(() => {
                if (message.method === failMethod) {
                    emit("message", { data: {
                        id: message.id,
                        ok: false,
                        error: { message: `${failMethod} failed`, code: "TEST_FAILURE" },
                    } });
                    return;
                }
                const result = {
                    probe: { webgl2: true },
                    prepare: {
                        status: { state: "ready", residency: null },
                        renderPolicy: { exposure: 1 },
                        appearance: { role: "measured-appearance", generation: 2, descriptionHash: "appearance" },
                        analytic: { role: "analytic-truth", generation: 2, descriptionHash: "analytic" },
                    },
                    prepareCapture: { status: { state: "streaming", residency: null } },
                    capture: {
                        aligned: true,
                        rgb: Uint8Array.from([1, 2, 3, 4]),
                        depth: Float32Array.from([5]),
                        semantic: Uint16Array.from([6]),
                        instance: Uint32Array.from([7]),
                        status: { state: "streaming", residency: null },
                    },
                    reset: { reset: true },
                    dispose: { disposed: true },
                }[message.method];
                emit("message", { data: { id: message.id, ok: true, result } });
            });
        },
        terminate() { terminated = true; },
    };
    return worker;
}

test("browser PBR worker runtime owns products and transfers aligned captures", async () => {
    const worker = fakeWorker();
    const vehicle = {
        telemetryId: "ego",
        position: new THREE.Vector3(1, 2, 3),
        rotation: new THREE.Euler(0, 0.5, 0),
    };
    const runtime = new BrowserPbrWorkerRuntime({
        workerFactory: () => worker,
        vehicles: () => [vehicle],
    });
    await runtime.prepare(resolvedPbrRun(), { vehicles: [vehicle], sensorRig: { sensors: [] } });

    const options = runtime.cameraOptions();
    assert.equal(options.runtimeOwnsProducts, true);
    assert.equal(options.captureSceneHandle.role, "measured-appearance");
    assert.equal(runtime.presentationBlocked, false);

    await runtime.prepareCapture({
        devices: [{ renderRuntime: runtime, getPosition: () => ({ x: 4, y: 5, z: 6 }) }],
        vehicles: [vehicle],
    });
    const captured = await runtime.captureCamera({
        cameraId: "front-camera",
        captureInput: { captureTimeNs: 1 },
        enabled: { rgb: true, depth: true, semantic: true, instance: true },
    });
    assert.deepEqual([...captured.rgb], [1, 2, 3, 4]);
    assert.deepEqual([...captured.depth], [5]);
    assert.deepEqual([...captured.semantic], [6]);
    assert.deepEqual([...captured.instance], [7]);
    assert.equal(worker.calls.find((entry) => entry.method === "prepareCapture").payload.vehicles[0].matrixWorld.length, 16);
    assert.equal(worker.calls.find((entry) => entry.method === "capture").payload.request.id, "front-camera");

    runtime.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.terminated, true);
});

test("browser PBR worker failures remain infrastructure failures and never switch runtime", async () => {
    const worker = fakeWorker({ failMethod: "capture" });
    const runtime = new BrowserPbrWorkerRuntime({ workerFactory: () => worker });
    await runtime.prepare(resolvedPbrRun(), { vehicles: [], sensorRig: { sensors: [] } });
    await assert.rejects(
        runtime.captureCamera({ cameraId: "camera", captureInput: {}, enabled: { rgb: true } }),
        (error) => error.infrastructureFailure === true && error.code === "TEST_FAILURE",
    );
    assert.equal(runtime.status.state, "error");
    runtime.dispose({ immediate: true });
});

test("serialized actor matrices preserve exact scene transforms", () => {
    const object = new THREE.Object3D();
    object.position.set(3, 4, 5);
    object.rotation.set(0.1, 0.2, 0.3);
    object.updateMatrixWorld(true);
    const [serialized] = serializePbrActors([{ telemetryId: "ego", sceneObject: object }]);
    assert.equal(serialized.telemetryId, "ego");
    assert.deepEqual(serialized.matrixWorld, object.matrixWorld.toArray());
});

test("manifest cameras do not allocate main-thread products for worker-owned capture", () => {
    const camera = new ManifestCamera({
        id: "front-camera",
        type: "camera",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        noise: {},
        outputs: { imageTopicId: "image" },
        calibration: {
            width: 4,
            height: 3,
            verticalFovDeg: 60,
            near: 0.1,
            far: 50,
            intrinsics: { fx: 3, fy: 3, cx: 1.5, cy: 1 },
            distortionModel: "none",
            distortion: [],
            products: { rgb: true },
        },
        latency: {},
        health: {},
    }, {
        captureMode: "calibrated-projection@1",
        captureSceneHandle: { role: "measured-appearance", scene: new THREE.Scene(), generation: 1, descriptionHash: "a" },
        analyticSceneHandle: { role: "analytic-truth", scene: new THREE.Scene(), generation: 1, descriptionHash: "b" },
        renderRuntime: {},
        runtimeOwnsProducts: true,
    });
    camera.setup(new THREE.Scene());
    assert.ok(camera.sensorCamera);
    assert.equal(camera.renderProducts, null);
    camera.dispose();
});
