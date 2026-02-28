
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { where } from '../util/Math';

export function huber(x, delta=0.02) {
    return where(
        x, 
        (i) => i <= delta, 
        (e) => e * e * 0.5,
        (e) => delta*(e - 0.5*delta)
    )
}

export function ellipse_sdf(point, center, radiusX, radiusY) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const px = Math.abs(dx) - radiusX;
    const py = Math.abs(dy) - radiusY;

    if (px > 0 && py > 0) {
        return Math.sqrt(px * px + py * py);
    } else if (px > 0) {
        return px;
    } else if (py > 0) {
        return py;
    } else {
        return -Math.min(-px, -py);
    }
}

export function box_sdf(point, center, sizeX, sizeY) {
    const dx = Math.abs(point.x - center.x) - sizeX;
    const dy = Math.abs(point.y - center.y) - sizeY;
    
    if (dx > 0 && dy > 0) {
        return Math.sqrt(dx * dx + dy * dy);
    } else if (dx > 0) {
        return dx;
    } else if (dy > 0) {
        return dy;
    } else {
        return -Math.min(-dx, -dy);
    }
}

export function plane_sdf(point, planePoint, planeNormal) {
    const toPoint = new THREE.Vector3().subVectors(point, planePoint);
    return toPoint.dot(planeNormal);
}

export function triangle_sdf(point, v0, v1, v2) {
    const edge0 = new THREE.Vector3().subVectors(v1, v0);
    const edge1 = new THREE.Vector3().subVectors(v2, v1);
    const edge2 = new THREE.Vector3().subVectors(v0, v2);

    const normal = new THREE.Vector3().crossVectors(edge0, edge1).normalize();
    const planeDist = plane_sdf(point, v0, normal);

    if (planeDist > 0) {
        return planeDist;
    }

    const c0 = new THREE.Vector3().crossVectors(edge0, new THREE.Vector3().subVectors(point, v0));
    const c1 = new THREE.Vector3().crossVectors(edge1, new THREE.Vector3().subVectors(point, v1));
    const c2 = new THREE.Vector3().crossVectors(edge2, new THREE.Vector3().subVectors(point, v2));

    if (c0.dot(normal) >= 0 && c1.dot(normal) >= 0 && c2.dot(normal) >= 0) {
        return planeDist;
    }

    const distToEdge0 = edge0.clone().projectOnVector(edge0).length();
    const distToEdge1 = edge1.clone().projectOnVector(edge1).length();
    const distToEdge2 = edge2.clone().projectOnVector(edge2).length();

    return Math.min(distToEdge0, distToEdge1, distToEdge2);
}

export class PointOptimizer {
    static async loadFromGLTF(resourceURL, scale = 1) {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(resourceURL);
        const optimizer = new PointOptimizer();

        console.log("GLTF loaded:", gltf);

        const mesh = gltf.scene.children.find(child => child.isMesh);
        if (!mesh) {
            console.error("No mesh found in GLTF");
            return optimizer;
        }

        const geometry = mesh.geometry;
        const positionAttribute = geometry.attributes.position;
        
        console.log("Position attribute:", positionAttribute.count, "vertices");

        for (let i = 0; i < positionAttribute.count; i++) {
            const vertex = new THREE.Vector3().fromBufferAttribute(positionAttribute, i);
            vertex.multiplyScalar(scale);
            // rotate vertex 90 degrees around the X axis
            vertex.applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
            optimizer.addVertex(vertex);
        }

        return optimizer;   
    }

    constructor() {
        this.verticies = [];

        this.sceneObjects = [];

        this.primitives = [];
    }

    optimize(options, rounds=5) {
        const originalVerticies = this.verticies.map(v => v.clone());

        let primitives = [];
        let minScore = Infinity; // todo

        for (let i = 0; i < rounds; i++) {
            this.verticies = originalVerticies.map(v => v.clone());

            // Downsample the point cloud
            this.voxelGrid();
            
            // Convert points to optimized primitives
            this.fitPrimitives(options);

            // Simplify the resulting primitives
            this.reducePrimitives();

            const score = this.grade(originalVerticies);
            if (score < minScore) {
                minScore = score;
                primitives = this.primitives.map(p => p.clone());
            }
        }

        this.primitives = primitives;
    }

    grade(points=[]) {
        let total = 0;

        for (const point of points) {
            let minDist = Infinity;
            for (const primitive of this.primitives) {
                // console.log("Grading point", point, "against primitive", primitive);
                // check what type of primitive this is and compute the appropriate SDF
                let dist = Infinity;
                if (primitive.name === "PlanePrimitive") {
                    // For plane primitives, we can use the plane SDF
                    const planeNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(primitive.quaternion);
                    dist = Math.abs(plane_sdf(point, primitive.position, planeNormal));
                } else if (primitive.name === "ClusterPrimitive") {
                    // For cluster primitives (ellipsoids), we can use the ellipse SDF
                    const localPoint = point.clone().sub(primitive.position).applyQuaternion(primitive.quaternion.clone().invert());
                    dist = ellipse_sdf(localPoint, new THREE.Vector3(0, 0, 0), primitive.scale.x, primitive.scale.y);
                } else if (primitive.name === "MergedPrimitive") {
                    // For merged primitives (also ellipsoids), we can use the ellipse SDF
                    const localPoint = point.clone().sub(primitive.position).applyQuaternion(primitive.quaternion.clone().invert());
                    dist = ellipse_sdf(localPoint, new THREE.Vector3(0, 0, 0), primitive.scale.x, primitive.scale.y);
                }

                if (dist < minDist) {
                    minDist = dist;
                }
            }
            
            total += Math.max(minDist, 0); // add a small epsilon to avoid zero distances
        }

        // multiply total by size of primitives to penalize more for just a big primitive that covers everything
        for (const primitive of this.primitives) {
            const scaleFactor = primitive.scale.x * primitive.scale.y * primitive.scale.z;
            total *= 1 + scaleFactor; // this is a simple heuristic, can be tuned
        }
        
        
        return total;
    }

    /**
     * 
     * @param {THREE.Vector3} vector3 
     */
    addVertex(vector3) {
        this.verticies.push(vector3);
    }

    removeVertex(index) {
        if (index < 0 || index >= this.verticies.length) {
            console.error("Index out of bounds");
            return;
        }
        this.verticies.splice(index, 1);
        
        if (index < 0 || index >= this.sceneObjects.length) {
            return;
        }

        const obj = this.sceneObjects.splice(index, 1)[0];
        if (obj) {
            obj.geometry.dispose();
            obj.material.dispose();
        }
    }

    constructObjects() {
        this.sceneObjects = [];
        this.verticies.forEach(vertex => {
            const point = new THREE.SphereGeometry(0.1, 8, 8);
            const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
            const sphere = new THREE.Mesh(point, material);
            sphere.position.copy(vertex);
            this.sceneObjects.push(sphere);
        });
    }

    /**
     * Extracts primitives from the point cloud.
     * Reduces the point cloud to major planes (boxes) and clusters remaining points.
     * @param {Object} options Configuration for primitive fitting
     */
    fitPrimitives(options = {}) {
        const {
            iterations = 1000,
            distanceThreshold = 0.5,
            minInliers = 20,
            clusterEps = 1.0,
            clusterMinPts = 5
        } = options;

        let remainingVertices = [...this.verticies];

        // 1. RANSAC to recursively find dominant planes
        while (remainingVertices.length > minInliers) {
            let bestPlane = null;
            let bestInliers = [];
            let bestOutliers = [];

            for (let i = 0; i < iterations; i++) {
                // Randomly select 3 points to define a plane
                const i1 = Math.floor(Math.random() * remainingVertices.length);
                const i2 = Math.floor(Math.random() * remainingVertices.length);
                const i3 = Math.floor(Math.random() * remainingVertices.length);

                if (i1 === i2 || i1 === i3 || i2 === i3) continue;

                const p1 = remainingVertices[i1];
                const p2 = remainingVertices[i2];
                const p3 = remainingVertices[i3];

                const plane = new THREE.Plane().setFromCoplanarPoints(p1, p2, p3);

                // Skip invalid planes (collinear points)
                if (plane.normal.lengthSq() < 0.001) continue;

                const inliers = [];
                const outliers = [];

                // Classify points as inliers or outliers
                for (let j = 0; j < remainingVertices.length; j++) {
                    const pt = remainingVertices[j];
                    if (Math.abs(plane.distanceToPoint(pt)) < distanceThreshold) {
                        inliers.push(pt);
                    } else {
                        outliers.push(pt);
                    }
                }

                // Keep the plane with the most inliers
                if (inliers.length > bestInliers.length) {
                    bestInliers = inliers;
                    bestOutliers = outliers;
                    bestPlane = plane;
                }
            }

            // Stop if no good plane can be found
            if (bestInliers.length < minInliers) {
                break; 
            }

        // Create an oriented bounding box or flat mesh primitive for the plane
            this._createConstrainedPlanePrimitive(bestPlane, bestInliers);

            remainingVertices = bestOutliers;
        }

        // 2. Cluster the remaining unstructured noise/details
        this._clusterToEllipsoids(remainingVertices, clusterEps, clusterMinPts);

        // Optionally clear or replace original vertices 
        // to show we've "reduced" the point cloud
        this.verticies = remainingVertices;
    }

    reducePrimitives() {
        // Remove intersecting primitives and merge nearby ones to further simplify the scene
        if (this.primitives.length <= 1) return;

        // console.log(`Starting reduction on ${this.primitives.length} primitives...`);
        const survivingPrimitives = [];
        const mergedIndices = new Set();
        
        // Simple bounding-sphere based heuristic to find extremely overlapping clusters
        for (let i = 0; i < this.primitives.length; i++) {
            if (mergedIndices.has(i)) continue;

            const p1 = this.primitives[i];
            p1.geometry.computeBoundingSphere();
            p1.updateMatrixWorld();
            
            const center1 = p1.geometry.boundingSphere.center.clone().applyMatrix4(p1.matrixWorld);
            const r1 = p1.geometry.boundingSphere.radius * Math.max(p1.scale.x, p1.scale.y, p1.scale.z);

            const clusterToMerge = [p1];

            // Check against remaining primitives
            for (let j = i + 1; j < this.primitives.length; j++) {
                if (mergedIndices.has(j)) continue;

                const p2 = this.primitives[j];
                p2.geometry.computeBoundingSphere();
                p2.updateMatrixWorld();
                
                const center2 = p2.geometry.boundingSphere.center.clone().applyMatrix4(p2.matrixWorld);
                const r2 = p2.geometry.boundingSphere.radius * Math.max(p2.scale.x, p2.scale.y, p2.scale.z);

                const distance = center1.distanceTo(center2);

                // If primitives heavily intersect (centroids are within each other's boundaries)
                if (distance < (r1 + r2) * 0.6) {
                    clusterToMerge.push(p2);
                    mergedIndices.add(j);
                }
            }

            if (clusterToMerge.length === 1) {
                survivingPrimitives.push(p1);
            } else {
                // We have intersecting geometry, let's merge them into one larger unified bounding shape
                const mergedMesh = this._mergeClusterMeshes(clusterToMerge);
                if (mergedMesh) {
                    survivingPrimitives.push(mergedMesh);
                }
            }
        }

        // console.log(`Reduced down to ${survivingPrimitives.length} final primitives.`);
        this.primitives = survivingPrimitives;
    }

    _mergeClusterMeshes(cluster) {
        // Collect all world-transformed vertices of the cluster
        const points = [];
        for (const mesh of cluster) {
            mesh.updateMatrixWorld();
            const geometry = mesh.geometry.clone();
            geometry.applyMatrix4(mesh.matrixWorld);
            
            const positionAttribute = geometry.getAttribute('position');
            for (let i = 0; i < positionAttribute.count; i++) {
                points.push(new THREE.Vector3().fromBufferAttribute(positionAttribute, i));
            }
        }

        // Just like our clustering logic above, find the centroid and min/max extents
        const center = new THREE.Vector3();
        for (const pt of points) center.add(pt);
        center.divideScalar(points.length);

        const minLocal = new THREE.Vector3(Infinity, Infinity, Infinity);
        const maxLocal = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

        for (const pt of points) {
            const local = new THREE.Vector3().subVectors(pt, center);
            minLocal.min(local);
            maxLocal.max(local);
        }

        const rx = Math.max(Math.abs(minLocal.x), Math.abs(maxLocal.x));
        const ry = Math.max(Math.abs(minLocal.y), Math.abs(maxLocal.y));
        const rz = Math.max(Math.abs(minLocal.z), Math.abs(maxLocal.z));

        // Create one single big ellipsoid
        const geometry = new THREE.SphereGeometry(1, 16, 16);
        const material = new THREE.MeshStandardMaterial({ 
            color: new THREE.Color().setHSL(Math.random(), 0.8, 0.5),
            transparent: true,
            opacity: 0.6,
            roughness: 0.8,
            metalness: 0.2
        });

        const unifiedMesh = new THREE.Mesh(geometry, material);
        unifiedMesh.scale.set(rx, ry, rz);
        unifiedMesh.position.copy(center);
        unifiedMesh.name = "MergedPrimitive";

        return unifiedMesh;
    }

    _createConstrainedPlanePrimitive(plane, points) {
        // Find the convex hull of the planar points and create a flat polygon mesh
        // instead of an arbitrary bounding box, which looks much cleaner.
        
        // 1. Determine local axes heavily aligned to the plane normal
        const zAxis = plane.normal.clone().normalize();
        let up = new THREE.Vector3(0, 1, 0);
        if (Math.abs(zAxis.dot(up)) > 0.99) {
            up.set(1, 0, 0);
        }
        const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
        const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();

        const rotationMatrix = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
        const inverseRotation = new THREE.Matrix4().copy(rotationMatrix).invert();

        // 2. Project points to local 2D space (Z is roughly 0)
        let points2d = [];
        let centerLocalZ = 0;
        for (const pt of points) {
            const localPt = pt.clone().applyMatrix4(inverseRotation);
            points2d.push(new THREE.Vector2(localPt.x, localPt.y));
            centerLocalZ += localPt.z;
        }
        centerLocalZ /= points.length;

        // 3. Compute 2D Convex Hull (Graham Scan or Monotone Chain)
        // Sort points by X, then by Y
        points2d.sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);

        const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        let lower = [];
        for (let i = 0; i < points2d.length; i++) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points2d[i]) <= 0) {
                lower.pop();
            }
            lower.push(points2d[i]);
        }

        let upper = [];
        for (let i = points2d.length - 1; i >= 0; i--) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points2d[i]) <= 0) {
                upper.pop();
            }
            upper.push(points2d[i]);
        }
        
        upper.pop();
        lower.pop();
        const hull2d = lower.concat(upper);
        if (hull2d.length < 3) return; // Need at least a triangle

        // 4. Triangulate the polygon to create a custom mesh
        const shape = new THREE.Shape(hull2d);
        const geometry = new THREE.ShapeGeometry(shape);
        
        // Translate Z back relative to plane
        geometry.translate(0, 0, centerLocalZ);

        const material = new THREE.MeshStandardMaterial({ 
            color: new THREE.Color().setHSL(Math.random(), 0.8, 0.5),
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.8,
            roughness: 0.3,
            metalness: 0.1
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "PlanePrimitive";
        // Position mesh correctly in world
        mesh.applyMatrix4(rotationMatrix);
        this.primitives.push(mesh);
    }

    _clusterToEllipsoids(points, eps, minPts) {
        const visited = new Set();
        const clusters = [];

        // Simple DBSCAN-like region growing to group nearby isolated points
        for (let i = 0; i < points.length; i++) {
            if (visited.has(i)) continue;

            const cluster = [];
            const queue = [i];
            visited.add(i);

            while (queue.length > 0) {
                const currentIdx = queue.shift();
                const currentPt = points[currentIdx];
                cluster.push(currentPt);

                // Find neighbors
                let neighbors = [];
                for (let j = 0; j < points.length; j++) {
                    if (!visited.has(j) && currentPt.distanceTo(points[j]) < eps) {
                        neighbors.push(j);
                    }
                }

                if (neighbors.length >= minPts) {
                    for (const neighbor of neighbors) {
                        if (!visited.has(neighbor)) {
                            visited.add(neighbor);
                            queue.push(neighbor);
                        }
                    }
                }
            }

            if (cluster.length >= minPts) {
                clusters.push(cluster);
            }
        }

        // Fit an enclosing Ellipsoid (Sphere with scaling) for each remaining cluster
        for (const cluster of clusters) {
            // Find centroid (center) of cluster
            const center = new THREE.Vector3();
            for (const pt of cluster) {
                center.add(pt);
            }
            center.divideScalar(cluster.length);

            // Find bounds from center to determine axes scales
            const minBoundsLocal = new THREE.Vector3(Infinity, Infinity, Infinity);
            const maxBoundsLocal = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

            for (const pt of cluster) {
                const local = new THREE.Vector3().subVectors(pt, center);
                minBoundsLocal.min(local);
                maxBoundsLocal.max(local);
            }

            // Radius scales based on extents (width, height, depth of cluster)
            const rx = Math.max(Math.max(Math.abs(minBoundsLocal.x), Math.abs(maxBoundsLocal.x)), 0.1);
            const ry = Math.max(Math.max(Math.abs(minBoundsLocal.y), Math.abs(maxBoundsLocal.y)), 0.1);
            const rz = Math.max(Math.max(Math.abs(minBoundsLocal.z), Math.abs(maxBoundsLocal.z)), 0.1);

            // Create a base sphere and scale it to mimic an ellipsoid
            const baseRadius = 1;
            const geometry = new THREE.SphereGeometry(baseRadius, 16, 16);
            
            const material = new THREE.MeshStandardMaterial({ 
                color: new THREE.Color().setHSL(Math.random(), 0.8, 0.5),
                transparent: true,
                opacity: 0.6,
                roughness: 0.8,
                metalness: 0.2
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.scale.set(rx, ry, rz);
            mesh.position.copy(center);
            mesh.name = "ClusterPrimitive";

            this.primitives.push(mesh);
        }
    }

    addPrimitives(scene) {
        this.primitives.forEach(primitive => {
            scene.add(primitive);
        });
        console.log("Added", this.primitives.length, "primitives to the scene");
    }

    /**
     * 
     * @param {THREE.Scene} scene 
     */
    addToScene(scene) {
        this.sceneObjects.forEach(obj => scene.add(obj));
        console.log("Added", this.sceneObjects.length, "points to the scene");
        // this.sceneObjects.forEach((obj, index) => {
        //     console.log("Point", index, "position:", obj.position);
        // });
    }

    voxelGrid() {
        // first pass: need to create a voxel grid and assign each point to a voxel
        const voxelSize = 0.5; // size of each voxel
        const voxelMap = new Map(); // map of voxel coordinates to points

        this.verticies.forEach(vertex => {
            const voxelX = Math.floor(vertex.x / voxelSize);
            const voxelY = Math.floor(vertex.y / voxelSize);
            const voxelZ = Math.floor(vertex.z / voxelSize);
            const key = `${voxelX},${voxelY},${voxelZ}`;

            if (!voxelMap.has(key)) {
                voxelMap.set(key, []);
            }
            voxelMap.get(key).push(vertex);
        });

        // second pass: for each voxel, compute the centroid of the points and create a new point at the centroid
        const optimizedPoints = [];
        voxelMap.forEach(points => {
            const centroid = new THREE.Vector3(0, 0, 0);
            points.forEach(point => centroid.add(point));
            centroid.divideScalar(points.length);
            optimizedPoints.push(centroid);
        });

        // replace the original verticies with the optimized points
        this.verticies = optimizedPoints;
    }

    remove_statistical_outliers(k = 8, threshold = 1.0) {
        // for each point, find the k nearest neighbors and compute the average distance to the neighbors
        const distances = this.verticies.map(vertex => {
            const neighborDistances = this.verticies.map(other => vertex.distanceTo(other)).sort((a, b) => a - b);
            const avgDistance = neighborDistances.slice(1, k + 1).reduce((sum, d) => sum + d, 0) / k;
            return avgDistance;
        });

        // compute the mean and standard deviation of the distances
        const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
        const stdDev = Math.sqrt(distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length);

        // remove points that are farther than the threshold times the standard deviation from the mean
        const filteredVerticies = this.verticies.filter((vertex, index) => distances[index] <= mean + threshold * stdDev);

        // update the verticies
        this.verticies = filteredVerticies;
    }


}
