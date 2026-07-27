import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    addBuildingRectangle,
    addFeature,
    addRoadEdge,
    getOrCreateNode,
} from "../app/3d/editor/document/documentMutations.js";
import { conflictsForNewEntities } from "../app/3d/editor/document/documentGeometry.js";
import {
    createScriptDocument,
    createEmptyGraph,
    nowIso,
} from "../app/scripting/EditorDocument.js";
import {
    createBinding,
    createBindingManifest,
    validateBinding,
} from "../app/scripting/bindings/BindingDocument.js";
import { StorageService } from "../server/storage/StorageService.js";
import { LogService } from "../server/logging/LogService.js";
import { storageEvents } from "../server/mcp/events.js";
import {
    inspectReplay,
    readReplaySeries,
    registerLoggingTools,
} from "../server/mcp/loggingTools.js";
import { SFLogBatchEncoder } from "../app/logging/SFLogCodec.js";
import {
    loadDocument,
    saveDocument,
} from "../server/mcp/environmentTools.js";
import {
    getManifest,
    putManifest,
    checkScriptInterface,
} from "../server/mcp/bindingTools.js";
import { registerRunManifestTools } from "../server/mcp/runManifestTools.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { PLACEMENT_CATALOG } from "../app/3d/editor/placement/placementCatalogData.js";

async function withTempStorage(fn) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sf-mcp-"));
    const storage = new StorageService(dir);
    try {
        await fn(storage);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("placement catalog includes cone", () => {
    assert.ok(PLACEMENT_CATALOG.some((asset) => asset.id === "cone"));
});

test("environment tools path: create, add road/building/object, persist conflicts", async () => {
    await withTempStorage(async (storage) => {
        await storage.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        const { manifest, document } = await loadDocument(storage, "yard");

        const n0 = getOrCreateNode(document, { x: 0, z: 0 }, 0.1);
        const n1 = getOrCreateNode(document, { x: 30, z: 0 }, 0.1);
        const n2 = getOrCreateNode(document, { x: 0, z: 30 }, 0.1);
        const n3 = getOrCreateNode(document, { x: 30, z: 30 }, 0.1);
        const edgeA = addRoadEdge(document, n0.id, n1.id);
        const edgeB = addRoadEdge(document, n2.id, n3.id);
        assert.equal(edgeA.ok, true);
        assert.equal(edgeB.ok, true);

        // Non-crossing parallel-ish? n2-n3 is diagonal? Actually 0,30 -> 30,30 is parallel to n0-n1.
        // Add a crossing road instead:
        const n4 = getOrCreateNode(document, { x: 15, z: -10 }, 0.1);
        const n5 = getOrCreateNode(document, { x: 15, z: 10 }, 0.1);
        const cross = addRoadEdge(document, n4.id, n5.id);
        assert.equal(cross.ok, true);

        const building = addBuildingRectangle(
            document,
            { x: -5, z: -5 },
            { x: 5, z: 5 },
            { height: 10 },
        );
        assert.equal(building.ok, true);

        const feature = addFeature(document, {
            type: "cone",
            x: 15,
            z: 0,
            tags: ["cone"],
        });
        assert.equal(feature.ok, true);

        const conflicts = conflictsForNewEntities(document, {
            edgeIds: [cross.edge.id],
            buildingIds: [building.record.buildingId],
            featureIds: [feature.record.id],
        });
        assert.ok(conflicts.length > 0);

        await saveDocument(storage, "yard", manifest, document);
        const reloaded = await storage.getEnvironment("yard");
        assert.equal(reloaded.roadsAuthored, true);
        assert.equal(reloaded.buildingsAuthored, true);
        assert.equal(reloaded.featuresAuthored, true);
        assert.equal(reloaded.document.features.length, 1);
        assert.equal(reloaded.document.features[0].type, "cone");
        assert.ok(reloaded.clientRevision > 0);
    });
});

test("script graph mutations persist through StorageService", async () => {
    await withTempStorage(async (storage) => {
        const document = createScriptDocument({
            id: "script-a",
            name: "Drive",
            graph: createEmptyGraph(),
        });
        document.graph.nodes.push({
            uuid: "num-1",
            type: "NumberUnitClass",
            state: null,
            storedData: 3.5,
            runtimeState: null,
            position: { x: 0, y: 0 },
        });
        document.graph.outputNodeConfig = {
            outputs: [{ id: "output", label: "value", type: "float64" }],
        };
        document.graph.connections.push({
            from: "num-1",
            output: "number",
            to: "head-uuid",
            input: "output",
            type: "float64",
        });
        document.updatedAt = nowIso();
        await storage.putScript(document);

        const loaded = await storage.getScript("script-a");
        assert.equal(loaded.graph.nodes.length, 1);
        assert.equal(loaded.graph.connections.length, 1);
        assert.equal(loaded.graph.nodes[0].storedData, 3.5);
        assert.equal(loaded.graph.outputNodeConfig.outputs[0].label, "value");
        assert.equal(loaded.graph.connections[0].to, "head-uuid");
    });
});

test("binding tools path: manifest CRUD and interface check", async () => {
    await withTempStorage(async (storage) => {
        const script = createScriptDocument({
            id: "script-b",
            name: "Bound",
            graph: createEmptyGraph(),
            latestValidArtifact: {
                kind: "cev-sim.visual-script.program",
                version: 2,
                name: "Bound",
                head: "out",
                finalStates: ["out"],
                startStates: [],
                Q: [],
                nodeIndex: {},
                nodes: [],
                transitions: { success: {}, reverseSuccess: {} },
                interface: {
                    inputs: [{ label: "speed", type: "float64" }],
                    outputs: [{ label: "cmd", type: "float64" }],
                },
                bindings: [],
                entrypoints: [],
            },
            compileStatus: { valid: true, error: null, artifactUpdatedAt: nowIso() },
        });
        await storage.putScript(script);

        const okCheck = await checkScriptInterface(
            storage,
            "script-b",
            [{ input: "speed", source: "constant", value: 1 }],
            [{ output: "cmd", sink: "signal", path: "debug.cmd" }],
        );
        assert.equal(okCheck.ok, true);

        const badCheck = await checkScriptInterface(
            storage,
            "script-b",
            [{ input: "nope", source: "constant", value: 1 }],
            [],
        );
        assert.equal(badCheck.ok, false);
        assert.match(badCheck.error, /Unknown input/);

        const binding = createBinding({
            name: "Speed binding",
            folderId: "controllers",
            scope: "global",
            scriptId: "script-b",
            trigger: { kind: "fixed-update", everyN: 1 },
            inputs: [{ input: "speed", source: "sim", key: "dt" }],
            outputs: [{ output: "cmd", sink: "signal", path: "debug.cmd" }],
        });
        assert.deepEqual(validateBinding(binding), []);

        const manifest = createBindingManifest({
            folders: [{ id: "controllers", name: "Controllers" }],
            bindings: [binding],
        });
        await putManifest(storage, manifest);
        const loaded = await getManifest(storage);
        assert.equal(loaded.bindings.length, 1);
        assert.equal(loaded.bindings[0].scriptId, "script-b");
        assert.equal(loaded.bindings[0].folderId, "controllers");
        assert.equal(loaded.bindings[0].scope, "global");
        assert.deepEqual(loaded.folders, [{ id: "controllers", name: "Controllers" }]);
    });
});

test("storageEvents publishes MCP change payloads", async () => {
    const events = [];
    const onChange = (payload) => events.push(payload);
    storageEvents.on("change", onChange);
    try {
        storageEvents.publish({ domain: "environment", id: "yard", action: "updated", requestId: "request-1", data: { source: "test" } });
        assert.equal(events.length, 1);
        assert.equal(events[0].domain, "environment");
        assert.equal(events[0].id, "yard");
        assert.equal(events[0].requestId, "request-1");
        assert.deepEqual(events[0].data, { source: "test" });
        assert.ok(events[0].at);
    } finally {
        storageEvents.off("change", onChange);
    }
});

test("logging MCP helpers inspect replay state and bounded series", async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sf-mcp-logs-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const logs = new LogService(directory);
    const session = await logs.createSession({ id: "mcp-replay", name: "MCP Replay" });
    const encoder = new SFLogBatchEncoder();
    const descriptor = { path: "simulation.time", type: "float64", unit: "s", replayRole: "state", logClass: "core" };
    encoder.addUpdate({ path: descriptor.path, timeUs: 0, cycle: 0, descriptor, entry: { type: descriptor.type, value: 0, timeUs: 0, cycle: 0 } });
    encoder.addCheckpoint({ "simulation.time": { type: "float64", value: 0 } }, [descriptor], 0);
    encoder.addEvent({ timeUs: 750_000, category: "simulation", name: "pause", severity: "info", payload: { source: "test" } });
    encoder.addUpdate({ path: descriptor.path, timeUs: 1_000_000, cycle: 60, descriptor, entry: { type: descriptor.type, value: 1, timeUs: 1_000_000, cycle: 60 } });
    const batch = encoder.flush();
    await logs.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 1_000_000, bytes: batch.bytes });
    await logs.finalize(session.id);

    const inspected = await inspectReplay(logs, session.id, { timeUs: 800_000, paths: ["simulation.**"], eventWindowUs: 100_000 });
    assert.equal(inspected.state["simulation.time"], 0);
    assert.equal(inspected.events[0].name, "pause");
    const series = await readReplaySeries(logs, session.id, { path: "simulation.time", maxSamples: 2 });
    assert.deepEqual(series.samples.map((sample) => sample.value), [0, 1]);
    assert.equal(series.descriptor.unit, "s");
});

test("logging MCP suite registers catalog, recording, and replay capabilities", () => {
    const tools = [];
    const resources = [];
    const server = {
        registerTool(name) { tools.push(name); },
        registerResource(name) { resources.push(name); },
    };
    registerLoggingTools(server, {});
    assert.deepEqual(tools, [
        "log_list",
        "log_get",
        "log_update",
        "log_delete",
        "recording_status",
        "recording_start",
        "recording_stop",
        "replay_open",
        "replay_control",
        "replay_inspect",
        "replay_series",
    ]);
    assert.deepEqual(resources, ["simulation-log-catalog", "simulation-log"]);
});

test("run manifest MCP suite exposes catalog, lifecycle, portable, and launch capabilities", () => {
    const tools = [];
    const resources = [];
    const server = {
        registerTool(name) { tools.push(name); },
        registerResource(name) { resources.push(name); },
    };
    registerRunManifestTools(server, {});
    assert.deepEqual(tools, [
        "run_manifest_list",
        "run_manifest_get",
        "run_manifest_create",
        "run_manifest_update",
        "run_manifest_duplicate",
        "run_manifest_delete",
        "run_manifest_validate",
        "run_manifest_resolve",
        "run_manifest_export",
        "run_manifest_import",
        "run_manifest_launch",
    ]);
    assert.deepEqual(resources, ["run-manifest-catalog", "run-manifest"]);
});

test("run manifest MCP tools preserve descriptions, enforce revisions, and publish launch", async () => {
    await withTempStorage(async (storage) => {
        const tools = new Map();
        const server = {
            registerTool(name, _definition, handler) { tools.set(name, handler); },
            registerResource() {},
        };
        registerRunManifestTools(server, storage);

        const events = [];
        const onChange = (event) => {
            if (event.domain === "run-manifest") events.push(event);
        };
        storageEvents.on("change", onChange);
        try {
            const createdResult = await tools.get("run_manifest_create")({
                manifest: createDefaultRunManifest({
                    id: "mcp-run",
                    name: "MCP Run",
                    description: "A description containing spaces",
                }),
            });
            const created = JSON.parse(createdResult.content[0].text).manifest;
            assert.equal(created.description, "A description containing spaces");
            assert.equal(created.revision, 1);

            const updateResult = await tools.get("run_manifest_update")({
                manifestId: created.id,
                expectedRevision: created.revision,
                manifest: { ...created, description: "An updated multi word description" },
            });
            const updated = JSON.parse(updateResult.content[0].text).manifest;
            assert.equal(updated.description, "An updated multi word description");
            assert.equal(updated.revision, 2);

            const validationResult = await tools.get("run_manifest_validate")({ manifestId: created.id });
            assert.equal(JSON.parse(validationResult.content[0].text).ok, true);

            const launchResult = await tools.get("run_manifest_launch")({ manifestId: created.id });
            const launch = JSON.parse(launchResult.content[0].text);
            assert.equal(launch.ok, true);
            assert.equal(launch.browserRequiredForLaunch, true);
            assert.equal(launch.resolvedHash.length, 64);
            assert.equal(events.at(-1).action, "launch");
            assert.equal(events.at(-1).data.autoplay, false);
        } finally {
            storageEvents.off("change", onChange);
        }
    });
});

test("EnvironmentDocument round-trip after MCP-style save", async () => {
    await withTempStorage(async (storage) => {
        await storage.createEnvironment({ id: "blank-a", name: "Blank", templateId: "blank" });
        const { manifest, document } = await loadDocument(storage, "blank-a");
        const a = getOrCreateNode(document, { x: 1, z: 1 });
        const b = getOrCreateNode(document, { x: 11, z: 1 });
        addRoadEdge(document, a.id, b.id);
        await saveDocument(storage, "blank-a", manifest, document);

        const again = await loadDocument(storage, "blank-a");
        assert.equal(again.document.roads.edges.length, 1);
        assert.ok(again.document instanceof EnvironmentDocument);
    });
});
