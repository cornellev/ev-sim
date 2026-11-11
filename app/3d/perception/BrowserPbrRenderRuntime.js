import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import {
    PBR_MEASURED_ASSET_OPERATIONS,
    assertPbrRenderSceneDescription,
    assertPbrRunEvidence,
    hashPbrRenderScene,
} from "../../simulation/render/PbrRenderScene.js";
import {
    VISUAL_CAPTURE_PASS_FAMILIES,
    canonicalizeAnalyticBindings,
    createOwnedCaptureScene,
    createVisualCaptureInput,
    createVisualCapturePassSet,
    assertVisualCaptureInput,
} from "../environment/visual/VisualCapturePipeline.js";
import {
    LIVE_CAMERA_OBJECT_MOTION,
    assertCameraObjectMotionFields,
    CameraObjectPoseTracker,
} from "../../simulation/render/CameraObjectMotion.js";
import {
    VisualLayerMaterializer,
    sanitizeMeasuredAppearanceObject,
} from "../environment/visual/VisualLayerMaterializer.js";
import { VisualAssetClient } from "../environment/visual/VisualAssetClient.js";
import { installImageSky, installTakramSky, releaseTakramSky } from "./PbrAppearanceSky.js";
import { addPbrRoadMarkings } from "./PbrRoadMarkings.js";
import { rep103PoseToThree } from "../../autonomy/CoordinateFrames.js";
import { browserSimulationPerformance } from "../../simulation/performance/BrowserSimulationPerformance.js";
import { RendererPresentationLease } from "./RendererPresentationLease.js";
import { cameraSceneDetections } from "../../simulation/render/CameraObjectTruth.js";
import { assertCanonicalAnalyticRenderSceneDescription, hashRenderScene } from "../../simulation/render/RenderScene.js";

const PROVIDER = Object.freeze({ id: "pbr-mesh", version: 1 });
const ROAD_SURFACE_COLOR = 0x2d3034;
const ROAD_SURFACE_ELEVATION = 0.015;
const ANALYTIC_SIDE = THREE.DoubleSide;
const ANALYTIC_RENDER_ORDER = 0;
const ROAD_APPEARANCE_RENDER_ORDER = 1;

function infrastructureError(error, fallbackCode = "PBR_RENDER_RUNTIME_FAILED") {
    const result = error instanceof Error ? error : new Error(String(error || "PBR render runtime failed."));
    result.code ||= fallbackCode;
    result.infrastructureFailure = true;
    return result;
}

function semanticColor(semanticId) {
    const value = Number(semanticId) >>> 0;
    return new THREE.Color(
        (48 + ((value * 97) % 176)) / 255,
        (48 + ((value * 57 + 43) % 176)) / 255,
        (48 + ((value * 23 + 91) % 176)) / 255,
    );
}

function primitiveGeometry(primitive) {
    if (primitive.shape === "box") {
        const geometry = new THREE.BoxGeometry(
            primitive.size.x,
            primitive.size.y,
            primitive.size.z,
        );
        geometry.translate(primitive.center.x, primitive.center.y, primitive.center.z);
        return geometry;
    }
    if (primitive.shape === "triangle") {
        const positions = primitive.vertices.flatMap((point) => [point.x, point.y, point.z]);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();
        return geometry;
    }
    throw new Error(`Unsupported analytic primitive shape "${primitive.shape}".`);
}

/** Non-indexed geometry so mergeGeometries preserves triangle order. */
function geometryForMerge(primitive) {
    const geometry = primitiveGeometry(primitive);
    if (!geometry.index) return geometry;
    const nonIndexed = geometry.toNonIndexed();
    geometry.dispose();
    nonIndexed.computeVertexNormals();
    return nonIndexed;
}

function analyticBatchKey(primitive, {
    side = ANALYTIC_SIDE,
    renderOrder = ANALYTIC_RENDER_ORDER,
} = {}) {
    return [
        Number(primitive.semanticId) >>> 0,
        Number(primitive.instanceId) >>> 0,
        side,
        renderOrder,
    ].join(":");
}

/**
 * Merge only contiguous runs that share the render-equivalence key so draw
 * order (and depth-test ties) match the one-mesh-per-triangle path.
 */
function groupPrimitivesForBatch(primitives, options = {}) {
    const groups = [];
    for (const primitive of primitives ?? []) {
        const key = analyticBatchKey(primitive, options);
        const previous = groups[groups.length - 1];
        if (previous && previous.key === key) {
            previous.primitives.push(primitive);
            continue;
        }
        groups.push({
            key,
            semanticId: Number(primitive.semanticId) >>> 0,
            instanceId: Number(primitive.instanceId) >>> 0,
            side: options.side ?? ANALYTIC_SIDE,
            renderOrder: options.renderOrder ?? ANALYTIC_RENDER_ORDER,
            primitives: [primitive],
        });
    }
    return groups;
}

function mergePrimitiveGeometries(primitives) {
    const geometries = primitives.map((primitive) => geometryForMerge(primitive));
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) {
        throw new Error("Failed to merge analytic primitive geometries.");
    }
    // Non-indexed merge keeps per-triangle face normals from the sources.
    if (!merged.getAttribute("normal")) merged.computeVertexNormals();
    return merged;
}

function ownedMesh(geometry, material, {
    name,
    renderableId,
    renderOrder = 0,
    userData = {},
} = {}) {
    material.dithering = false;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.renderOrder = renderOrder;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = {
        cevSimRenderRuntimeOwned: true,
        renderableId,
        ...userData,
    };
    return mesh;
}

function primitiveMesh(primitive, { appearance = false } = {}) {
    const material = appearance
        ? new THREE.MeshStandardMaterial({
            color: semanticColor(primitive.semanticId),
            metalness: 0,
            roughness: 0.8,
            side: THREE.DoubleSide,
        })
        : new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    return ownedMesh(primitiveGeometry(primitive), material, {
        name: primitive.id,
        renderableId: primitive.id,
    });
}

function vehicleMatrix(vehicle) {
    const serializedMatrix = vehicle?.matrixWorld;
    if (Array.isArray(serializedMatrix) || ArrayBuffer.isView(serializedMatrix)) {
        if (serializedMatrix.length !== 16) {
            throw new Error("A serialized PBR actor matrix must contain 16 elements.");
        }
        return new THREE.Matrix4().fromArray(serializedMatrix);
    }
    if (vehicle?.sceneObject?.matrixWorld) {
        vehicle.sceneObject.updateMatrixWorld?.(true);
        return vehicle.sceneObject.matrixWorld.clone();
    }
    const position = vehicle?.position ?? {};
    const rotation = vehicle?.rotation ?? {};
    return new THREE.Matrix4().compose(
        new THREE.Vector3(
            Number(position.x) || 0,
            Number(position.y) || 0,
            Number(position.z) || 0,
        ),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
            Number(rotation.x) || 0,
            Number(rotation.y) || 0,
            Number(rotation.z) || 0,
            rotation.order || "XYZ",
        )),
        new THREE.Vector3(1, 1, 1),
    );
}

function matrixElementsMatch(matrix, next) {
    const left = matrix?.elements;
    const right = next?.elements;
    if (!left || !right || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function actorId(vehicle, index) {
    return String(vehicle?.telemetryId || vehicle?.id || `vehicle-${index + 1}`);
}

function applyActorMaterial(root, recipe) {
    const ownedMaterials = [];
    root.traverse((object) => {
        if (!object.isMesh) return;
        const replace = (source) => {
            const material = new THREE.MeshStandardMaterial({
                color: new THREE.Color(...recipe.baseColorFactor.slice(0, 3)),
                opacity: recipe.baseColorFactor[3],
                metalness: recipe.metallicFactor,
                roughness: recipe.roughnessFactor,
                emissive: new THREE.Color(...recipe.emissiveFactor),
                map: source?.map ?? null,
                normalMap: source?.normalMap ?? null,
                roughnessMap: source?.roughnessMap ?? null,
                metalnessMap: source?.metalnessMap ?? null,
                emissiveMap: source?.emissiveMap ?? null,
                aoMap: source?.aoMap ?? null,
                alphaMap: source?.alphaMap ?? null,
                alphaTest: recipe.alphaMode === "MASK" ? recipe.alphaCutoff : 0,
                side: recipe.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
                transparent: false,
                depthTest: true,
                depthWrite: true,
            });
            material.dithering = false;
            ownedMaterials.push(material);
            return material;
        };
        object.material = Array.isArray(object.material)
            ? object.material.map(replace)
            : replace(object.material);
    });
    return ownedMaterials;
}

function disposeOwnedScene(scene) {
    scene?.traverse?.((object) => {
        if (object.userData?.cevSimRenderRuntimeOwned !== true) return;
        object.geometry?.dispose?.();
        for (const material of [].concat(object.material ?? [])) material?.dispose?.();
    });
    scene?.clear?.();
}

function capturePosition(device) {
    const position = device?.getPosition?.() ?? {};
    return {
        x: Number(position.x) || 0,
        y: Number(position.y) || 0,
        z: Number(position.z) || 0,
    };
}

function initialCameraPositions(sensorRig, vehicles) {
    const byId = new Map(vehicles.map((vehicle, index) => [actorId(vehicle, index), vehicle]));
    return (sensorRig?.sensors ?? [])
        .filter((sensor) => sensor.enabled !== false && sensor.type === "camera")
        .map((sensor) => {
            const local = rep103PoseToThree(sensor.pose).position;
            if (sensor.poseReference === "map") {
                return { x: local.x, y: local.y, z: local.z };
            }
            const vehicle = byId.get(sensor.parentId);
            if (!vehicle) {
                throw new Error(`Camera "${sensor.id}" references missing vehicle "${sensor.parentId}".`);
            }
            const world = new THREE.Vector3(local.x, local.y, local.z)
                .applyMatrix4(vehicleMatrix(vehicle));
            return { x: world.x, y: world.y, z: world.z };
        });
}

/** Browser-owned PBR scene pair for one immutable resolved run. */
export class BrowserPbrRenderRuntime {
    constructor({
        renderer,
        assetClient = new VisualAssetClient(),
        materializerFactory = (options) => new VisualLayerMaterializer(options),
        installImageSky: installImageSkyOverride = null,
        installTakramSky: installTakramSkyOverride = null,
        vehicles = () => [],
        /** When false, keep one mesh per analytic primitive (parity / debug). */
        batchAnalyticGeometry = true,
    } = {}) {
        this.renderer = renderer;
        this.implementation = "inline";
        this.rendererLease = new RendererPresentationLease();
        this.runtimeOwnsProducts = false;
        this.assetClient = assetClient;
        this.materializerFactory = materializerFactory;
        this.installImageSky = installImageSkyOverride;
        this.installTakramSky = installTakramSkyOverride;
        this.vehicleSource = vehicles;
        this.batchAnalyticGeometry = batchAnalyticGeometry !== false;
        this.generation = 0;
        this.captureEpoch = 0;
        this.controller = null;
        this.materializer = null;
        this.appearanceScene = null;
        this.analyticScene = null;
        this.appearanceSceneHandle = null;
        this.analyticSceneHandle = null;
        this.analyticRenderables = new Map();
        this.analyticBindings = [];
        this._primitiveRenderableIds = new Map();
        this._semanticIds = null;
        this.actorGroups = new Map();
        this.objectGroups = new Map();
        this.objectPoses = Object.freeze([]);
        this.objectMotionBindings = [];
        this.objectMotion = undefined;
        this.objectAppearanceMatrices = new Map();
        this.objectRequiredChunkIds = [];
        this.objectPoseTracker = new CameraObjectPoseTracker();
        this.captureObjectPoseTracker = new CameraObjectPoseTracker();
        this.objectMotionStates = new Map();
        this.objectAppearanceRoots = new Map();
        this._objectAppearanceChildren = [];
        this._objectAppearanceTopologyRevision = null;
        this._objectPosition = new THREE.Vector3();
        this._objectRotation = new THREE.Quaternion();
        this._objectUnitScale = new THREE.Vector3(1, 1, 1);
        this.assetLeases = [];
        this.ownedActorMaterials = [];
        this.environmentTextureLease = null;
        this.environmentTexture = null;
        this.skyInstallation = null;
        this.rootUseHashes = [];
        this.renderPolicy = null;
        this.listeners = new Set();
        this._rightsCache = new Map();
        this._rightsInflight = new Map();
        this.status = this._snapshot("idle");
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.status);
        return () => this.listeners.delete(listener);
    }

    get ready() {
        return ["ready", "streaming", "degraded"].includes(this.status.state);
    }

    get presentationBlocked() {
        return this.rendererLease.blocked;
    }

    subscribePresentationAvailability(listener) {
        return this.rendererLease.subscribe(listener);
    }

    cameraOptions() {
        if (!this.ready) throw infrastructureError(new Error("PBR render runtime is not ready."));
        return {
            renderRuntime: this,
            captureMode: "calibrated-projection@1",
            captureSceneHandle: this.appearanceSceneHandle,
            analyticSceneHandle: this.analyticSceneHandle,
            authorizeSourceUse: (request) => this.authorizeSourceUse(request),
            renderPolicy: this.renderPolicy,
            rendererLease: this.rendererLease,
        };
    }

    async prepare(resolved, { interest = null, sensorRig = null, vehicles = null } = {}) {
        this.dispose({ preserveListeners: true });
        if (!this.renderer) throw infrastructureError(new Error("Browser PBR rendering requires a configured renderer."));
        const generation = ++this.generation;
        this.controller = new AbortController();
        this._setStatus("preparing");
        try {
            const renderScene = resolved?.renderScene;
            const description = renderScene?.description;
            assertPbrRenderSceneDescription(description);
            assertCameraObjectMotionFields(description, {
                world: resolved.world?.description,
                visualLayer: resolved.visualLayer?.description,
            });
            if (hashPbrRenderScene(description) !== renderScene.hash) {
                throw new Error("Resolved PBR render-scene hash does not match its description.");
            }
            assertPbrRunEvidence(resolved.evidence, {
                visualLayer: resolved.visualLayer,
                renderScene,
            });

            this.appearanceScene = new THREE.Scene();
            this.analyticScene = new THREE.Scene();
            this.appearanceScene.userData.cevSimCaptureTopologyRevision = 1;
            this.appearanceScene.userData.cevSimCaptureTransformRevision = 1;
            this.analyticScene.userData.cevSimCaptureTopologyRevision = 1;
            this.analyticScene.userData.cevSimCaptureTransformRevision = 1;
            this._configureRecipe(description.recipe);
            this.objectMotion = description.objectMotion;
            this.renderSceneDescription = description;
            this.objectMotionBindings = structuredClone(description.objectMotionBindings ?? []);
            const appearanceIds = new Set(this.objectMotionBindings.flatMap((binding) => binding.appearanceInstanceIds));
            for (const instance of resolved.visualLayer.description.instances) {
                if (!appearanceIds.has(instance.id)) continue;
                this.objectAppearanceMatrices.set(instance.id, new THREE.Matrix4().fromArray(instance.matrix));
                this.objectRequiredChunkIds.push(...instance.chunkIds);
            }
            this._buildAnalyticScene(description.analyticTruth.description, description.actors);
            addPbrRoadMarkings(this.appearanceScene, resolved.world?.description?.roads);

            const uses = new Map(resolved.evidence.visualAssets.uses.map((entry) => [
                entry.useHash,
                entry.use,
            ]));
            const runVehicles = vehicles ?? this._vehicles();
            const cameraPositions = initialCameraPositions(sensorRig, runVehicles);
            const initialInterest = interest ?? {
                positions: cameraPositions.length > 0 ? cameraPositions : runVehicles.map((vehicle) => ({
                    x: Number(vehicle.position?.x) || 0,
                    y: Number(vehicle.position?.y) || 0,
                    z: Number(vehicle.position?.z) || 0,
                })),
            };
            this.materializer = this.materializerFactory({
                previewRoot: this.appearanceScene,
                renderer: this.renderer,
                assetClient: this.assetClient,
                lodPolicy: description.recipe.lodPolicy,
                sceneRole: "measured-appearance",
                requiredOperations: PBR_MEASURED_ASSET_OPERATIONS,
                strict: true,
            });
            await this.materializer.replaceResolved({
                descriptor: resolved.visualLayer.description,
                access: resolved.evidence.visualAssets.access,
                uses,
            }, resolved.world, { interest: { ...initialInterest, requiredChunkIds: this.objectRequiredChunkIds } });
            this._appearanceResidencySignature = this._residencySignature();
            this._throwIfStale(generation);

            await this._buildActorAppearances(description.actors, resolved.evidence.visualAssets.roots);
            await this._loadEnvironmentMap(description.recipe, resolved.evidence.visualAssets.roots);
            await this._installSky(description.recipe.sky);
            this._throwIfStale(generation);
            this.rootUseHashes = [...new Set(
                resolved.evidence.visualAssets.roots.map((entry) => entry.useHash),
            )].sort();
            await this._warmCaptureRights(this.controller?.signal);
            this._throwIfStale(generation);
            this.appearanceScene.updateMatrixWorld(true);
            this.analyticScene.updateMatrixWorld(true);
            this.appearanceSceneHandle = createOwnedCaptureScene({
                role: "measured-appearance",
                scene: this.appearanceScene,
                generation,
                descriptionHash: renderScene.hash,
                objectMotion: this.objectMotion,
                objectMotionBindings: this.objectMotionBindings,
            });
            this.analyticSceneHandle = createOwnedCaptureScene({
                role: "analytic-truth",
                scene: this.analyticScene,
                generation,
                descriptionHash: description.analyticTruth.hash,
                objectMotion: this.objectMotion,
                objectMotionBindings: this.objectMotionBindings,
            });
            this._updateActors(this._vehicles());
            this._initializeObjectMotion();
            this._applyObjectPoses(this.objectPoses);
            this._setReadyStatus();
            return this.status;
        } catch (error) {
            const failure = infrastructureError(error, "PBR_RENDER_PREPARATION_FAILED");
            this._setStatus("error", failure);
            this._releaseResources();
            throw failure;
        }
    }

    async prepareCapture({ devices = [], vehicles = this._vehicles() } = {}) {
        if (!this.ready) throw infrastructureError(new Error("PBR render runtime is not ready."));
        this._updateActors(vehicles);
        const positions = devices
            .filter((device) => device?.renderRuntime === this)
            .map(capturePosition);
        try {
            const materializerStatus = await this.materializer.updateInterest({
                positions: positions.length > 0 ? positions : [{ x: 0, y: 0, z: 0 }],
                requiredChunkIds: this.objectRequiredChunkIds,
            });
            if (materializerStatus.status === "error") {
                throw new Error(materializerStatus.error?.message || "Required PBR residency failed.");
            }
            const residency = materializerStatus.residency;
            const residencySignature = this._residencySignature(residency);
            if (residencySignature !== this._appearanceResidencySignature) {
                this._appearanceResidencySignature = residencySignature;
                this.appearanceScene.userData.cevSimCaptureTopologyRevision += 1;
            }
            const resident = new Set(residency?.residentChunkIds ?? []);
            const missing = (residency?.requiredChunkIds ?? []).filter((id) => !resident.has(id));
            if (missing.length > 0) {
                throw new Error(`Required PBR chunks are not resident: ${missing.join(", ")}.`);
            }
            this._setReadyStatus({ streaming: true });
        } catch (error) {
            const failure = infrastructureError(error, "PBR_REQUIRED_RESIDENCY_FAILED");
            this._setStatus("error", failure);
            throw failure;
        }
    }

    async captureCamera({ captureInput, enabled, renderProducts, signal = this.controller?.signal } = {}) {
        if (!this.ready) throw infrastructureError(new Error("PBR render runtime is not ready."));
        const generation = this.generation;
        const captureEpoch = this.captureEpoch;
        try {
            assertVisualCaptureInput(captureInput, { sceneHandle: this.appearanceSceneHandle });
            if (this.objectMotion === LIVE_CAMERA_OBJECT_MOTION) {
                this._applyObjectPoses(captureInput.objectPoses);
            }
            const visualPassSet = enabled.rgb ? createVisualCapturePassSet({
                family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
                captureInput,
                products: ["beauty", "validity"],
                bindings: [],
                sourceUseHashes: this.rootUseHashes,
            }) : null;
            const analyticProducts = [
                ...(enabled.depth ? ["axial-depth"] : []),
                ...(enabled.semantic ? ["semantic-id"] : []),
                ...(enabled.instance ? ["instance-id"] : []),
            ];
            const analyticInput = analyticProducts.length > 0 ? createVisualCaptureInput({
                calibration: captureInput.calibration,
                pose: captureInput.pose,
                sceneHandle: this.analyticSceneHandle,
                captureTimeNs: captureInput.captureTimeNs,
                objectPoses: captureInput.objectPoses,
            }) : null;
            const analyticPassSet = analyticInput ? createVisualCapturePassSet({
                family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
                captureInput: analyticInput,
                products: [...analyticProducts, "validity"],
                bindings: this.analyticBindings,
            }) : null;
            const captured = await renderProducts.captureAlignedProducts({
                visualPassSet,
                visualRenderables: new Map(),
                analyticPassSet,
                analyticRenderables: this.analyticRenderables,
                signal,
            });
            this._throwIfStale(generation);
            if (captureEpoch !== this.captureEpoch) throw infrastructureError(new Error("PBR capture was reset."), "PBR_CAPTURE_SUPERSEDED");
            for (const [name, durationMs] of Object.entries(
                renderProducts?._alignedProducts?.lastCaptureTimings ?? {},
            )) {
                browserSimulationPerformance.recordTiming(`capture.${name}`, durationMs);
            }
            const analytic = captured.analytic?.products;
            const depth = analytic?.axialDepth;
            if (depth && analytic.validity) {
                for (let index = 0; index < depth.length; index += 1) {
                    if (analytic.validity[index] !== 1) depth[index] = Number.NaN;
                }
            }
            this._setReadyStatus({ streaming: true });
            return {
                aligned: true,
                rgb: captured.visual?.products?.beauty ?? null,
                depth: depth ?? null,
                semantic: analytic?.semanticId
                    ? this._semanticIdsFrom(analytic.semanticId)
                    : null,
                instance: analytic?.instanceId ?? null,
            };
        } catch (error) {
            const failure = infrastructureError(error, "PBR_CAPTURE_FAILED");
            if (generation === this.generation && captureEpoch === this.captureEpoch) this._setStatus("error", failure);
            throw failure;
        }
    }

    dispose({ preserveListeners = false } = {}) {
        this.generation += 1;
        this.controller?.abort();
        this.controller = null;
        this._releaseResources();
        this.rendererLease.reset({ preserveListeners });
        this.status = this._snapshot("idle");
        if (!preserveListeners) this.listeners.clear();
    }

    reset() {
        this.captureEpoch += 1;
        this.applyRigidBodyPoses([]);
        if (this.ready) this._applyObjectPoses(this.objectPoses);
    }

    _configureRecipe(recipe) {
        const background = recipe.background.colorRgba;
        this.appearanceScene.background = new THREE.Color(background[0], background[1], background[2]);
        const ambient = recipe.lighting.ambient;
        this.appearanceScene.add(new THREE.AmbientLight(
            new THREE.Color(...ambient.colorRgb),
            ambient.intensity,
        ));
        this.analyticScene.background = new THREE.Color(0, 0, 0);
        this.renderPolicy = {
            exposure: recipe.colorPipeline.exposure,
            outputColorSpace: recipe.colorPipeline.outputColorSpace,
            toneMapping: recipe.colorPipeline.toneMapping,
            backgroundColorRgba: [...background],
        };
    }

    _buildAnalyticScene(analyticTruth, actorDescriptions) {
        const actorById = new Map(actorDescriptions.map((entry) => [entry.actorId, entry]));
        const objectIds = new Set(this.objectMotionBindings.map((binding) => binding.id));
        const staticPrimitives = analyticTruth.staticPrimitives.filter((primitive) => !objectIds.has(primitive.sourceId));
        for (const binding of this.objectMotionBindings) {
            const group = new THREE.Group();
            group.matrixAutoUpdate = false;
            group.userData.cevSimCaptureDynamic = true;
            this.analyticScene.add(group);
            const primitives = analyticTruth.staticPrimitives.filter((primitive) => primitive.sourceId === binding.id);
            if (this.batchAnalyticGeometry) this._addBatchedAnalyticPrimitives(primitives, group, { idPrefix: `object:${binding.id}` });
            else for (const primitive of primitives) this._addAnalyticPrimitive(primitive, group);
            this.objectGroups.set(binding.id, group);
        }
        if (this.batchAnalyticGeometry) {
            this._addBatchedAnalyticPrimitives(staticPrimitives, this.analyticScene, {
                idPrefix: "static",
            });
            this._addBatchedRoadAppearance(staticPrimitives);
        } else {
            for (const primitive of staticPrimitives) {
                this._addAnalyticPrimitive(primitive, this.analyticScene);
                this._addRoadAppearance(primitive);
            }
        }
        for (const plane of analyticTruth.planes ?? []) {
            const geometry = new THREE.PlaneGeometry(20000, 20000);
            geometry.rotateX(-Math.PI / 2);
            const material = new THREE.MeshBasicMaterial({
                color: semanticColor(plane.semanticId),
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = plane.id;
            mesh.position.y = plane.y;
            this.analyticScene.add(mesh);
        }
        for (const actor of analyticTruth.actors) {
            const analyticGroup = new THREE.Group();
            analyticGroup.name = `cev-sim.analytic-actor:${actor.actorId}`;
            analyticGroup.matrixAutoUpdate = false;
            analyticGroup.userData.cevSimCaptureDynamic = true;
            this.analyticScene.add(analyticGroup);
            if (this.batchAnalyticGeometry) {
                this._addBatchedAnalyticPrimitives(actor.primitives, analyticGroup, {
                    idPrefix: `actor:${actor.actorId}`,
                });
            } else {
                for (const primitive of actor.primitives) {
                    this._addAnalyticPrimitive(primitive, analyticGroup);
                }
            }

            const appearanceGroup = new THREE.Group();
            appearanceGroup.name = `cev-sim.appearance-actor:${actor.actorId}`;
            appearanceGroup.matrixAutoUpdate = false;
            appearanceGroup.userData.cevSimCaptureDynamic = true;
            const visualTransform = new THREE.Group();
            visualTransform.matrix.fromArray(actorById.get(actor.actorId).transform);
            visualTransform.matrixAutoUpdate = false;
            appearanceGroup.add(visualTransform);
            this.appearanceScene.add(appearanceGroup);
            this.actorGroups.set(actor.actorId, {
                analytic: analyticGroup,
                appearance: appearanceGroup,
                visualTransform,
                primitives: actor.primitives,
            });
        }
        this.analyticBindings = canonicalizeAnalyticBindings(this.analyticBindings);
    }

    _addBatchedAnalyticPrimitives(primitives, parent, { idPrefix }) {
        if (!Array.isArray(primitives) || primitives.length === 0) return;
        const groups = groupPrimitivesForBatch(primitives, {
            side: ANALYTIC_SIDE,
            renderOrder: ANALYTIC_RENDER_ORDER,
        });
        groups.forEach((group, groupIndex) => {
            const renderableId = `${idPrefix}:s${group.semanticId}:i${group.instanceId}:${groupIndex}`;
            const material = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                side: group.side,
            });
            const mesh = ownedMesh(mergePrimitiveGeometries(group.primitives), material, {
                name: renderableId,
                renderableId,
                renderOrder: group.renderOrder,
            });
            parent.add(mesh);
            this.analyticRenderables.set(renderableId, mesh);
            this.analyticBindings.push({
                renderableId,
                semanticId: group.semanticId,
                instanceId: group.instanceId,
            });
            for (const primitive of group.primitives) {
                this._primitiveRenderableIds.set(primitive.id, renderableId);
            }
        });
    }

    _addBatchedRoadAppearance(primitives) {
        const roads = (primitives ?? []).filter((primitive) => (
            Array.isArray(primitive.tags) && primitive.tags.includes("road")
        ));
        if (roads.length === 0) return;
        // Preserve first-appearance triangle order across the road set.
        const material = new THREE.MeshStandardMaterial({
            color: ROAD_SURFACE_COLOR,
            metalness: 0,
            roughness: 0.9,
            side: THREE.DoubleSide,
        });
        const mesh = ownedMesh(mergePrimitiveGeometries(roads), material, {
            name: "road-appearance",
            renderableId: "road-appearance",
            renderOrder: ROAD_APPEARANCE_RENDER_ORDER,
            userData: { cevSimRoadAppearance: true },
        });
        // Corrected capture rejects polygon offset. Lift the merged surface so
        // it wins a coplanar depth test against the analytic road mesh.
        mesh.position.y += ROAD_SURFACE_ELEVATION;
        this.appearanceScene.add(mesh);
    }

    _addAnalyticPrimitive(primitive, parent) {
        const mesh = primitiveMesh(primitive);
        parent.add(mesh);
        this.analyticRenderables.set(primitive.id, mesh);
        this._primitiveRenderableIds.set(primitive.id, primitive.id);
        this.analyticBindings.push({
            renderableId: primitive.id,
            semanticId: primitive.semanticId,
            instanceId: primitive.instanceId,
        });
    }

    _addRoadAppearance(primitive) {
        if (!Array.isArray(primitive.tags) || !primitive.tags.includes("road")) return;
        const mesh = primitiveMesh(primitive, { appearance: true });
        mesh.material.color.setHex(ROAD_SURFACE_COLOR);
        mesh.material.roughness = 0.9;
        mesh.material.metalness = 0;
        // Corrected capture rejects polygon offset. The editor lifts road
        // surfaces by this elevation so they win a coplanar depth test.
        mesh.position.y += ROAD_SURFACE_ELEVATION;
        mesh.renderOrder = ROAD_APPEARANCE_RENDER_ORDER;
        mesh.userData.cevSimRoadAppearance = true;
        this.appearanceScene.add(mesh);
    }

    async _installSky(sky) {
        if (!sky) return;
        if (sky.mode === "image") {
            const install = this.installImageSky ?? installImageSky;
            const texture = await install({ scene: this.appearanceScene, sky });
            if (this.environmentTexture && this.environmentTexture !== texture) {
                this.environmentTexture.dispose?.();
            }
            this.environmentTexture = texture;
            return;
        }
        if (sky.mode !== "takram") return;
        const install = this.installTakramSky ?? installTakramSky;
        const installed = await install({
            scene: this.appearanceScene,
            renderer: this.renderer,
            sky,
        });
        this.skyInstallation = installed ?? null;
    }

    async _buildActorAppearances(actors, roots) {
        const rootByScope = new Map(roots.map((entry) => [entry.scope, entry]));
        for (const actor of actors) {
            const holder = this.actorGroups.get(actor.actorId);
            if (actor.mode === "canonical-primitives") {
                for (const primitive of holder.primitives) {
                    const mesh = primitiveMesh(primitive, { appearance: true });
                    sanitizeMeasuredAppearanceObject(mesh, { actorId: actor.actorId });
                    // Sanitization strips imported authority; this tag only
                    // records renderer ownership for deterministic disposal.
                    mesh.userData.cevSimRenderRuntimeOwned = true;
                    holder.visualTransform.add(mesh);
                }
                continue;
            }
            const root = rootByScope.get(`actor:${actor.actorId}`);
            if (!root || root.sha256 !== actor.source.asset.sha256) {
                throw new Error(`Resolved actor asset use is missing for ${actor.actorId}.`);
            }
            const lease = await this.materializer.materializeAssetUse(root.useHash, {
                metadata: { actorId: actor.actorId },
            });
            this.assetLeases.push(lease);
            this.ownedActorMaterials.push(...applyActorMaterial(lease.root, actor.source.material));
            holder.visualTransform.add(lease.root);
        }
    }

    async _loadEnvironmentMap(recipe, roots) {
        const environmentMap = recipe.background.environmentMap;
        if (!environmentMap) return;
        const root = roots.find((entry) => entry.scope === "environment-map");
        if (!root || root.sha256 !== environmentMap.asset.sha256) {
            throw new Error("Resolved environment-map use is missing.");
        }
        const lease = await this.materializer.materializeTextureUse(root.useHash);
        const texture = lease.value.clone();
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        this.appearanceScene.background = texture;
        this.appearanceScene.environment = texture;
        this.appearanceScene.backgroundIntensity = environmentMap.intensity;
        this.appearanceScene.environmentIntensity = environmentMap.intensity;
        this.appearanceScene.backgroundRotation.set(0, environmentMap.rotationRadians, 0);
        this.appearanceScene.environmentRotation.set(0, environmentMap.rotationRadians, 0);
        this.environmentTextureLease = lease;
        this.environmentTexture = texture;
    }

    _semanticIdsFrom(ids) {
        if (!this._semanticIds || this._semanticIds.length !== ids.length) {
            this._semanticIds = new Uint16Array(ids.length);
        }
        for (let index = 0; index < ids.length; index += 1) this._semanticIds[index] = ids[index];
        return this._semanticIds;
    }

    _updateActors(vehicles) {
        const byId = new Map(vehicles.map((vehicle, index) => [actorId(vehicle, index), vehicle]));
        let analyticMovedAny = false;
        let appearanceMovedAny = false;
        for (const [id, groups] of this.actorGroups) {
            const vehicle = byId.get(id);
            if (!vehicle) throw new Error(`Resolved PBR actor "${id}" is not present in the simulation.`);
            const matrix = vehicleMatrix(vehicle);
            const analyticMoved = !matrixElementsMatch(groups.analytic.matrix, matrix);
            const appearanceMoved = !matrixElementsMatch(groups.appearance.matrix, matrix);
            if (analyticMoved) {
                analyticMovedAny = true;
                groups.analytic.matrix.copy(matrix);
                groups.analytic.matrixWorldNeedsUpdate = true;
                groups.analytic.updateMatrixWorld(true);
            }
            if (appearanceMoved) {
                appearanceMovedAny = true;
                groups.appearance.matrix.copy(matrix);
                groups.appearance.matrixWorldNeedsUpdate = true;
                groups.appearance.updateMatrixWorld(true);
            }
        }
        if (analyticMovedAny) this.analyticScene.userData.cevSimCaptureTransformRevision += 1;
        if (appearanceMovedAny) this.appearanceScene.userData.cevSimCaptureTransformRevision += 1;
    }

    applyRigidBodyPoses(poses = []) {
        if (this.objectMotion !== LIVE_CAMERA_OBJECT_MOTION) return;
        if (this.objectPoseTracker.sync(poses).size) this.objectPoses = this.objectPoseTracker.poses;
    }

    captureDetections(captureInput) {
        return cameraSceneDetections(this.renderSceneDescription, captureInput,
            new Map([...this.actorGroups].map(([id, groups]) => [id, groups.analytic.matrix.elements])));
    }

    _initializeObjectMotion() {
        this.objectPoseTracker = new CameraObjectPoseTracker(this.objectMotionBindings);
        this.captureObjectPoseTracker = new CameraObjectPoseTracker(this.objectMotionBindings);
        this.objectPoses = this.objectPoseTracker.poses;
        for (const binding of this.objectMotionBindings) {
            const { spawnPosition: p, spawnRotation: q } = binding;
            const spawnInverse = new THREE.Matrix4().compose(
                this._objectPosition.set(p.x, p.y, p.z),
                this._objectRotation.set(q.x, q.y, q.z, q.w),
                this._objectUnitScale,
            ).invert();
            this.objectMotionStates.set(binding.id, {
                group: this.objectGroups.get(binding.id),
                spawnInverse,
                delta: new THREE.Matrix4(),
                appearances: binding.appearanceInstanceIds.map((id) => ({ id, authored: this.objectAppearanceMatrices.get(id), next: new THREE.Matrix4() })),
            });
        }
    }

    _refreshObjectAppearanceRoots() {
        const children = this.appearanceScene.children;
        const topology = this.appearanceScene.userData.cevSimCaptureTopologyRevision;
        if (topology === this._objectAppearanceTopologyRevision && children.length === this._objectAppearanceChildren.length
            && children.every((child, index) => child === this._objectAppearanceChildren[index])) return new Set();
        const roots = new Map();
        if (this.objectAppearanceMatrices.size) this.appearanceScene.traverse((object) => {
            const id = object.userData?.visualInstanceId;
            if (this.objectAppearanceMatrices.has(id) && object.parent?.userData?.visualInstanceId !== id) {
                const entries = roots.get(id) ?? [];
                entries.push(object);
                roots.set(id, entries);
            }
        });
        for (const id of this.objectAppearanceMatrices.keys()) {
            if (!roots.get(id)?.length) throw new Error(`Required live PBR appearance ${id} is not resident.`);
        }
        const changed = new Set();
        for (const [id, state] of this.objectMotionStates) {
            if (state.appearances.some((appearance) => {
                const previous = this.objectAppearanceRoots.get(appearance.id) ?? [];
                const next = roots.get(appearance.id) ?? [];
                return previous.length !== next.length || previous.some((root, index) => root !== next[index]);
            })) changed.add(id);
        }
        this.objectAppearanceRoots = roots;
        this._objectAppearanceChildren = [...children];
        this._objectAppearanceTopologyRevision = topology;
        return changed;
    }

    _applyObjectPoses(poses) {
        if (this.objectMotion !== LIVE_CAMERA_OBJECT_MOTION) return new Set();
        const changed = this.captureObjectPoseTracker.sync(poses);
        const appearanceChanged = this._refreshObjectAppearanceRoots();
        let analyticMoved = false;
        let appearanceMoved = false;
        for (const id of new Set([...changed, ...appearanceChanged])) {
            const state = this.objectMotionStates.get(id);
            if (changed.has(id)) {
                const pose = this.captureObjectPoseTracker.tracker.get(id);
                if (pose) state.delta.compose(
                    this._objectPosition.set(pose.position.x, pose.position.y, pose.position.z),
                    this._objectRotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w),
                    this._objectUnitScale,
                ).multiply(state.spawnInverse);
                else state.delta.identity();
                if (!matrixElementsMatch(state.group.matrix, state.delta)) {
                    state.group.matrix.copy(state.delta);
                    state.group.matrixWorldNeedsUpdate = true;
                    state.group.updateMatrixWorld(true);
                    analyticMoved = true;
                }
            }
            for (const appearance of state.appearances) {
                const instances = this.objectAppearanceRoots.get(appearance.id);
                if (!instances?.length) throw new Error(`Required live PBR appearance ${appearance.id} is not resident.`);
                appearance.next.copy(state.delta).multiply(appearance.authored);
                for (const root of instances) {
                    root.userData.cevSimCaptureDynamic = true;
                    if (matrixElementsMatch(root.matrix, appearance.next)) continue;
                    root.matrix.copy(appearance.next);
                    root.matrixAutoUpdate = false;
                    root.matrixWorldNeedsUpdate = true;
                    root.updateWorldMatrix(true, true);
                    appearanceMoved = true;
                }
            }
        }
        if (analyticMoved) this.analyticScene.userData.cevSimCaptureTransformRevision += 1;
        if (appearanceMoved) this.appearanceScene.userData.cevSimCaptureTransformRevision += 1;
        return changed;
    }

    _residencySignature(residency = this.materializer?.residencySnapshot?.()) {
        const ids = residency?.residentChunkIds ?? residency?.residentChunks ?? [];
        return `${Array.isArray(ids) ? [...ids].map(String).sort().join("\0") : String(ids ?? "")}\0${JSON.stringify(residency?.selectedLods ?? {})}`;
    }

    _vehicles() {
        return typeof this.vehicleSource === "function"
            ? (this.vehicleSource() ?? [])
            : (this.vehicleSource ?? []);
    }

    _throwIfStale(generation) {
        if (generation !== this.generation || this.controller?.signal.aborted) {
            throw infrastructureError(new Error("PBR render preparation was superseded."), "PBR_RENDER_SUPERSEDED");
        }
    }

    _setReadyStatus({ streaming = false } = {}) {
        const residency = this.materializer?.residencySnapshot?.() ?? null;
        const degraded = Number(residency?.prefetchShed || 0) > 0;
        this._setStatus(degraded ? "degraded" : streaming ? "streaming" : "ready");
    }

    _snapshot(state, error = null) {
        const residency = this.materializer?.residencySnapshot?.() ?? null;
        return {
            provider: { ...PROVIDER },
            productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
            state,
            residency: residency ? {
                requiredChunks: residency.requiredChunks,
                residentChunks: residency.residentChunks,
                queuedChunks: residency.queuedChunks,
                prefetchShed: residency.prefetchShed,
                pressure: residency.pressure,
            } : null,
            diagnostic: error ? { code: error.code, message: error.message } : null,
            error: error ? { code: error.code, message: error.message } : null,
        };
    }

    _setStatus(state, error = null) {
        this.status = this._snapshot(state, error);
        for (const listener of this.listeners) listener(this.status);
    }

    _releaseResources() {
        releaseTakramSky(this.skyInstallation);
        this.skyInstallation = null;
        if (this.appearanceScene?.userData) delete this.appearanceScene.userData.cevSimBeautyComposer;
        this.environmentTexture?.dispose?.();
        this.environmentTexture = null;
        this.environmentTextureLease?.release?.();
        this.environmentTextureLease = null;
        for (const lease of this.assetLeases) lease.release?.();
        this.assetLeases = [];
        for (const material of this.ownedActorMaterials) material.dispose?.();
        this.ownedActorMaterials = [];
        this.materializer?.dispose?.();
        this.materializer = null;
        disposeOwnedScene(this.analyticScene);
        disposeOwnedScene(this.appearanceScene);
        this.appearanceScene = null;
        this.analyticScene = null;
        this.appearanceSceneHandle = null;
        this.analyticSceneHandle = null;
        this.analyticRenderables = new Map();
        this.analyticBindings = [];
        this._primitiveRenderableIds = new Map();
        this._semanticIds = null;
        this.actorGroups = new Map();
        this.objectGroups = new Map();
        this.objectPoses = Object.freeze([]);
        this.objectMotionBindings = [];
        this.objectMotion = undefined;
        this.renderSceneDescription = null;
        this.objectAppearanceMatrices = new Map();
        this.objectRequiredChunkIds = [];
        this.objectPoseTracker = new CameraObjectPoseTracker();
        this.captureObjectPoseTracker = new CameraObjectPoseTracker();
        this.objectMotionStates = new Map();
        this.objectAppearanceRoots = new Map();
        this._objectAppearanceChildren = [];
        this._objectAppearanceTopologyRevision = null;
        this.rootUseHashes = [];
        this._appearanceResidencySignature = null;
        this.renderPolicy = null;
        this._rightsCache?.clear();
        this._rightsInflight?.clear();
    }

    _rightsKey(useHash, operations) {
        return `${useHash}\0${[...operations].sort().join(",")}`;
    }

    async authorizeSourceUse({ useHash, operations = [] } = {}) {
        const key = this._rightsKey(useHash, operations);
        if (this._rightsCache.has(key)) return this._rightsCache.get(key);
        const existing = this._rightsInflight.get(key);
        if (existing) return existing;
        const pending = (async () => {
            const decision = await this.assetClient.validateClosure({ useHash, operations });
            this._rightsCache.set(key, decision);
            return decision;
        })();
        this._rightsInflight.set(key, pending);
        try {
            return await pending;
        } finally {
            this._rightsInflight.delete(key);
        }
    }

    async _warmCaptureRights(signal) {
        const useHashes = this.rootUseHashes;
        if (useHashes.length === 0) return;
        const operations = [...PBR_MEASURED_ASSET_OPERATIONS];
        if (typeof this.assetClient.validateAccessSet === "function") {
            const decision = await this.assetClient.validateAccessSet({ useHashes, operations }, signal);
            for (const useHash of useHashes) {
                this._rightsCache.set(this._rightsKey(useHash, operations), Object.freeze({
                    ...decision,
                    useHash,
                }));
            }
            return;
        }
        await Promise.all(useHashes.map((useHash) => this.authorizeSourceUse({ useHash, operations })));
    }
}

/** Explicit live analytic cameras own their geometry; historical cameras keep their existing path. */
export class BrowserAnalyticRenderRuntime extends BrowserPbrRenderRuntime {
    async prepare(resolved, { vehicles = this._vehicles() } = {}) {
        this.dispose({ preserveListeners: true });
        const description = resolved.renderScene?.description;
        assertCanonicalAnalyticRenderSceneDescription(description);
        if (hashRenderScene(description) !== resolved.renderScene.hash) throw new Error("Analytic render-scene hash mismatch.");
        assertCameraObjectMotionFields(description, { world: resolved.world.description });
        this.controller = new AbortController();
        this.objectMotion = description.objectMotion;
        this.objectMotionBindings = structuredClone(description.objectMotionBindings ?? []);
        this.renderSceneDescription = description;
        this.appearanceScene = new THREE.Scene();
        this.analyticScene = new THREE.Scene();
        for (const scene of [this.appearanceScene, this.analyticScene]) {
            scene.userData.cevSimCaptureTopologyRevision = 1;
            scene.userData.cevSimCaptureTransformRevision = 1;
            scene.background = new THREE.Color(0, 0, 0);
        }
        this._buildAnalyticScene(description, description.actors.map((actor) => ({ actorId: actor.actorId, transform: new THREE.Matrix4().toArray() })));
        disposeOwnedScene(this.appearanceScene);
        const originals = [];
        this.analyticScene.traverse((object) => originals.push(object));
        const cloned = this.analyticScene.clone(true);
        const clones = [];
        cloned.traverse((object) => clones.push(object));
        const paired = new Map(originals.map((object, index) => [object, clones[index]]));
        const bindings = new Map(this.analyticBindings.map((binding) => [binding.renderableId, binding]));
        cloned.traverse((object) => {
            if (!object.isMesh) return;
            object.geometry = object.geometry.clone();
            const binding = bindings.get(object.userData.renderableId);
            const color = description.materials.find((material) => material.semanticId === binding?.semanticId)?.colorRgba;
            object.material = new THREE.MeshBasicMaterial({
                color: color ? new THREE.Color().setRGB(color[0] / 255, color[1] / 255, color[2] / 255, THREE.SRGBColorSpace) : semanticColor(binding?.semanticId ?? 0),
                side: THREE.DoubleSide,
            });
        });
        this.appearanceScene = cloned;
        for (const groups of this.actorGroups.values()) groups.appearance = paired.get(groups.analytic);
        this.renderPolicy = { exposure: 1, outputColorSpace: "srgb", toneMapping: "none", backgroundColorRgba: [0, 0, 0, 1] };
        for (const [key, role] of [["appearanceSceneHandle", "measured-appearance"], ["analyticSceneHandle", "analytic-truth"]]) {
            this[key] = createOwnedCaptureScene({
                role,
                scene: role === "measured-appearance" ? this.appearanceScene : this.analyticScene,
                generation: this.generation,
                descriptionHash: resolved.renderScene.hash,
                objectMotion: this.objectMotion,
                objectMotionBindings: this.objectMotionBindings,
            });
        }
        this.analyticAppearanceObjects = new Map([...this.objectGroups].map(([id, group]) => [id, paired.get(group)]));
        this._initializeObjectMotion();
        this._updateActors(vehicles);
        this._setReadyStatus();
        this.applyRigidBodyPoses([]);
        return this.status;
    }

    _applyObjectPoses(poses) {
        const changed = super._applyObjectPoses(poses);
        let moved = false;
        for (const id of changed) {
            const appearance = this.analyticAppearanceObjects.get(id);
            const matrix = this.objectGroups.get(id).matrix;
            if (matrixElementsMatch(appearance.matrix, matrix)) continue;
            appearance.matrix.copy(matrix);
            appearance.matrixWorldNeedsUpdate = true;
            appearance.updateMatrixWorld(true);
            moved = true;
        }
        if (moved) this.appearanceScene.userData.cevSimCaptureTransformRevision += 1;
        return changed;
    }

    async prepareCapture({ vehicles = this._vehicles() } = {}) {
        this._updateActors(vehicles);
    }

    _snapshot(state, error = null) {
        return { ...super._snapshot(state, error), provider: { id: "canonical-analytic", version: 1 } };
    }

    _releaseResources() {
        super._releaseResources();
        this.analyticAppearanceObjects = new Map();
    }
}
