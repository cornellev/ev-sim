import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDocument, registerEnvironmentTools, saveDocument } from "../server/mcp/environmentTools.js";
import { StorageService } from "../server/storage/StorageService.js";
import { buildPropsAlongRoadDocument } from "../app/3d/editor/scripts/propsAlongRoadTemplate.js";

function mcpTools(storage) {
    const tools = new Map();
    registerEnvironmentTools({ registerTool(name, _definition, handler) { tools.set(name, handler); } }, storage);
    return (name, args) => tools.get(name)(args).then((result) => ({
        ...JSON.parse(result.content[0].text),
        isError: result.isError === true,
    }));
}

test("MCP attaches a road script, parents a prop, and runs permanent barrels", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-object-script-"));
    const storage = new StorageService(dir);
    try {
        const call = mcpTools(storage);
        await storage.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        const road = await call("environment_add_road", {
            environmentId: "yard",
            points: [{ x: 0, z: 0 }, { x: 30, z: 0 }],
        });
        assert.equal(road.ok, true, road.error);
        const edgeId = road.createdEdges[0].id;

        const loaded = await loadDocument(storage, "yard");
        const group = loaded.service.run("createObject", { typeId: "group", name: "Shoulder" });
        assert.equal(group.ok, true, JSON.stringify(group.issues));
        await saveDocument(storage, "yard", loaded.manifest, loaded.document);

        const script = buildPropsAlongRoadDocument();
        await storage.putScript(script);
        const attached = await call("environment_attach_script", {
            environmentId: "yard",
            objectId: edgeId,
            scriptId: script.id,
            parameters: { count: 2, sideOffset: 2, assetId: "barrel", group: group.result.objectId },
        });
        assert.equal(attached.ok, true, attached.error);
        const ran = await call("environment_run_object_script", {
            environmentId: "yard",
            objectId: edgeId,
            attachmentId: attached.attachmentId,
        });
        assert.equal(ran.ok, true, ran.error);
        const saved = await storage.getEnvironment("yard");
        const subgroup = saved.document.objects.find((record) => record.name === "Barrels");
        assert.equal(subgroup.parentId, group.result.objectId);
        const barrels = saved.document.objects.filter((record) => record.parentId === subgroup.id);
        assert.equal(barrels.length, 4);
        assert.ok(barrels.every((record) => saved.document.features.find((feature) => feature.id === record.id)?.type === "barrel"));

        const parented = await call("environment_add_object", {
            environmentId: "yard",
            type: "cone",
            x: 3,
            z: 4,
            parentId: group.result.objectId,
        });
        assert.equal(parented.ok, true, parented.error);
        const withCone = await storage.getEnvironment("yard");
        assert.equal(withCone.document.objects.find((record) => record.id === parented.feature.id).parentId, group.result.objectId);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
