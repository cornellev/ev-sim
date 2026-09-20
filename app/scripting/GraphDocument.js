import { ScriptManager } from "./ScriptManager.js";
import { normalizeOutputNodeState } from "./units/program/ProgramTypes.js";
import { recomputeBindings } from "./types/unifyGraph.js";
import { normalizeCanvasViewport } from "./canvas/CanvasViewport.js";

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function makeConnectionKey(connection) {
    return [
        connection.from,
        connection.output,
        connection.to,
        connection.input
    ].join("|");
}

export function formatRestoreErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return null;

    return errors.map(({ connection, error }) => {
        const edge = connection
            ? `${connection.from}.${connection.output} -> ${connection.to}.${connection.input}`
            : "connection";
        const message = error || `Cannot restore ${edge}.`;
        return `${message} Rewire this connection manually.`;
    }).join(" ");
}

export function mergeUnrestoredConnections(liveConnections = [], restoreErrors = []) {
    const connections = [...liveConnections];
    const seen = new Set(connections.map((connection) => makeConnectionKey(connection)));

    restoreErrors.forEach(({ connection }) => {
        if (!connection) return;
        const key = makeConnectionKey(connection);
        if (seen.has(key)) return;
        seen.add(key);
        connections.push({ ...connection });
    });

    return connections;
}

export function pruneRestoreErrors(manager) {
    if (!manager || typeof manager.pruneRestoreErrors !== "function") {
        return manager?.restoreErrors || [];
    }
    return manager.pruneRestoreErrors();
}

export function serializeManagerGraph(manager, {
    outputNodeConfig = null,
    positions = {},
    headUUID = "head-uuid",
    viewport = null
} = {}) {
    const connections = [];
    const seenConnections = new Set();

    manager.units.forEach((unit) => {
        Object.entries(unit.outputs || {}).forEach(([outputLabel, outputConnections]) => {
            outputConnections.forEach((connection) => {
                const input = connection.getInput();
                const output = connection.getOutput();
                const edge = {
                    from: output.unit.uuid,
                    output: output.label || outputLabel,
                    to: input.unit.uuid,
                    input: input.label,
                    type: output.unit.outputType(output.label)
                };
                const key = makeConnectionKey(edge);
                if (seenConnections.has(key)) return;

                seenConnections.add(key);
                connections.push(edge);
            });
        });
    });

    const nodes = manager.units
        .filter((unit) => unit.uuid !== headUUID)
        .map((unit) => {
            const node = {
                uuid: unit.uuid,
                type: unit.typeId(),
                state: cloneJson(unit.serializeState()),
                storedData: cloneJson(manager.getStoredData(unit.uuid)),
                runtimeState: cloneJson(unit.serializeRuntimeState()),
                position: positions[unit.uuid] || null
            };
            if (unit.typeBindings && Object.keys(unit.typeBindings).length > 0) {
                node.typeBindings = cloneJson(unit.typeBindings);
            }
            return node;
        });

    return {
        head: manager.head || headUUID,
        headPosition: cloneJson(positions[headUUID] || null),
        outputNodeConfig: cloneJson(outputNodeConfig),
        nodes,
        connections,
        viewport: normalizeCanvasViewport(viewport),
        ...(manager.pluginLocks?.length ? { pluginLocks: cloneJson(manager.pluginLocks) } : {})
    };
}

export function restoreManagerFromGraph(graph, getBlockClass, {
    createManager = () => new ScriptManager(),
    headUnit = null,
    headUUID = "head-uuid",
    onMissingBlock = null
} = {}) {
    const manager = createManager();
    manager.pluginLocks = cloneJson(graph?.pluginLocks ?? []);
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const resolvedHeadUUID = graph?.head || headUUID;
    const headInNodes = nodes.some((node) => node.uuid === resolvedHeadUUID);

    if (headUnit) {
        manager.addUnit(headUnit);
        manager.setHead(resolvedHeadUUID);
    } else if (!headInNodes) {
        const OutputNodeClass = typeof getBlockClass === "function"
            ? getBlockClass("OutputNodeBlock")
            : null;
        if (OutputNodeClass) {
            const unit = new OutputNodeClass(resolvedHeadUUID);
            const config = normalizeOutputNodeState(graph?.outputNodeConfig || {});
            unit.hydrateState(config);
            manager.addUnit(unit);
            manager.storeData(resolvedHeadUUID, config);
            manager.setHead(resolvedHeadUUID);
        }
    } else if (graph?.head) {
        manager.setHead(graph.head);
    }

    nodes.forEach((node) => {
        const BlockClass = getBlockClass(node.type);
        if (!BlockClass) {
            if (onMissingBlock) onMissingBlock(node);
            return;
        }

        const block = new BlockClass(node.uuid);
        if (node.state) block.hydrateState(node.state);
        manager.addUnit(block);

        if (node.storedData !== undefined) {
            manager.storeData(node.uuid, node.storedData);
            block.reregister();
        }

        if (node.runtimeState && typeof block.hydrateRuntimeState === "function") {
            block.hydrateRuntimeState(node.runtimeState);
        }
    });

    const connections = Array.isArray(graph?.connections) ? graph.connections : [];
    manager.restoreErrors = [];
    connections.forEach((connection) => {
        const result = manager.connectUnitsDetailed(
            connection.from,
            connection.output,
            connection.to,
            connection.input
        );
        if (!result.ok) {
            manager.restoreErrors.push({
                connection: {
                    from: connection.from,
                    output: connection.output,
                    to: connection.to,
                    input: connection.input,
                    type: connection.type
                },
                error: result.error
            });
        }
    });
    recomputeBindings(manager);

    return manager;
}

export function mutateGraphConnections(graph, getBlockClass, mutate, extras = {}) {
    const headUUID = graph?.head || extras.headUUID || "head-uuid";
    const positions = {
        [headUUID]: graph?.headPosition || null,
        ...Object.fromEntries((graph?.nodes || []).map((node) => [node.uuid, node.position || null]))
    };
    const manager = restoreManagerFromGraph(graph, getBlockClass, {
        headUUID,
        ...extras
    });
    const result = mutate(manager) || { ok: false, error: "Graph mutation failed." };
    if (result.ok === false) return result;

    pruneRestoreErrors(manager);
    const nextGraph = serializeManagerGraph(manager, {
        outputNodeConfig: graph?.outputNodeConfig ?? extras.outputNodeConfig ?? null,
        positions,
        headUUID,
        viewport: graph?.viewport
    });
    nextGraph.connections = mergeUnrestoredConnections(nextGraph.connections, manager.restoreErrors);

    return {
        ok: true,
        graph: nextGraph,
        ...result
    };
}

export function reconfigureGraphUnit(graph, getBlockClass, uuid, patch = {}, extras = {}) {
    const headUUID = graph?.head || extras.headUUID || "head-uuid";
    const positions = {
        [headUUID]: cloneJson(graph?.headPosition || null),
        ...Object.fromEntries((graph?.nodes || []).map((node) => [node.uuid, cloneJson(node.position || null)]))
    };
    const manager = restoreManagerFromGraph(graph, getBlockClass, {
        headUUID,
        ...extras
    });
    const unit = manager.units.find((candidate) => candidate.uuid === uuid);
    if (!unit) return { ok: false, error: `Unit "${uuid}" not found.` };

    const configuration = {};
    if (Object.prototype.hasOwnProperty.call(patch, "state")) configuration.state = patch.state;
    if (Object.prototype.hasOwnProperty.call(patch, "storedData")) configuration.storedData = patch.storedData;

    const result = manager.reconfigureUnitDetailed(uuid, configuration);
    if (!result.ok) return result;

    if (patch.position) positions[uuid] = cloneJson(patch.position);
    pruneRestoreErrors(manager);

    const headUnit = manager.units.find((candidate) => candidate.uuid === headUUID);
    const outputNodeConfig = headUnit
        ? normalizeOutputNodeState(headUnit.serializeState())
        : normalizeOutputNodeState(graph?.outputNodeConfig || {});
    const nextGraph = serializeManagerGraph(manager, {
        outputNodeConfig,
        positions,
        headUUID,
        viewport: graph?.viewport
    });
    nextGraph.connections = mergeUnrestoredConnections(nextGraph.connections, manager.restoreErrors);

    const node = uuid === headUUID
        ? {
            uuid,
            type: "OutputNodeBlock",
            state: cloneJson(outputNodeConfig),
            storedData: cloneJson(outputNodeConfig),
            position: cloneJson(positions[uuid] || null)
        }
        : nextGraph.nodes.find((candidate) => candidate.uuid === uuid) || null;

    return { ok: true, error: null, graph: nextGraph, node };
}

export function getGraphScriptReferences(graph) {
    if (!graph || !Array.isArray(graph.nodes)) return [];

    return graph.nodes
        .map((node) => node?.state?.sourceScriptId)
        .filter(Boolean);
}

export function documentReferencesScript(document, targetScriptId, documentsById, visited = new Set()) {
    if (!document || !targetScriptId || visited.has(document.id)) return false;
    visited.add(document.id);

    const directReferences = getGraphScriptReferences(document.graph);
    if (directReferences.includes(targetScriptId)) return true;

    return directReferences.some((referenceId) => (
        documentReferencesScript(documentsById.get(referenceId), targetScriptId, documentsById, visited)
    ));
}

export function wouldCreateScriptReferenceCycle(currentScriptId, sourceScriptId, documents) {
    if (!currentScriptId || !sourceScriptId) return false;
    if (currentScriptId === sourceScriptId) return true;

    const documentsById = documents instanceof Map
        ? documents
        : new Map((documents || []).map((document) => [document.id, document]));

    return documentReferencesScript(documentsById.get(sourceScriptId), currentScriptId, documentsById);
}
