import { perceptionClassId } from "../../autonomy/PerceptionLabelCatalog.js";
import { compareUtf8 } from "../world/WorldDescription.js";
import { canonicalizeSimulationValue, simulationSha256 } from "../kernel/SimulationHashes.js";
import { allocateLidarInstanceIds, stableInstanceIdFromSource } from "./LidarInstanceIds.js";

export const LIDAR_GEOMETRY_KIND = "cev-sim.lidar-geometry";
export const LIDAR_GEOMETRY_VERSION = 1;
export const INTERSECTION_SEGMENTS = 64;

function finite(value, label) {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite.`);
    return Object.is(result, -0) ? 0 : result;
}

function vec3(value, label) {
    return {
        x: finite(value?.x, `${label}.x`),
        y: finite(value?.y, `${label}.y`),
        z: finite(value?.z, `${label}.z`),
    };
}

function normalizedTags(tags, fallback = "unknown") {
    const result = [...new Set((Array.isArray(tags) ? tags : []).map(String).filter(Boolean))]
        .sort(compareUtf8);
    return result.length > 0 ? result : [fallback];
}

function semanticName(sourceType, tags) {
    if (["stop-sign", "one-way-sign"].includes(sourceType)) return "sign";
    return tags[0] ?? sourceType ?? "unknown";
}

export function createTriangleLidarTwin({
    id,
    sourceId,
    ownerActorId = null,
    frame = "world",
    vertices,
    tags = [],
    semanticId = null,
    instanceId = null,
    triangleIndex = 0,
}) {
    const canonicalTags = normalizedTags(tags);
    return canonicalizeSimulationValue({
        id: String(id),
        sourceId: String(sourceId),
        ownerActorId: ownerActorId === null ? null : String(ownerActorId),
        frame: String(frame),
        shape: "triangle",
        vertices: vertices.map((entry, index) => vec3(entry, `${id}.vertices[${index}]`)),
        tags: canonicalTags,
        semanticId: semanticId === null ? perceptionClassId(canonicalTags[0]) : Number(semanticId),
        instanceId: instanceId === null ? stableInstanceIdFromSource(sourceId) : Number(instanceId),
        triangleIndex: Number(triangleIndex),
    });
}

export function createBoxLidarTwin({
    id,
    sourceId,
    ownerActorId = null,
    frame = "world",
    center,
    size,
    tags = [],
    semanticId = null,
    instanceId = null,
}) {
    const canonicalTags = normalizedTags(tags);
    const canonicalSize = vec3(size, `${id}.size`);
    if (canonicalSize.x <= 0 || canonicalSize.y <= 0 || canonicalSize.z <= 0) {
        throw new TypeError(`${id}.size must be positive.`);
    }
    return canonicalizeSimulationValue({
        id: String(id),
        sourceId: String(sourceId),
        ownerActorId: ownerActorId === null ? null : String(ownerActorId),
        frame: String(frame),
        shape: "box",
        center: vec3(center, `${id}.center`),
        size: canonicalSize,
        tags: canonicalTags,
        semanticId: semanticId === null ? perceptionClassId(canonicalTags[0]) : Number(semanticId),
        instanceId: instanceId === null ? stableInstanceIdFromSource(sourceId) : Number(instanceId),
    });
}

function extrudedTriangles(obstacle, tags, instanceId) {
    const points = obstacle.footprint;
    const triangles = [];
    const add = (suffix, indexes, yValues) => {
        triangles.push(createTriangleLidarTwin({
            id: `${obstacle.id}:${suffix}`,
            sourceId: obstacle.sourceId,
            vertices: indexes.map((index, offset) => ({
                x: points[index].x,
                y: yValues[offset],
                z: points[index].z,
            })),
            tags,
            semanticId: perceptionClassId(semanticName(obstacle.sourceType, tags)),
            instanceId,
            triangleIndex: triangles.length,
        }));
    };
    for (const [index, face] of obstacle.triangles.entries()) {
        add(`bottom:${index}`, [face[2], face[1], face[0]], [obstacle.minY, obstacle.minY, obstacle.minY]);
        add(`top:${index}`, face, [obstacle.maxY, obstacle.maxY, obstacle.maxY]);
    }
    for (let index = 0; index < points.length; index += 1) {
        const next = (index + 1) % points.length;
        add(`side:${index}:0`, [index, next, next], [obstacle.minY, obstacle.minY, obstacle.maxY]);
        add(`side:${index}:1`, [index, next, index], [obstacle.minY, obstacle.maxY, obstacle.maxY]);
    }
    return triangles;
}

function surfaceTriangles(surface, instanceId) {
    const tags = ["road"];
    if (surface.kind === "road-corridor") {
        const y = (surface.minY + surface.maxY) * 0.5;
        return [[0, 1, 2], [0, 2, 3]].map((face, index) => createTriangleLidarTwin({
            id: `${surface.id}:${index}`,
            sourceId: surface.sourceId,
            vertices: face.map((pointIndex) => ({ ...surface.footprint[pointIndex], y })),
            tags,
            semanticId: perceptionClassId("road"),
            instanceId,
            triangleIndex: index,
        }));
    }
    const result = [];
    for (let index = 0; index < INTERSECTION_SEGMENTS; index += 1) {
        const start = index * Math.PI * 2 / INTERSECTION_SEGMENTS;
        const end = (index + 1) * Math.PI * 2 / INTERSECTION_SEGMENTS;
        result.push(createTriangleLidarTwin({
            id: `${surface.id}:${index}`,
            sourceId: surface.sourceId,
            vertices: [
                surface.center,
                { x: surface.center.x + Math.cos(start) * surface.radius, y: surface.center.y, z: surface.center.z + Math.sin(start) * surface.radius },
                { x: surface.center.x + Math.cos(end) * surface.radius, y: surface.center.y, z: surface.center.z + Math.sin(end) * surface.radius },
            ],
            tags,
            semanticId: perceptionClassId("road"),
            instanceId,
            triangleIndex: index,
        }));
    }
    return result;
}

function actorTwins(dependency, instanceId) {
    const actorId = String(dependency.actorId);
    const manifest = dependency.manifest;
    const common = {
        sourceId: actorId,
        ownerActorId: actorId,
        frame: "actor-local",
        tags: ["vehicle"],
        semanticId: perceptionClassId("vehicle"),
        instanceId,
    };
    const lidarVertices = manifest.lidarZone?.vertices ?? [];
    const lidarTriangles = manifest.lidarZone?.triangles ?? [];
    if (lidarVertices.length > 0 && lidarTriangles.length > 0) {
        return lidarTriangles.map((face, index) => createTriangleLidarTwin({
            ...common,
            id: `actor:${actorId}:lidar-zone:${index}`,
            vertices: face.map((vertexIndex) => {
                const [x, y, z] = lidarVertices[vertexIndex];
                return { x, y, z };
            }),
            triangleIndex: index,
        }));
    }
    return [createBoxLidarTwin({
        ...common,
        id: `actor:${actorId}:bounding-box`,
        center: manifest.boundingBox.center,
        size: manifest.boundingBox.size,
    })];
}

export function createLidarGeometry(worldResource, vehicleDependencies = []) {
    const world = worldResource?.description ?? worldResource;
    if (!world?.obstacles || !world?.drivableSurfaces) {
        throw new TypeError("A resolved world description is required for LiDAR geometry.");
    }
    const sourceIds = [
        ...world.obstacles.map((entry) => entry.sourceId),
        ...world.drivableSurfaces.map((entry) => entry.sourceId),
        ...vehicleDependencies.map((entry) => entry.actorId),
    ];
    const instanceIds = allocateLidarInstanceIds(sourceIds, compareUtf8);
    const staticPrimitives = [
        ...world.obstacles.flatMap((obstacle) => {
            const tags = normalizedTags(
                obstacle.sourceType === "building" ? ["building"] : [obstacle.sourceType],
            );
            return extrudedTriangles(obstacle, tags, instanceIds.get(String(obstacle.sourceId)));
        }),
        ...world.drivableSurfaces.flatMap((surface) => (
            surfaceTriangles(surface, instanceIds.get(String(surface.sourceId)))
        )),
    ].sort((left, right) => compareUtf8(left.id, right.id));
    const actors = vehicleDependencies
        .map((dependency) => ({
            actorId: String(dependency.actorId),
            primitives: actorTwins(dependency, instanceIds.get(String(dependency.actorId)))
                .sort((left, right) => compareUtf8(left.id, right.id)),
        }))
        .sort((left, right) => compareUtf8(left.actorId, right.actorId));
    return canonicalizeSimulationValue({
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: world.coordinateFrame,
        staticPrimitives,
        actors,
    });
}

export function hashLidarGeometry(description) {
    assertLidarGeometryDescription(description);
    return simulationSha256(description);
}

export function createLidarGeometryResource(worldResource, vehicleDependencies = []) {
    const description = createLidarGeometry(worldResource, vehicleDependencies);
    return { description, hash: hashLidarGeometry(description) };
}

export function assertLidarGeometryDescription(description) {
    if (description?.kind !== LIDAR_GEOMETRY_KIND || Number(description.version) !== LIDAR_GEOMETRY_VERSION) {
        throw new TypeError(`Expected ${LIDAR_GEOMETRY_KIND} v${LIDAR_GEOMETRY_VERSION}.`);
    }
    if (!Array.isArray(description.staticPrimitives) || !Array.isArray(description.actors)) {
        throw new TypeError("LiDAR geometry requires staticPrimitives and actors arrays.");
    }
    const actorIds = description.actors.map((actor) => String(actor?.actorId ?? ""));
    if (actorIds.some((id) => !id) || new Set(actorIds).size !== actorIds.length) {
        throw new TypeError("LiDAR geometry actor IDs must be unique and non-empty.");
    }
    if ([...actorIds].sort(compareUtf8).some((id, index) => id !== actorIds[index])) {
        throw new TypeError("LiDAR geometry actors are not in canonical UTF-8 order.");
    }
    const primitives = [
        ...description.staticPrimitives.map((primitive) => ({ primitive, actorId: null })),
        ...description.actors.flatMap((actor) => {
            if (!Array.isArray(actor.primitives)) {
                throw new TypeError(`LiDAR actor "${actor.actorId}" requires a primitives array.`);
            }
            const ordered = actor.primitives.map((entry) => entry.id);
            if ([...ordered].sort(compareUtf8).some((id, index) => id !== ordered[index])) {
                throw new TypeError(`LiDAR actor "${actor.actorId}" primitives are not in canonical UTF-8 order.`);
            }
            return actor.primitives.map((primitive) => ({ primitive, actorId: String(actor.actorId) }));
        }),
    ];
    const ids = new Set();
    const instances = new Map();
    const sourceInstances = new Map();
    for (const { primitive, actorId } of primitives) {
        if (!primitive.id || ids.has(primitive.id)) throw new TypeError(`Duplicate or missing LiDAR primitive ID "${primitive.id ?? ""}".`);
        ids.add(primitive.id);
        if (!["box", "triangle"].includes(primitive.shape)) throw new TypeError(`Unsupported LiDAR primitive shape "${primitive.shape}".`);
        if (primitive.shape === "triangle"
            && (!Array.isArray(primitive.vertices) || primitive.vertices.length !== 3
                || !Number.isInteger(primitive.triangleIndex) || primitive.triangleIndex < 0)) {
            throw new TypeError(`LiDAR triangle "${primitive.id}" requires three vertices and a non-negative triangle index.`);
        }
        if (!primitive.sourceId || !Array.isArray(primitive.tags) || primitive.tags.length === 0) {
            throw new TypeError(`LiDAR primitive "${primitive.id}" requires a source ID and tags.`);
        }
        if (!Number.isInteger(primitive.semanticId) || primitive.semanticId < 0 || primitive.semanticId > 0x00ffffff) {
            throw new TypeError(`LiDAR primitive "${primitive.id}" has an invalid semantic ID.`);
        }
        if (!Number.isInteger(primitive.instanceId) || primitive.instanceId <= 0 || primitive.instanceId > 0x00ffffff) {
            throw new TypeError(`LiDAR primitive "${primitive.id}" has an invalid instance ID.`);
        }
        if (actorId === null && (primitive.ownerActorId !== null || primitive.frame !== "world")) {
            throw new TypeError(`Static LiDAR primitive "${primitive.id}" must use the world frame without an actor owner.`);
        }
        if (actorId !== null && (primitive.ownerActorId !== actorId || primitive.frame !== "actor-local")) {
            throw new TypeError(`LiDAR primitive "${primitive.id}" must be local to actor "${actorId}".`);
        }
        const owner = instances.get(primitive.instanceId);
        if (owner && owner !== primitive.sourceId) throw new TypeError(`LiDAR instance ID collision between "${owner}" and "${primitive.sourceId}".`);
        instances.set(primitive.instanceId, primitive.sourceId);
        const sourceInstance = sourceInstances.get(primitive.sourceId);
        if (sourceInstance && sourceInstance !== primitive.instanceId) {
            throw new TypeError(`LiDAR source "${primitive.sourceId}" has inconsistent instance IDs.`);
        }
        sourceInstances.set(primitive.sourceId, primitive.instanceId);
        const rebuilt = primitive.shape === "box"
            ? createBoxLidarTwin(primitive)
            : createTriangleLidarTwin(primitive);
        if (simulationSha256(rebuilt) !== simulationSha256(primitive)) {
            throw new TypeError(`LiDAR primitive "${primitive.id}" is not canonical.`);
        }
    }
    const staticIds = description.staticPrimitives.map((entry) => entry.id);
    if ([...staticIds].sort(compareUtf8).some((id, index) => id !== staticIds[index])) {
        throw new TypeError("Static LiDAR primitives are not in canonical UTF-8 order.");
    }
    const rebuiltDescription = canonicalizeSimulationValue({
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: description.coordinateFrame,
        staticPrimitives: description.staticPrimitives,
        actors: description.actors,
    });
    if (simulationSha256(rebuiltDescription) !== simulationSha256(description)) {
        throw new TypeError("LiDAR geometry contains non-canonical fields.");
    }
    return description;
}

export function assertLidarGeometryResource(resource) {
    if (!resource?.description || !resource?.hash) throw new TypeError("Resolved LiDAR geometry resource is required.");
    const hash = hashLidarGeometry(resource.description);
    if (hash !== resource.hash) throw new Error(`Resolved LiDAR geometry hash mismatch: expected ${resource.hash}, computed ${hash}.`);
    return resource.description;
}

/** Canonical twin used by the browser texture registry for every GLSL primitive. */
export function lidarTwinFromGlslObject(object) {
    const sourceId = String(
        object?.perceptionSourceId ?? object?.environmentSourceId ?? object?._vehicleId ?? object?._buildingId
        ?? object?._roadId ?? object?._uuid,
    );
    const common = {
        id: String(object?.lidarTwinId ?? object?._uuid),
        sourceId,
        ownerActorId: object?._vehicleId ?? null,
        frame: String(object?.lidarTwinFrame ?? "world"),
        tags: object?.tags ?? [],
        semanticId: Number(object?.tagId ?? 0),
        instanceId: Number(object?.lidarInstanceId ?? stableInstanceIdFromSource(sourceId)),
    };
    if (object?.a && object?.b && object?.c) {
        return createTriangleLidarTwin({
            ...common,
            vertices: [object.a, object.b, object.c],
            triangleIndex: Number(object?.lidarTriangleIndex ?? 0),
        });
    }
    return createBoxLidarTwin({ ...common, center: object.position, size: object.scale });
}
