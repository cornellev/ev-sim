import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { VISUAL_PREVIEW_USERDATA } from "../app/3d/environment/visual/VisualPreviewIsolation.js";
import { EDITOR_LAYERS } from "../app/3d/editor/EditorState.js";
import {
    MapSatelliteCapture,
    shouldHideFromMapSatellite,
} from "../app/3d/editor/map/MapSatelliteCapture.js";

test("shouldHideFromMapSatellite keeps tiles and preview, hides editor chrome and roads", () => {
    const tile = { userData: { earthImportLayer: true, skipEnvironmentSelection: true, bakeIgnore: true } };
    const preview = { userData: { [VISUAL_PREVIEW_USERDATA.previewOnly]: true, skipEnvironmentSelection: true } };
    const helper = { userData: { editorHelper: true } };
    const sky = { userData: { preserveInEarthImportMode: true, bakeIgnore: true } };
    const grid = { isGridHelper: true, name: "EditorWorkingGrid", userData: {} };
    const occupancy = {
        name: "EnvironmentChunk:0,0",
        userData: { environmentChunkKey: "0,0", skipEnvironmentSelection: true },
    };
    const occupant = { userData: {}, parent: occupancy };
    const chunk = { name: "EnvironmentChunkOutlines", userData: { skipEnvironmentSelection: true } };
    const gizmo = { isTransformControls: true, type: "TransformControls", userData: {} };
    const ghost = { name: "EditorAssetPlacementGhost", userData: { skipEnvironmentSelection: true } };
    const building = { userData: {} };

    assert.equal(shouldHideFromMapSatellite(tile), false);
    assert.equal(shouldHideFromMapSatellite(preview), false);
    assert.equal(shouldHideFromMapSatellite(building), false);
    assert.equal(shouldHideFromMapSatellite(occupancy), false, "chunk occupancy groups parent authored meshes");
    assert.equal(shouldHideFromMapSatellite(occupant), false);
    assert.equal(shouldHideFromMapSatellite(helper), true);
    assert.equal(shouldHideFromMapSatellite(sky), true);
    assert.equal(shouldHideFromMapSatellite(grid), true);
    assert.equal(shouldHideFromMapSatellite(chunk), true);
    assert.equal(shouldHideFromMapSatellite(gizmo), true);
    assert.equal(shouldHideFromMapSatellite(ghost), true);

    const road = { userData: {} };
    const child = { userData: {}, parent: road };
    const registry = {
        entities: new Map([
            ["road:e1", { layer: EDITOR_LAYERS.ROADS, object3D: road }],
        ]),
    };
    assert.equal(shouldHideFromMapSatellite(road, { registry }), true);
    assert.equal(shouldHideFromMapSatellite(child, { registry }), true);
    assert.equal(shouldHideFromMapSatellite(building, { registry }), false);
});

test("MapSatelliteCapture reveals a hidden tile host for the snapshot and restores it", () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    scene.add(mesh);
    const visibility = [];
    const tilesHost = {
        visible: false,
        setVisible(value) {
            this.visible = value;
            visibility.push(value);
        },
        update() {},
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext() {
            return {
                createImageData(width, height) {
                    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
                },
                putImageData() {},
            };
        },
    };
    const renderer = {
        autoClear: true,
        shadowMap: { enabled: false },
        _target: null,
        _clearColor: new THREE.Color(0x000000),
        _clearAlpha: 1,
        getRenderTarget() { return this._target; },
        setRenderTarget(target) { this._target = target; },
        getClearColor(color) { color.copy(this._clearColor); },
        getClearAlpha() { return this._clearAlpha; },
        setClearColor() {},
        setViewport() { this.viewportCalls = (this.viewportCalls ?? 0) + 1; this.lastViewport = [...arguments]; },
        getViewport(vector) { return vector.set(0, 0, 32, 16); },
        render() { this.renderedWithTarget = this._target; },
        readRenderTargetPixels(target, x, y, width, height, buffer) { buffer.fill(255); },
    };
    const capturer = new MapSatelliteCapture({ maxSize: 64 });
    capturer.capture({
        renderer,
        scene,
        tilesHost,
        viewport: { centerX: 0, centerZ: 0, zoom: 1 },
        size: { width: 32, height: 16 },
        canvas,
    });
    assert.deepEqual(visibility, [true, false]);
    assert.equal(tilesHost.visible, false);
    capturer.dispose();
});

test("MapSatelliteCapture blits a Y-flipped target, disables shadows, and restores visibility", () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xff0000);
    const helper = new THREE.Object3D();
    helper.userData.editorHelper = true;
    scene.add(helper);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    scene.add(mesh);

    const frames = [];
    const renderer = {
        autoClear: true,
        shadowMap: { enabled: true },
        _target: "default",
        _clearAlpha: 0.25,
        _clearColor: new THREE.Color(0x112233),
        getRenderTarget() { return this._target; },
        setRenderTarget(target) { this._target = target; },
        getClearColor(color) { color.copy(this._clearColor); },
        getClearAlpha() { return this._clearAlpha; },
        setClearColor(color, alpha) {
            this._clearColor = color?.clone?.() ?? new THREE.Color(color);
            this._clearAlpha = alpha;
        },
        viewportCalls: [],
        getViewport(vector) { return vector.set(2, 4, 800, 600); },
        setViewport(...args) { this.viewportCalls.push(args); },
        render(nextScene, camera) {
            frames.push({
                scene: nextScene,
                camera,
                shadow: this.shadowMap.enabled,
                helperVisible: helper.visible,
                background: nextScene.background?.getHex?.() ?? null,
                target: this._target,
                viewportCalls: this.viewportCalls.length,
            });
        },
        readRenderTargetPixels(target, x, y, width, height, buffer) {
            buffer.fill(40);
            for (let i = 3; i < buffer.length; i += 4) buffer[i] = 255;
            buffer[0] = 255;
            buffer[1] = 0;
            buffer[2] = 0;
            buffer[3] = 255;
        },
    };

    let image = null;
    const canvas = {
        width: 0,
        height: 0,
        getContext() {
            return {
                createImageData(width, height) {
                    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
                },
                putImageData(next) { image = next; },
            };
        },
    };

    const capturer = new MapSatelliteCapture({ maxSize: 64 });
    const result = capturer.capture({
        renderer,
        scene,
        viewport: { centerX: 2, centerZ: 4, zoom: 1 },
        size: { width: 32, height: 16 },
        canvas,
    });

    assert.equal(result.viewport.centerX, 2);
    assert.equal(result.viewport.centerZ, 4);
    assert.equal(result.size.width, 32);
    assert.equal(helper.visible, true);
    assert.equal(renderer.shadowMap.enabled, true);
    assert.equal(renderer._target, "default");
    assert.equal(scene.background.getHex(), 0xff0000);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].shadow, false);
    assert.equal(frames[0].helperVisible, false);
    assert.equal(frames[0].camera.isOrthographicCamera, true);
    assert.equal(frames[0].viewportCalls, 0, "render-target viewport is not set in CSS pixels");
    assert.equal(result.canvas, canvas);
    assert.equal(renderer.viewportCalls.length, 1, "canvas viewport is restored after blit");
    assert.equal(renderer.viewportCalls[0][0].z, 800);
    assert.ok(image);
    const bottom = (image.height - 1) * image.width * 4;
    assert.equal(image.data[0], 40, "canvas top comes from the last WebGL row");
    assert.equal(image.data[bottom], 255, "WebGL (0,0) is bottom-left and lands on the canvas bottom");
    assert.equal(image.data[bottom + 1], 0);
    assert.equal(image.data[bottom + 2], 0);

    capturer.dispose();
    assert.equal(capturer.target, null);
});

test("MapSatelliteCapture restores the previous tiles camera after the snapshot", () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    const sceneCamera = { name: "scene-camera" };
    const cameras = [];
    const tilesHost = {
        visible: true,
        camera: sceneCamera,
        active: { session: { camera: sceneCamera } },
        update(camera) {
            cameras.push(camera);
            this.camera = camera;
            this.active.session.camera = camera;
        },
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext() {
            return {
                createImageData(width, height) {
                    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
                },
                putImageData() {},
            };
        },
    };
    const renderer = {
        autoClear: true,
        shadowMap: { enabled: false },
        _target: null,
        _clearColor: new THREE.Color(0x000000),
        _clearAlpha: 1,
        getRenderTarget() { return this._target; },
        setRenderTarget(target) { this._target = target; },
        getClearColor(color) { color.copy(this._clearColor); },
        getClearAlpha() { return this._clearAlpha; },
        setClearColor() {},
        getViewport(vector) { return vector.set(0, 0, 32, 16); },
        setViewport() {},
        render() {},
        readRenderTargetPixels(target, x, y, width, height, buffer) { buffer.fill(255); },
    };
    const capturer = new MapSatelliteCapture({ maxSize: 64 });
    capturer.capture({
        renderer,
        scene,
        tilesHost,
        viewport: { centerX: 0, centerZ: 0, zoom: 1 },
        size: { width: 32, height: 16 },
        canvas,
    });
    assert.equal(cameras.length, 2);
    assert.equal(cameras[0].isOrthographicCamera, true);
    assert.equal(cameras[1], sceneCamera);
    assert.equal(tilesHost.camera, sceneCamera);
    capturer.dispose();
});
