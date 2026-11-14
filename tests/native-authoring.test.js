import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultRunManifest, normalizeRunManifest, validateRunManifest } from "../app/simulation/RunManifest.js";
import { createDefaultRunManifest as createHistoricalManifest } from "../server/interfaces/historical/RunContracts.js";
import { planProtobufRouteAdmission } from "../app/interfaces/ProtobufRunBinding.js";

test("production authoring rejects historical admission and legacy sensor declarations", () => {
    const historical = createHistoricalManifest({ version: 12 });
    assert.throws(() => createDefaultRunManifest({ version: 12 }), /reviewed native adoption/);
    assert.throws(() => normalizeRunManifest(historical), /reviewed native adoption/);
    assert.throws(() => planProtobufRouteAdmission({ manifest: historical }), /inspected native adoption/);
    const native = createDefaultRunManifest();
    assert.equal(validateRunManifest(native).ok, true);
    native.sensorRig.sensors[0].schema = { imageTopicId: "sensor_msgs/Image" };
    assert.equal(validateRunManifest(native).ok, false);
});
