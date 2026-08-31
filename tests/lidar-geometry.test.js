import assert from "node:assert/strict";
import test from "node:test";

import {
    assertLidarGeometryResource,
    createBoxLidarTwin,
    createLidarGeometryResource,
    createTriangleLidarTwin,
    lidarTwinFromGlslObject,
} from "../app/simulation/lidar/LidarGeometry.js";
import { allocateLidarInstanceIds } from "../app/simulation/lidar/LidarInstanceIds.js";
import { compareUtf8 } from "../app/simulation/world/WorldDescription.js";
import { StorageService } from "../server/storage/StorageService.js";

function world() {
    return {
        description: {
            coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
            obstacles: [
                {
                    id: "building:z", sourceId: "z", sourceType: "building", shape: "extruded-footprint",
                    footprint: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }],
                    triangles: [[0, 1, 2], [0, 2, 3]], minY: 0, maxY: 3,
                },
                {
                    id: "feature:a", sourceId: "a", sourceType: "barrel", shape: "oriented-box-prism",
                    footprint: [{ x: 4, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 1 }, { x: 4, z: 1 }],
                    triangles: [[0, 1, 2], [0, 2, 3]], minY: 0, maxY: 1,
                },
            ],
            drivableSurfaces: [
                {
                    id: "road-surface:r", sourceId: "r", kind: "road-corridor",
                    footprint: [{ x: 0, z: -2 }, { x: 10, z: -2 }, { x: 10, z: 2 }, { x: 0, z: 2 }],
                    minY: 0, maxY: 0,
                },
                { id: "intersection-surface:i", sourceId: "i", kind: "intersection-disc", center: { x: 10, y: 0, z: 0 }, radius: 4 },
            ],
        },
    };
}

function vehicles() {
    return [
        {
            actorId: "zone-car",
            manifest: {
                lidarZone: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] },
                boundingBox: { center: { x: 0, y: 1, z: 0 }, size: { x: 4, y: 2, z: 2 } },
            },
        },
        {
            actorId: "box-car",
            manifest: {
                boundingBox: { center: { x: 0, y: 1, z: 0 }, size: { x: 4, y: 2, z: 2 } },
            },
        },
    ];
}

test("LiDAR geometry twins are canonical, complete, and tamper evident", () => {
    const first = createLidarGeometryResource(world(), vehicles());
    const second = createLidarGeometryResource(world(), [...vehicles()].reverse());
    assert.equal(first.hash, second.hash);
    assert.deepEqual(first, second);
    assert.equal(first.description.staticPrimitives.length, 90);
    assert.deepEqual(first.description.actors.map((entry) => entry.actorId), ["box-car", "zone-car"]);
    assert.equal(first.description.actors[0].primitives[0].shape, "box");
    assert.equal(first.description.actors[1].primitives[0].shape, "triangle");
    assert.equal(new Set(first.description.staticPrimitives.map((entry) => entry.id)).size, 90);
    assert.doesNotThrow(() => assertLidarGeometryResource(first));

    const tampered = structuredClone(first);
    tampered.description.staticPrimitives[0].vertices[0].x += 1;
    assert.throws(() => assertLidarGeometryResource(tampered), /hash mismatch/i);
});

test("browser GLSL objects serialize through the same box and triangle twin constructors", () => {
    const boxObject = {
        _uuid: "box-uuid", lidarTwinId: "box", environmentSourceId: "building-1",
        position: { x: 1, y: 2, z: 3 }, scale: { x: 4, y: 5, z: 6 }, tags: ["building"], tagId: 1,
    };
    assert.deepEqual(
        lidarTwinFromGlslObject(boxObject),
        createBoxLidarTwin({
            id: "box", sourceId: "building-1", center: boxObject.position, size: boxObject.scale,
            tags: ["building"], semanticId: 1,
        }),
    );
    const triangleObject = {
        _uuid: "tri-uuid", lidarTwinId: "triangle", environmentSourceId: "road-1",
        a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 0, z: 0 }, c: { x: 0, y: 0, z: 1 },
        tags: ["road"], tagId: 4, lidarTriangleIndex: 7,
    };
    assert.deepEqual(
        lidarTwinFromGlslObject(triangleObject),
        createTriangleLidarTwin({
            id: "triangle", sourceId: "road-1", vertices: [triangleObject.a, triangleObject.b, triangleObject.c],
            tags: ["road"], semanticId: 4, triangleIndex: 7,
        }),
    );
    const actorTriangle = lidarTwinFromGlslObject({
        ...triangleObject,
        _vehicleId: "ego",
        lidarInstanceId: 77,
    });
    assert.equal(actorTriangle.ownerActorId, "ego");
    assert.equal(actorTriangle.frame, "world");
    assert.equal(actorTriangle.instanceId, 77);
});

test("instance allocation resolves 24-bit hash collisions in canonical source order", () => {
    const sources = ["source-79640", "source-38324"];
    const first = allocateLidarInstanceIds(sources, compareUtf8);
    const second = allocateLidarInstanceIds([...sources].reverse(), compareUtf8);
    assert.deepEqual([...first], [...second]);
    assert.equal(new Set(first.values()).size, 2);
});

test("resolution persists LiDAR twins conditionally without changing world identity", async () => {
    const service = new StorageService();
    const lidar = await service.resolveRunManifest("igvc-default");
    assert.ok(lidar.lidarGeometry);
    assert.equal(lidar.dependencyHashes.lidarGeometry, lidar.lidarGeometry.hash);

    const manifest = structuredClone(lidar.manifest);
    manifest.sensorRig.sensors = manifest.sensorRig.sensors.filter((sensor) => sensor.type !== "lidar3d");
    const withoutLidar = await service.resolveRunManifest(manifest.id, { manifest });
    assert.equal(withoutLidar.lidarGeometry, undefined);
    assert.equal(withoutLidar.dependencyHashes.lidarGeometry, undefined);
    assert.equal(withoutLidar.world.hash, lidar.world.hash);
    assert.notEqual(withoutLidar.resolvedHash, lidar.resolvedHash);
    assert.notEqual(withoutLidar.simulationSemanticHash, lidar.simulationSemanticHash);
});
