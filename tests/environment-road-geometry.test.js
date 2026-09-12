import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { assertNoRoadGeometryDowngrade, parseEnvironmentWriteEnvelope } from "../app/3d/environment/EnvironmentManifestPolicy.js";
import { StorageService } from "../server/storage/StorageService.js";
import { registerEnvironmentTools } from "../server/mcp/environmentTools.js";
import { hydrateDocumentFromRuntime } from "../app/3d/editor/document/documentRuntimeHydration.js";

function v2Document(environmentId = "yard") {
    const document = new EnvironmentDocument({ environmentId, roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 10, y: 2, z: 3 }, { x: 20, y: 4, z: 0 }] });
    return document.toManifest();
}

test("ED-04 snapshots and nested roadGeometryVersion history are lossless", () => {
    const source = v2Document("x");
    const document = EnvironmentDocument.fromManifest(source);
    const restored = new EnvironmentDocument();
    restored.restoreSnapshot(document.snapshot());
    assert.deepEqual(restored.toManifest(), source);
    restored.setScalar("roadGeometryVersion", null);
    assert.equal(Object.hasOwn(restored.roads, "geometryVersion"), false);
    const legacy = new EnvironmentDocument({ roads: { nodes: [], edges: [] } });
    assert.equal(Object.hasOwn(legacy.snapshot().roads, "geometryVersion"), false);
});

test("ED-04 write envelopes carry request-only capabilities and reject unaware replacement", () => {
    const current = { document: v2Document() };
    const incoming = { document: v2Document() };
    assert.deepEqual(parseEnvironmentWriteEnvelope({ manifest: incoming, expectedRevision: 1, supportedRoadGeometryVersions: [1, 2, 2] }).supportedRoadGeometryVersions, [1, 2]);
    assert.throws(() => assertNoRoadGeometryDowngrade(incoming, current, [1]), /must declare v2 support/);
    assert.doesNotThrow(() => assertNoRoadGeometryDowngrade({ name: "metadata only" }, current, []));
    assert.doesNotThrow(() => assertNoRoadGeometryDowngrade(incoming, current, [1, 2]));
});

test("ED-04 storage writes one pre-road-geometry backup and guards later old-client writes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed04-"));
    try {
        const storage = new StorageService(dir);
        const created = await storage.createEnvironment({ id: "yard", name: "Yard" });
        const upgraded = await storage.putEnvironment("yard", { manifest: { ...created, document: v2Document() }, expectedRevision: created.revision, supportedRoadGeometryVersions: [1, 2] });
        const backupPath = path.join(dir, "environment-migrations", "yard.pre-road-geometry-v2.json");
        const backup = JSON.parse(await fs.readFile(backupPath, "utf8"));
        assert.equal(backup.kind, "cev-sim.environment-pre-road-geometry");
        assert.equal(backup.manifest.revision, created.revision);
        await assert.rejects(() => storage.putEnvironment("yard", { manifest: { ...upgraded, name: "old" }, expectedRevision: upgraded.revision }), /must declare v2 support/);
        const saved = await storage.putEnvironment("yard", { manifest: { ...upgraded, name: "aware" }, expectedRevision: upgraded.revision, supportedRoadGeometryVersions: [1, 2] });
        assert.equal(saved.name, "aware");
        assert.equal(JSON.parse(await fs.readFile(backupPath, "utf8")).manifest.revision, created.revision);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("ED-04 MCP geometry arguments use the shared create and edit commands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed04-mcp-"));
    try {
        const storage = new StorageService(dir);
        await storage.createEnvironment({ id: "mcp-roads", name: "MCP roads", templateId: "blank" });
        const tools = new Map();
        registerEnvironmentTools({ registerTool(name, _definition, handler) { tools.set(name, handler); } }, storage);
        const addedResult = await tools.get("environment_add_road")({
            environmentId: "mcp-roads",
            points: [{ x: 0, z: 0 }, { x: 10, z: 4 }, { x: 20, z: 0 }],
            geometryKind: "cubic-bezier",
        });
        const added = JSON.parse(addedResult.content[0].text);
        assert.equal(added.ok, true);
        const edgeId = added.createdEdges[0].id;
        const editedResult = await tools.get("environment_edit_road")({
            environmentId: "mcp-roads",
            operation: "insert-knot",
            edgeId,
            at: { span: 0, u: 0.5 },
        });
        assert.equal(JSON.parse(editedResult.content[0].text).ok, true);
        const stored = await storage.getEnvironment("mcp-roads");
        assert.equal(stored.document.roads.geometryVersion, 2);
        assert.ok(stored.document.roads.edges[0].geometry.knots.length > 3);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("ED-04 runtime hydration cannot rewrite v2 authoring knots or derived node kinds", () => {
    const document = new EnvironmentDocument({
        ...v2Document("hydrate"),
        roads: {
            ...v2Document("hydrate").roads,
            nodes: [
                { id: "a", kind: "endpoint", x: 0, y: 0, z: 0 },
                { id: "b", kind: "endpoint", x: 10, y: 0, z: 0 },
                { id: "c", kind: "endpoint", x: 20, y: 0, z: 0 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2, geometry: { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] } },
                { id: "bc", startNodeId: "b", endNodeId: "c", width: 7, laneCount: 2, geometry: { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] } },
            ],
        },
    });
    const before = document.snapshot().roads;
    hydrateDocumentFromRuntime({ city: () => ({ getRoads: () => [], getIntersections: () => [] }) }, document);
    assert.deepEqual(document.snapshot().roads, before);
    assert.equal(document.getNode("b").kind, "endpoint");
});
