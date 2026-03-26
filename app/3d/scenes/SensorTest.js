import * as THREE from "three";
import { Data } from "../data/Data";
import { wait } from "@/app/util/Wait";
import { Shader, standardVTX } from "../shaders/Shader";
import { TriangleOptimizer } from "@/app/optimization/TriangleOptimizer";
import { Box } from "../data/objects/Box";

const MAX_INTERSECTIONS = 4096;

/**
 * 
 * @param {Data} data 
 * @param {THREE.Scene} scene
 */
export async function SensorTest(data, scene) {
    data.vehicles().vehicles.forEach(vehicle => {
        vehicle.disableControls();
    });

    data.devices().disableLoop();

    data.keys().registerKeyPress("t", async () => {
        console.log("Running sensor test...");
        await runSensorTest(data, scene);
        console.log("Sensor test complete.");
    });

    const optimizer = await TriangleOptimizer.loadFromGLTF("shell/shell.gltf", 0.001);
    optimizer.optimize(0.2);

    const bigCar = data.vehicles().vehicles.find(vehicle => vehicle?.constructor?.name === "BigCar");
    if (bigCar?.sceneObject) {
        const sourceBounds = new THREE.Box3().setFromPoints(optimizer.vertices);
        const sourceSize = sourceBounds.getSize(new THREE.Vector3());
        const sourceCenter = sourceBounds.getCenter(new THREE.Vector3());

        const targetBounds = new THREE.Box3().setFromObject(bigCar.sceneObject);
        const targetSize = targetBounds.getSize(new THREE.Vector3());
        const targetCenter = targetBounds.getCenter(new THREE.Vector3());

        const safeDivide = (a, b) => (Math.abs(b) > 1e-6 ? a / b : 1);
        const bboxScale = new THREE.Vector3(
            safeDivide(targetSize.x, sourceSize.x),
            safeDivide(targetSize.y, sourceSize.y),
            safeDivide(targetSize.z, sourceSize.z)
        );

        const bigCarRotation = bigCar.sceneObject.getWorldQuaternion(new THREE.Quaternion());
        const yawCorrection = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
        const transformed = new THREE.Vector3();

        optimizer.vertices.forEach(vertex => {
            transformed.copy(vertex).sub(sourceCenter);
            transformed.multiply(bboxScale);
            transformed.applyQuaternion(yawCorrection);
            transformed.applyQuaternion(bigCarRotation);
            vertex.copy(transformed).add(targetCenter);
        });
    } else {
        console.warn("SensorTest: BigCar not found, placing optimized mesh at origin.");
    }

    // optimizer.addToScene(scene);
    const triangles = optimizer.exportTriangles();
    data.objects().addObjects(triangles);


    // data.objects().addObject(new Box(
    //     new THREE.Vector3(0, -0.1, 0),
    //     new THREE.Vector3(50, 0.2, 50)
    // ))
    
    data.objects().scene(scene);
}

const frag = `
varying vec2 vUv;

uniform vec3 color;
uniform sampler2D u_pointsTex;
uniform float u_pointsTexWidth;
uniform float u_intersectionCount;
uniform float blotSize;

const int MAX_INTERSECTIONS = ${MAX_INTERSECTIONS};

void main() {
    float coverage = 0.0;
    float sigma = blotSize;
    float denom = max(2.0 * sigma * sigma, 1e-6);

    for (int i = 0; i < MAX_INTERSECTIONS; i++) {
        if (float(i) >= u_intersectionCount) break;

        float x = (float(i) + 0.5) / u_pointsTexWidth;
        vec2 pointUv = texture2D(u_pointsTex, vec2(x, 0.5)).xy;

        vec2 delta = abs(vUv - pointUv);
        delta.x = min(delta.x, 1.0 - delta.x);

        float dist = length(delta);
        float blot = exp(-(dist * dist) / denom);
        coverage += blot;
    }

    float alpha = 1.0 - exp(-1.2 * coverage);
    vec3 outColor = color * pow(alpha, 0.8);
    gl_FragColor = vec4(outColor, alpha);
}
`;

/**
 * 
 * @param {Data} data 
 * @param {THREE.Scene} scene
 */
export async function runSensorTest(data, scene) {
    // first, run the devices to get all data
    await data.devices().asyncExecute();

    await wait(100); // wait a bit to ensure all data is processed and available

    const measureRadius = 5; // radius of the area around the vehicle to measure coverage
    const intersectSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), measureRadius);
    const intersectionTarget = new THREE.Vector3();

    const phiStep = Math.PI / (180 * 2);
    const thetaStep = Math.PI / (180 * 2);
    const w = Math.ceil((2 * Math.PI) / thetaStep);
    const h = Math.ceil(Math.PI / phiStep);
    const maxIntersections = MAX_INTERSECTIONS;
    const pointsData = new Float32Array(maxIntersections * 4);
    let seenIntersections = 0;
    
    const blotSize = 0.008 / 2;
    const normal = new THREE.Vector3();

    pointsData.fill(-10.0);

    const shader = new Shader(w, h, standardVTX, frag, {
        u_pointsTex: { value: null },
        u_pointsTexWidth: { value: maxIntersections },
        u_intersectionCount: { value: 0 },
        color: { value: new THREE.Color(0xff0000) },
        blotSize: { value: blotSize }
    });

    // first, we'll go over all distance data
    for (let device of data.devices().devices) {
        if (!device.enabled) continue;
        if (device.tags.includes("pointcloud")) {
            device.parseDistances();

            for (let i = 0; i < device.distances.length; i++) {
                const dist = device.distances[i];
                if (dist != 0 && dist != device.settings.range) continue; // skip non-zero distances, which are likely valid readings; we're looking for the total coverage, so if it's non-zero, it means it's blocked in that direction and doesn't contribute to coverage

                const angle = device.calculateRayAngle(i);
                if (angle.outOfRange) continue; // skip rays that are out of the device's specified angle range
                
                const vertical = angle.phi ?? angle.vertical;
                const horizontal = angle.theta ?? angle.horizontal;
                if (!Number.isFinite(vertical) || !Number.isFinite(horizontal)) continue;

                // find intersection point with measure sphere
                const rayDir = new THREE.Vector3(
                    Math.cos(vertical) * Math.cos(horizontal),
                    Math.sin(vertical),
                    Math.cos(vertical) * Math.sin(horizontal)
                )
                    .applyEuler(device.getRotation())
                    .normalize();
                
                const rayOrigin = device.getPosition();

                const ray = new THREE.Ray(rayOrigin, rayDir);
                const intersection = ray.intersectSphere(intersectSphere, intersectionTarget);
                if (intersection) {
                    normal.copy(intersectionTarget).normalize();
                    const u = Math.atan2(normal.z, normal.x) / (2 * Math.PI) + 0.5;
                    const v = Math.asin(normal.y) / Math.PI + 0.5;

                    

                    let writeIndex = -1;
                    if (seenIntersections < maxIntersections) {
                        writeIndex = seenIntersections;
                    } else {
                        const replaceIndex = Math.floor(Math.random() * (seenIntersections + 1));
                        if (replaceIndex < maxIntersections) {
                            writeIndex = replaceIndex;
                        }
                    }

                    if (writeIndex >= 0) {
                        pointsData[writeIndex * 4] = 1- u;
                        pointsData[writeIndex * 4 + 1] = v;
                        pointsData[writeIndex * 4 + 2] = 0.0;
                        pointsData[writeIndex * 4 + 3] = 1.0;
                    }

                    seenIntersections += 1;
                }
            }
        }
    }

    const intersectionCount = Math.min(seenIntersections, maxIntersections);

    if (intersectionCount === 0) {
        console.log("SensorTest: no intersections found for origin sphere.");
        return;
    }

    const pointsTexture = new THREE.DataTexture(
        pointsData,
        maxIntersections,
        1,
        THREE.RGBAFormat,
        THREE.FloatType,
    );
    pointsTexture.needsUpdate = true;
    pointsTexture.wrapS = THREE.RepeatWrapping;
    pointsTexture.wrapT = THREE.ClampToEdgeWrapping;
    pointsTexture.minFilter = THREE.NearestFilter;
    pointsTexture.magFilter = THREE.NearestFilter;

    shader.setup(data.renderer);
    shader.update({
        u_pointsTex: { value: pointsTexture },
        u_pointsTexWidth: { value: maxIntersections },
        u_intersectionCount: { value: intersectionCount },
        blotSize: { value: blotSize },
    });

    let sphere = scene.getObjectByName("sensor-test-coverage-sphere");
    if (!sphere) {
        const sphereGeometry = new THREE.SphereGeometry(measureRadius, 64, 32);
        const sphereMaterial = new THREE.MeshBasicMaterial({
            map: shader.getTexture(),
            transparent: true,
            side: THREE.DoubleSide,
        });
        sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
        sphere.name = "sensor-test-coverage-sphere";
        sphere.position.set(0, 0, 0);
        scene.add(sphere);
    } else if (sphere.material && shader.getTexture()) {
        sphere.material.map = shader.getTexture();
        sphere.material.needsUpdate = true;
    }

    console.log(`SensorTest: applied ${intersectionCount} blots to origin sphere texture.`);
}