import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createRigidBodyMotionFixture } from "./helpers/rigidBodyMotionFixture.js";
import { flushRigidBodyLidarSolids, setRigidBodyLidarPoses, syncRigidBodyLidarSolids } from "../app/3d/editor/projection/rigidBodyLidarSolids.js";
import { applyRigidBodyViewportPoses } from "../app/3d/editor/projection/applyRigidBodyPoses.js";
import { Euler, Vector3 } from "three";
import { transformRigidBodyPoint } from "../app/simulation/world/RigidBodyRecords.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));
await import("../app/3d/data/VehicleDatabase.js");
const { ObjectDatabase } = await import("../app/3d/data/ObjectDatabase.js");

test("1,000 and 5,000 triangles update only changed bodies when a shader consumes them", () => {
    for (const triangleCount of [1000, 5000]) {
        const { data, objects, triangles, poses } = createRigidBodyMotionFixture(ObjectDatabase, triangleCount, 5);
        const texture = objects.t_triangles().posTexture;
        const tags = objects.t_triangles().tagTexture;
        const initialTagsVersion = tags.version;
        const snapshot = objects.lidarTwins();
        const twin = objects.lidarTwinRegistry.get(triangles[0]._uuid);
        objects.triangles = () => { throw new Error("Motion must not enumerate the triangle database."); };
        objects.updateLidarTwin = () => { throw new Error("Motion must reuse the existing twin."); };
        setRigidBodyLidarPoses(data, poses);
        assert.equal(flushRigidBodyLidarSolids(data), 0);
        const moved = structuredClone(poses);
        moved[0].position.x = 3;
        for (let index = 0; index < 10; index += 1) setRigidBodyLidarPoses(data, structuredClone(moved));
        assert.equal(triangles[0].a.x, 5);
        assert.equal(flushRigidBodyLidarSolids(data), triangleCount / 5);
        assert.equal(triangles[0].a.x, 8);
        assert.equal(triangles[1].a.x, 5);
        assert.equal(objects.lidarTwinRegistry.get(triangles[0]._uuid), twin);
        assert.equal(snapshot[0].vertices[0].x, 5);
        assert.equal(texture, objects.t_triangles().posTexture);
        assert.equal(tags.version, initialTagsVersion);
        const version = texture.version;
        applyRigidBodyViewportPoses(data, moved);
        setRigidBodyLidarPoses(data, moved);
        assert.equal(flushRigidBodyLidarSolids(data), 0);
        assert.equal(texture.version, version);
        setRigidBodyLidarPoses(data, []);
        assert.equal(flushRigidBodyLidarSolids(data), triangleCount / 5);
        assert.equal(triangles[0].a.x, 5);
    }
});

test("geometry replacement reapplies the latest pose, keeps authored coordinates, and reindexes notifications", () => {
    const { data, objects, triangles, poses } = createRigidBodyMotionFixture(ObjectDatabase, 10, 2);
    poses[0].position.x = 2;
    syncRigidBodyLidarSolids(data, poses);
    const replacement = triangles[0].constructor;
    const fresh = new replacement(triangles[1].a.clone(), triangles[1].b.clone(), triangles[1].c.clone());
    fresh.environmentSourceId = "body-0";
    fresh.environmentGeometryType = "asset-lidar";
    objects.replaceTriangles((triangle) => triangle.environmentSourceId === "body-0", [fresh]);
    assert.equal(flushRigidBodyLidarSolids(data), 1);
    assert.equal(fresh.a.x, 7);
    syncRigidBodyLidarSolids(data, null);
    assert.equal(fresh.a.x, 5);
    const kept = objects.triangles()[0];
    kept.a.x = 12;
    kept.notifyTextureUpdate();
    assert.equal(objects.textures.data._trianglePosData[0], 12);
    assert.equal(objects.t_triangles().count, 6);
});

test("viewport meshes skip unchanged transforms and do not flush shader geometry", () => {
    const { data, objects, poses, triangles } = createRigidBodyMotionFixture(ObjectDatabase, 10);
    let matrices = 0;
    const mesh = {
        position: triangles[0].a.clone().set(0, 0, 0),
        quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { Object.assign(this, { x, y, z, w }); } },
        updateMatrixWorld() { matrices += 1; },
    };
    data.scene = { getObjectByName: () => mesh };
    poses[0].position.x = 3;
    setRigidBodyLidarPoses(data, poses);
    applyRigidBodyViewportPoses(data, poses);
    applyRigidBodyViewportPoses(data, structuredClone(poses));
    assert.equal(matrices, 1);
    assert.equal(objects.textures.data._trianglePosData[0], 5);
});

test("shader capture consumes a frozen rotated pose and a replacement scene receives it independently", async () => {
    const { LiDAR3d } = await import("../app/3d/devices/LiDAR3d.js");
    const fixture = createRigidBodyMotionFixture(ObjectDatabase, 10);
    const { data, objects, poses, triangles } = fixture;
    const authored = { x: triangles[0].a.x, y: triangles[0].a.y, z: triangles[0].a.z };
    poses[0].rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    poses[0].position.x = 2;
    const expected = transformRigidBodyPoint(authored, poses[0]);
    setRigidBodyLidarPoses(data, poses);
    poses[0].position.x = 100;
    const sensor = Object.create(LiDAR3d.prototype);
    sensor.getParent = () => ({ getParent: () => data });
    sensor.getPosition = () => new Vector3();
    sensor.getRotation = () => new Euler();
    sensor.shader = { update() { return objects.textures.data._trianglePosData.slice(0, 3); } };
    const captured = sensor.execute(0);
    const rounded = (number) => Math.fround(Number(number.toFixed(6)));
    assert.deepEqual(Array.from(captured), [rounded(expected.x), rounded(expected.y), rounded(expected.z)]);
    const next = createRigidBodyMotionFixture(ObjectDatabase, 10);
    data.objects = () => next.objects;
    assert.equal(flushRigidBodyLidarSolids(data), 10);
    assert.equal(next.triangles[0].a.x, expected.x);
    syncRigidBodyLidarSolids(data, null);
    assert.equal(next.triangles[0].a.x, authored.x);
});
