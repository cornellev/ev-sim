import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { where } from '../util/Math';
import { Triangle } from '../3d/data/objects/Triangle';


export class TriangleOptimizer {
    /**
     * Load a GLTF mesh and prepare it for optimization.
     * Extracts both vertex positions and triangle indices so topology can be preserved.
     * @param {string} resourceURL
     * @param {number} scale
     * @returns {Promise<TriangleOptimizer>}
     */
    static async loadFromGLTF(resourceURL, scale = 1) {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(resourceURL);
        const optimizer = new TriangleOptimizer();

        console.log("GLTF loaded:", gltf);

        const mesh = gltf.scene.children.find(child => child.isMesh);
        if (!mesh) {
            console.error("No mesh found in GLTF");
            return optimizer;
        }

        // Ensure we have a non-indexed geometry so every triplet of positions is a triangle
        const geometry = mesh.geometry.index
            ? mesh.geometry.toNonIndexed()
            : mesh.geometry;

        const positionAttribute = geometry.attributes.position;
        console.log("Position attribute:", positionAttribute.count, "vertices");

        const xAxis = new THREE.Vector3(1, 0, 0);

        for (let i = 0; i < positionAttribute.count; i++) {
            const vertex = new THREE.Vector3().fromBufferAttribute(positionAttribute, i);
            vertex.multiplyScalar(scale);
            vertex.applyAxisAngle(xAxis, -Math.PI / 2);
            optimizer.addVertex(vertex);
        }

        // Each consecutive triplet of vertices forms a triangle
        for (let i = 0; i < positionAttribute.count; i += 3) {
            optimizer.addTriangle(i, i + 1, i + 2);
        }

        console.log(`Loaded ${optimizer.vertices.length} vertices, ${optimizer.triangles.length} triangles`);
        return optimizer;
    }

    constructor() {
        /** @type {THREE.Vector3[]} */
        this.vertices = [];

        /** @type {Array<[number, number, number]>} */
        this.triangles = [];

        /** @type {THREE.Object3D[]} */
        this.sceneObjects = [];
    }

    addVertex(v) {
        this.vertices.push(v);
    }

    addTriangle(i0, i1, i2) {
        this.triangles.push([i0, i1, i2]);
    }

    exportTriangles() {
        const objects = [];
        for (const [i0, i1, i2] of this.triangles) {
            const tri = new Triangle(
                this.vertices[i0],
                this.vertices[i1],
                this.vertices[i2]
            );
            // console.log(tri instanceof Object)
            objects.push(tri);
        }
        return objects;
    }

    /**
     * Simplify the mesh using vertex clustering.
     *
     * Vertices that fall in the same voxel are merged into their centroid.
     * Triangle indices are remapped to cluster representatives, then degenerate
     * and duplicate triangles are pruned — producing a clean low-poly mesh.
     *
     * @param {number} voxelSize  Controls aggressiveness: larger = fewer polygons.
     */
    optimize(voxelSize = 0.5) {
        const originalVertices = this.vertices.length;
        const originalTriangles = this.triangles.length;

        // ── Step 1: assign every vertex to a voxel cluster ──────────────────
        const voxelMap = new Map(); // voxelKey → { sum: Vector3, count: number, clusterIndex: number }
        const vertexToCluster = new Int32Array(this.vertices.length);
        const clusters = [];

        this.vertices.forEach((v, i) => {
            const key = `${Math.floor(v.x / voxelSize)},${Math.floor(v.y / voxelSize)},${Math.floor(v.z / voxelSize)}`;
            if (!voxelMap.has(key)) {
                voxelMap.set(key, { sum: new THREE.Vector3(), count: 0, clusterIndex: clusters.length });
                clusters.push(key);
            }
            const entry = voxelMap.get(key);
            entry.sum.add(v);
            entry.count++;
            vertexToCluster[i] = entry.clusterIndex;
        });

        // ── Step 2: compute centroid for every cluster ───────────────────────
        const clusterCentroids = new Array(clusters.length);
        clusters.forEach((key, idx) => {
            const { sum, count } = voxelMap.get(key);
            clusterCentroids[idx] = sum.clone().divideScalar(count);
        });

        // ── Step 3: remap triangles and remove degenerate / duplicate faces ──
        const seenTriangles = new Set();
        const simplifiedTriangles = [];

        for (const [i0, i1, i2] of this.triangles) {
            const c0 = vertexToCluster[i0];
            const c1 = vertexToCluster[i1];
            const c2 = vertexToCluster[i2];

            // Degenerate: two or more corners collapsed to the same cluster
            if (c0 === c1 || c1 === c2 || c0 === c2) continue;

            // Duplicate: same triangle seen before (independent of winding order)
            const sorted = [c0, c1, c2].sort((a, b) => a - b).join(',');
            if (seenTriangles.has(sorted)) continue;
            seenTriangles.add(sorted);

            simplifiedTriangles.push([c0, c1, c2]);
        }

        // ── Step 4: commit results ───────────────────────────────────────────
        this.vertices = clusterCentroids;
        this.triangles = simplifiedTriangles;

        console.log(
            `Simplified: ${originalVertices} → ${this.vertices.length} vertices`,
            `| ${originalTriangles} → ${this.triangles.length} triangles`,
            `(${(100 - (this.triangles.length / originalTriangles) * 100).toFixed(1)}% reduction)`
        );
    }

    /**
     * Build a Three.js Mesh from the current vertices and triangles.
     * Vertex normals are computed automatically.
     *
     * @param {THREE.Material} [material]
     * @returns {THREE.Mesh}
     */
    buildMesh(material) {
        const geometry = new THREE.BufferGeometry();

        // Flat position array  (3 floats per vertex)
        const positions = new Float32Array(this.vertices.length * 3);
        this.vertices.forEach((v, i) => {
            positions[i * 3]     = v.x;
            positions[i * 3 + 1] = v.y;
            positions[i * 3 + 2] = v.z;
        });
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        // Index buffer
        const indices = new Uint32Array(this.triangles.length * 3);
        this.triangles.forEach(([a, b, c], i) => {
            indices[i * 3]     = a;
            indices[i * 3 + 1] = b;
            indices[i * 3 + 2] = c;
        });
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        geometry.computeVertexNormals();

        const mat = material ?? new THREE.MeshStandardMaterial({
            color: 0x88aacc,
            flatShading: true,   // enhances the low-poly faceted look
            side: THREE.DoubleSide,
        });

        return new THREE.Mesh(geometry, mat);
    }

    /**
     * Add the optimized mesh to a Three.js scene.
     * @param {THREE.Scene} scene
     * @param {THREE.Material} [material]
     */
    addToScene(scene, material) {
        const mesh = this.buildMesh(material);
        scene.add(mesh);
        this.sceneObjects.push(mesh);
        console.log(`Added low-poly mesh: ${this.vertices.length} vertices, ${this.triangles.length} triangles`);
    }

    /**
     * Remove all previously added scene objects.
     * @param {THREE.Scene} scene
     */
    removeFromScene(scene) {
        this.sceneObjects.forEach(obj => scene.remove(obj));
        this.sceneObjects = [];
    }
}