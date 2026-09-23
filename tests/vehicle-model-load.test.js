import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { resolveVehicleModelUrl } from "../app/vehicles/VehicleManifest.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

test("resolved vehicle models keep their authored URL for loadAsync", async () => {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
        throw new Error("configureFromManifest must not fetch vehicle model bytes");
    };
    try {
        const manifest = getBuiltInVehicleManifest("big-car");
        const database = new VehicleDatabase({
            devices: () => ({ addDevice() {} }),
            bindings: () => null,
            scene: null,
        });
        await database.configureFromManifest([{
            id: "ego",
            type: "big-car",
            pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        }], null, {
            resolvedVehicles: [{
                actorId: "ego",
                vehicleId: "big-car",
                hash: "vehicle-hash",
                manifest,
                assetHashes: { "/shell/shell.gltf": "abc", "/shell/buffer.bin": "def" },
            }],
        });

        const vehicle = database.vehicles.find((entry) => entry.telemetryId === "ego");
        assert.ok(vehicle);
        assert.equal(vehicle.manifest.model.asset, "/shell/shell.gltf");
        assert.equal(manifest.model.asset, "/shell/shell.gltf");
        assert.equal(resolveVehicleModelUrl("big-car", vehicle.manifest.model.asset), "/shell/shell.gltf");
        assert.throws(() => resolveVehicleModelUrl("car", "data:text/plain,model"), /scheme/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
