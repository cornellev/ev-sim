import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { VehicleModelLoader } from "../app/3d/vehicles/VehicleModelLoader.js";
import { writeGlb } from "../app/simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { makePng } from "./helpers/visual-assets.js";

function glbAsset(bin = new Uint8Array([1, 2, 3, 4])) {
    const bytes = writeGlb({ asset: { version: "2.0" } }, bin);
    return {
        name: `${sha256ExactBytes(bytes)}.glb`,
        bytes,
        mediaType: "model/gltf-binary",
        sha256: sha256ExactBytes(bytes),
        size: bytes.byteLength,
    };
}

function trackedRoot(name, disposals) {
    const root = new THREE.Group();
    root.name = name;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const original = geometry.dispose.bind(geometry);
    geometry.dispose = () => {
        disposals.count += 1;
        original();
    };
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    return {
        scene: root,
        parser: { associations: new Map([[root, { nodes: name === "new" ? 4 : 0 }]]), json: { nodes: [{ name }] } },
    };
}

test("VEH-02d a newer load discards the older decode for the same slot", async () => {
    const pending = [];
    const disposals = { count: 0 };
    const loader = new VehicleModelLoader({
        THREE,
        parseGltf() {
            return new Promise((resolve) => {
                pending.push((name) => resolve(trackedRoot(name, disposals)));
            });
        },
    });
    const request = {
        slotId: "studio",
        source: { kind: "bytes", asset: glbAsset(), dependencies: [] },
        model: { scale: 2, offset: { x: 0.5, y: 0, z: 0 } },
    };
    const first = loader.load(request);
    await Promise.resolve();
    assert.equal(pending.length, 1);
    const second = loader.load(request);
    await Promise.resolve();
    assert.equal(pending.length, 2);
    pending[0]("old");
    const oldLease = await first;
    assert.equal(oldLease.stale, true);
    assert.equal(oldLease.root, null);
    assert.equal(disposals.count, 1);
    pending[1]("new");
    const current = await second;
    assert.equal(current.stale, false);
    assert.equal(current.root.name, "new");
    assert.equal(current.root.scale.x, 2);
    assert.equal(current.root.position.x, 0.5);
    assert.equal(current.nodeMappings.get(current.root).nodeIndex, 4);
    current.dispose();
    assert.equal(disposals.count, 2);
    loader.dispose();
});

test("VEH-02d aborting a staged read returns no root and does not parse", async () => {
    const controller = new AbortController();
    const asset = glbAsset();
    let parsed = false;
    const loader = new VehicleModelLoader({
        THREE,
        async readMember() {
            controller.abort();
            return asset.bytes;
        },
        async parseGltf() {
            parsed = true;
            throw new Error("parsed");
        },
    });
    const result = await loader.load({
        slotId: "draft",
        source: { kind: "bytes", asset: { name: asset.name }, dependencies: [] },
        model: { scale: 1 },
    }, { signal: controller.signal });
    assert.equal(result.root, null);
    assert.equal(result.aborted, true);
    assert.equal(parsed, false);
});

test("VEH-02d version 3 URL members are checked before parse", async () => {
    const asset = glbAsset();
    const png = makePng();
    const pngName = `${sha256ExactBytes(png)}.png`;
    const events = [];
    const loader = new VehicleModelLoader({
        THREE,
        async fetchResource(url) {
            events.push(url);
            return url.endsWith(".png") ? png : asset.bytes;
        },
        async parseGltf() {
            events.push("parse");
            const root = new THREE.Group();
            return { scene: root, parser: { associations: new Map([[root, { nodes: 2 }]]) } };
        },
    });
    const lease = await loader.load({
        slotId: "canonical",
        source: {
            kind: "url",
            asset: { name: asset.name, url: "https://assets.test/model.glb" },
            dependencies: [{ name: pngName, url: "https://assets.test/image.png" }],
        },
        model: { scale: 1 },
    });
    assert.deepEqual(events, [
        "https://assets.test/model.glb",
        "https://assets.test/image.png",
        "parse",
    ]);
    assert.equal(lease.nodeMappings.get(lease.root).nodeIndex, 2);
    lease.dispose();

    const bad = new Uint8Array(asset.bytes);
    bad[bad.length - 1] ^= 0xff;
    let parsed = false;
    const rejected = new VehicleModelLoader({
        THREE,
        async fetchResource() { return bad; },
        async parseGltf() {
            parsed = true;
            return { scene: new THREE.Group() };
        },
    });
    await assert.rejects(() => rejected.load({
        slotId: "canonical",
        source: {
            kind: "url",
            asset: { name: asset.name, url: "https://assets.test/model.glb" },
            dependencies: [],
        },
        model: { scale: 1 },
    }), /byte identity verification/);
    assert.equal(parsed, false);
});

test("VEH-02d a legacy URL load uses GLTFLoader without a dependency closure", async () => {
    let loaded = null;
    class FakeGLTFLoader {
        async loadAsync(url) {
            loaded = url;
            const root = new THREE.Group();
            return { scene: root, parser: { associations: new Map() } };
        }
    }
    const loader = new VehicleModelLoader({ THREE, GLTFLoader: FakeGLTFLoader });
    const lease = await loader.load({
        slotId: "legacy",
        source: { kind: "url", url: "/shell/shell.gltf" },
        model: { scale: 1 },
    });
    assert.equal(loaded, "/shell/shell.gltf");
    assert.equal(lease.stale, false);
    assert.equal(lease.root.isGroup, true);
    lease.dispose();
    loader.dispose();
});
