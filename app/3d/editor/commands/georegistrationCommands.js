import { createGeoFrame, geodeticToLocal } from "../../../geography/GeoFrame.js";
import { resolveRoadEdge } from "../../../roads/RoadGeometryRecord.js";
import { sampleCenterline } from "../../../roads/RoadGeometry.js";
import { ROAD_GEOMETRY_POLICY_V1 } from "../../../roads/RoadGeometryPolicy.js";
import { COMMAND_ISSUE_CODES, commandFailure, commandIssue, commandSuccess } from "./commandIssues.js";

const WEB_MERCATOR_RADIUS = 6378137;
const SCOPES = new Set(["roads", "environment"]);

function legacyLocalToGeodetic(point, anchor) {
    const lat0 = Number(anchor?.lat);
    const lng0 = Number(anchor?.lng);
    if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) {
        throw new TypeError("Legacy georegistration requires a valid Earth anchor.");
    }
    const originX = WEB_MERCATOR_RADIUS * lng0 * Math.PI / 180;
    const originZ = WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + lat0 * Math.PI / 360));
    const mercatorX = originX + Number(point.x);
    const mercatorZ = originZ + Number(point.z);
    return {
        lat: (2 * Math.atan(Math.exp(mercatorZ / WEB_MERCATOR_RADIUS)) - Math.PI / 2) * 180 / Math.PI,
        lng: mercatorX / WEB_MERCATOR_RADIUS * 180 / Math.PI,
        height: 0,
    };
}

function migratePoint(point, anchor, frame) {
    const local = geodeticToLocal(legacyLocalToGeodetic(point, anchor), frame);
    return { x: local.x, y: Number(point?.y ?? 0), z: local.z };
}

function migrateHeading(point, rotationY, anchor, frame) {
    const yaw = Number(rotationY ?? 0);
    const start = migratePoint(point, anchor, frame);
    const end = migratePoint({
        x: Number(point.x) + Math.cos(yaw),
        y: Number(point.y ?? 0),
        z: Number(point.z) + Math.sin(yaw),
    }, anchor, frame);
    return Math.atan2(end.z - start.z, end.x - start.x);
}

function reverseLaneLayout(edge) {
    if (!Array.isArray(edge.lanes) || edge.lanes.length < 1) {
        [edge.borderLeft, edge.borderRight] = [edge.borderRight, edge.borderLeft];
        return;
    }
    const previous = edge.lanes.map((lane) => structuredClone(lane));
    edge.lanes = previous.slice().reverse().map((lane, index) => {
        const result = { ...lane };
        delete result.markingLeft;
        const oldBoundaryIndex = previous.length - 2 - index;
        if (oldBoundaryIndex >= 0 && previous[oldBoundaryIndex]?.markingLeft !== undefined) {
            result.markingLeft = previous[oldBoundaryIndex].markingLeft;
        }
        return result;
    });
    [edge.borderLeft, edge.borderRight] = [edge.borderRight, edge.borderLeft];
}

function objectTransformComponent(record) {
    if (record.typeId === "group") return { key: "transform", value: record.components?.transform };
    if (record.typeId === "asset-instance" || (record.typeId === "tile" && record.typeVersion === 2)) {
        return { key: "asset", value: record.components?.asset };
    }
    return null;
}

function sourceVersion2(earth) {
    if (!earth) return null;
    return {
        version: 2,
        tileProvider: earth.tileProvider ?? "google-photorealistic",
        bounds: structuredClone(earth.bounds),
        quality: {
            maxScreenSpaceError: Number(earth.quality?.maxScreenSpaceError ?? 1),
            maxCachedTiles: Number(earth.quality?.maxCachedTiles ?? 2000),
            maxCacheBytes: Number(earth.quality?.maxCacheBytes ?? 1073741824),
        },
        roadProvider: earth.roadProvider ?? null,
        roadFilters: { highwayClasses: [...(earth.roadFilters?.highwayClasses ?? [])] },
        importedLayerIds: [...(earth.importedLayerIds ?? [])],
        importedAt: earth.importedAt ?? null,
    };
}

/**
 * Prepare a complete, detached georegistration result. The returned plan is
 * serializable and contains every byte the command will commit.
 */
export function planGeoregistration(document, { targetFrame, scope } = {}) {
    if (!SCOPES.has(scope)) throw new TypeError('Georegistration scope must be "roads" or "environment".');
    if (document.geoFrame) throw new TypeError("This environment already uses an ED-08 geospatial frame.");
    const frame = createGeoFrame(targetFrame);
    const anchor = document.earth?.anchor;
    if (!anchor) throw new TypeError("This legacy environment has no geographic anchor to migrate from.");

    const before = document.snapshot();
    const after = structuredClone(before);
    const issues = [];
    const relevantLegacyIds = new Set([
        ...after.roads.nodes.map((entry) => String(entry.id)),
        ...after.roads.edges.map((entry) => String(entry.id)),
        ...(scope === "environment" ? after.buildings.map((entry) => String(entry.buildingId)) : []),
        ...(scope === "environment" ? after.features.map((entry) => String(entry.id)) : []),
    ]);
    if (scope === "environment") {
        for (const record of after.objects ?? []) {
            const binding = objectTransformComponent(record);
            const relevant = Boolean(binding) || relevantLegacyIds.has(String(record.id));
            if (relevant && record.components?.locked === true) {
                issues.push(commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${record.name ?? record.id}" is locked.`, { objectId: String(record.id) }));
            }
            if (!binding && (record.components?.transform || record.components?.asset)
                && !relevantLegacyIds.has(String(record.id))) {
                issues.push(commandIssue(
                    COMMAND_ISSUE_CODES.ARGUMENT_INVALID,
                    `"${record.name ?? record.id}" uses an unsupported transform component.`,
                    { objectId: String(record.id) },
                ));
            }
        }
    }
    if (issues.length > 0) return { version: 1, scope, targetFrame: frame, before, after: null, issues };

    const originalNodeById = new Map(before.roads.nodes.map((node) => [String(node.id), node]));
    for (const node of after.roads.nodes) Object.assign(node, migratePoint(node, anchor, frame));

    let convertedCurves = 0;
    for (const edge of after.roads.edges) {
        const original = before.roads.edges.find((candidate) => String(candidate.id) === String(edge.id));
        const resolved = resolveRoadEdge(original, originalNodeById);
        const wasCurve = resolved.geometry.kind === "cubic-bezier";
        const points = wasCurve
            ? sampleCenterline(resolved, ROAD_GEOMETRY_POLICY_V1).points
            : resolved.geometry.knots.map((knot) => knot.position);
        const migrated = points.map((point) => migratePoint(point, anchor, frame));
        edge.startArm = null;
        edge.endArm = null;
        edge.geometry = {
            version: 1,
            kind: "polyline",
            knots: migrated.map((point, index) => ({
                id: index === 0 ? "start" : index === migrated.length - 1 ? "end" : `migrated-${index}`,
                ...(index > 0 && index < migrated.length - 1 ? { position: point } : {}),
            })),
        };
        reverseLaneLayout(edge);
        if (wasCurve) convertedCurves += 1;
    }
    after.roads.geometryVersion = 2;
    after.roadsAuthored = true;

    if (scope === "environment") {
        for (const building of after.buildings) {
            building.footprint = building.footprint.map((point) => {
                const migrated = migratePoint({ ...point, y: 0 }, anchor, frame);
                return { ...point, x: migrated.x, z: migrated.z };
            });
        }
        for (const feature of after.features) {
            const position = { x: feature.x, y: 0, z: feature.z };
            const heading = migrateHeading(position, feature.rotationY, anchor, frame);
            const migrated = migratePoint(position, anchor, frame);
            feature.x = migrated.x;
            feature.z = migrated.z;
            feature.rotationY = heading;
        }
        for (const record of after.objects ?? []) {
            const binding = objectTransformComponent(record);
            if (!binding?.value?.position) continue;
            const value = binding.value;
            const heading = migrateHeading(value.position, value.rotationY, anchor, frame);
            const migrated = migratePoint(value.position, anchor, frame);
            record.components[binding.key] = {
                ...value,
                position: migrated,
                rotationY: heading,
            };
        }
        after.buildingsAuthored = after.buildings.length > 0 || after.buildingsAuthored === true;
        after.featuresAuthored = after.features.length > 0 || after.featuresAuthored === true;
    }
    after.geoFrame = frame;
    after.earth = sourceVersion2(after.earth);
    return {
        version: 1,
        scope,
        targetFrame: frame,
        before,
        after,
        issues,
        statistics: {
            roadNodes: after.roads.nodes.length,
            roadEdges: after.roads.edges.length,
            convertedCurves,
            buildings: scope === "environment" ? after.buildings.length : 0,
            features: scope === "environment" ? after.features.length : 0,
            rigidObjects: scope === "environment"
                ? (after.objects ?? []).filter((entry) => objectTransformComponent(entry)?.value?.position).length
                : 0,
        },
    };
}

/** Commit a previously validated georegistration plan as one history entry. */
export function migrateGeoregistration({ expectedDocumentVersion, plan } = {}) {
    return {
        id: "environment.migrate-georegistration",
        label: plan?.scope === "environment" ? "Georegister whole environment" : "Georegister roads",
        run(ctx) {
            if (ctx.document.version !== expectedDocumentVersion) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.DOCUMENT_STALE, "The environment changed after this georegistration preview was prepared."));
            }
            if (!plan || plan.version !== 1 || !SCOPES.has(plan.scope)) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "A valid georegistration plan is required."));
            }
            if ((plan.issues ?? []).some((entry) => entry.severity === "error") || !plan.after) {
                return commandFailure(plan.issues ?? commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "The georegistration plan cannot be applied."));
            }
            ctx.document.restoreSnapshot(plan.after, { notify: false });
            return commandSuccess({ scope: plan.scope, statistics: structuredClone(plan.statistics ?? {}) });
        },
    };
}
