import assert from "node:assert/strict";
import test from "node:test";

import { assertAllowedBrowserResourceUrl } from "../app/security/BrowserResourcePolicy.js";
import {
    assertAllowedBakeHost,
    bakeAuthorizationHeaders,
    bakeServerUrl,
} from "../app/3d/environment/visualization/BakeAccess.js";
import { resolveVehicleModelUrl } from "../app/vehicles/VehicleManifest.js";

test("browser resources allow local paths and reject active or unapproved origins", () => {
    assert.equal(
        assertAllowedBrowserResourceUrl("assets/skybox/sky.exr", { baseOrigin: "http://localhost:3000" }),
        "assets/skybox/sky.exr",
    );
    assert.equal(resolveVehicleModelUrl("car", "model.glb"), "/api/storage/vehicle-assets/car/model.glb");
    assert.throws(() => resolveVehicleModelUrl("car", "data:text/plain,model"), /scheme/);
    assert.throws(() => resolveVehicleModelUrl("car", "//attacker.invalid/model.glb"), /malformed/);
    assert.throws(
        () => assertAllowedBrowserResourceUrl("https://attacker.invalid/sky.exr", {
            baseOrigin: "http://localhost:3000",
        }),
        /origin .* is not allowed/,
    );
    assert.equal(
        assertAllowedBrowserResourceUrl("https://assets.example/sky.exr", {
            baseOrigin: "http://localhost:3000",
            allowedOrigins: new Set(["https://assets.example"]),
        }),
        "https://assets.example/sky.exr",
    );
});

test("bake requests are limited to loopback or explicitly allowed origins", () => {
    assert.equal(assertAllowedBakeHost("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
    assert.equal(
        bakeServerUrl({ host: "http://localhost:8000" }, "/healthz"),
        "http://localhost:8000/healthz",
    );
    assert.throws(() => assertAllowedBakeHost("http://attacker.invalid:8000"), /not allowed/);
    assert.throws(() => assertAllowedBakeHost("http://localhost:8000/clear"), /without credentials or a path/);
    assert.throws(() => bakeServerUrl({ host: "http://localhost:8000" }, "//attacker.invalid"), /path is invalid/);
    assert.deepEqual(
        bakeAuthorizationHeaders({ host: "http://localhost:8000", accessToken: "secret" }, { Accept: "image/png" }),
        { Accept: "image/png", Authorization: "Bearer secret" },
    );
    assert.throws(
        () => bakeAuthorizationHeaders({ host: "http://localhost:8000", accessToken: "" }),
        /session bake access token is required/i,
    );
});
