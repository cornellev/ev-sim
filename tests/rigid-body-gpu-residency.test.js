import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import test from "node:test";

import { AnalyticGpuScene } from "../app/simulation/sensors/AnalyticGpuScene.js";
import { ChromiumWebGlRendererAdapter, PooledGpuRenderer } from "../server/headless/PooledGpuRenderer.js";
import { createOwnedCaptureScene, createVisualCaptureInput, createVisualCameraCalibration } from "../app/3d/environment/visual/VisualCapturePipeline.js";

function pose(id, x = 0) {
    return { id, position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, spawnPosition: { x: 0, y: 0, z: 0 }, spawnRotation: { x: 0, y: 0, z: 0, w: 1 } };
}

function triangle(id, x) {
    return { shape: "triangle", sourceId: id, vertices: [{ x, y: -1, z: -1 }, { x, y: 1, z: -1 }, { x, y: 1, z: 1 }], semanticId: 3, instanceId: 7 };
}

function scene() {
    return { hash: "a".repeat(64), description: { staticPrimitives: [triangle("a", 5), triangle("b", 10)], materials: [{ semanticId: 3, colorRgba: [255, 128, 0, 255] }], actors: [{ actorId: "other", primitives: [triangle("actor", 0)] }], planes: [] } };
}

function job(type = "lidar3d", rigidBodyPoses = [], extra = {}) {
    return {
        id: type, type, width: 2, height: 1, rigidBodyPoses,
        sensor: { parentId: "ego", pose: {}, calibration: { azimuth: { startDeg: 0, endDeg: 2, stepDeg: 1 }, elevation: { startDeg: 0, stepDeg: 1 }, range: 30, verticalFovDeg: 60, near: 0.1, far: 30 } },
        vehicles: [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }],
        products: { rgb: true, depth: true }, ...extra,
    };
}

function liveScene() {
    const resource = scene();
    resource.hash = "d".repeat(64);
    resource.description.objectMotion = "live-rigid-bodies@1";
    resource.description.objectMotionBindings = ["a", "b"].map((id) => ({ id, spawnPosition: { x: 0, y: 0, z: 0 }, spawnRotation: { x: 0, y: 0, z: 0, w: 1 }, appearanceInstanceIds: [] }));
    return resource;
}

function liveJob(resource, poses = []) {
    const handle = createOwnedCaptureScene({ role: "measured-appearance", scene: {}, generation: 1, descriptionHash: resource.hash, objectMotion: "live-rigid-bodies@1", objectMotionBindings: resource.description.objectMotionBindings });
    const captureInput = createVisualCaptureInput({ calibration: createVisualCameraCalibration({ width: 2, height: 1, near: 0.1, far: 30, intrinsics: { fx: 1, fy: 1, cx: 1, cy: 0.5 } }), pose: {}, sceneHandle: handle, captureTimeNs: 0, objectPoses: poses });
    return job("camera", undefined, { captureInput, captureTimeNs: 0, rigidBodyPoses: undefined });
}

/** Runs the actual serialized page callback with no module-scope variables. */
function fakeGl() {
    const calls = [], live = new Set(), bindings = new Map();
    let texture, vao;
    const gl = { calls, live, lost: false, waits: 0, shaders: [],
        isContextLost() { return this.lost; },
        bindTexture(_target, next) { texture = next; },
        bindBuffer(target, next) { bindings.set(target, next); },
        bindVertexArray(next) { vao = next; },
        bufferData(target, value) {
            const buffer = bindings.get(target);
            buffer.data = typeof value === "number" ? new Uint8Array(value) : new Uint8Array(value.buffer.slice(0));
            if (vao && target === this.ARRAY_BUFFER) vao.buffer = buffer;
            calls.push(["bufferData", target, buffer.data.byteLength]);
        },
        bufferSubData(target, offset, value) {
            bindings.get(target).data.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), offset);
            calls.push(["bufferSubData", offset, value.byteLength]);
        },
        texStorage2D(_target, _levels, format, width, height) {
            texture.data = format === this.RGBA32F ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
            texture.width = width;
            calls.push(["texStorage2D", width, height]);
        },
        texSubImage2D(_target, _level, x, y, width, height, _format, _type, value) {
            assert.equal(x, 0);
            assert.equal(width, texture.width);
            texture.data.set(value, y * width * 4);
            calls.push(["texSubImage2D", y, height, value.byteLength]);
        },
        shaderSource(shader, source) { shader.source = source; this.shaders.push(source); },
        getShaderParameter() { return true; }, getProgramParameter() { return true; },
        getUniformLocation(program, name) { calls.push(["uniform", name]); return { program, name }; },
        checkFramebufferStatus() { return this.FRAMEBUFFER_COMPLETE; },
        readPixels() { bindings.get(this.PIXEL_PACK_BUFFER).data.fill(0); },
        clientWaitSync() { if (this.waits-- > 0) return this.TIMEOUT_EXPIRED; return this.CONDITION_SATISFIED; },
        getBufferSubData(target, _offset, output) { new Uint8Array(output.buffer).set(bindings.get(target).data); },
        bytes() { return [...live].reduce((total, object) => total + (object.data?.byteLength || 0), 0); },
    };
    for (const kind of ["Buffer", "Texture", "Framebuffer", "VertexArray", "Program", "Shader", "Sync"]) {
        gl[`create${kind}`] = () => { const value = { kind }; live.add(value); calls.push([`create${kind}`]); return value; };
        gl[`delete${kind}`] = (value) => { if (value) { live.delete(value); calls.push([`delete${kind}`]); } };
    }
    gl.fenceSync = gl.createSync;
    for (const name of ["activeTexture", "texParameteri", "compileShader", "attachShader", "linkProgram", "bindFramebuffer", "framebufferTexture2D", "viewport", "clearColor", "clear", "enableVertexAttribArray", "vertexAttribPointer", "useProgram", "uniform1i", "uniform3fv", "uniform4fv", "uniform3f", "uniform2f", "uniform1f", "uniform4f", "uniformMatrix4fv", "enable", "disable", "depthFunc", "flush", "drawArrays"]) gl[name] = () => {};
    for (const name of ["TEXTURE_2D", "TEXTURE0", "RGBA32F", "RGBA8", "RGBA", "FLOAT", "UNSIGNED_BYTE", "ARRAY_BUFFER", "PIXEL_PACK_BUFFER", "STREAM_DRAW", "STREAM_READ", "FRAMEBUFFER", "FRAMEBUFFER_COMPLETE", "VERTEX_SHADER", "FRAGMENT_SHADER", "COMPILE_STATUS", "LINK_STATUS", "TIMEOUT_EXPIRED", "WAIT_FAILED", "CONDITION_SATISFIED"]) gl[name] = name;
    return gl;
}

function harness(config = {}) {
    const adapters = [];
    const pool = new PooledGpuRenderer({ chromiumExecutable: "/fake", ...config }, { adapterFactory: () => {
        const adapter = new ChromiumWebGlRendererAdapter();
        adapter.start = async (count) => {
            adapter.contexts = Array.from({ length: count }, () => ({ canvas: {}, gl: fakeGl() }));
            const sandbox = vm.createContext({ __cevGpuContexts: adapter.contexts, setTimeout, btoa, Float32Array, Uint8Array });
            adapter.page = { evaluate(fn, arg) { sandbox.arg = structuredClone(arg); return vm.runInContext(`(${fn.toString()})(arg)`, sandbox); } };
            adapter.browser = { close: async () => {} };
            adapter.provenance = { renderer: "hardware-test", floatColorBuffer: true, floatFramebufferComplete: true, readbackCheck: true };
            adapters.push(adapter);
        };
        return adapter;
    } });
    const capture = (environmentKey = "A", requests = [job()], resource = scene(), maxGpuBytes = 1_000_000) => pool.captureGroup({ environmentKey, requests, scene: resource, maxGpuBytes });
    return { pool, capture, adapters, gl: () => adapters.at(-1).contexts[0].gl };
}

function work(gl) {
    return gl.calls.filter(([name]) => (name.startsWith("create") && name !== "createSync") || name === "uniform" || name === "bufferData" || name === "bufferSubData" || name === "texStorage2D" || name === "texSubImage2D");
}

test("GPU residency repeats compile, locate and upload nothing; body deltas preserve legacy cameras", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    const source = scene(), before = structuredClone(source);
    const requests = [job(), job("camera")];
    const first = await h.capture("A", requests, source);
    const gl = h.gl();
    gl.calls.length = 0;
    assert.deepEqual(await h.capture("A", structuredClone(requests), source), first);
    assert.deepEqual(work(gl), []);
    await h.capture("A", [job("lidar3d", [pose("a", 2)]), job("camera", [pose("a", 2)])], source);
    assert.deepEqual(work(gl), [["texSubImage2D", 0, 1, 64]]);
    gl.calls.length = 0;
    const live = liveScene();
    await h.capture("A", [liveJob(live)], live);
    gl.calls.length = 0;
    await h.capture("A", [liveJob(live, [pose("a", 2)])], live);
    assert.deepEqual(work(gl), [["bufferSubData", 0, 84]]);
    gl.calls.length = 0;
    await h.capture("A", [liveJob(live, [pose("a", 2)])], live);
    assert.deepEqual(work(gl), []);
    await h.capture("A", [liveJob(live)], live);
    assert.deepEqual(work(gl), [["bufferSubData", 0, 84]]);
    assert.deepEqual(source, before);
    await h.pool.releaseEnvironment("A");
    assert.equal(h.pool.diagnostics().trackedGpuBytes, 0);
    assert.equal(gl.live.size, 0);
    assert.equal(h.adapters[0].analyticScenes.size, 0);
});

test("GPU authored geometry and actor ranges retain coordinates, normals and ordering", () => {
    const resource = scene(), geometry = new AnalyticGpuScene(resource.description);
    const authored = geometry.prepare(job());
    assert.deepEqual(authored.triangles[0], { vertices: [[5, -1, -1], [5, 1, -1], [5, 1, 1]], normal: [1, 0, 0], semanticId: 3, instanceId: 7 });
    const moved = geometry.prepare(job("lidar3d", [pose("a", 2)]));
    assert.deepEqual(moved.triangleUpdates[0], { start: 0, triangles: [{ ...authored.triangles[0], vertices: [[7, -1, -1], [7, 1, -1], [7, 1, 1]] }] });
    assert.deepEqual(geometry.prepare(job("lidar3d", [pose("a", 2)])).triangleUpdates, []);
    assert.deepEqual(geometry.prepare(job()).triangleUpdates[0].triangles[0].vertices, [[5, -1, -1], [5, 1, -1], [5, 1, 1]]);
    const vehicles = [...job().vehicles, { id: "other", position: { x: 20, y: 0, z: 0 }, rotation: {} }];
    assert.equal(geometry.prepare(job("lidar3d", [], { vehicles })).geometryFull, true);
    vehicles[1].position.x = 21;
    const actor = geometry.prepare(job("lidar3d", [], { vehicles }));
    assert.equal(actor.geometryFull, false);
    assert.deepEqual(actor.triangleUpdates.map((update) => update.start), [2]);
    assert.deepEqual(actor.triangles[2].vertices, [[21, -1, -1], [21, 1, -1], [21, 1, 1]]);
    const rotated = pose("a"); rotated.rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const normal = geometry.prepare(job("lidar3d", [rotated])).triangles[0].normal;
    assert.ok(Math.abs(normal[0]) < 1e-14 && Math.abs(normal[2] + 1) < 1e-14);
    assert.equal(geometry.prepare(job()).triangleCount, 2);
    geometry.dispose(); assert.equal(geometry.frames.size, 0);
});

test("GPU live camera admission validates policy, object IDs, time, and the immutable capture snapshot", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    const source = liveScene();
    await assert.rejects(h.capture("A", [job("camera", [], { cameraObjectMotion: "live-rigid-bodies@1" })], scene()), /policy-bound/);
    await assert.rejects(h.capture("A", [job("camera")], source), /input v2/);
    const unknown = structuredClone(liveJob(source, [pose("a", 2)]));
    unknown.captureInput.objectPoses[0].id = "invented";
    await assert.rejects(h.capture("A", [unknown], source), /Unknown/);
    const stale = liveJob(source);
    stale.captureTimeNs = 1;
    await assert.rejects(h.capture("A", [stale], source), /time/);
    assert.equal(h.pool.diagnostics().trackedGpuBytes, 0);
    const request = liveJob(source, [pose("a", 2)]);
    request.rigidBodyPoses = [pose("a", 100)];
    await h.capture("A", [request], source);
    const cached = h.adapters[0].contexts[0].analyticCache.environments.get("A").resources.get(JSON.stringify([source.hash, "camera", "camera"]));
    assert.equal(new Float32Array(cached.buffer.data.buffer)[0], 7);
    assert.equal(request.rigidBodyPoses[0].position.x, 100);
});

test("GPU live captureInput v2 uses trusted authored spawn bindings without changing legacy cameras", () => {
    const description = scene().description;
    description.objectMotionBindings = [{ id: "a", spawnPosition: { x: 5, y: 0, z: 0 }, spawnRotation: { x: 0, y: 0, z: 0, w: 1 } }];
    const geometry = new AnalyticGpuScene(description);
    const input = Object.freeze({ version: 2, objectMotion: "live-rigid-bodies@1", objectPoses: Object.freeze([{ id: "a", position: Object.freeze({ x: 8, y: 0, z: 0 }), rotation: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }) }]) });
    const live = geometry.prepare(job("camera", undefined, { rigidBodyPoses: undefined, captureInput: input }));
    assert.deepEqual(live.triangles[0].vertices.map((vertex) => vertex[0]), [8, 8, 8]);
    const legacy = geometry.prepare(job("camera", undefined, { rigidBodyPoses: undefined, captureInput: { ...input, objectMotion: undefined } }));
    assert.deepEqual(legacy.triangles[0].vertices.map((vertex) => vertex[0]), [5, 5, 5]);
    assert.equal(input.objectPoses[0].position.x, 8);
});

test("GPU mixed rigs keep both scene hashes resident in one environment", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    const lidar = scene(), camera = { ...scene(), hash: "c".repeat(64) };
    await h.capture("A", [job()], lidar);
    await h.capture("A", [job("camera")], camera);
    assert.equal(h.pool.analyticEnvironments.get("A").scenes.size, 2);
    assert.equal(h.adapters[0].analyticScenes.size, 2);
    h.gl().calls.length = 0;
    await h.capture("A", [job()], lidar);
    await h.capture("A", [job("camera")], camera);
    assert.deepEqual(work(h.gl()), []);
    await h.pool.releaseEnvironment("A");
    assert.equal(h.gl().bytes(), 0); assert.equal(h.gl().live.size, 0);
});

test("GPU A/B/A resources are isolated with shared shaders; release fences generations", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    const resource = scene();
    await h.capture("A", [job("lidar3d", [pose("a", 1)])], resource);
    const generation = h.pool.analyticEnvironments.get("A").generation;
    await h.capture("B", [job("lidar3d", [pose("a", 4)])], resource);
    const gl = h.gl(), cache = h.adapters[0].contexts[0].analyticCache;
    const texture = (key, hash = resource.hash) => cache.environments.get(key).resources.get(JSON.stringify([hash, "lidar3d", "lidar3d"])).triangleTexture;
    assert.notEqual(texture("A"), texture("B"));
    assert.equal(texture("A").data[0], 6); assert.equal(texture("B").data[0], 9);
    assert.equal(gl.shaders.length, 2);
    gl.calls.length = 0;
    await h.capture("A", [job("lidar3d", [pose("a", 1)])], resource);
    assert.deepEqual(work(gl), []);
    await h.pool.releaseEnvironment("A");
    await h.capture("A", [job()], resource);
    assert.ok(h.pool.analyticEnvironments.get("A").generation > generation);
    assert.equal(texture("A").data[0], 5); assert.equal(texture("B").data[0], 9);
    const next = { ...resource, hash: "b".repeat(64), description: { ...resource.description, staticPrimitives: [triangle("a", 12)] } };
    await h.capture("A", [job()], next);
    assert.equal(texture("A", next.hash).data[0], 12); assert.equal(texture("B").data[0], 9);
    gl.calls.length = 0;
    await h.capture("A", [job()], resource);
    assert.deepEqual(work(gl), []);
});

test("GPU budgets include retained targets, buffers and all environments, with bounded eviction", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    const resource = scene();
    await h.capture("A", [job()], resource);
    const bytes = h.pool.diagnostics().trackedGpuBytes;
    assert.ok(bytes >= h.gl().bytes());
    h.pool.config.globalGpuBytes = bytes + 100;
    await h.capture("B", [job()], resource);
    assert.equal(h.pool.analyticEnvironments.has("A"), false);
    assert.ok(h.pool.diagnostics().trackedGpuBytes <= h.pool.config.globalGpuBytes);
    h.pool.config.globalGpuBytes = 1_000_000;
    const gl = h.gl(); gl.calls.length = 0;
    await assert.rejects(h.capture("C", [job()], resource, 1), /environment limit/);
    assert.deepEqual(work(gl), []);
    await h.capture("B", [job("camera")], resource, bytes + 600);
    assert.equal(h.pool.analyticEnvironments.get("B").resources.size, 1);
    assert.equal(h.adapters[0].analyticScenes.values().next().value.geometry.frames.size, 1);
    await h.pool.close(); assert.equal(gl.bytes(), 0); assert.equal(gl.live.size, 0);
    assert.equal(h.pool.diagnostics().trackedGpuBytes, 0);
});

test("GPU actor uploads affect their ranges only and contexts have separate GL caches", async (t) => {
    const h = harness({ contextPoolSize: 2 }); t.after(() => h.pool.close());
    const resource = scene(), vehicles = [...job().vehicles, { id: "other", position: { x: 20, y: 0, z: 0 }, rotation: {} }];
    await h.capture("A", [job("lidar3d", [], { vehicles }), job("camera", [], { vehicles })], resource);
    await h.capture("B", [job()], resource);
    assert.equal(h.adapters[0].contexts[1].gl.shaders.length, 2);
    h.gl().calls.length = 0;
    vehicles[1].position.x = 22;
    await h.capture("A", [job("lidar3d", [], { vehicles }), job("camera", [], { vehicles })], resource);
    assert.deepEqual(work(h.gl()), [["texSubImage2D", 2, 1, 64], ["bufferSubData", 168, 84]]);
    assert.equal(resource.description.actors[0].primitives[0].vertices[0].x, 0);
});

test("GPU context loss disposes resident resources and restart uses a fresh generation", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    const resource = scene(); await h.capture("A", [job()], resource);
    const gl = h.gl(); gl.lost = true;
    await assert.rejects(h.capture("A", [job()], resource), /context is lost/);
    await h.capture("A", [job()], resource);
    assert.equal(h.adapters.length, 2); assert.equal(gl.live.size, 0); assert.equal(gl.bytes(), 0);
    assert.equal(h.gl().shaders.length, 2);
});

test("GPU release during readback cancels old capture and drains allocations", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    await h.capture(); h.gl().waits = 3;
    const pending = h.capture(); const rejected = assert.rejects(pending, /released environment/);
    while (!h.pool.busyContexts) await new Promise((resolve) => setImmediate(resolve));
    await h.pool.releaseEnvironment("A"); await rejected;
    assert.equal(h.pool.diagnostics().trackedGpuBytes, 0); assert.equal(h.gl().live.size, 0);
    await h.capture(); assert.equal(h.gl().shaders.length, 4);
});

test("GPU GLSL specializations keep canonical precision, depth and strict distance ties", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    await h.capture("A", [job(), job("camera")]);
    const shaders = h.gl().shaders;
    assert.equal(shaders.length, 6);
    assert.match(shaders[1], /uniform highp sampler2D uTriangles/);
    assert.match(shaders[1], /distance<best/);
    assert.match(shaders[1], /for\(int i=0;i<2;i\+\+\)/);
    assert.match(shaders[5], /color=vec4\(-vViewZ,0\.,0\.,1\.\)/);
    // Exact sources, including whitespace, are the pre-residency GLSL specializations.
    assert.equal(createHash("sha256").update(JSON.stringify(shaders)).digest("hex"), "b8622f1f67f6863efe20c7394e849823b3baf0d570293f59ff5d684cbc935a44");
});

test("GPU shader specialization eviction bounds programs per context", async (t) => {
    const h = harness(); t.after(() => h.pool.close());
    for (let index = 0; index < 36; index += 1) {
        const resource = scene();
        resource.hash = String(index).padStart(64, "0");
        resource.description.planes = [{ y: index, semanticId: 0, instanceId: 0 }];
        await h.capture(String(index), [job()], resource);
    }
    assert.equal(h.adapters[0].contexts[0].analyticCache.programs.size, 32);
    assert.equal([...h.gl().live].filter((entry) => entry.kind === "Program").length, 32);
    await h.pool.close(); assert.equal(h.gl().live.size, 0);
});

test("GPU hardware cold/warm products and legacy camera bytes remain canonical", {
    skip: !process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
}, async (t) => {
    const pool = new PooledGpuRenderer({ chromiumExecutable: process.env.CEV_SIM_CHROMIUM_EXECUTABLE, angle: process.env.CEV_SIM_GPU_ANGLE || "" });
    t.after(() => pool.close());
    const resource = scene();
    const camera = job("camera", [], { width: 8, height: 8 });
    const capture = (requests) => pool.captureGroup({ environmentKey: "hardware-residency", scene: resource, requests, maxGpuBytes: 16 * 1024 * 1024 });
    const cold = await capture([job(), camera]);
    assert.ok(Math.abs(cold[0].data[0] - 5) < 1e-4);
    assert.deepEqual(await capture([job(), camera]), cold);
    const moved = await capture([job("lidar3d", [pose("a", 2)]), { ...camera, rigidBodyPoses: [pose("a", 2)] }]);
    assert.ok(Math.abs(moved[0].data[0] - 7) < 1e-4);
    assert.deepEqual(moved[1], cold[1]);
    assert.deepEqual(await capture([job(), camera]), cold);
    await pool.releaseEnvironment("hardware-residency");
    assert.equal(pool.diagnostics().trackedGpuBytes, 0);
});
