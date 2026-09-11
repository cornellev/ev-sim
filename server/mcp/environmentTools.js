import { z } from "zod";
import { EnvironmentDocument } from "../../app/3d/editor/document/EnvironmentDocument.js";
import {
    addBuildingRectangle,
    addFeature,
    addRoadEdge,
    getOrCreateNode,
    isIntersectionNode,
    moveFeature,
    moveRoadNode,
    removeBuilding,
    removeFeature,
    removeRoadEdge,
    setRoadNodeElevation,
} from "../../app/3d/editor/document/documentMutations.js";
import {
    conflictsForNewEntities,
    findDocumentConflicts,
} from "../../app/3d/editor/document/documentGeometry.js";
import { PLACEMENT_CATALOG, getPlacementAsset } from "../../app/3d/editor/placement/placementCatalogData.js";
import {
    listObjectTypes,
    objectTypeRegistry,
    reconcileObjectGraph,
    validateObjectGraph,
} from "../../app/3d/editor/objects/index.js";
import { environmentObjectTypeUnsupportedError } from "../storage/StorageErrors.js";
import { storageEvents } from "./events.js";
import { fail, maybeFailStrict, ok } from "./toolResult.js";

const ACTIVE_ENVIRONMENT_SETTING = "activeEnvironmentId";

const PointSchema = z.object({
    x: z.number(),
    y: z.number().optional(),
    z: z.number(),
});

/**
 * @param {import("../storage/StorageService.js").StorageService} storage
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerEnvironmentTools(server, storage) {
    server.registerTool(
        "environment_list",
        {
            title: "List environments",
            description: "List all saved and built-in environments.",
            inputSchema: {},
        },
        async () => {
            try {
                const environments = await storage.listEnvironments();
                const activeId = await storage.getSetting(ACTIVE_ENVIRONMENT_SETTING);
                return ok({ ok: true, activeEnvironmentId: activeId ?? "igvc", environments });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_create",
        {
            title: "Create environment",
            description: "Create a blank or IGVC-templated environment.",
            inputSchema: {
                id: z.string().min(1).describe("Stable environment id (slug)"),
                name: z.string().optional().describe("Display name"),
                templateId: z.enum(["blank", "igvc"]).optional().describe("Template to bootstrap from"),
            },
        },
        async ({ id, name, templateId }) => {
            try {
                const manifest = await storage.createEnvironment({
                    id,
                    name: name ?? id,
                    templateId: templateId ?? "blank",
                });
                storageEvents.publish({ domain: "environment", id, action: "created", revision: manifest.revision });
                return ok({ ok: true, environment: summarizeManifest(manifest) });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_rename",
        {
            title: "Rename environment",
            description: "Rename an environment.",
            inputSchema: {
                environmentId: z.string().min(1),
                name: z.string().min(1),
                expectedRevision: z.number().int().nonnegative(),
            },
        },
        async ({ environmentId, name, expectedRevision }) => {
            try {
                const manifest = await storage.renameEnvironment(environmentId, { name, expectedRevision });
                storageEvents.publish({
                    domain: "environment",
                    id: environmentId,
                    action: "renamed",
                    revision: manifest.revision,
                });
                return ok({ ok: true, environment: summarizeManifest(manifest) });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_delete",
        {
            title: "Delete environment",
            description: "Delete a saved environment (built-in IGVC cannot be deleted).",
            inputSchema: {
                environmentId: z.string().min(1),
                expectedRevision: z.number().int().nonnegative(),
            },
        },
        async ({ environmentId, expectedRevision }) => {
            try {
                await storage.deleteEnvironment(environmentId, expectedRevision);
                storageEvents.publish({ domain: "environment", id: environmentId, action: "deleted" });
                return ok({ ok: true, deleted: environmentId });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_get",
        {
            title: "Get environment",
            description: "Get an environment summary or full authored document.",
            inputSchema: {
                environmentId: z.string().min(1),
                full: z.boolean().optional().describe("If true, include the full document snapshot"),
            },
        },
        async ({ environmentId, full }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const snapshot = document.snapshot();
                if (full) {
                    return ok({
                        ok: true,
                        environment: summarizeManifest(manifest),
                        document: snapshot,
                    });
                }
                return ok({
                    ok: true,
                    environment: summarizeManifest(manifest),
                    counts: {
                        nodes: snapshot.roads.nodes.length,
                        edges: snapshot.roads.edges.length,
                        buildings: snapshot.buildings.length,
                        features: snapshot.features.length,
                    },
                    placementCatalog: PLACEMENT_CATALOG,
                    objectTypes: listObjectTypes().map(summarizeObjectType),
                });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_set_active",
        {
            title: "Set active environment",
            description: "Set which environment the browser app loads by default.",
            inputSchema: {
                environmentId: z.string().min(1),
            },
        },
        async ({ environmentId }) => {
            try {
                const environments = await storage.listEnvironments();
                if (!environments.some((entry) => entry.id === environmentId)) {
                    throw new Error(`Environment "${environmentId}" does not exist.`);
                }
                await storage.putSetting(ACTIVE_ENVIRONMENT_SETTING, environmentId);
                storageEvents.publish({ domain: "environment", id: environmentId, action: "active" });
                return ok({ ok: true, activeEnvironmentId: environmentId });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_add_road",
        {
            title: "Add road",
            description:
                "Add a road polyline (sequence of xz points, optional y elevation). Points snap to nearby nodes. Returns created nodes/edges and any geometric conflicts.",
            inputSchema: {
                environmentId: z.string().min(1),
                points: z.array(PointSchema).min(2).describe("Polyline points in world meters (x, optional y, z)"),
                width: z.number().positive().optional(),
                laneCount: z.number().int().positive().optional(),
                bidirectional: z.boolean().optional(),
                snapRadius: z.number().positive().optional(),
                strict: z.boolean().optional().describe("If true, reject when conflicts exist"),
            },
        },
        async ({ environmentId, points, width, laneCount, bidirectional, snapRadius, strict }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const createdNodes = [];
                const createdEdges = [];
                const errors = [];

                const nodeIds = points.map((point) => {
                    const before = new Set(document.roads.nodes.map((node) => node.id));
                    const node = getOrCreateNode(document, point, snapRadius ?? 2);
                    if (!before.has(node.id)) createdNodes.push(node);
                    return node.id;
                });

                for (let i = 0; i < nodeIds.length - 1; i++) {
                    const result = addRoadEdge(
                        document,
                        nodeIds[i],
                        nodeIds[i + 1],
                        {
                            width,
                            laneCount,
                            bidirectional,
                        },
                    );
                    if (!result.ok) {
                        errors.push(result.error);
                        continue;
                    }
                    createdEdges.push(result.edge);
                }

                if (createdEdges.length === 0 && errors.length > 0) {
                    return fail(errors[0], { errors });
                }

                const conflicts = conflictsForNewEntities(document, {
                    edgeIds: createdEdges.map((edge) => edge.id),
                });
                if (strict && conflicts.length > 0) {
                    return fail("Rejected due to geometric conflicts (strict=true).", {
                        conflicts,
                        createdNodes,
                        createdEdges,
                        errors,
                    });
                }

                await saveDocument(storage, environmentId, manifest, document);
                return ok({
                    ok: true,
                    createdNodes,
                    createdEdges,
                    errors,
                    conflicts,
                });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_remove_road",
        {
            title: "Remove road edge",
            description: "Remove a road edge by id.",
            inputSchema: {
                environmentId: z.string().min(1),
                edgeId: z.string().min(1),
            },
        },
        async ({ environmentId, edgeId }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const result = removeRoadEdge(document, edgeId);
                if (!result.ok) return fail(result.error);
                await saveDocument(storage, environmentId, manifest, document);
                return ok({ ok: true, removed: edgeId });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_move_road_node",
        {
            title: "Move road node",
            description:
                "Move a free endpoint road node in xz (optional y). Intersections accept y-only elevation changes.",
            inputSchema: {
                environmentId: z.string().min(1),
                nodeId: z.string().min(1),
                point: PointSchema,
                strict: z.boolean().optional(),
            },
        },
        async ({ environmentId, nodeId, point, strict }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const node = document.getNode(nodeId);
                if (!node) return fail("Road node not found.");

                let result;
                if (isIntersectionNode(document, node)) {
                    const dx = Math.abs(Number(point.x) - Number(node.x));
                    const dz = Math.abs(Number(point.z) - Number(node.z));
                    if (dx > 1e-6 || dz > 1e-6) {
                        return fail("Intersection nodes cannot move in xz; supply matching x/z and a new y.");
                    }
                    if (point.y === undefined) {
                        return fail("Intersection elevation requires point.y.");
                    }
                    result = setRoadNodeElevation(document, nodeId, point.y);
                } else {
                    result = moveRoadNode(document, nodeId, point);
                }
                if (!result.ok) return fail(result.error);
                const edgeIds = document.roads.edges
                    .filter((edge) => edge.startNodeId === nodeId || edge.endNodeId === nodeId)
                    .map((edge) => edge.id);
                const conflicts = conflictsForNewEntities(document, { edgeIds });
                if (strict && conflicts.length > 0) {
                    return fail("Rejected due to geometric conflicts (strict=true).", { conflicts });
                }
                await saveDocument(storage, environmentId, manifest, document);
                return ok({ ok: true, nodeId, point, conflicts });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_add_building",
        {
            title: "Add building",
            description: "Add a rectangular building from two opposite corners. Returns overlap conflicts.",
            inputSchema: {
                environmentId: z.string().min(1),
                cornerA: PointSchema,
                cornerB: PointSchema,
                height: z.number().positive().optional(),
                textureId: z.number().int().nonnegative().optional(),
                strict: z.boolean().optional(),
            },
        },
        async ({ environmentId, cornerA, cornerB, height, textureId, strict }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const result = addBuildingRectangle(document, cornerA, cornerB, { height, textureId });
                if (!result.ok) return fail(result.error);
                const conflicts = conflictsForNewEntities(document, {
                    buildingIds: [result.record.buildingId],
                });
                const response = maybeFailStrict(strict, conflicts, { building: result.record });
                if (response.isError) return response;
                await saveDocument(storage, environmentId, manifest, document);
                return response;
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_remove_building",
        {
            title: "Remove building",
            description: "Remove a building by id.",
            inputSchema: {
                environmentId: z.string().min(1),
                buildingId: z.string().min(1),
            },
        },
        async ({ environmentId, buildingId }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const result = removeBuilding(document, buildingId);
                if (!result.ok) return fail(result.error);
                await saveDocument(storage, environmentId, manifest, document);
                return ok({ ok: true, removed: buildingId });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_add_object",
        {
            title: "Add placed object",
            description:
                "Add a prop/feature (stop-sign, one-way-sign, barrel, tire, cone) at a world position.",
            inputSchema: {
                environmentId: z.string().min(1),
                type: z.string().min(1).describe("Placement catalog asset id"),
                x: z.number(),
                z: z.number(),
                rotationY: z.number().optional(),
                dir: z.number().optional(),
                strict: z.boolean().optional(),
            },
        },
        async ({ environmentId, type, x, z, rotationY, dir, strict }) => {
            try {
                if (!getPlacementAsset(type)) {
                    return fail(environmentObjectTypeUnsupportedError(type, PLACEMENT_CATALOG.map((a) => a.id)));
                }
                const { manifest, document } = await loadDocument(storage, environmentId);
                const result = addFeature(document, {
                    type,
                    x,
                    z,
                    rotationY: rotationY ?? 0,
                    dir: dir ?? 0,
                    tags: [type],
                });
                if (!result.ok) return fail(result.error ?? "Could not add feature.");
                const conflicts = conflictsForNewEntities(document, {
                    featureIds: [result.record.id],
                });
                const response = maybeFailStrict(strict, conflicts, { feature: result.record });
                if (response.isError) return response;
                await saveDocument(storage, environmentId, manifest, document);
                return response;
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_move_object",
        {
            title: "Move placed object",
            description: "Move a feature/prop by id.",
            inputSchema: {
                environmentId: z.string().min(1),
                featureId: z.string().min(1),
                x: z.number(),
                z: z.number(),
                strict: z.boolean().optional(),
            },
        },
        async ({ environmentId, featureId, x, z, strict }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const result = moveFeature(document, featureId, { x, z });
                if (!result.ok) return fail(result.error);
                const conflicts = conflictsForNewEntities(document, { featureIds: [featureId] });
                const response = maybeFailStrict(strict, conflicts, { feature: result.feature });
                if (response.isError) return response;
                await saveDocument(storage, environmentId, manifest, document);
                return response;
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_remove_object",
        {
            title: "Remove placed object",
            description: "Remove a feature/prop by id.",
            inputSchema: {
                environmentId: z.string().min(1),
                featureId: z.string().min(1),
            },
        },
        async ({ environmentId, featureId }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const result = removeFeature(document, featureId);
                if (!result.ok) return fail(result.error);
                await saveDocument(storage, environmentId, manifest, document);
                return ok({ ok: true, removed: featureId });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "environment_validate",
        {
            title: "Validate environment",
            description: "Run geometric conflict checks and object-graph validation over an environment document.",
            inputSchema: {
                environmentId: z.string().min(1),
            },
        },
        async ({ environmentId }) => {
            try {
                const { manifest, document } = await loadDocument(storage, environmentId);
                const conflicts = findDocumentConflicts(document);
                const graph = validateObjectGraph(document.snapshot(), objectTypeRegistry, { sky: manifest.sky ?? null });
                return ok({
                    ok: true,
                    conflictCount: conflicts.length,
                    conflicts,
                    objectGraphOk: graph.ok,
                    issueCount: graph.issues.length,
                    issues: graph.issues,
                });
            } catch (error) {
                return fail(error);
            }
        },
    );
}

async function loadDocument(storage, environmentId) {
    const manifest = await storage.getEnvironment(environmentId);
    if (!manifest) {
        throw new Error(`Environment "${environmentId}" not found.`);
    }
    const document = EnvironmentDocument.fromManifest(manifest.document ?? {
        environmentId,
        roads: { nodes: [], edges: [] },
        buildings: [],
        features: [],
    });
    reconcileDocumentObjects(manifest, document);
    return { manifest, document };
}

/**
 * Keep the schema-v4 overlay complete around legacy mutations: every legacy
 * entity gains a record, orphans are dropped, unknown types are preserved.
 * Default (v3) storage strips the overlay again on write.
 */
function reconcileDocumentObjects(manifest, document) {
    const { records } = reconcileObjectGraph(
        document.snapshot(),
        document.objects,
        objectTypeRegistry,
        { sky: manifest.sky ?? null },
    );
    document.replaceObjectGraph(records);
}

function summarizeObjectType(definition) {
    return {
        typeId: definition.typeId,
        version: definition.version,
        label: definition.label,
        catalog: definition.catalog,
        capabilities: definition.getCapabilities(null),
        legacyDomain: definition.legacy?.domain ?? null,
    };
}

async function saveDocument(storage, environmentId, manifest, document) {
    reconcileDocumentObjects(manifest, document);
    const snapshot = document.toManifest();
    const saved = await storage.putEnvironment(environmentId, {
        manifest: {
            ...manifest,
            environmentId,
            document: snapshot,
            roadsAuthored: document.roadsAuthored,
            buildingsAuthored: document.buildingsAuthored,
            featuresAuthored: document.featuresAuthored,
            updatedAt: new Date().toISOString(),
        },
        expectedRevision: Number.isInteger(manifest.revision) ? manifest.revision : 0,
        detachStaleVisual: true,
    });
    storageEvents.publish({
        domain: "environment",
        id: environmentId,
        action: "updated",
        revision: saved.revision,
    });
    return saved;
}

function summarizeManifest(manifest) {
    if (!manifest) return null;
    return {
        id: manifest.environmentId,
        name: manifest.name,
        templateId: manifest.templateId,
        schemaVersion: manifest.schemaVersion,
        revision: manifest.revision ?? 0,
        roadsAuthored: manifest.roadsAuthored === true,
        buildingsAuthored: manifest.buildingsAuthored === true,
        featuresAuthored: manifest.featuresAuthored === true,
        visualLayer: manifest.visualLayer ?? null,
        evidence: manifest.evidence ?? null,
    };
}

/** Exported for unit tests. */
export { loadDocument, saveDocument, summarizeManifest };
