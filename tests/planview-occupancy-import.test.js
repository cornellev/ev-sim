import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOccupancy } from "../app/autonomy/AutonomyVisualizationModel.js";
import { CandidateOutputRuntime } from "../app/autonomy/CandidateOutputRuntime.js";
import { applyMapping, compileMapping } from "../app/interfaces/ProtobufMapping.js";
import { createProtobufInterfaceResource, planProtobufRouteAdmission } from "../app/interfaces/ProtobufRunBinding.js";
import { loadUploadedProtoFiles } from "../server/interfaces/ProtobufSourceLoader.js";
import { defaultNativeManifestTopics, topicFromNativeContract } from "../app/simulation/NativeTopicCatalog.js";
import { createNativeTopicContractResource, validateNativeTopicValue } from "../app/simulation/NativeTopicContracts.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { OCCUPANCY_NOT_CONFIGURED, occupancyImportStatus } from "../app/spatial/planview/occupancy/stackImport.js";
import { uploadedSource } from "./helpers/protobufFixtures.js";

const schema = await loadUploadedProtoFiles(uploadedSource('syntax="proto3"; package occ; message Vec { double x=1; double y=2; double z=3; } message Grid { bytes cells=1; uint32 width=2; uint32 height=3; double resolution=4; Vec origin=5; string encoding=6; }'));

function topic() {
    return topicFromNativeContract("planning-occupancy");
}

function resolved(routes) {
    const resource = createProtobufInterfaceResource({
        kind: "cev-sim.protobuf-interface",
        version: 2,
        schemas: [{ id: "main", fingerprint: schema.fingerprint, descriptorBase64: schema.descriptorBase64 }],
        routes,
        bootstrap: [],
    });
    const manifestTopic = topic();
    return {
        version: 13,
        manifest: {
            version: 13,
            id: "run",
            topics: [manifestTopic],
            protobuf: { mode: "zenoh", interfaceHash: resource.hash, externalController: false },
        },
        protobufInterface: resource,
        nativeTopicContracts: createNativeTopicContractResource([manifestTopic]),
    };
}

function route() {
    return {
        id: "grid",
        schemaId: "main",
        messageType: "occ.Grid",
        direction: "subscribe",
        key: "stack/{run_id}/occupancy",
        target: { topicId: "planning-occupancy" },
        mapping: { fields: [
            { to: "data", from: "value.cells" },
            { to: "width", from: "value.width" },
            { to: "height", from: "value.height" },
            { to: "resolutionM", from: "value.resolution" },
            { to: "origin.x", from: "value.origin.x" },
            { to: "origin.y", from: "value.origin.y" },
            { to: "origin.z", from: "value.origin.z" },
            { to: "encoding", from: "value.encoding" },
        ] },
    };
}

test("a subscribe mapping fills occupancy and a missing route is not configured", () => {
    assert.equal(defaultNativeManifestTopics().some((entry) => entry.valueContract.id === "cev.occupancy"), false);
    const run = resolved([route()]);
    const entry = planProtobufRouteAdmission({ manifest: run.manifest, interfaceResource: run.protobufInterface, resolvedRun: run }).routes[0];
    const value = applyMapping(compileMapping(entry, { resolvedRun: run, runId: "run" }), {
        value: { cells: Uint8Array.from([0, 1, 1, 0]), width: 2, height: 2, resolution: 0.5, origin: { x: 4, y: 1, z: -2 }, encoding: "cost" },
    });
    assert.equal(validateNativeTopicValue(topic().valueContract, value).ok, true);
    assert.equal(occupancyImportStatus(run).configured, true);
    assert.equal(occupancyImportStatus({ manifest: { topics: [] }, protobufInterface: { document: { routes: [] } } }).message, OCCUPANCY_NOT_CONFIGURED);
    const doubled = resolved([route(), { ...route(), id: "grid-2", key: "stack/{run_id}/occupancy-2" }]);
    assert.equal(occupancyImportStatus(doubled).configured, false);

    const grid = normalizeOccupancy(value, { valueContract: topic().valueContract, metadata: { frameId: "map" } });
    assert.equal(grid.originX, 4);
    assert.equal(grid.originZ, -2);
    assert.equal(grid.yawRad, 0);
    assert.equal(validateNativeTopicValue(topic().valueContract, { ...value, data: new Uint8Array(1) }).ok, false);

    const router = new TopicContractRouter({ id: "run", version: 13, topics: [topic()] }, { publicationPort: () => true });
    const runtime = new CandidateOutputRuntime({ manifest: { topics: [topic()] } });
    const routed = router.routeInbound({
        name: topic().name,
        value,
        metadata: { frameId: "map", captureTimeNs: 10 },
        captureTimeNs: 10,
    }, { applyStep: 1, applyTimeNs: 10 });
    runtime.ingestRouted(routed, { applyStep: 1, applyTimeNs: 10 });
    assert.equal(runtime.lastOccupancy.originX, 4);
    runtime.reset();
    assert.equal(runtime.lastOccupancy, null);
});
