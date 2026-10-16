import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";

import { writeGlb } from "../app/simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { publishedVehicleModelSource } from "../app/3d/vehicles/VehicleModelLoader.js";
import { normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { makePng } from "./helpers/visual-assets.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

test("published vehicle model sources keep legacy URLs and expand canonical closures", () => {
    const legacy = normalizeVehicleManifest({ version: 2, id: "box", model: { asset: "car.glb" } });
    const legacySource = publishedVehicleModelSource(legacy, "/api/storage/vehicle-assets/box/car.glb");
    assert.equal(legacySource.asset, undefined);
    assert.equal(legacySource.url, "/api/storage/vehicle-assets/box/car.glb");

    const bytes = writeGlb({ asset: { version: "2.0" } }, new Uint8Array([1, 2, 3, 4]));
    const name = `${sha256ExactBytes(bytes)}.glb`;
    const pngName = `${sha256ExactBytes(makePng())}.png`;
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "boxed",
        model: { asset: name, dependencies: [pngName] },
    });
    const source = publishedVehicleModelSource(manifest, `/api/storage/vehicle-assets/boxed/${name}?v=3`);
    assert.equal(source.kind, "url");
    assert.equal(source.asset.name, name);
    assert.equal(source.asset.url, `/api/storage/vehicle-assets/boxed/${name}?v=3`);
    assert.deepEqual(source.dependencies, [{
        name: pngName,
        url: `/api/storage/vehicle-assets/boxed/${pngName}?v=3`,
    }]);
});

test("ManifestVehicle ignores an older in-flight model load", async () => {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { ManifestVehicle } = await import("../app/3d/vehicles/ManifestVehicle.js");
    const database = new VehicleDatabase({
        devices: () => ({ addDevice() {} }),
        bindings: () => null,
        scene: null,
    });
    const manifest = normalizeVehicleManifest({ version: 2, id: "box", model: { asset: "car.glb" } });
    let calls = 0;
    const loader = {
        async load() {
            const which = ++calls;
            await Promise.resolve();
            const root = new THREE.Group();
            root.name = `model-${which}`;
            return {
                stale: false,
                root,
                nodeMappings: new Map(),
                alignment: { x: 0, y: 0, z: 0 },
                dispose() {},
            };
        },
        dispose() {},
    };
    const vehicle = new ManifestVehicle(database, manifest, new THREE.Vector3(), new THREE.Euler(), {
        skipManifestDevices: true,
        modelLoader: loader,
    });
    const scene = { add() {} };
    const first = vehicle.addToScene(scene);
    const second = vehicle.addToScene(scene);
    await first;
    await second;
    assert.equal(vehicle.sceneObject.children.some((child) => child.name === "model-2"), true);
    assert.equal(vehicle.sceneObject.children.some((child) => child.name === "model-1"), false);
    vehicle.dispose();
});
