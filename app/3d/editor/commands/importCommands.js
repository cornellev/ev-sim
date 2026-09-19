import { ensureRoadGeometryV2 } from "./roadCommands.js";
import { COMMAND_ISSUE_CODES, commandFailure, commandIssue, commandSuccess } from "./commandIssues.js";
import { hydrateDocumentFromRuntime } from "../document/documentRuntimeHydration.js";

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function sourceImportId(draft) {
    const explicit = String(draft?.importId ?? "").trim();
    if (explicit) return explicit;
    const node = draft?.roads?.nodes?.find((entry) => entry?.source?.importId);
    const edge = draft?.roads?.edges?.find((entry) => entry?.source?.importId);
    return String(node?.source?.importId ?? edge?.source?.importId ?? "road-import");
}

function namespaceDraftRoads(draft, existingNodeIds, existingEdgeIds) {
    const imported = clone(draft?.roads ?? { geometryVersion: 2, nodes: [], edges: [], turnRules: [] });
    const prefix = `import:${sourceImportId(draft)}:`;
    const nodeMap = new Map();
    for (const node of imported.nodes ?? []) {
        const original = String(node.id);
        let next = original.startsWith(prefix) ? original : `${prefix}${original}`;
        let suffix = 2;
        while (existingNodeIds.has(next)) next = `${prefix}${original}:${suffix++}`;
        nodeMap.set(original, next);
        existingNodeIds.add(next);
        node.id = next;
    }
    const edgeMap = new Map();
    for (const edge of imported.edges ?? []) {
        const original = String(edge.id);
        let next = original.startsWith(prefix) ? original : `${prefix}${original}`;
        let suffix = 2;
        while (existingEdgeIds.has(next)) next = `${prefix}${original}:${suffix++}`;
        edgeMap.set(original, next);
        existingEdgeIds.add(next);
        edge.id = next;
        edge.startNodeId = nodeMap.get(String(edge.startNodeId));
        edge.endNodeId = nodeMap.get(String(edge.endNodeId));
    }
    imported.turnRules = (imported.turnRules ?? []).map((rule) => ({
        ...rule,
        nodeId: nodeMap.get(String(rule.nodeId)),
        fromEdgeId: edgeMap.get(String(rule.fromEdgeId)),
        toEdgeId: edgeMap.get(String(rule.toEdgeId)),
    }));
    return imported;
}

function invalidIssues(draft) {
    return (draft?.issues ?? []).filter((entry) => entry?.severity === "error");
}

/** Import legacy runtime objects as one undoable editor transaction. */
export function hydrateRuntimeDocument({ data, label = "Import runtime content" } = {}) {
    return {
        id: "environment.hydrate-runtime",
        label,
        run(ctx) {
            const changed = hydrateDocumentFromRuntime(data, ctx.document, { notify: false });
            return commandSuccess({ changed });
        },
    };
}

/**
 * Apply a detached ED-08 road/source draft as one undoable change.
 * Preview code never receives the active document; this is its only commit seam.
 */
export function applyRoadImport({
    expectedDocumentVersion,
    draft = null,
    mode = "add",
    includeRoads = true,
    allowEmptyReplace = false,
    source,
    geoFrame,
} = {}) {
    return {
        id: "environment.apply-road-import",
        label: mode === "replace" ? "Replace roads from import" : "Add imported roads",
        run(ctx) {
            if (ctx.document.version !== expectedDocumentVersion) {
                return commandFailure(commandIssue(
                    COMMAND_ISSUE_CODES.DOCUMENT_STALE,
                    "The environment changed after this import preview was prepared. Preview it again before applying.",
                ));
            }
            if (mode !== "add" && mode !== "replace") {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Unknown road import mode "${mode}".`));
            }
            if (includeRoads) {
                const issues = invalidIssues(draft);
                if (issues.length > 0) return commandFailure(issues);
                if (!draft?.roads || !Array.isArray(draft.roads.nodes) || !Array.isArray(draft.roads.edges)) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "A completed road draft is required."));
                }
                if (mode === "replace" && draft.roads.edges.length === 0
                    && ctx.document.roads.edges.length > 0 && allowEmptyReplace !== true) {
                    return commandFailure(commandIssue(
                        COMMAND_ISSUE_CODES.ARGUMENT_INVALID,
                        "Replacing existing roads with an empty result requires explicit confirmation.",
                    ));
                }
            }

            let importedNodes = 0;
            let importedEdges = 0;
            let upgradedLegacyRoads = false;
            if (includeRoads) {
                importedNodes = draft.roads.nodes.length;
                importedEdges = draft.roads.edges.length;
                if (mode === "replace") {
                    ctx.document.roads = {
                        geometryVersion: 2,
                        nodes: clone(draft.roads.nodes),
                        edges: clone(draft.roads.edges),
                        turnRules: clone(draft.roads.turnRules ?? []),
                    };
                } else {
                    upgradedLegacyRoads = ensureRoadGeometryV2(ctx);
                    const incoming = namespaceDraftRoads(
                        draft,
                        new Set(ctx.document.roads.nodes.map((entry) => String(entry.id))),
                        new Set(ctx.document.roads.edges.map((entry) => String(entry.id))),
                    );
                    ctx.document.roads.nodes.push(...incoming.nodes);
                    ctx.document.roads.edges.push(...incoming.edges);
                    ctx.document.roads.turnRules ??= [];
                    ctx.document.roads.turnRules.push(...incoming.turnRules);
                }
                ctx.document.setScalar("roadsAuthored", true, { notify: false });
            }
            if (geoFrame !== undefined) ctx.document.setScalar("geoFrame", geoFrame, { notify: false });
            if (source !== undefined) ctx.document.setScalar("earth", source, { notify: false });
            return commandSuccess({
                mode,
                includeRoads: includeRoads === true,
                importedNodes,
                importedEdges,
                upgradedLegacyRoads,
            });
        },
    };
}
