import * as THREE from "three";

import {
    PBR_MEASURED_ASSET_OPERATIONS,
    assertPbrRenderSceneDescription,
    assertPbrRunEvidence,
    hashPbrRenderScene,
} from "../../simulation/render/PbrRenderScene.js";
import {
    VISUAL_CAPTURE_PASS_FAMILIES,
    createOwnedCaptureScene,
    createVisualCaptureInput,
    createVisualCapturePassSet,
} from "../environment/visual/VisualCapturePipeline.js";
import {
    VisualLayerMaterializer,
    sanitizeMeasuredAppearanceObject,
} from "../environment/visual/VisualLayerMaterializer.js";
import { VisualAssetClient } from "../environment/visual/VisualAssetClient.js";
import { rep103PoseToThree } from "../../autonomy/CoordinateFrames.js";
import { applyPbrRenderRecipeToScene } from "../environment/visual/PbrRenderRecipeRuntime.js";

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

function primitiveMesh(primitive, { appearance = false } = {}) {
    const material = appearance
        ? new THREE.MeshStandardMaterial({
            color: semanticColor(primitive.semanticId),
            metalness: 0,
            roughness: 0.8,
            side: THREE.DoubleSide,
        })
        : new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    material.dithering = false;
    const mesh = new THREE.Mesh(primitiveGeometry(primitive), material);
    mesh.name = primitive.id;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = {
        cevSimRenderRuntimeOwned: true,
        renderableId: primitive.id,
    };
    return mesh;
}

function vehicleMatrix(vehicle) {
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
            const vehicle = byId.get(sensor.parentId);
            if (!vehicle) {
                throw new Error(`Camera "${sensor.id}" references missing vehicle "${sensor.parentId}".`);
            }
            const local = rep103PoseToThree(sensor.pose).position;
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
        vehicles = () => [],
    } = {}) {
        this.renderer = renderer;
        this.assetClient = assetClient;
        this.materializerFactory = materializerFactory;
        this.vehicleSource = vehicles;
        this.generation = 0;
        this.controller = null;
        this.materializer = null;
        this.appearanceScene = null;
        this.analyticScene = null;
        this.appearanceSceneHandle = null;
        this.analyticSceneHandle = null;
        this.analyticRenderables = new Map();
        this.analyticBindings = [];
        this.actorGroups = new Map();
        this.assetLeases = [];
        this.ownedActorMaterials = [];
        this.environmentTextureLease = null;
        this.environmentTexture = null;
        this.rootUseHashes = [];
        this.renderPolicy = null;
        this.recipeSceneState = null;
        this.provider = { id: "pbr-mesh", version: 1 };
        this.listeners = new Set();
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

    cameraOptions() {
        if (!this.ready) throw infrastructureError(new Error("PBR render runtime is not ready."));
        return {
            renderRuntime: this,
            captureMode: "calibrated-projection@1",
            captureSceneHandle: this.appearanceSceneHandle,
            analyticSceneHandle: this.analyticSceneHandle,
            authorizeSourceUse: ({ useHash, operations }) => (
                this.assetClient.validateClosure({ useHash, operations })
            ),
            renderPolicy: this.renderPolicy,
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
            this.provider = { ...description.provider };
            if (hashPbrRenderScene(description) !== renderScene.hash) {
                throw new Error("Resolved PBR render-scene hash does not match its description.");
            }
            assertPbrRunEvidence(resolved.evidence, {
                visualLayer: resolved.visualLayer,
                renderScene,
            });

            this.appearanceScene = new THREE.Scene();
            this.analyticScene = new THREE.Scene();
            this._configureRecipe(description.recipe);
            this._buildAnalyticScene(description.analyticTruth.description, description.actors);

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
            }, resolved.world, { interest: initialInterest });
            this._throwIfStale(generation);

            await this._buildActorAppearances(description.actors, resolved.evidence.visualAssets.roots);
            await this._loadEnvironmentMap(description.recipe, resolved.evidence.visualAssets.roots);
            if (description.recipe.shadows.enabled) {
                this.appearanceScene.traverse((object) => {
                    if (!object.isMesh) return;
                    object.castShadow = true;
                    object.receiveShadow = true;
                });
            }
            this._throwIfStale(generation);
            this.rootUseHashes = [...new Set(
                resolved.evidence.visualAssets.roots.map((entry) => entry.useHash),
            )].sort();
            this.appearanceScene.updateMatrixWorld(true);
            this.analyticScene.updateMatrixWorld(true);
            this.appearanceSceneHandle = createOwnedCaptureScene({
                role: "measured-appearance",
                scene: this.appearanceScene,
                generation,
                descriptionHash: renderScene.hash,
            });
            this.analyticSceneHandle = createOwnedCaptureScene({
                role: "analytic-truth",
                scene: this.analyticScene,
                generation,
                descriptionHash: description.analyticTruth.hash,
            });
            this._updateActors(this._vehicles());
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
            });
            if (materializerStatus.status === "error") {
                throw new Error(materializerStatus.error?.message || "Required PBR residency failed.");
            }
            const residency = materializerStatus.residency;
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
        try {
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
                    ? Uint16Array.from(analytic.semanticId)
                    : null,
                instance: analytic?.instanceId ?? null,
            };
        } catch (error) {
            const failure = infrastructureError(error, "PBR_CAPTURE_FAILED");
            this._setStatus("error", failure);
            throw failure;
        }
    }

    dispose({ preserveListeners = false } = {}) {
        this.generation += 1;
        this.controller?.abort();
        this.controller = null;
        this._releaseResources();
        this.status = this._snapshot("idle");
        if (!preserveListeners) this.listeners.clear();
    }

    _configureRecipe(recipe) {
        const background = recipe.background.colorRgba;
        this.appearanceScene.background = new THREE.Color(background[0], background[1], background[2]);
        this.recipeSceneState = applyPbrRenderRecipeToScene(this.appearanceScene, recipe);
        this.analyticScene.background = new THREE.Color(0, 0, 0);
        this.renderPolicy = this.recipeSceneState.renderPolicy;
    }

    _buildAnalyticScene(analyticTruth, actorDescriptions) {
        const actorById = new Map(actorDescriptions.map((entry) => [entry.actorId, entry]));
        for (const primitive of analyticTruth.staticPrimitives) {
            this._addAnalyticPrimitive(primitive, this.analyticScene);
        }
        for (const actor of analyticTruth.actors) {
            const analyticGroup = new THREE.Group();
            analyticGroup.name = `cev-sim.analytic-actor:${actor.actorId}`;
            analyticGroup.matrixAutoUpdate = false;
            this.analyticScene.add(analyticGroup);
            for (const primitive of actor.primitives) this._addAnalyticPrimitive(primitive, analyticGroup);

            const appearanceGroup = new THREE.Group();
            appearanceGroup.name = `cev-sim.appearance-actor:${actor.actorId}`;
            appearanceGroup.matrixAutoUpdate = false;
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
    }

    _addAnalyticPrimitive(primitive, parent) {
        const mesh = primitiveMesh(primitive);
        parent.add(mesh);
        this.analyticRenderables.set(primitive.id, mesh);
        this.analyticBindings.push({
            renderableId: primitive.id,
            semanticId: primitive.semanticId,
            instanceId: primitive.instanceId,
        });
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

    _updateActors(vehicles) {
        const byId = new Map(vehicles.map((vehicle, index) => [actorId(vehicle, index), vehicle]));
        for (const [id, groups] of this.actorGroups) {
            const vehicle = byId.get(id);
            if (!vehicle) throw new Error(`Resolved PBR actor "${id}" is not present in the simulation.`);
            const matrix = vehicleMatrix(vehicle);
            groups.analytic.matrix.copy(matrix);
            groups.appearance.matrix.copy(matrix);
        }
        this.appearanceScene?.updateMatrixWorld?.(true);
        this.analyticScene?.updateMatrixWorld?.(true);
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
            provider: { ...this.provider },
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
        this.recipeSceneState?.dispose?.();
        this.recipeSceneState = null;
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
        this.actorGroups = new Map();
        this.rootUseHashes = [];
        this.renderPolicy = null;
    }
}
