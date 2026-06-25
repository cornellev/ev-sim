import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import {
    activeBuildingAllowsPoint,
    CoverageGrid,
    sampleColor,
    srgbToLinearColor,
    worldToPixel,
} from "./LidarSplatProjector";
import {
    maskAllowsPixel,
    pixelInSliver,
} from "./BakeImageMask";

function roundNumber(value, digits = 3) {
    return Number(value?.toFixed?.(digits) ?? value);
}

function serializeRgb(rgb) {
    if (!rgb) return null;
    return {
        r: roundNumber(rgb.r),
        g: roundNumber(rgb.g),
        b: roundNumber(rgb.b),
    };
}

function classifyRgb(rgb) {
    if (!rgb) return "missing";
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    if (rgb.b > 0.45 && rgb.b > rgb.r + 0.12 && rgb.b >= rgb.g) return "sky_like";
    if (max < 0.22) return "dark_road_like";
    if (max - min < 0.08 && max < 0.55) return "gray_road_like";
    return "other";
}

function incrementCount(map, key) {
    const id = key || "unknown";
    map[id] = (map[id] ?? 0) + 1;
}

function expectedPixelFromAngles(point, intrinsics, prefix = "") {
    if (point.cameraPlane && intrinsics) {
        return {
            px: Math.round(intrinsics.fx * point.cameraPlane.x + intrinsics.cx),
            py: Math.round(intrinsics.fy * point.cameraPlane.y + intrinsics.cy),
        };
    }

    const thetaDeg = prefix === "shader" ? point.shaderThetaDeg : point.thetaDeg;
    const phiDeg = prefix === "shader" ? point.shaderPhiDeg : point.phiDeg;
    if (thetaDeg === undefined || phiDeg === undefined || !intrinsics) return null;

    const thetaRad = THREE.MathUtils.degToRad(thetaDeg);
    const phiRad = THREE.MathUtils.degToRad(phiDeg);
    const cosTheta = Math.cos(thetaRad);
    if (Math.abs(cosTheta) < 1e-6) return null;

    const px = Math.round(intrinsics.fx * Math.tan(thetaRad) + intrinsics.cx);
    const py = Math.round(intrinsics.fy * (Math.tan(phiRad) / cosTheta) + intrinsics.cy);
    return { px, py };
}

function pixelDelta(a, b) {
    if (!a || !b) return null;
    return {
        dx: a.px - b.px,
        dy: a.py - b.py,
    };
}

function cameraOriginFromMatrix(matrixWorld) {
    if (!matrixWorld?.length) return null;
    const matrix = new THREE.Matrix4().fromArray(matrixWorld);
    return new THREE.Vector3().setFromMatrixPosition(matrix);
}

function findNearestMeshHit(raycaster, objects, origin, world) {
    if (!origin || !world || objects.length === 0) return null;
    const direction = world.clone().sub(origin);
    const targetDistance = direction.length();
    if (targetDistance <= 1e-6) return null;

    raycaster.set(origin, direction.normalize());
    raycaster.near = 0;
    raycaster.far = targetDistance + 0.5;
    const hit = raycaster.intersectObjects(objects, false)[0] ?? null;
    if (!hit) {
        return {
            targetDistance: roundNumber(targetDistance),
            nearestDistance: null,
            behindMeshSurface: false,
        };
    }

    return {
        targetDistance: roundNumber(targetDistance),
        nearestDistance: roundNumber(hit.distance),
        objectBuildingId: effectiveBuildingId(hit.object),
        behindMeshSurface: hit.distance < targetDistance - 0.05,
    };
}

function effectiveBuildingId(object) {
    let current = object;
    while (current) {
        if (current.userData?.buildingId) return current.userData.buildingId;
        current = current.parent;
    }
    return null;
}

/**
 * Incrementally builds a Spark Gaussian splat cloud from sequential bake frames.
 */
export class SplatAccumulator {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} [options]
     */
    constructor(scene, options = {}) {
        this.scene = scene;
        this.maxSplats = options.maxSplats ?? 500000;
        this.coverageVoxelSize = options.coverageVoxelSize ?? 0.25;
        this.hideThreshold = options.hideThreshold ?? 50;

        this.coverageGrid = new CoverageGrid(this.coverageVoxelSize);
        /** @type {Map<string, number>} */
        this.buildingCounts = new Map();
        /** @type {Set<string>} */
        this.hiddenBuildings = new Set();

        this.mesh = null;
        this.ready = Promise.resolve();
        this._createMesh();

        this._accumulatorId = `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    _createMesh() {
        this.mesh = new SplatMesh({
            maxSplats: this.maxSplats,
            editable: true,
        });
        this.ready = this.mesh.initialized;
        this.scene.add(this.mesh);
    }

    reset() {
        if (this.hiddenBuildings.size > 0) {
            this.scene.traverse((object) => {
                const buildingId = effectiveBuildingId(object);
                if (buildingId && this.hiddenBuildings.has(buildingId)) {
                    object.visible = true;
                }
            });
        }

        if (this.mesh?.parent) {
            this.mesh.parent.remove(this.mesh);
        }

        this.coverageGrid = new CoverageGrid(this.coverageVoxelSize);
        this.buildingCounts.clear();
        this.hiddenBuildings.clear();
        this._createMesh();
    }

    /**
     * @returns {number}
     */
    get splatCount() {
        return this.mesh?.packedSplats?.numSplats ?? 0;
    }

    /**
     * Best-effort debug attribution for a world point against existing building
     * meshes. This is intentionally only used for runtime diagnostics.
     * @param {THREE.Vector3} world
     * @returns {string|null}
     */
    _nearestBuildingIdForPoint(world) {
        let nearestId = null;
        let nearestDistance = Infinity;
        const box = new THREE.Box3();
        const expanded = new THREE.Box3();

        this.scene.traverse((object) => {
            const buildingId = effectiveBuildingId(object);
            if (!buildingId || !object.isMesh) return;

            box.setFromObject(object);
            expanded.copy(box).expandByScalar(this.coverageVoxelSize * 2);
            if (!expanded.containsPoint(world)) return;

            const distance = box.distanceToPoint(world);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestId = buildingId;
            }
        });

        return nearestId;
    }

    /**
     * @param {Object[]} filteredPoints
     * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number }} bakedImage
     * @param {Object} options
     * @returns {Promise<{ committed: number, buildingCounts: Map<string, number> }>}
     */
    async commitSliver(filteredPoints, bakedImage, options = {}) {
        await this.ready;

        const intrinsics = options.intrinsics;
        const matrixWorld = options.matrixWorld;
        const radius = options.radius ?? 0.06;
        const adaptiveRadius = options.adaptiveRadius !== false;
        const maxPointsPerFrame = options.maxPointsPerFrame ?? 20000;
        const buildingId = options.buildingId ?? null;
        const coverageNeighbor = options.coverageNeighbor !== false;
        const maskImage = options.maskImage ?? null;
        const buildingMaskImage = options.buildingMaskImage ?? null;
        const sliverBounds = options.sliverBounds ?? null;
        const debugSamples = [];
        const projectionDiagnostics = [];
        const debugColorBuckets = {};
        const debugCommittedBuildingCounts = {};
        const debugCommittedColorByBuilding = {};
        let skippedCovered = 0;
        let skippedNoPixel = 0;
        let skippedNoColor = 0;
        let skippedMasked = 0;
        let skippedBuildingMask = 0;
        let skippedSliver = 0;
        let skippedWrongBuilding = 0;

        // Raw framebuffer reads are already linear; decoded model PNGs are sRGB.
        const isSrgb = (bakedImage.colorSpace ?? "linear") === "srgb";

        const sorted = [...filteredPoints].sort((a, b) => a.distance - b.distance);
        const identityQuat = new THREE.Quaternion();
        const cameraOrigin = cameraOriginFromMatrix(matrixWorld);
        const raycaster = new THREE.Raycaster();
        const meshOcclusionObjects = [];
        this.scene.traverse((object) => {
            if (object.isMesh && object.visible && effectiveBuildingId(object)) {
                meshOcclusionObjects.push(object);
            }
        });
        let committed = 0;

        for (const point of sorted) {
            if (committed >= maxPointsPerFrame) break;
            const covered = coverageNeighbor
                ? this.coverageGrid.hasNeighbor(point.world)
                : this.coverageGrid.has(point.world);
            if (covered) {
                skippedCovered += 1;
                continue;
            }

            const pixel = worldToPixel(point.world, intrinsics, matrixWorld);
            if (!pixel) {
                skippedNoPixel += 1;
                continue;
            }
            if (!pixelInSliver(pixel.px, sliverBounds)) {
                skippedSliver += 1;
                continue;
            }
            const maskAllowed = maskAllowsPixel(maskImage, pixel.px, pixel.py);
            const buildingMaskAllowed = maskAllowsPixel(buildingMaskImage, pixel.px, pixel.py);
            const attributedBuildingId = this._nearestBuildingIdForPoint(point.world);
            if (projectionDiagnostics.length < 16) {
                const legacyExpectedPixel = expectedPixelFromAngles(point, intrinsics);
                const shaderExpectedPixel = expectedPixelFromAngles(point, intrinsics, "shader");
                projectionDiagnostics.push({
                    tagName: point.tagName,
                    distance: roundNumber(point.distance),
                    thetaIndex: point.thetaIndex,
                    phiIndex: point.phiIndex,
                    thetaDeg: roundNumber(point.thetaDeg),
                    phiDeg: roundNumber(point.phiDeg),
                    thetaStepDeg: roundNumber(point.thetaStepDeg, 6),
                    phiStepDeg: roundNumber(point.phiStepDeg, 6),
                    shaderThetaDeg: roundNumber(point.shaderThetaDeg),
                    shaderPhiDeg: roundNumber(point.shaderPhiDeg),
                    shaderThetaStepDeg: roundNumber(point.shaderThetaStepDeg, 6),
                    shaderPhiStepDeg: roundNumber(point.shaderPhiStepDeg, 6),
                    pixel,
                    legacyExpectedPixel,
                    shaderExpectedPixel,
                    deltaFromLegacy: pixelDelta(pixel, legacyExpectedPixel),
                    deltaFromShader: pixelDelta(pixel, shaderExpectedPixel),
                    maskAllowed,
                    buildingMaskAllowed,
                    attributedBuildingId,
                    meshOcclusion: findNearestMeshHit(raycaster, meshOcclusionObjects, cameraOrigin, point.world),
                    world: {
                        x: roundNumber(point.world.x),
                        y: roundNumber(point.world.y),
                        z: roundNumber(point.world.z),
                    },
                });
            }
            if (!maskAllowed) {
                skippedMasked += 1;
                continue;
            }
            if (!buildingMaskAllowed) {
                skippedBuildingMask += 1;
                continue;
            }
            if (!activeBuildingAllowsPoint(buildingId, attributedBuildingId)) {
                skippedWrongBuilding += 1;
                continue;
            }

            const rgb = sampleColor(
                bakedImage.data,
                bakedImage.width,
                bakedImage.height,
                pixel.px,
                pixel.py,
            );
            if (!rgb) {
                skippedNoColor += 1;
                continue;
            }
            const flippedRgb = sampleColor(
                bakedImage.data,
                bakedImage.width,
                bakedImage.height,
                pixel.px,
                bakedImage.height - 1 - pixel.py,
            );
            const colorBucket = classifyRgb(rgb);
            debugColorBuckets[colorBucket] = (debugColorBuckets[colorBucket] ?? 0) + 1;

            const thetaRad = THREE.MathUtils.degToRad(point.thetaStepDeg ?? 0.1);
            const phiRad = THREE.MathUtils.degToRad(point.phiStepDeg ?? 0.1);
            const angularStep = Math.max(thetaRad, phiRad);
            const splatRadius = adaptiveRadius
                ? Math.max(radius, point.distance * angularStep * 0.5)
                : radius;
            const scales = new THREE.Vector3(splatRadius, splatRadius, splatRadius);
            const color = isSrgb
                ? srgbToLinearColor(rgb)
                : new THREE.Color(rgb.r, rgb.g, rgb.b);

            this.mesh.pushSplat(point.world, scales, identityQuat, 1.0, color);
            this.coverageGrid.add(point.world);
            committed += 1;

            const debugBuildingId = attributedBuildingId;
            incrementCount(debugCommittedBuildingCounts, debugBuildingId);
            if (!debugCommittedColorByBuilding[debugBuildingId || "unknown"]) {
                debugCommittedColorByBuilding[debugBuildingId || "unknown"] = {};
            }
            incrementCount(debugCommittedColorByBuilding[debugBuildingId || "unknown"], colorBucket);

            if (debugSamples.length < 12) {
                debugSamples.push({
                    tagName: point.tagName,
                    tagId: point.tagId,
                    distance: roundNumber(point.distance),
                    pixel,
                    rgb: serializeRgb(rgb),
                    flippedRgb: serializeRgb(flippedRgb),
                    colorBucket,
                    world: {
                        x: roundNumber(point.world.x),
                        y: roundNumber(point.world.y),
                        z: roundNumber(point.world.z),
                    },
                    debugBuildingId,
                });
            }

            if (debugBuildingId && point.tagName === "building") {
                this.buildingCounts.set(
                    debugBuildingId,
                    (this.buildingCounts.get(debugBuildingId) ?? 0) + 1,
                );
            }
        }

        if (committed > 0) {
            this.mesh.numSplats = this.mesh.packedSplats.numSplats;
            this.mesh.updateVersion();
            this.mesh.packedSplats.needsUpdate = true;
        }

        const accumulatorDebugData = {
            sampleId: options.sampleId,
            frameIndex: options.frameIndex,
            viewId: options.viewId,
            imageSource: options.imageSource ?? bakedImage.source,
            imageColorSpace: bakedImage.colorSpace,
            inputCount: filteredPoints.length,
            committed,
            skippedCovered,
            skippedNoPixel,
            skippedNoColor,
            skippedWrongBuilding,
            skippedSliver,
            skippedMasked,
            skippedBuildingMask,
            coverageNeighbor,
            coverageVoxelSize: this.coverageVoxelSize,
            sliverBounds,
            colorBuckets: debugColorBuckets,
            activeBuildingId: buildingId,
            committedBuildingCounts: debugCommittedBuildingCounts,
            committedColorByBuilding: debugCommittedColorByBuilding,
            meshState: {
                visible: this.mesh?.visible,
                parentAttached: Boolean(this.mesh?.parent),
                numSplats: this.splatCount,
            },
            committedSamples: debugSamples,
            projectionDiagnostics,
            totalSplatsAfterCommit: this.splatCount,
        };
        if (options.debug === true) {
            console.log("SplatAccumulator: commit summary", accumulatorDebugData);
        }

        return {
            committed,
            buildingCounts: this.buildingCounts,
            skippedCovered,
            skippedNoPixel,
            skippedNoColor,
            skippedMasked,
            skippedBuildingMask,
            skippedSliver,
            skippedWrongBuilding,
        };
    }

    /**
     * Hide low-poly building meshes once enough splats exist for that building.
     * LiDAR triangles remain in ObjectDatabase.
     * @param {THREE.Scene} scene
     * @param {Object} [config]
     */
    hideBakedGeometry(scene, config = {}, context = {}) {
        if (config.hideBakedGeometry === false) return;

        const threshold = config.hideThreshold ?? this.hideThreshold;
        const hiddenThisCall = [];
        const eligibleThisCall = [];

        scene.traverse((object) => {
            const buildingId = effectiveBuildingId(object);
            if (!buildingId || !object.isMesh) return;

            const count = this.buildingCounts.get(buildingId) ?? 0;
            if (count < threshold) return;
            eligibleThisCall.push({
                buildingId,
                count,
                wasVisible: object.visible,
            });

            object.visible = false;
            this.hiddenBuildings.add(buildingId);
            hiddenThisCall.push({
                buildingId,
                count,
            });
        });

        if (config.debug === true) {
            console.log("SplatAccumulator: hide baked geometry", {
                ...context,
                threshold,
                eligibleThisCall,
                hiddenThisCall,
                hiddenBuildingIds: [...this.hiddenBuildings],
            });
        }
    }

    dispose() {
        if (this.mesh?.parent) {
            this.mesh.parent.remove(this.mesh);
        }
        this.mesh = null;
    }
}
