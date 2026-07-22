import { z } from "zod";
import {
    createDocumentId,
    createEmptyGraph,
    createScriptDocument,
    nowIso,
    normalizeDocumentName,
    summarizeScriptDocument,
} from "../../app/scripting/EditorDocument.js";
import { normalizeOutputNodeState } from "../../app/scripting/units/program/ProgramTypes.js";
import { storageEvents } from "./events.js";
import { fail, ok, selfFetchJson } from "./toolResult.js";

const DEFAULT_HEAD_UUID = "head-uuid";

function resolveHeadUuid(graph) {
    return graph?.head || DEFAULT_HEAD_UUID;
}

function getOutputNodePorts(graph) {
    return normalizeOutputNodeState(graph?.outputNodeConfig || {}).outputs;
}

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("../storage/StorageService.js").StorageService} storage
 */
export function registerScriptingTools(server, storage) {
    server.registerTool(
        "script_list",
        {
            title: "List scripts",
            description: "List all visual script documents with compile status summaries.",
            inputSchema: {},
        },
        async () => {
            try {
                const documents = await storage.listScripts();
                return ok({
                    ok: true,
                    scripts: documents.map((doc) => summarizeScriptDocument(doc)),
                });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_create",
        {
            title: "Create script",
            description: "Create a new empty editable visual script document.",
            inputSchema: {
                name: z.string().optional(),
                id: z.string().optional(),
            },
        },
        async ({ name, id }) => {
            try {
                const document = createScriptDocument({
                    id: id || createDocumentId(),
                    name: name || "Untitled Script",
                    graph: createEmptyGraph(),
                });
                if (await storage.getScript(document.id)) {
                    throw new Error(`Script "${document.id}" already exists.`);
                }
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: document.id, action: "created" });
                return ok({ ok: true, script: summarizeScriptDocument(document) });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_rename",
        {
            title: "Rename script",
            description: "Rename a script document.",
            inputSchema: {
                scriptId: z.string().min(1),
                name: z.string().min(1),
            },
        },
        async ({ scriptId, name }) => {
            try {
                const document = await requireScript(storage, scriptId);
                document.name = normalizeDocumentName(name);
                document.updatedAt = nowIso();
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: scriptId, action: "renamed" });
                return ok({ ok: true, script: summarizeScriptDocument(document) });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_delete",
        {
            title: "Delete script",
            description: "Delete a script document.",
            inputSchema: {
                scriptId: z.string().min(1),
            },
        },
        async ({ scriptId }) => {
            try {
                await storage.deleteScript(scriptId);
                storageEvents.publish({ domain: "script", id: scriptId, action: "deleted" });
                return ok({ ok: true, deleted: scriptId });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_get",
        {
            title: "Get script",
            description: "Get a script summary, graph, compile status, and program interface.",
            inputSchema: {
                scriptId: z.string().min(1),
                includeGraph: z.boolean().optional().describe("Include full nodes/connections (default true)"),
            },
        },
        async ({ scriptId, includeGraph }) => {
            try {
                const document = await requireScript(storage, scriptId);
                const artifact = document.latestValidArtifact;
                return ok({
                    ok: true,
                    script: summarizeScriptDocument(document),
                    compileStatus: document.compileStatus,
                    interface: artifact?.interface ?? { inputs: [], outputs: [] },
                    graph: includeGraph === false
                        ? null
                        : {
                            head: document.graph?.head ?? DEFAULT_HEAD_UUID,
                            outputNodeConfig: normalizeOutputNodeState(
                                document.graph?.outputNodeConfig || {},
                            ),
                            nodeCount: document.graph?.nodes?.length ?? 0,
                            connectionCount: document.graph?.connections?.length ?? 0,
                            nodes: document.graph?.nodes ?? [],
                            connections: document.graph?.connections ?? [],
                        },
                });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "unit_catalog",
        {
            title: "Unit catalog",
            description:
                "Enumerate all visual-script unit types with categories and ports. "
                + "OutputNode is listed with placeable=false — it is the graph head, not added via script_add_unit.",
            inputSchema: {},
        },
        async () => {
            try {
                const catalog = await selfFetchJson("/api/scripting/units");
                return ok({ ok: true, units: catalog.units ?? catalog });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "unit_describe",
        {
            title: "Describe unit type",
            description: "Full detail for one unit type: ports, settings, program I/O roles.",
            inputSchema: {
                type: z.string().min(1).describe("Registered block type name, e.g. NumberUnitClass"),
            },
        },
        async ({ type }) => {
            try {
                const catalog = await selfFetchJson("/api/scripting/units");
                const units = catalog.units ?? [];
                const unit = units.find((entry) => entry.type === type);
                if (!unit) {
                    return fail(`Unknown unit type "${type}". Use unit_catalog to list types.`);
                }
                return ok({ ok: true, unit });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_add_unit",
        {
            title: "Add unit to script",
            description:
                "Add a unit/node to a script graph. OutputNode is the graph head — configure it with script_update_unit on the head uuid instead of adding it.",
            inputSchema: {
                scriptId: z.string().min(1),
                type: z.string().min(1),
                x: z.number().optional(),
                y: z.number().optional(),
                storedData: z.any().optional().describe("Initial stored data / constant value"),
                state: z.record(z.any()).optional().describe("Initial serialized block state"),
                uuid: z.string().optional(),
            },
        },
        async ({ scriptId, type, x, y, storedData, state, uuid }) => {
            try {
                const document = await requireEditableScript(storage, scriptId);
                ensureGraph(document);

                // Soft-check type exists when the units API is reachable.
                try {
                    const catalog = await selfFetchJson("/api/scripting/units");
                    const meta = (catalog.units ?? []).find((entry) => entry.type === type);
                    if (!meta) {
                        return fail(`Unknown unit type "${type}". Use unit_catalog to list types.`);
                    }
                    if (meta.placeable === false) {
                        return fail(
                            `Unit type "${type}" is not placeable. `
                            + (meta.notes || "Configure the graph head OutputNode via script_update_unit."),
                        );
                    }
                } catch {
                    // Units API may be unavailable during early boot; allow add and rely on lint.
                    if (type === "OutputNodeBlock" || type === "ProgramOutputBlock") {
                        return fail(
                            `Unit type "${type}" is not placeable. `
                            + "Configure the graph head OutputNode via script_update_unit on the head uuid.",
                        );
                    }
                }

                const node = {
                    uuid: uuid || createUnitId(),
                    type,
                    state: state ?? null,
                    storedData: storedData === undefined ? null : storedData,
                    runtimeState: null,
                    position: { x: x ?? 0, y: y ?? 0 },
                };
                document.graph.nodes.push(node);
                document.updatedAt = nowIso();
                document.compileStatus = {
                    ...document.compileStatus,
                    valid: false,
                    error: "Graph changed; run script_lint to recompile.",
                };
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: scriptId, action: "updated" });
                return ok({ ok: true, node });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_update_unit",
        {
            title: "Update unit settings",
            description:
                "Update a unit's storedData, state, and/or position. "
                + "Pass the graph head uuid (default head-uuid) to update OutputNode ports via storedData/state shaped as { outputs: [{ id, label, type }] }.",
            inputSchema: {
                scriptId: z.string().min(1),
                uuid: z.string().min(1),
                storedData: z.any().optional(),
                state: z.record(z.any()).optional(),
                x: z.number().optional(),
                y: z.number().optional(),
            },
        },
        async ({ scriptId, uuid, storedData, state, x, y }) => {
            try {
                const document = await requireEditableScript(storage, scriptId);
                ensureGraph(document);
                const headUuid = resolveHeadUuid(document.graph);

                if (uuid === headUuid) {
                    const patch = storedData !== undefined
                        ? storedData
                        : (state !== undefined ? state : null);
                    if (patch !== null) {
                        document.graph.outputNodeConfig = normalizeOutputNodeState(patch);
                    }
                    if (x !== undefined || y !== undefined) {
                        document.graph.headPosition = {
                            x: x ?? document.graph.headPosition?.x ?? 0,
                            y: y ?? document.graph.headPosition?.y ?? 0,
                        };
                    }
                    document.updatedAt = nowIso();
                    document.compileStatus = {
                        ...document.compileStatus,
                        valid: false,
                        error: "Graph changed; run script_lint to recompile.",
                    };
                    await storage.putScript(document);
                    storageEvents.publish({ domain: "script", id: scriptId, action: "updated" });
                    return ok({
                        ok: true,
                        node: {
                            uuid: headUuid,
                            type: "OutputNodeBlock",
                            state: document.graph.outputNodeConfig,
                            storedData: document.graph.outputNodeConfig,
                            position: document.graph.headPosition || null,
                        },
                    });
                }

                const node = document.graph.nodes.find((entry) => entry.uuid === uuid);
                if (!node) return fail(`Unit "${uuid}" not found.`);

                if (storedData !== undefined) node.storedData = storedData;
                if (state !== undefined) node.state = { ...(node.state || {}), ...state };
                if (x !== undefined || y !== undefined) {
                    node.position = {
                        x: x ?? node.position?.x ?? 0,
                        y: y ?? node.position?.y ?? 0,
                    };
                }
                document.updatedAt = nowIso();
                document.compileStatus = {
                    ...document.compileStatus,
                    valid: false,
                    error: "Graph changed; run script_lint to recompile.",
                };
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: scriptId, action: "updated" });
                return ok({ ok: true, node });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_remove_unit",
        {
            title: "Remove unit",
            description: "Remove a unit and all connections attached to it.",
            inputSchema: {
                scriptId: z.string().min(1),
                uuid: z.string().min(1),
            },
        },
        async ({ scriptId, uuid }) => {
            try {
                const document = await requireEditableScript(storage, scriptId);
                ensureGraph(document);
                const headUuid = resolveHeadUuid(document.graph);
                if (uuid === headUuid) {
                    return fail(`Cannot remove the graph head OutputNode ("${headUuid}").`);
                }
                const before = document.graph.nodes.length;
                document.graph.nodes = document.graph.nodes.filter((node) => node.uuid !== uuid);
                if (document.graph.nodes.length === before) {
                    return fail(`Unit "${uuid}" not found.`);
                }
                document.graph.connections = document.graph.connections.filter(
                    (connection) => connection.from !== uuid && connection.to !== uuid,
                );
                document.updatedAt = nowIso();
                document.compileStatus = {
                    ...document.compileStatus,
                    valid: false,
                    error: "Graph changed; run script_lint to recompile.",
                };
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: scriptId, action: "updated" });
                return ok({ ok: true, removed: uuid });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_connect",
        {
            title: "Connect units",
            description:
                "Wire an output port of one unit to an input port of another. Port types must match. "
                + "Connect to the graph head OutputNode with to=head uuid (default head-uuid) and input=output port id.",
            inputSchema: {
                scriptId: z.string().min(1),
                from: z.string().min(1).describe("Source unit uuid"),
                output: z.string().min(1).describe("Source output port name"),
                to: z.string().min(1).describe("Target unit uuid (use head-uuid for OutputNode)"),
                input: z.string().min(1).describe("Target input port name"),
            },
        },
        async ({ scriptId, from, output, to, input }) => {
            try {
                const document = await requireEditableScript(storage, scriptId);
                ensureGraph(document);
                const headUuid = resolveHeadUuid(document.graph);
                const fromNode = document.graph.nodes.find((node) => node.uuid === from);
                const toNode = document.graph.nodes.find((node) => node.uuid === to);
                const targetingHead = to === headUuid;
                if (!fromNode) return fail(`Source unit "${from}" not found.`);
                if (!toNode && !targetingHead) return fail(`Target unit "${to}" not found.`);

                let portType = "any";
                try {
                    const catalog = await selfFetchJson("/api/scripting/units");
                    const fromMeta = (catalog.units ?? []).find((entry) => entry.type === fromNode.type);
                    const outPort = fromMeta?.outputs?.find((port) => port.name === output);
                    if (!outPort) {
                        return fail(
                            `Output port "${output}" not found on type "${fromNode.type}". `
                            + `Available: ${(fromMeta?.outputs ?? []).map((p) => p.name).join(", ") || "(none)"}`,
                        );
                    }

                    let inPort = null;
                    if (targetingHead) {
                        const headPorts = getOutputNodePorts(document.graph);
                        const headPort = headPorts.find((port) => port.id === input || port.label === input);
                        if (!headPort) {
                            return fail(
                                `Input port "${input}" not found on OutputNode (head "${headUuid}"). `
                                + `Available: ${headPorts.map((p) => p.id).join(", ") || "(none)"}. `
                                + "Configure ports with script_update_unit on the head uuid.",
                            );
                        }
                        inPort = { name: headPort.id, type: headPort.type };
                    } else {
                        const toMeta = (catalog.units ?? []).find((entry) => entry.type === toNode.type);
                        inPort = toMeta?.inputs?.find((port) => port.name === input) || null;
                        if (!inPort) {
                            return fail(
                                `Input port "${input}" not found on type "${toNode.type}". `
                                + `Available: ${(toMeta?.inputs ?? []).map((p) => p.name).join(", ") || "(none)"}`,
                            );
                        }
                    }

                    if (outPort.type !== inPort.type) {
                        return fail(
                            `Port type mismatch: ${fromNode.type}.${output} (${outPort.type}) `
                            + `→ ${(targetingHead ? "OutputNodeBlock" : toNode.type)}.${input} (${inPort.type}).`,
                        );
                    }
                    portType = outPort.type;
                } catch {
                    // Fall through — lint will catch type errors.
                }

                const duplicate = document.graph.connections.some(
                    (connection) => connection.to === to && connection.input === input,
                );
                if (duplicate) {
                    return fail(`Input "${input}" on unit "${to}" already has a connection.`);
                }

                const connection = { from, output, to, input, type: portType };
                document.graph.connections.push(connection);
                document.updatedAt = nowIso();
                document.compileStatus = {
                    ...document.compileStatus,
                    valid: false,
                    error: "Graph changed; run script_lint to recompile.",
                };
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: scriptId, action: "updated" });
                return ok({ ok: true, connection });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_disconnect",
        {
            title: "Disconnect units",
            description: "Remove a connection between two unit ports.",
            inputSchema: {
                scriptId: z.string().min(1),
                from: z.string().min(1),
                output: z.string().min(1),
                to: z.string().min(1),
                input: z.string().min(1),
            },
        },
        async ({ scriptId, from, output, to, input }) => {
            try {
                const document = await requireEditableScript(storage, scriptId);
                ensureGraph(document);
                const before = document.graph.connections.length;
                document.graph.connections = document.graph.connections.filter(
                    (connection) => !(
                        connection.from === from
                        && connection.output === output
                        && connection.to === to
                        && connection.input === input
                    ),
                );
                if (document.graph.connections.length === before) {
                    return fail("Connection not found.");
                }
                document.updatedAt = nowIso();
                document.compileStatus = {
                    ...document.compileStatus,
                    valid: false,
                    error: "Graph changed; run script_lint to recompile.",
                };
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: scriptId, action: "updated" });
                return ok({ ok: true, disconnected: { from, output, to, input } });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "script_lint",
        {
            title: "Lint / compile script",
            description:
                "Compile the script graph. On success persists latestValidArtifact; on failure returns the compiler error.",
            inputSchema: {
                scriptId: z.string().min(1),
            },
        },
        async ({ scriptId }) => {
            try {
                const document = await requireEditableScript(storage, scriptId);
                if (!document.graph) {
                    return fail("Script has no editable graph.");
                }

                const result = await selfFetchJson("/api/scripting/compile", {
                    method: "POST",
                    body: { graph: document.graph, name: document.name },
                });

                if (!result.ok) {
                    document.compileStatus = {
                        valid: false,
                        error: result.error || "Compile failed.",
                        artifactUpdatedAt: document.compileStatus?.artifactUpdatedAt ?? null,
                    };
                    document.updatedAt = nowIso();
                    await storage.putScript(document);
                    storageEvents.publish({ domain: "script", id: scriptId, action: "lint-failed" });
                    return ok({
                        ok: false,
                        valid: false,
                        error: result.error,
                        compileStatus: document.compileStatus,
                    });
                }

                document.latestValidArtifact = result.artifact;
                document.compileStatus = {
                    valid: true,
                    error: null,
                    artifactUpdatedAt: nowIso(),
                };
                document.updatedAt = nowIso();
                await storage.putScript(document);
                storageEvents.publish({ domain: "script", id: scriptId, action: "compiled" });
                return ok({
                    ok: true,
                    valid: true,
                    interface: result.artifact?.interface ?? null,
                    compileStatus: document.compileStatus,
                });
            } catch (error) {
                return fail(error);
            }
        },
    );
}

async function requireScript(storage, scriptId) {
    const document = await storage.getScript(scriptId);
    if (!document) throw new Error(`Script "${scriptId}" not found.`);
    return document;
}

async function requireEditableScript(storage, scriptId) {
    const document = await requireScript(storage, scriptId);
    if (document.editable === false || document.sourceType === "artifact") {
        throw new Error(`Script "${scriptId}" is artifact-only and cannot be edited as a graph.`);
    }
    return document;
}

function ensureGraph(document) {
    if (!document.graph) {
        document.graph = createEmptyGraph();
    }
    if (!Array.isArray(document.graph.nodes)) document.graph.nodes = [];
    if (!Array.isArray(document.graph.connections)) document.graph.connections = [];
    if (!document.graph.head) document.graph.head = DEFAULT_HEAD_UUID;
    if (!document.graph.outputNodeConfig) {
        document.graph.outputNodeConfig = normalizeOutputNodeState({});
    }
}

function createUnitId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `unit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
