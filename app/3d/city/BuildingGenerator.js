import * as THREE from "three";
import { Triangle } from "../data/objects/Triangle.js";
import { SeededRNG } from "../../util/SeededRNG.js";
import { buildingIdFromFootprint } from "./buildingIds.js";

/**
 * @typedef {import("../environment/visualization/BakeRunConfig").BuildingRecord} BuildingRecord
 */

/**
 * @param {{ x: number, y: number, z: number }[]} footprint
 * @param {number} index
 * @returns {string}
 */
export { buildingIdFromFootprint } from "./buildingIds.js";

/**
 * @param {THREE.Vector3[]} footprint
 * @returns {{ x: number, y: number, z: number }[]}
 */
function serializeFootprint(footprint) {
    return footprint.map((point) => ({
        x: point.x,
        y: point.y,
        z: point.z,
    }));
}

function partitionLength(totalLength, minWidth, maxWidth, variation, rng) {
    if (totalLength <= 0) return [];
    if (totalLength < minWidth) return [totalLength];
    if (totalLength <= maxWidth) return [totalLength];

    const minCount = Math.ceil(totalLength / maxWidth);
    const maxCount = Math.floor(totalLength / minWidth);

    if (minCount > maxCount) {
        return [totalLength];
    }

    const targetWidth = (minWidth + maxWidth) * 0.5;
    let count = Math.round(totalLength / targetWidth);
    count = THREE.MathUtils.clamp(count, minCount, maxCount);

    const baseWidth = totalLength / count;
    const widths = new Array(count).fill(baseWidth);

    if (variation > 0 && count > 1) {
        for (let pass = 0; pass < count * 3; pass++) {
            const i = rng.int(count - 1);

            const maxPositive = Math.min(
                widths[i] - minWidth,
                maxWidth - widths[i + 1],
                baseWidth * variation,
            );

            const maxNegative = Math.min(
                maxWidth - widths[i],
                widths[i + 1] - minWidth,
                baseWidth * variation,
            );

            const delta = THREE.MathUtils.lerp(-maxNegative, maxPositive, rng.next());

            widths[i] -= delta;
            widths[i + 1] += delta;
        }
    }

    return widths;
}

function makeFootprintsForSide(start, end, normal, params, rng) {
    const tangentVec = new THREE.Vector3().subVectors(end, start).setY(0);
    const totalLength = tangentVec.length();
    if (totalLength < 0.001) return [];

    const tangent = tangentVec.clone().normalize();

    const inset = Math.min(params.intersectionInset, totalLength * 0.45);
    const usableStart = inset;
    const usableLength = totalLength - inset * 2;

    if (usableLength < params.minWidth) return [];

    const widths = partitionLength(
        usableLength,
        params.minWidth,
        params.maxWidth,
        0.3,
        rng,
    );

    const footprints = [];
    let cursor = usableStart;

    for (const width of widths) {
        const s0 = cursor;
        const s1 = cursor + width;

        const p0 = start.clone()
            .add(tangent.clone().multiplyScalar(s0))
            .add(normal.clone().multiplyScalar(params.depthOffRoad));

        const p1 = start.clone()
            .add(tangent.clone().multiplyScalar(s0))
            .add(normal.clone().multiplyScalar(params.depthOffRoad + params.buildingDepth));

        const p2 = start.clone()
            .add(tangent.clone().multiplyScalar(s1))
            .add(normal.clone().multiplyScalar(params.depthOffRoad + params.buildingDepth));

        const p3 = start.clone()
            .add(tangent.clone().multiplyScalar(s1))
            .add(normal.clone().multiplyScalar(params.depthOffRoad));

        footprints.push([p0, p1, p2, p3]);
        cursor = s1;
    }

    return footprints;
}

function toXZ(v) {
    return new THREE.Vector2(v.x, v.z);
}

function getFootprintAxes(footprint) {
    const pts = footprint.map(toXZ);

    const edge0 = pts[1].clone().sub(pts[0]).normalize();
    const edge1 = pts[3].clone().sub(pts[0]).normalize();

    return [edge0, edge1];
}

function projectFootprint(axis, footprint) {
    let min = Infinity;
    let max = -Infinity;

    for (const p3 of footprint) {
        const p = toXZ(p3);
        const d = p.dot(axis);
        if (d < min) min = d;
        if (d > max) max = d;
    }

    return { min, max };
}

function intervalsOverlap(a, b, padding = 0) {
    return a.max > b.min + padding && b.max > a.min + padding;
}

function footprintsOverlap(a, b, padding = 0) {
    const axes = [...getFootprintAxes(a), ...getFootprintAxes(b)];

    for (const axis of axes) {
        const projA = projectFootprint(axis, a);
        const projB = projectFootprint(axis, b);

        if (!intervalsOverlap(projA, projB, padding)) {
            return false;
        }
    }

    return true;
}

function footprintAreaXZ(footprint) {
    const a = toXZ(footprint[0]);
    const b = toXZ(footprint[1]);
    const d = toXZ(footprint[3]);

    const width = d.distanceTo(a);
    const depth = b.distanceTo(a);
    return width * depth;
}

function filterOverlappingFootprints(footprints, padding = 0.1) {
    const sorted = [...footprints].sort(
        (a, b) => footprintAreaXZ(b) - footprintAreaXZ(a),
    );

    const accepted = [];

    for (const candidate of sorted) {
        let overlaps = false;

        for (const existing of accepted) {
            if (footprintsOverlap(candidate, existing, padding)) {
                overlaps = true;
                break;
            }
        }

        if (!overlaps) {
            accepted.push(candidate);
        }
    }

    return accepted;
}

/**
 * Extract world-space triangles from an extruded building mesh.
 * @param {THREE.Mesh} mesh
 * @returns {Triangle[]}
 */
export function trianglesFromBuildingMesh(mesh) {
    const geometry = mesh.geometry;
    if (!geometry?.attributes?.position) return [];

    mesh.updateMatrixWorld(true);
    const position = geometry.attributes.position;
    const index = geometry.index;
    const triangles = [];

    const pushTriangle = (ia, ib, ic) => {
        const a = new THREE.Vector3().fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
        const b = new THREE.Vector3().fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
        const c = new THREE.Vector3().fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
        const triangle = new Triangle(a, b, c);
        triangle.setTags(["building"]);
        triangle.visible = false;
        triangles.push(triangle);
    };

    if (index) {
        for (let i = 0; i < index.count; i += 3) {
            pushTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        }
    } else {
        for (let i = 0; i < position.count; i += 3) {
            pushTriangle(i, i + 1, i + 2);
        }
    }

    return triangles;
}

/**
 * @param {THREE.Scene} scene
 * @param {import("../data/Data").Data} data
 * @param {Object} [options]
 * @returns {BuildingRecord[]}
 */
export function generateBuildings(scene, data, options = {}) {
    const roads = data.city().getRoads();
    const seed = options.seed ?? data.bakeRunConfig?.()?.seed ?? 42;
    const rng = options.rng ?? new SeededRNG(seed);
    const records = Array.isArray(options.records) ? options.records : null;

    const params = {
        depthOffRoad: 2,
        buildingDepth: 5,
        minWidth: 5,
        maxWidth: 20,
        heightRange: [6, 14],
        intersectionInset: 0,
        overlapPadding: 0.2,
        debugTileMaterials: options.debugTileMaterials === true,
        debugTileSize: options.debugTileSize ?? 2,
        ...options.params,
    };

    if (records?.length) {
        return rehydrateBuildings(scene, data, records, params);
    }

    const rectangles = [];

    for (const road of roads) {
        const leftPoints = road.roadEdges.left;
        const rightPoints = road.roadEdges.right;

        const leftStart = leftPoints[0].clone().setY(0);
        const leftEnd = leftPoints[leftPoints.length - 1].clone().setY(0);

        const up = new THREE.Vector3(0, 1, 0);
        const tangent = new THREE.Vector3().subVectors(leftEnd, leftStart).setY(0).normalize();

        const leftNormal = new THREE.Vector3().crossVectors(up, tangent).normalize();
        const rightNormal = leftNormal.clone().negate();

        const rightStart = rightPoints[0].clone().setY(0);
        const rightEnd = rightPoints[rightPoints.length - 1].clone().setY(0);

        const roadRng = rng.fork(`road-${leftStart.x.toFixed(2)}-${leftStart.z.toFixed(2)}`);

        rectangles.push(
            ...makeFootprintsForSide(leftStart, leftEnd, leftNormal, params, roadRng),
            ...makeFootprintsForSide(rightStart, rightEnd, rightNormal, params, roadRng.fork("right")),
        );
    }

    const filtered = filterOverlappingFootprints(
        rectangles,
        params.overlapPadding,
    );

    console.log(
        "Generated",
        rectangles.length,
        "building footprints,",
        filtered.length,
        "after filtering overlaps",
    );

    return generateBuildingMeshes(scene, data, filtered, params, rng);
}

/**
 * @param {THREE.Scene} scene
 * @param {import("../data/Data").Data} data
 * @param {BuildingRecord[]} records
 * @param {Object} params
 * @returns {BuildingRecord[]}
 */
function rehydrateBuildings(scene, data, records, params) {
    const footprints = records.map((record) =>
        record.footprint.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
    );

    const rng = new SeededRNG(records[0]?.buildingId ?? "rehydrate");
    return generateBuildingMeshes(scene, data, footprints, params, rng, records);
}

function chooseTexture(rng, maxIndex = 6) {
    const basePath = "assets/textures/buildings/";
    const index = rng.intRange(1, maxIndex);
    return { path: `${basePath}${index}.jpg`, textureId: index };
}

function hashStringToUnit(value) {
    let hash = 2166136261;
    const input = String(value ?? "building");
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 0xffffffff;
}

function createDebugTileMaterial(buildingId, tileSize = 2) {
    const baseColor = new THREE.Color().setHSL(hashStringToUnit(buildingId), 0.78, 0.56);

    return new THREE.ShaderMaterial({
        uniforms: {
            uBaseColor: { value: baseColor },
            uTileSize: { value: Math.max(0.1, tileSize) },
        },
        vertexShader: `
            varying vec3 vWorldPosition;
            varying vec3 vWorldNormal;

            void main() {
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPosition.xyz;
                vWorldNormal = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * viewMatrix * worldPosition;
            }
        `,
        fragmentShader: `
            uniform vec3 uBaseColor;
            uniform float uTileSize;
            varying vec3 vWorldPosition;
            varying vec3 vWorldNormal;

            void main() {
                vec3 normal = normalize(vWorldNormal);
                vec3 absNormal = abs(normal);
                vec3 sideTint = vec3(1.0);

                if (absNormal.y >= absNormal.x && absNormal.y >= absNormal.z) {
                    sideTint = normal.y >= 0.0 ? vec3(1.25, 1.12, 0.72) : vec3(0.65, 0.85, 1.15);
                } else if (absNormal.x >= absNormal.z) {
                    sideTint = normal.x >= 0.0 ? vec3(1.22, 0.72, 0.78) : vec3(0.72, 1.18, 0.82);
                } else {
                    sideTint = normal.z >= 0.0 ? vec3(0.78, 0.92, 1.25) : vec3(1.22, 0.82, 1.18);
                }

                vec3 tile = vWorldPosition / uTileSize;
                vec3 fracTile = fract(tile);
                float checker = mod(floor(tile.x) + floor(tile.y) + floor(tile.z), 2.0);
                float grid = max(
                    max(1.0 - step(0.04, fracTile.x), step(0.96, fracTile.x)),
                    max(
                        max(1.0 - step(0.04, fracTile.y), step(0.96, fracTile.y)),
                        max(1.0 - step(0.04, fracTile.z), step(0.96, fracTile.z))
                    )
                );

                vec3 color = clamp(uBaseColor * sideTint, 0.0, 1.0);
                color = mix(color * 0.72, min(color * 1.22, vec3(1.0)), checker * 0.55);
                color = mix(color, vec3(0.02), grid * 0.85);
                gl_FragColor = vec4(color, 1.0);
            }
        `,
        side: THREE.FrontSide,
        toneMapped: false,
    });
}

/**
 * @param {THREE.Scene} scene
 * @param {import("../data/Data").Data} data
 * @param {THREE.Vector3[][]} footprints
 * @param {Object} params
 * @param {SeededRNG} rng
 * @param {BuildingRecord[]} [presetRecords]
 * @returns {BuildingRecord[]}
 */
function generateBuildingMeshes(scene, data, footprints, params, rng, presetRecords = null) {
    const meshes = [];
    const buildingRecords = [];
    let debugTileMaterialCount = 0;

    footprints.forEach((footprint, index) => {
        if (!footprint || footprint.length < 3) return;

        const preset = presetRecords?.[index];
        const serialized = preset?.footprint ?? serializeFootprint(footprint);
        const buildingId = preset?.buildingId ?? buildingIdFromFootprint(serialized, index);
        const lotRng = rng.fork(buildingId);

        const height = preset?.height ?? THREE.MathUtils.lerp(
            params.heightRange[0],
            params.heightRange[1],
            lotRng.next(),
        );

        let points2D = footprint.map((p) => new THREE.Vector2(p.x, -p.z));

        if (THREE.ShapeUtils.isClockWise(points2D)) {
            points2D = points2D.reverse();
        }

        const shape = new THREE.Shape(points2D);

        const geometry = new THREE.ExtrudeGeometry(shape, {
            steps: 1,
            depth: height,
            bevelEnabled: false,
        });

        geometry.rotateX(-Math.PI / 2);
        geometry.computeBoundingBox();
        if (geometry.boundingBox) {
            geometry.translate(0, -geometry.boundingBox.min.y, 0);
        }
        geometry.computeVertexNormals();

        const textureChoice = preset?.textureId
            ? { path: `assets/textures/buildings/${preset.textureId}.jpg`, textureId: preset.textureId }
            : chooseTexture(lotRng);

        let material;
        if (params.debugTileMaterials === true) {
            material = createDebugTileMaterial(buildingId, params.debugTileSize);
            debugTileMaterialCount += 1;
        } else {
            const texture = new THREE.TextureLoader().load(textureChoice.path);
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.repeat.set(1, height / 10);
            material = new THREE.MeshStandardMaterial({
                map: texture,
                side: THREE.FrontSide,
            });
        }

        const meshName = preset?.meshName ?? `Building:${buildingId}`;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = meshName;
        mesh.userData.buildingId = buildingId;
        mesh.userData.bakeObjectId = buildingId;
        mesh.userData.bakeTags = preset?.tags ?? ["building"];

        scene.add(mesh);
        meshes.push(mesh);

        const triangles = trianglesFromBuildingMesh(mesh);
        if (data?.objects?.()) {
            data.objects().addObjects(triangles);
        }

        buildingRecords.push({
            buildingId,
            footprint: serialized,
            height,
            textureId: textureChoice.textureId,
            tags: preset?.tags ?? ["building"],
            meshName,
        });
    });

    if (data?.bakeRunConfig?.()) {
        data.bakeRunConfig().setBuildings(buildingRecords);
    }

    if (params.debugTileMaterials === true) {
        // #region agent log
        fetch('http://127.0.0.1:7888/ingest/39c56e68-cc15-4bd9-8cfa-9d0d2daf2b74',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8f4404'},body:JSON.stringify({sessionId:'8f4404',runId:data?.bakeRunConfig?.()?.runId ?? 'bake-igvc',hypothesisId:'H14',location:'BuildingGenerator.js:debug-tile-materials',message:'IGVC building debug tile materials assigned at generation time',data:{buildingCount:buildingRecords.length,debugTileMaterialCount,tileSize:params.debugTileSize ?? 2,buildingIds:buildingRecords.slice(0,12).map((record)=>record.buildingId)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
    }

    return buildingRecords;
}
