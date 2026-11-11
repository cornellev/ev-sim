import { Vector3 } from "three";
import { Triangle } from "../../app/3d/data/objects/Triangle.js";

export function createRigidBodyMotionFixture(ObjectDatabase, triangleCount, bodyCount = 1) {
    const objects = new ObjectDatabase({});
    const triangles = Array.from({ length: triangleCount }, (_, index) => {
        const triangle = new Triangle(new Vector3(5, index, 0), new Vector3(5, index + 1, 0), new Vector3(5, index, 1));
        triangle.environmentGeometryType = "asset-lidar";
        triangle.environmentSourceId = `body-${index % bodyCount}`;
        triangle.lidarTwinId = `body-${index % bodyCount}:triangle:${index}`;
        triangle.lidarTriangleIndex = index;
        return triangle;
    });
    objects.replaceTriangles(() => false, triangles);
    const poses = Array.from({ length: bodyCount }, (_, index) => ({
        id: `body-${index}`,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        spawnPosition: { x: 0, y: 0, z: 0 },
        spawnRotation: { x: 0, y: 0, z: 0, w: 1 },
    }));
    return { data: { objects: () => objects }, objects, triangles, poses };
}
