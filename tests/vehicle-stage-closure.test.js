import assert from "node:assert/strict";
import test from "node:test";

import { stagedVehicleModelSource } from "../app/3d/vehicles/VehicleModelLoader.js";
import { stageVehicleClosure } from "../app/vehicles/editor/stageVehicleClosure.js";

function fakeClient(readSha = "abc") {
    const abandoned = [];
    return {
        abandoned,
        async createVehicleStage() {
            return { stageId: "stage-1" };
        },
        async uploadVehicleStageMember(_stageId, name) {
            return { name, sha256: "abc", size: 3, mediaType: "model/gltf-binary" };
        },
        async readVehicleStageMember() {
            return { sha256: readSha, size: 3, bytes: new Uint8Array([1, 2, 3]) };
        },
        async abandonVehicleStage(stageId) {
            abandoned.push(stageId);
        },
    };
}

const file = { name: "abc.glb", bytes: new Uint8Array([1, 2, 3]), sha256: "abc", size: 3, mediaType: "model/gltf-binary" };

test("stageVehicleClosure keeps a stage only after the read-back digest matches", async () => {
    const client = fakeClient("abc");
    const staged = await stageVehicleClosure([file], client);
    assert.equal(staged.stageId, "stage-1");
    assert.equal(staged.members[0].sha256, "abc");
    assert.deepEqual(client.abandoned, []);
    const source = stagedVehicleModelSource({ model: { asset: "abc.glb", dependencies: [] } }, staged);
    assert.equal(source.asset.url, "/api/storage/vehicle-stages/stage-1/members/abc.glb");
});

test("a digest mismatch abandons the stage and does not return it", async () => {
    const client = fakeClient("def");
    await assert.rejects(() => stageVehicleClosure([file], client), /does not match the server digest/);
    assert.deepEqual(client.abandoned, ["stage-1"]);
    assert.equal(stagedVehicleModelSource({ model: { asset: "abc.glb", dependencies: [] } }, { stageId: "stage-1", members: [] }), null);
});
