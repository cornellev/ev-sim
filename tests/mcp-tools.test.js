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
import { storageEvents } from "../server/mcp/events.js";
import {
    loadDocument,
    saveDocument,
} from "../server/mcp/environmentTools.js";
import {
    getManifest,
    putManifest,
    checkScriptInterface,
} from "../server/mcp/bindingTools.js";
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
                kind: "sensor-fusion.visual-script.program",
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
            scriptId: "script-b",
            trigger: { kind: "fixed-update", everyN: 1 },
            inputs: [{ input: "speed", source: "sim", key: "dt" }],
            outputs: [{ output: "cmd", sink: "signal", path: "debug.cmd" }],
        });
        assert.deepEqual(validateBinding(binding), []);

        const manifest = createBindingManifest({ bindings: [binding] });
        await putManifest(storage, manifest);
        const loaded = await getManifest(storage);
        assert.equal(loaded.bindings.length, 1);
        assert.equal(loaded.bindings[0].scriptId, "script-b");
    });
});

test("storageEvents publishes MCP change payloads", async () => {
    const events = [];
    const onChange = (payload) => events.push(payload);
    storageEvents.on("change", onChange);
    try {
        storageEvents.publish({ domain: "environment", id: "yard", action: "updated" });
        assert.equal(events.length, 1);
        assert.equal(events[0].domain, "environment");
        assert.equal(events[0].id, "yard");
        assert.ok(events[0].at);
    } finally {
        storageEvents.off("change", onChange);
    }
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
