import * as THREE from "three";

import { BuildingRegionPlanner } from "../visualization/BuildingRegionPlanner.js";
import {
    BAKE_JOB_PHASES,
    BAKE_JOB_STATES,
    BAKE_PRODUCT_RESULT_KEYS,
    BakeRunCatalog,
    buildBakeCapturePlan,
    composeBakePoses,
    createBakeProductDigest,
    hashBakeProviderRequest,
    hashCaptureProductBuffer,
    interpolateBakePathSample,
    isTerminalBakeState,
    normalizeBakeProviderRequest,
    pathLengthMeters,
    planIntegerSampleDistances,
} from "./BakeRunCatalog.js";
import { buildBakeSourceSnapshot } from "./BakeSnapshotBuilder.js";
import {
    applyProjectionToThreeCamera,
    CORRECTED_VISUAL_CAPTURE_MODE,
} from "./VisualCapturePipeline.js";
import { createDefaultBakeRunConfig } from "../visualization/BakeRunConfig.js";
import { bakeCaptureUnitId } from "./BakeReuseContracts.js";
import {
    buildProposalArtifactsFromModelOutput,
    isIntrinsicMaterialModelProvider,
} from "./BakeModelOutput.js";
import { normalizeBakeMaterialProposalSet, validateBakeMaterialProposals } from "./BakeMaterialProposals.js";

function asVector3(value) {
    if (!value) return new THREE.Vector3();
    if (value.isVector3 || typeof value.clone === "function") return value.clone();
    return new THREE.Vector3(value.x ?? 0, value.y ?? 0, value.z ?? 0);
}

function asEuler(value) {
    if (!value) return new THREE.Euler(0, 0, 0, "XYZ");
    if (value.isEuler) return value.clone();
    if (value.w !== undefined) {
        return new THREE.Euler().setFromQuaternion(
            new THREE.Quaternion(value.x, value.y, value.z, value.w),
            "XYZ",
        );
    }
    return new THREE.Euler(value.x ?? 0, value.y ?? 0, value.z ?? 0, value.order || "XYZ");
}

/**
 * Prepare → snapshot → capture → provider → terminal for version-1 bake jobs.
 * Host may be a BakeHarness instance or a catalog-only test double.
 */
export async function runVersion1BakeJob(host, options = {}) {
    const catalog = host.catalog ?? options.catalog ?? new BakeRunCatalog();
    host.catalog = catalog;
    host._version1 ??= { jobId: null, generation: 0, controller: null, snapshot: null, views: [] };
    if (typeof host._disposeVersion1Job === "function") {
        host._disposeVersion1Job({ supersede: true });
    }
    const controller = options.signal ? null : new AbortController();
    const signal = options.signal ?? controller.signal;
    host._version1.controller = controller;
    host._version1.generation += 1;
    const generation = options.generation ?? host._version1.generation;
    host._version1.generation = generation;

    const configInput = options.config
        ?? host.data?.bakeRunConfig?.()?.document?.()
        ?? createDefaultBakeRunConfig().document();
    const throwIfAborted = () => {
        if (!signal?.aborted) return;
        throw signal.reason instanceof Error ? signal.reason : new Error("Bake job cancelled.");
    };
    let job = null;
    try {
        throwIfAborted();
        job = catalog.createJob(configInput, {
            jobId: options.jobId,
            generation,
            incremental: options.incremental === true,
        });
        host._version1.jobId = job.jobId;
        catalog.updateStatus(job.jobId, {
            state: BAKE_JOB_STATES.running,
            phase: BAKE_JOB_PHASES.prepare,
            timestamps: { startedAt: Date.now() },
        });
        throwIfAborted();
        const adapter = catalog.providers.preflight(job.config.provider, {
            incremental: options.incremental === true,
            config: job.config,
        });
        if (typeof adapter.probe === "function") {
            await adapter.probe({
                config: job.config,
                operational: job.config.operational,
                signal,
            });
        }
        const materializerInputs = options.materializer?.bakeSnapshotInputs?.() ?? {};
        const sourceScene = options.sourceScene
            ?? options.scene
            ?? materializerInputs.previewRoot?.parent
            ?? host.data?.scene;
        const previewRoot = options.previewRoot ?? materializerInputs.previewRoot ?? null;
        throwIfAborted();
        const frozen = buildBakeSourceSnapshot({
            sourceScene,
            previewRoot,
            livePreviewRoot: previewRoot,
            worldHash: options.worldHash ?? materializerInputs.worldHash ?? "0".repeat(64),
            environmentRevision: options.environmentRevision
                ?? host.data?.environment?.()?.revision
                ?? 0,
            bakeGeneration: generation,
            visualDescriptorHash: options.visualDescriptorHash ?? null,
            visualAccessHash: options.visualAccessHash ?? null,
            descriptor: options.descriptor ?? materializerInputs.descriptor ?? null,
            access: options.access ?? materializerInputs.access ?? null,
            sourceUseHashes: options.sourceUseHashes
                ?? materializerInputs.access?.assets?.map((entry) => entry.useHash).filter(Boolean)
                ?? [],
            uses: options.uses ?? materializerInputs.uses ?? [],
            selectedChunks: options.selectedChunks ?? materializerInputs.selectedChunks ?? [],
            outputRoles: job.config.outputRoles,
            lodPolicyHash: options.lodPolicyHash ?? materializerInputs.lodPolicyHash ?? null,
            calibrations: job.config.views.map((view) => ({
                viewId: view.id,
                calibration: view.calibration,
            })),
            authorizeSourceUse: options.authorizeSourceUse ?? null,
            registry: options.registry ?? null,
            resourceCache: options.resourceCache ?? materializerInputs.cache ?? null,
        });
        host._version1.snapshot = frozen;
        catalog.attachSnapshot(job.jobId, frozen.snapshot);

        const planner = new BuildingRegionPlanner(job.config.buildings, {
            rotationIndex: job.config.planner.rotationIndex,
        });
        host.regionPlanner = planner;
        const spatialIndex = options.spatialIndex ?? host.spatialIndex;
        const regionsBySample = {};
        for (const path of job.config.paths) {
            const distances = planIntegerSampleDistances(pathLengthMeters(path), job.config.sampling);
            for (let sampleIndex = 0; sampleIndex < distances.length; sampleIndex += 1) {
                const interpolated = interpolateBakePathSample(path.vertices, distances[sampleIndex]);
                for (const view of job.config.views) {
                    const worldPose = composeBakePoses(interpolated, view.pose);
                    const camera = new THREE.PerspectiveCamera();
                    camera.position.set(worldPose.position.x, worldPose.position.y, worldPose.position.z);
                    camera.quaternion.set(
                        worldPose.rotation.x,
                        worldPose.rotation.y,
                        worldPose.rotation.z,
                        worldPose.rotation.w,
                    );
                    camera.updateMatrixWorld(true);
                    applyProjectionToThreeCamera(camera, view.calibration);
                    planner.advance(sampleIndex);
                    regionsBySample[`${job.config.seedKeys.run}:${path.id}:${sampleIndex}:${view.id}`] = planner.planForView(
                        spatialIndex ?? frozen.sceneHandle.scene,
                        camera,
                    );
                }
            }
        }
        const plan = buildBakeCapturePlan({
            config: job.config,
            snapshot: frozen.snapshot,
            regionsBySample,
        });
        catalog.attachPlan(job.jobId, plan);
        catalog.updateStatus(job.jobId, { phase: BAKE_JOB_PHASES.capture });

        const bindings = options.bindings ?? [];
        const renderables = options.renderables ?? new Map();
        const sourceUseHashes = frozen.snapshot.sourceUseHashes;
        if (typeof adapter.authorizeUses === "function") {
            await adapter.authorizeUses({
                sourceUseHashes,
                authorizeSourceUse: options.authorizeSourceUse,
                cachePolicy: job.config.cachePolicy,
            });
        }
        const injectCapture = typeof options.captureAlignedProducts === "function";
        const viewsById = new Map();
        if (!injectCapture) {
            const { BakeView } = await import("../visualization/BakeView.js");
            for (const viewConfig of job.config.views) {
                const view = new BakeView(viewConfig.id, {
                    position: asVector3(viewConfig.pose.position),
                    rotation: asEuler(viewConfig.pose.rotation),
                    camera: {
                        width: viewConfig.camera.width,
                        height: viewConfig.camera.height,
                        fov: viewConfig.camera.fov,
                        near: viewConfig.camera.near,
                        far: viewConfig.camera.far,
                        intrinsics: viewConfig.camera.intrinsics,
                        distortionModel: viewConfig.camera.distortionModel,
                        distortion: viewConfig.camera.distortion,
                    },
                    captureMode: CORRECTED_VISUAL_CAPTURE_MODE,
                    captureSceneHandle: frozen.sceneHandle,
                    authorizeSourceUse: options.authorizeSourceUse,
                    includeTags: viewConfig.includeTags,
                    excludeTags: viewConfig.excludeTags,
                    maxFramesPerChannel: 0,
                });
                view.setup({
                    scene: frozen.sceneHandle.scene,
                    renderer: options.renderer ?? host.data?.renderer,
                    data: host.data,
                });
                viewsById.set(viewConfig.id, view);
                host._version1.views.push(view);
            }
        }

        const captureFn = injectCapture
            ? options.captureAlignedProducts
            : async (view, args) => view.captureAlignedProducts(args);
        const inputs = [];
        const productBuffers = new Map();
        const productDigests = new Map();
        const captureUnitIds = options.captureUnitIds ? new Set(options.captureUnitIds) : null;
        const retainBuffers = options.retainBuffers !== false;
        for (const sample of plan.samples) {
            throwIfAborted();
            const unitId = bakeCaptureUnitId(sample.pathId, sample.sampleIndex, sample.viewId);
            if (captureUnitIds && !captureUnitIds.has(unitId)) continue;
            const view = viewsById.get(sample.viewId) ?? { name: sample.viewId };
            if (view.setPose) view.setPose(asVector3(sample.pose.position), asEuler(sample.pose.rotation));
            const captured = await captureFn(view, {
                captureTimeNs: plan.captureTimeNs,
                products: sample.products,
                bindings,
                sourceUseHashes,
                renderables,
                signal,
                sample,
            });
            const family = captured?.visual ?? captured;
            const width = job.config.views.find((entry) => entry.id === sample.viewId).camera.width;
            const height = job.config.views.find((entry) => entry.id === sample.viewId).camera.height;
            const unitBuffers = new Map();
            for (const role of sample.products) {
                const key = BAKE_PRODUCT_RESULT_KEYS[role] ?? role;
                const data = family?.products?.[key] ?? family?.products?.[role];
                if (!data) {
                    throw new Error(`Aligned capture missing product ${role} for ${sample.sampleId}.`);
                }
                const copied = data instanceof Float32Array
                    ? new Float32Array(data)
                    : data instanceof Uint32Array
                        ? new Uint32Array(data)
                        : new Uint8Array(data);
                const bufferKey = `${sample.sampleId}:${sample.viewId}:${role}`;
                unitBuffers.set(bufferKey, copied);
                const digestRecord = createBakeProductDigest({
                    sampleId: sample.sampleId,
                    viewId: sample.viewId,
                    role,
                    data: copied,
                    width,
                    height,
                });
                productDigests.set(bufferKey, digestRecord.sha256);
                if (retainBuffers) productBuffers.set(bufferKey, copied);
                inputs.push(digestRecord);
            }
            if (typeof options.onUnitCaptured === "function") {
                await options.onUnitCaptured({
                    sample,
                    unitId,
                    buffers: unitBuffers,
                    width,
                    height,
                });
            }
            catalog.updateStatus(job.jobId, {
                progress: {
                    completedSamples: inputs.length,
                    totalSamples: plan.samples.length,
                },
            });
        }

        const request = normalizeBakeProviderRequest({
            kind: "cev-sim.bake-provider-request",
            version: 1,
            recipeHash: job.recipeHash,
            snapshotHash: job.snapshotHash,
            planHash: job.planHash,
            provider: job.config.provider,
            providerOptions: job.config.providerOptions,
            cachePolicy: job.config.cachePolicy,
            seed: job.config.seed,
            inputs,
        });
        catalog.attachRequest(job.jobId, request);
        throwIfAborted();
        const execution = await adapter.execute(request, {
            generation,
            requestHash: hashBakeProviderRequest(request),
            buffers: productBuffers,
            operational: job.config.operational,
            construction: job.config.construction,
            config: job.config,
            authorizeSourceUse: options.authorizeSourceUse,
            sourceUseHashes,
            signal,
        });
        const response = execution?.response ?? execution;
        catalog.attachResponse(job.jobId, response, { generation });
        const completed = catalog.get(job.jobId);
        for (const output of completed.response.outputs) {
            const key = `${output.sampleId}:${output.viewId}:${output.role}`;
            if (productDigests.get(key) !== output.sha256) {
                throw new Error(`Retained ${output.role} buffer does not match the provider response digest.`);
            }
            if (retainBuffers) {
                const retained = productBuffers.get(key);
                if (!retained || hashCaptureProductBuffer(retained) !== output.sha256) {
                    throw new Error(`Retained ${output.role} buffer does not match the provider response digest.`);
                }
            }
        }
        if (isIntrinsicMaterialModelProvider(job.config.provider)) {
            if (options.materialProposalSet || options.materialProposalBuffers) {
                const error = new Error("Intrinsic model jobs cannot mix caller-supplied proposals with model-generated proposals.");
                error.code = "BAKE_MATERIAL_PROPOSAL_CONFLICT";
                throw error;
            }
            if (!execution?.modelOutputSet || !execution?.modelBuffers) {
                const error = new Error("intrinsic-material-model@1 did not return a complete model-output set.");
                error.code = "BAKE_MODEL_INCOMPLETE";
                throw error;
            }
            const artifacts = buildProposalArtifactsFromModelOutput({
                job: completed,
                modelOutputSet: execution.modelOutputSet,
                buffers: execution.modelBuffers,
                options: job.config.providerOptions,
                sourceUseHashes,
                response: completed.response,
            });
            const validated = validateBakeMaterialProposals({
                proposalSet: artifacts.proposalSet,
                buffers: artifacts.buffers,
                construction: job.config.construction,
                job: completed,
            });
            completed.materialProposalSet = validated.proposalSet ?? normalizeBakeMaterialProposalSet(artifacts.proposalSet);
            completed.materialProposalBuffers = artifacts.buffers;
            completed.modelOutputSet = execution.modelOutputSet;
        }
        if (host._version1) host._version1.productBuffers = productBuffers;
        catalog.complete(job.jobId);
        const result = catalog.get(job.jobId);
        result.productBuffers = productBuffers;
        result.sceneHandle = frozen.sceneHandle;
        return result;
    } catch (error) {
        const current = job ? catalog.get(job.jobId) : null;
        if (current && !isTerminalBakeState(current.status.state)) {
            const cancelled = signal?.aborted || /cancel/i.test(error?.message ?? "");
            if (cancelled) catalog.cancel(job.jobId);
            else catalog.fail(job.jobId, error);
        }
        throw error;
    }
}
