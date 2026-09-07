import { performance } from "node:perf_hooks";
import * as THREE from "three";

import {
    VISUAL_SCALE_REPORT_KIND,
    VISUAL_SCALE_REPORT_VERSION,
    VISUAL_SCALE_PROFILE_IDS,
    getVisualScaleProfile,
    hashVisualScaleProfile,
    teardownResidueCeiling,
    visualScaleIdentity,
} from "./VisualScaleProfile.js";
import {
    defaultVisualLodPolicy,
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    hashVisualLodPolicy,
    normalizeVisualAssetUse,
    normalizeVisualLayer,
    normalizeVisualLayerAccess,
    selectVisualLodIndex,
    selectVisualLodUri,
    sha256ExactBytes,
} from "./VisualLayer.js";
import { VisualMemoryLedger, VisualBudgetError } from "../../3d/environment/visual/VisualMemoryLedger.js";
import { VisualResourceCache } from "../../3d/environment/visual/VisualResourceCache.js";
import { VisualChunkResidencyController } from "../../3d/environment/visual/VisualChunkResidencyController.js";
import { VisualLayerMaterializer } from "../../3d/environment/visual/VisualLayerMaterializer.js";
import { BakeMemoryLedger, estimatePassSetBytes } from "../../3d/environment/visualization/BakeMemoryLedger.js";
import { BakeSpatialIndex } from "../../3d/environment/visualization/BakeSpatialIndex.js";

export async function runVisualScaleBenchmark({
    profileId = VISUAL_SCALE_PROFILE_IDS.hostedQuickV1,
    requireGpu = false,
    now = () => Date.now(),
    rss = () => process.memoryUsage().rss,
    telemetry = null,
    gitRevision = process.env.GITHUB_SHA ?? null,
} = {}) {
    const profile = getVisualScaleProfile(profileId);
    const startedAt = now();
    const baselineRss = rss();
    const failures = [];
    const skips = [];
    const timings = {};
    if (requireGpu && !telemetry?.available) {
        throw new Error("Full hardware visual-scale mode requires usable GPU/unified-memory telemetry.");
    }
    if (!requireGpu) skips.push("hardware-telemetry");

    const lodPolicy = defaultVisualLodPolicy();
    const lodChecks = [0, 79.9, 80, 199.9, 200, 400].map((distance) => ({
        distance,
        index: selectVisualLodIndex(distance, lodPolicy),
        uri: selectVisualLodUri({ lodLevels: ["sha256:a", "sha256:b", "sha256:c"] }, distance, lodPolicy),
    }));
    const orin = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.jetsonAgxOrinV1);
    const thor = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.jetsonAgxThorV1);
    const x64 = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1);
    if (hashVisualLodPolicy(orin.lodPolicy) !== hashVisualLodPolicy(x64.lodPolicy)
        || hashVisualLodPolicy(thor.lodPolicy) !== hashVisualLodPolicy(x64.lodPolicy)) {
        failures.push("lod-policy-divergence");
    }

    const cache = new VisualResourceCache({ profile, now });
    const payload = new Uint8Array(4096);
    let loaderCalls = 0;
    const first = performance.now();
    const [a, b] = await Promise.all([
        cache.acquireEncoded({
            digest: "a".repeat(64),
            useHash: "b".repeat(64),
            sizeBytes: payload.byteLength,
            loader: async () => {
                loaderCalls += 1;
                return payload;
            },
        }),
        cache.acquireEncoded({
            digest: "a".repeat(64),
            useHash: "b".repeat(64),
            sizeBytes: payload.byteLength,
            loader: async () => {
                loaderCalls += 1;
                return payload;
            },
        }),
    ]);
    timings.concurrentAcquireMs = performance.now() - first;
    if (loaderCalls !== 1 || cache.snapshot().entryCount !== 1) failures.push("cache-dedup");
    a.release();
    b.release();
    cache.evictUntil("encodedCpu", profile.ceilings.encodedCpuBytes);
    if (cache.snapshot().liveLeases !== 0) failures.push("cache-leases");

    const documents = syntheticLayer(profile);
    const materializer = new VisualLayerMaterializer({
        previewRoot: new THREE.Group(),
        THREE,
        profile,
        lodPolicy,
        parseGltf: documents.parseGltf,
        decodeTexture: async () => ({
            isTexture: true,
            clone() { return { isTexture: true, dispose() {} }; },
            dispose() {},
        }),
        layerClient: documents.layerClient,
        assetClient: documents.assetClient,
        cache: new VisualResourceCache({ profile, now }),
    });
    const coldStart = performance.now();
    const cold = await materializer.replace(documents.reference, documents.world, {
        interest: { position: { x: 0, y: 0, z: 0 } },
    });
    timings.coldAoiMs = performance.now() - coldStart;
    const fetchedCold = documents.fetched.slice();
    const warmStart = performance.now();
    await materializer.updateInterest({ position: { x: 5, y: 0, z: 0 } });
    timings.warmAoiMs = performance.now() - warmStart;
    const far = await materializer.updateInterest({ position: { x: 10_000, y: 0, z: 0 } });
    if (fetchedCold.length >= documents.access.assets.length && documents.descriptor.chunks.length > 2) {
        failures.push("eager-whole-layer-fetch");
    }
    if (cold.status !== "ready") failures.push("cold-aoi-not-ready");

    const cancelStart = performance.now();
    const pending = materializer.replace(documents.reference, documents.world);
    materializer.dispose();
    await pending.catch(() => null);
    timings.cancelMs = performance.now() - cancelStart;

    const ledger = new BakeMemoryLedger({ profile });
    const passBytes = estimatePassSetBytes({
        width: profile.workload.bakeWidth,
        height: profile.workload.bakeHeight,
        passCount: profile.workload.bakePassesPerView,
        includeLidar: false,
    });
    await ledger.withPipelineReservation(Math.min(passBytes, profile.ceilings.bakeBufferBytes), async () => "ok");
    const index = new BakeSpatialIndex();
    index.upsert({
        id: "building-0",
        kind: "building",
        bounds: { minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 4, maxZ: 1 },
        meshes: [],
    });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    index.queryFrustum(camera);
    if (index.wholeSceneSearches !== 0) failures.push("whole-scene-search");

    const residency = new VisualChunkResidencyController({ profile, policy: lodPolicy });
    const planNear = residency.plan(documents.descriptor, { position: { x: 0, y: 0, z: 0 } });
    const planFar = residency.plan(documents.descriptor, { position: { x: 10_000, y: 0, z: 0 } });
    if (planNear.required.length === 0) failures.push("required-aoi");
    if (planFar.required.length > planNear.required.length) failures.push("silent-object-reduction");

    let budgetFailed = false;
    try {
        const tight = new VisualMemoryLedger({
            profile,
            ceilings: { encodedCpu: 1, decodedCpu: 1, gpu: 1, transient: 1 },
            unifiedCeiling: null,
        });
        tight.reserve("encodedCpu", 8);
    } catch (error) {
        budgetFailed = error instanceof VisualBudgetError;
    }
    if (!budgetFailed) failures.push("budget-enforcement");

    cache.dispose();
    ledger.releaseAll();
    const residue = Math.max(0, rss() - baselineRss);
    const residueCeiling = teardownResidueCeiling(baselineRss, profile);
    if (profile.advertised && requireGpu && residue > residueCeiling) {
        failures.push("teardown-residue");
    }
    const report = {
        kind: VISUAL_SCALE_REPORT_KIND,
        version: VISUAL_SCALE_REPORT_VERSION,
        createdAt: new Date(startedAt).toISOString(),
        identity: visualScaleIdentity(profile),
        profileId: profile.id,
        profileHash: hashVisualScaleProfile(profile),
        lodPolicyHash: hashVisualLodPolicy(lodPolicy),
        workloadHash: hashVisualScaleProfile(profile),
        advertised: profile.advertised === true,
        requireGpu,
        gitRevision,
        host: {
            model: telemetry?.model ?? null,
            sku: telemetry?.sku ?? null,
            os: process.platform,
            arch: process.arch,
            jetpack: telemetry?.jetpack ?? null,
            l4t: telemetry?.l4t ?? null,
            powerMode: telemetry?.powerMode ?? null,
            chromium: telemetry?.chromium ?? null,
            angle: telemetry?.angle ?? null,
            webgl: telemetry?.webgl ?? null,
            gpu: telemetry?.gpu ?? null,
            driver: telemetry?.driver ?? null,
        },
        memory: {
            logical: cache.snapshot().memory,
            rssBytes: rss(),
            baselineRssBytes: baselineRss,
            residueBytes: residue,
            residueCeilingBytes: residueCeiling,
            unified: telemetry?.unified ?? null,
            gpu: telemetry?.gpuMemory ?? null,
        },
        latency: timings,
        throughput: {
            fetchedAssets: fetchedCold.length,
            residentChunks: cold.residency?.residentChunks ?? 0,
        },
        queue: cache.snapshot().queue,
        evictions: cache.snapshot().evictions,
        disposals: cache.snapshot().disposals,
        lodChecks,
        farStatus: far.status,
        gScale: {
            noPerFrameWholeCityTransfer: !failures.includes("eager-whole-layer-fetch"),
            noQuadraticLookup: index.wholeSceneSearches === 0,
            noSilentLodReduction: !failures.includes("silent-object-reduction")
                && !failures.includes("lod-policy-divergence"),
            noCapabilitySkip: !profile.advertised || (requireGpu && telemetry?.available === true),
        },
        failures,
        skips,
        passed: failures.length === 0 && (!profile.advertised || !requireGpu || telemetry?.available === true),
        elapsedMs: now() - startedAt,
    };
    return report;
}

function syntheticLayer(profile) {
    const fetched = [];
    const chunks = [];
    const instances = [];
    const assets = [];
    const uses = new Map();
    const bytesByUse = new Map();
    const chunkCount = Math.min(8, profile.workload.chunks);
    for (let index = 0; index < chunkCount; index += 1) {
        const bytes = Uint8Array.from({ length: 64 }, (_, byte) => (byte + index) % 256);
        const digest = sha256ExactBytes(bytes);
        assets.push({
            sha256: digest,
            mediaType: "model/gltf-binary",
            sizeBytes: bytes.byteLength,
            role: "mesh",
        });
        const use = normalizeVisualAssetUse({
            kind: "cev-sim.visual-asset-use",
            version: 1,
            asset: assets.at(-1),
            sourceIds: ["owned-lab"],
            dependencies: {},
        });
        const useHash = hashVisualAssetUse(use);
        uses.set(useHash, use);
        bytesByUse.set(useHash, bytes);
        const id = `chunk-${index}`;
        const instanceId = `building-${index}`;
        const x = index < 2 ? index * 10 : 5_000 + index * 20;
        chunks.push({ id, instanceIds: [instanceId], dependencyUris: [`sha256:${digest}`] });
        instances.push({
            id: instanceId,
            assetUri: `sha256:${digest}`,
            lodLevels: [`sha256:${digest}`],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
            chunkIds: [id],
            materialIds: ["brick"],
        });
    }
    const descriptor = normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: "c".repeat(64),
        assetProfile: { id: "static-gltf-surface", version: 1 },
        assets,
        materials: [{
            id: "brick",
            mode: "metallic-roughness",
            parameters: {},
            textures: [],
            extensions: [],
        }],
        chunks,
        instances,
        bindings: instances.map((instance) => ({
            id: `binding-${instance.id}`,
            instanceId: instance.id,
            truthEntityId: instance.id,
        })),
        appearanceDependencies: [],
    });
    const access = normalizeVisualLayerAccess({
        kind: "cev-sim.visual-layer-access",
        version: 1,
        descriptorHash: hashVisualLayer(descriptor),
        assets: descriptor.assets.map((asset) => ({
            sha256: asset.sha256,
            useHash: [...uses.entries()].find(([, use]) => use.asset.sha256 === asset.sha256)[0],
        })),
    });
    return {
        descriptor,
        access,
        fetched,
        reference: {
            descriptorHash: hashVisualLayer(descriptor),
            accessHash: hashVisualLayerAccess(access),
        },
        world: {
            hash: "c".repeat(64),
            description: {
                buildings: instances.map((instance) => ({ id: instance.id })),
                features: [],
                roads: { nodes: [], edges: [] },
            },
        },
        layerClient: {
            async getAccess() {
                return { descriptor, access };
            },
        },
        assetClient: {
            async getUse(useHash) {
                return uses.get(useHash);
            },
            async getUseContent(useHash) {
                fetched.push(useHash);
                const use = uses.get(useHash);
                return {
                    bytes: bytesByUse.get(useHash),
                    mediaType: use.asset.mediaType,
                    etag: `"${use.asset.sha256}"`,
                };
            },
        },
        parseGltf: async (_bytes, digest) => {
            const scene = new THREE.Group();
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(0.2, 0.2, 0.2),
                new THREE.MeshPhysicalMaterial({ name: "brick" }),
            );
            scene.add(mesh);
            return {
                scene,
                json: { materials: [{ name: "brick" }], meshes: [{ primitives: [{ material: 0 }] }] },
                digest,
            };
        },
    };
}
