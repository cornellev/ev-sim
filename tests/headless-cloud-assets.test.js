import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";

import {
    DEFAULT_LOCAL_WEATHER_URL,
    DEFAULT_SHAPE_DETAIL_URL,
    DEFAULT_SHAPE_URL,
    DEFAULT_TURBULENCE_URL,
} from "@takram/three-clouds";

import { cloudTextureUrl } from "../app/3d/perception/PbrAppearanceSky.js";
import { packagedCloudAsset } from "../server/headless/PooledGpuRenderer.js";

const CLOUD_TEXTURES = [
    ["local_weather.png", DEFAULT_LOCAL_WEATHER_URL, "image/png"],
    ["turbulence.png", DEFAULT_TURBULENCE_URL, "image/png"],
    ["shape.bin", DEFAULT_SHAPE_URL, "application/octet-stream"],
    ["shape_detail.bin", DEFAULT_SHAPE_DETAIL_URL, "application/octet-stream"],
];

test("headless PBR loads packaged cloud textures from the private origin", async () => {
    const previousLocation = globalThis.location;
    globalThis.location = { origin: "http://cev-sim.invalid" };
    try {
        for (const [filename, remoteUrl, contentType] of CLOUD_TEXTURES) {
            const url = new URL(cloudTextureUrl(filename, remoteUrl));
            assert.equal(url.origin, "http://cev-sim.invalid");
            assert.equal(url.protocol, "http:");
            const asset = packagedCloudAsset(url.pathname);
            assert.equal(asset?.contentType, contentType);
            const file = await stat(asset.file);
            assert.ok(file.size > 0);
        }
        globalThis.location = { origin: "http://localhost:3000" };
        assert.equal(cloudTextureUrl("shape.bin", DEFAULT_SHAPE_URL), DEFAULT_SHAPE_URL);
    } finally {
        if (previousLocation === undefined) delete globalThis.location;
        else globalThis.location = previousLocation;
    }
    assert.equal(packagedCloudAsset("/runtime/node_modules/@takram/three-clouds/assets/../package.json"), null);
    assert.equal(packagedCloudAsset("/runtime/node_modules/@takram/three-clouds/build/index.js"), null);
    assert.equal(packagedCloudAsset("/runtime/app/client/Client.js"), null);
});
