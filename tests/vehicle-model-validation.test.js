import assert from "node:assert/strict";
import test from "node:test";

import { writeGlb } from "../app/simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import {
    VEHICLE_MODEL_LIMITS,
    assertVehicleGltfGraph,
    inspectVehicleImage,
    validateVehicleModelClosure,
} from "../app/vehicles/model/validateVehicleModel.js";
import { inspectJpeg, inspectKtx2, inspectPng } from "../server/storage/visual-assets/mediaInspectors.js";
import { preflightGltf } from "../server/storage/visual-assets/gltfPreflight.js";
import { makeJpeg, makeKtx2, makePng } from "./helpers/visual-assets.js";

const limits = VEHICLE_MODEL_LIMITS;

function imageDependency(bytes) {
    const digest = sha256ExactBytes(bytes);
    const mediaType = inspectVehicleImage(bytes).mediaType;
    const extension = mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : "ktx2";
    return {
        name: `${digest}.${extension}`,
        mediaType,
        sha256: digest,
        size: bytes.byteLength,
        bytes,
    };
}

test("VEH-02c graph checks accept and reject the same documents as server preflight", () => {
    const json = { asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] };
    const binBytes = new Uint8Array(4);
    assert.doesNotThrow(() => preflightGltf({ json, binBytes, limits, declaredDependencies: {} }));
    assert.doesNotThrow(() => assertVehicleGltfGraph(json, limits));

    const animated = { ...json, animations: [{ name: "roll" }] };
    assert.throws(() => preflightGltf({ json: animated, binBytes, limits, declaredDependencies: {} }));
    assert.throws(() => assertVehicleGltfGraph(animated, limits), /Animation is not permitted/);

    const extended = { ...json, extensionsUsed: ["NOT_A_REAL_EXTENSION"] };
    assert.throws(() => preflightGltf({ json: extended, binBytes, limits, declaredDependencies: {} }));
    assert.throws(() => assertVehicleGltfGraph(extended, limits), /not permitted/);
});

test("VEH-02c texture inspection matches server PNG, JPEG, and KTX2 checks", () => {
    const png = makePng();
    const jpeg = makeJpeg();
    const ktx = makeKtx2();
    for (const [bytes, server] of [
        [png, inspectPng(png, limits)],
        [jpeg, inspectJpeg(jpeg, limits)],
        [ktx, inspectKtx2(ktx, limits)],
    ]) {
        const vehicle = inspectVehicleImage(bytes, limits);
        assert.equal(vehicle.width, server.width);
        assert.equal(vehicle.height, server.height);
        assert.equal(vehicle.mipLevels, server.mipLevels);
        assert.equal(vehicle.decodedBytesEstimate, server.decodedBytesEstimate);
    }
    const huge = makePng({ width: 8193, height: 1 });
    assert.throws(() => inspectPng(huge, limits));
    assert.throws(() => inspectVehicleImage(huge, limits), /8193/);
});

test("VEH-02c closure validation checks sibling names, digests, and decoded size", () => {
    const png = makePng();
    const dependency = imageDependency(png);
    const glb = writeGlb({
        asset: { version: "2.0" },
        images: [{ uri: dependency.name, mimeType: "image/png" }],
        buffers: [{ byteLength: 4 }],
    }, new Uint8Array([1, 2, 3, 4]));
    const accepted = validateVehicleModelClosure({ glbBytes: glb, dependencies: [dependency] });
    assert.equal(accepted.decodedBytesEstimate > 0, true);

    assert.throws(() => validateVehicleModelClosure({
        glbBytes: writeGlb({
            asset: { version: "2.0" },
            images: [{ uri: "textures/a.png" }],
        }),
        dependencies: [],
    }), /content-addressed sibling filename/);

    const flipped = new Uint8Array(png);
    flipped[flipped.length - 1] ^= 0xff;
    assert.throws(() => validateVehicleModelClosure({
        glbBytes: glb,
        dependencies: [{ ...dependency, bytes: flipped, sha256: sha256ExactBytes(flipped) }],
    }), /byte identity verification/);

    const extra = imageDependency(makePng({ red: 1 }));
    assert.throws(() => validateVehicleModelClosure({
        glbBytes: glb,
        dependencies: [dependency, extra],
    }), /not referenced/);

    assert.throws(() => validateVehicleModelClosure({
        glbBytes: glb,
        dependencies: [dependency],
        limits: { decodedClosureBytes: 1 },
    }), /Decoded model closure exceeds/);
});
