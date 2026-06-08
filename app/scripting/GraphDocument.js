import { ScriptManager } from "./ScriptManager.js";

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

export function serializeManagerGraph(manager, {
    outputNodeConfig = null,
    positions = {},
    headUUID = "head-uuid"
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
        .map((unit) => ({
            uuid: unit.uuid,
            type: unit.typeId(),
            state: cloneJson(unit.serializeState()),
            storedData: cloneJson(manager.getStoredData(unit.uuid)),
            runtimeState: cloneJson(unit.serializeRuntimeState()),
            position: positions[unit.uuid] || null
        }));

    return {
        head: manager.head || headUUID,
        headPosition: cloneJson(positions[headUUID] || null),
        outputNodeConfig: cloneJson(outputNodeConfig),
        nodes,
        connections
    };
}

export function restoreManagerFromGraph(graph, getBlockClass, {
    createManager = () => new ScriptManager(),
    headUnit = null,
    headUUID = "head-uuid",
    onMissingBlock = null
} = {}) {
    const manager = createManager();
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];

    if (headUnit) {
        manager.addUnit(headUnit);
        manager.setHead(headUUID);
    } else if (graph?.head && nodes.some((node) => node.uuid === graph.head)) {
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
        }

        if (node.runtimeState && typeof block.hydrateRuntimeState === "function") {
            block.hydrateRuntimeState(node.runtimeState);
        }
    });

    const connections = Array.isArray(graph?.connections) ? graph.connections : [];
    connections.forEach((connection) => {
        manager.connectUnits(connection.from, connection.output, connection.to, connection.input);
    });

    return manager;
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
