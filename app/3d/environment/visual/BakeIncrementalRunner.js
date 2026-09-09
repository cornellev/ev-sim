/**
 * VIS-09/VIS-10a incremental bake: compare dependency keys, capture only
 * invalidated units, convert captures to sparse contributions, and rebuild
 * only dirty atlas chunks.
 */

import { BakeSpatialIndex } from "../visualization/BakeSpatialIndex.js";
import {
    BakeMemoryLedger,
    BAKE_MEMORY_KINDS,
    estimatePassSetBytes,
} from "../visualization/BakeMemoryLedger.js";
import {
    hashBakeReuseManifest,
    normalizeBakeReuseReport,
    BAKE_REUSE_REASONS,
    isBakeReuseManifestV2,
} from "./BakeReuseContracts.js";
import {
    constructionFromConfig,
    isChunkAtlasConstruction,
    isIntrinsicProposalConstruction,
} from "./BakeConstructionPolicy.js";
import {
    buildBakeDependencyGraph,
    compareBakeReuseGraphs,
    fragmentMapFromManifest,
} from "./BakeDependencyGraph.js";
import { runVersion1BakeJob } from "./BakeJobRunner.js";
import {
    createBakeArtifactWriter,
    encodeBakeUnitArtifacts,
    uploadBakeArtifacts,
    writeBakeArtifacts,
} from "./BakeArtifactWriter.js";
import {
    buildAtlasLayoutFromScene,
    encodeUnitContribution,
    loadContributionPayloads,
} from "./BakeAtlasArtifactWriter.js";
import {
    bakeMaterialProposalUnitDigests,
    normalizeBakeMaterialProposalSet,
    validateBakeMaterialProposals,
} from "./BakeMaterialProposals.js";
import { isIntrinsicMaterialModelProvider } from "./BakeModelOutput.js";

function peakUsed(ledger, peak) {
    return Math.max(peak, ledger.snapshot().usedBytes);
}

function configDocument(options) {
    const config = options.config;
    if (typeof config?.document === "function") return config.document();
    return config ?? null;
}

function dirtyChunkKeys({ compared, graph, previousManifest, layout }) {
    const keys = new Set();
    const unitChunks = (unitId, source) => {
        const current = graph.units.find((entry) => entry.unitId === unitId);
        if (current?.chunkKeys) return current.chunkKeys;
        const prior = source?.units?.find((entry) => entry.unitId === unitId);
        return prior?.chunkKeys ?? [];
    };
    for (const unitId of compared.captureUnitIds ?? []) {
        for (const key of unitChunks(unitId, previousManifest)) keys.add(key);
    }
    for (const unitId of compared.removedUnitIds ?? []) {
        for (const key of unitChunks(unitId, previousManifest)) keys.add(key);
    }
    if (isBakeReuseManifestV2(previousManifest) && layout) {
        const previous = new Map((previousManifest.chunks ?? []).map((entry) => [entry.chunkKey, entry.chartHash]));
        for (const chunk of layout.chunks) {
            if (previous.get(chunk.chunkKey) !== chunk.chartHash) keys.add(chunk.chunkKey);
        }
        for (const [chunkKey] of previous) {
            if (!layout.chunks.some((entry) => entry.chunkKey === chunkKey)) keys.add(chunkKey);
        }
    }
    return [...keys];
}

function createProjectedStreamHandler({
    host,
    sourceIds,
    fragmentsByUnit,
    ledger,
    uploadClient,
    peakRef,
}) {
    return async ({ sample, unitId, buffers }) => {
        const current = host.catalog?.get(host._version1?.jobId);
        const view = current?.config?.views?.[0] ?? { camera: { width: 20, height: 20 } };
        const unitBytes = estimatePassSetBytes({
            width: view.camera.width,
            height: view.camera.height,
            passCount: 3,
            includeLidar: false,
        });
        const reservation = ledger.reserve(BAKE_MEMORY_KINDS.passBuffer, unitBytes, { label: unitId });
        peakRef.value = peakUsed(ledger, peakRef.value);
        try {
            const encoded = encodeBakeUnitArtifacts({
                sample,
                buffers,
                config: current.config,
                writer: createBakeArtifactWriter(),
                sourceIds,
                viewsById: new Map((current.plan?.views ?? []).map((entry) => [entry.viewId, entry])),
            });
            const pngId = ledger.reserve(BAKE_MEMORY_KINDS.encodedAsset, encoded.uploads[0].bytes.length);
            const glbId = ledger.reserve(BAKE_MEMORY_KINDS.encodedAsset, encoded.uploads[1].bytes.length);
            peakRef.value = peakUsed(ledger, peakRef.value);
            fragmentsByUnit.set(unitId, encoded.fragments);
            if (uploadClient) await uploadBakeArtifacts(uploadClient, encoded.uploads);
            ledger.release(pngId);
            ledger.release(glbId);
            encoded.uploads.forEach((upload) => {
                upload.bytes = null;
            });
        } finally {
            ledger.release(reservation);
        }
    };
}

function createAtlasStreamHandler({
    host,
    sourceIds,
    construction,
    layoutRef,
    contributionsByUnit,
    ledger,
    uploadClient,
    peakRef,
}) {
    return async ({ sample, unitId, buffers }) => {
        const current = host.catalog?.get(host._version1?.jobId);
        const view = current?.config?.views?.find((entry) => entry.id === sample.viewId)
            ?? current?.config?.views?.[0]
            ?? { camera: { width: 20, height: 20 } };
        const unitBytes = estimatePassSetBytes({
            width: view.camera.width,
            height: view.camera.height,
            passCount: 5,
            includeLidar: false,
        });
        const reservation = ledger.reserve(BAKE_MEMORY_KINDS.passBuffer, unitBytes, { label: unitId });
        peakRef.value = peakUsed(ledger, peakRef.value);
        try {
            if (!layoutRef.value) {
                const scene = host._version1?.snapshot?.sceneHandle?.scene ?? current?.sceneHandle?.scene;
                const chartBytes = 256 * 1024;
                const chartId = ledger.reserve(BAKE_MEMORY_KINDS.chart, chartBytes, { label: "atlas-layout" });
                peakRef.value = peakUsed(ledger, peakRef.value);
                layoutRef.value = buildAtlasLayoutFromScene(scene, construction);
                ledger.release(chartId);
            }
            const encoded = encodeUnitContribution({
                sample,
                buffers,
                layout: layoutRef.value,
                construction,
                unitId,
                viewsById: new Map((current.config?.views ?? []).map((entry) => [entry.id, {
                    ...entry,
                    viewId: entry.id,
                    camera: entry.camera,
                    pose: entry.pose,
                }])),
            });
            const contribId = ledger.reserve(
                BAKE_MEMORY_KINDS.contribution,
                encoded.bytes.length,
                { label: unitId },
            );
            peakRef.value = peakUsed(ledger, peakRef.value);
            contributionsByUnit.set(unitId, encoded.bytes);
            ledger.release(contribId);
            void sourceIds;
            void uploadClient;
        } finally {
            ledger.release(reservation);
        }
    };
}

export async function runIncrementalBake({
    host = {},
    options = {},
    previousManifest = null,
    previousGraph = null,
    previousWritten = null,
    currentDescriptor = null,
    currentAccess = null,
    sourceIds = [],
    reuseDisabled = false,
    uploadClient = null,
    assetClient = null,
    memoryLedger = null,
} = {}) {
    const ledger = memoryLedger ?? options.memoryLedger ?? host.memoryLedger ?? new BakeMemoryLedger({
        profile: options.profile ?? host.profile,
    });
    const spatialIndex = options.spatialIndex
        ?? host.spatialIndex
        ?? (options.sourceScene || options.scene
            ? BakeSpatialIndex.fromRegistry(options.registry ?? null, options.chunkManager ?? host.chunkManager, {
                scene: options.sourceScene ?? options.scene,
            })
            : null);
    const construction = constructionFromConfig(configDocument(options) ?? {});
    const atlas = isChunkAtlasConstruction(construction);
    const intrinsic = isIntrinsicProposalConstruction(construction);
    const modelProvider = isIntrinsicMaterialModelProvider(configDocument(options)?.provider);
    const hasCallerProposals = Boolean(options.materialProposalSet && options.materialProposalBuffers);
    if (intrinsic && modelProvider && hasCallerProposals) {
        const error = new Error("Intrinsic model jobs cannot mix caller-supplied proposals with model-generated proposals.");
        error.code = "BAKE_MATERIAL_PROPOSAL_CONFLICT";
        throw error;
    }
    if (intrinsic && !modelProvider && !hasCallerProposals) {
        const error = new Error("Intrinsic construction requires materialProposalSet and materialProposalBuffers before capture.");
        error.code = "BAKE_MATERIAL_PROPOSAL_MISSING";
        throw error;
    }
    let proposalSet = intrinsic && !modelProvider ? normalizeBakeMaterialProposalSet(options.materialProposalSet) : null;
    let proposalUnitDigests = proposalSet ? bakeMaterialProposalUnitDigests(proposalSet) : null;
    const proposalBuffers = intrinsic && !modelProvider ? options.materialProposalBuffers : null;
    const captureAll = reuseDisabled || !previousManifest || modelProvider;
    const streamUnits = options.streamUnits === true && !intrinsic;
    const incremental = reuseDisabled !== true;
    const fragmentsByUnit = fragmentMapFromManifest(previousManifest);
    const contributionsByUnit = new Map(previousWritten?.contributionPayloads ?? options.previousContributions ?? []);
    const layoutRef = { value: null };
    const peakRef = { value: ledger.snapshot().usedBytes };
    const streamHandler = streamUnits
        ? (atlas
            ? createAtlasStreamHandler({
                host,
                sourceIds,
                construction,
                layoutRef,
                contributionsByUnit,
                ledger,
                uploadClient,
                peakRef,
            })
            : createProjectedStreamHandler({
                host,
                sourceIds,
                fragmentsByUnit,
                ledger,
                uploadClient,
                peakRef,
            }))
        : null;

    const job = await runVersion1BakeJob(host, {
        ...options,
        spatialIndex,
        incremental,
        captureUnitIds: captureAll ? undefined : [],
        retainBuffers: !(streamUnits && captureAll),
        onUnitCaptured: streamUnits && captureAll ? streamHandler : undefined,
    });
    if (modelProvider) {
        if (!job.materialProposalSet || !job.materialProposalBuffers) {
            const error = new Error("intrinsic-material-model@1 did not return a complete material proposal set.");
            error.code = "BAKE_MODEL_INCOMPLETE";
            throw error;
        }
        proposalSet = job.materialProposalSet;
        proposalUnitDigests = bakeMaterialProposalUnitDigests(proposalSet);
    }
    const resolvedProposalBuffers = modelProvider ? job.materialProposalBuffers : proposalBuffers;
    const scene = host._version1?.snapshot?.sceneHandle?.scene
        ?? job.sceneHandle?.scene
        ?? options.sourceScene
        ?? options.scene
        ?? null;
    if (atlas && !layoutRef.value) {
        const chartId = ledger.reserve(BAKE_MEMORY_KINDS.chart, 256 * 1024, { label: "atlas-layout" });
        peakRef.value = peakUsed(ledger, peakRef.value);
        layoutRef.value = buildAtlasLayoutFromScene(scene, constructionFromConfig(job.config));
        ledger.release(chartId);
    }
    const graph = buildBakeDependencyGraph({
        config: job.config,
        snapshot: job.snapshot,
        scene,
        spatialIndex,
        chunkIndex: options.chunkIndex ?? options.chunkManager?.index ?? host.chunkManager?.index ?? null,
        proposalUnitDigests,
    });
    const compared = compareBakeReuseGraphs({
        graph,
        previousManifest,
        previousGraph,
        reuseDisabled,
    });
    compared.report = normalizeBakeReuseReport({
        ...compared.report,
        previousManifestHash: previousManifest ? hashBakeReuseManifest(previousManifest) : null,
    });

    if (compared.mode === "noop") {
        if (intrinsic) {
            validateBakeMaterialProposals({
                proposalSet,
                buffers: resolvedProposalBuffers,
                construction,
                job,
            });
        }
        return {
            job,
            graph,
            compared,
            written: null,
            reuseManifest: previousManifest,
            reuseReport: compared.report,
            peakLedgerBytes: peakRef.value,
            uploaded: [],
        };
    }

    const captureUnitIds = compared.captureUnitIds;
    if (!captureAll && captureUnitIds.length) {
        host._version1 = { ...(host._version1 ?? {}), jobId: null, views: [] };
        const captured = await runVersion1BakeJob(host, {
            ...options,
            spatialIndex,
            generation: job.snapshot.bakeGeneration,
            config: job.config,
            incremental: true,
            captureUnitIds,
            retainBuffers: !streamUnits,
            onUnitCaptured: streamUnits ? streamHandler : undefined,
        });
        Object.assign(job, {
            request: captured.request,
            response: captured.response,
            requestHash: captured.requestHash,
            responseHash: captured.responseHash,
            productBuffers: captured.productBuffers,
            status: captured.status,
            sceneHandle: captured.sceneHandle ?? job.sceneHandle,
        });
    }

    const streamed = streamUnits && (captureAll || captureUnitIds.length > 0);
    if (atlas && !captureAll) {
        const loaded = await loadContributionPayloads(
            previousManifest,
            assetClient?.getUseContent?.bind(assetClient)
                ?? options.getUseContent
                ?? host.assetClient?.getUseContent?.bind(host.assetClient)
                ?? null,
        );
        for (const [unitId, bytes] of loaded) {
            if (!contributionsByUnit.has(unitId)) contributionsByUnit.set(unitId, bytes);
        }
    }
    const rebuildChunkKeys = atlas && !captureAll
        ? dirtyChunkKeys({
            compared,
            graph,
            previousManifest,
            layout: layoutRef.value,
        })
        : null;
    const previousPages = atlas && previousWritten?.chunkOutputs
        ? new Map(previousWritten.chunkOutputs.map((entry) => [entry.chunkKey, entry]))
        : null;
    const resolvedConstruction = constructionFromConfig(job.config);
    const proposalBytes = proposalSet
        ? proposalSet.units.reduce((unitTotal, unit) => unitTotal + unit.outputs.reduce((outputTotal, output) => (
            outputTotal + output.values.byteSize + output.confidence.byteSize + output.knownMask.byteSize
        ), 0), 0)
        : 0;
    const proposalId = proposalBytes
        ? ledger.reserve(BAKE_MEMORY_KINDS.proposal, proposalBytes, { label: "material-proposals" })
        : null;
    const contributionBytes = proposalSet
        ? proposalSet.units.reduce((total, unit) => (
            total + 4096 + unit.width * unit.height * unit.outputs.length * 64
        ), 0)
        : 0;
    let contributionId = null;
    try {
        contributionId = contributionBytes
            ? ledger.reserve(BAKE_MEMORY_KINDS.contribution, contributionBytes, { label: "material-contributions" })
            : null;
    } catch (error) {
        if (proposalId != null) ledger.release(proposalId);
        throw error;
    }
    const fusionBytes = atlas
        ? resolvedConstruction.pageSizePx * resolvedConstruction.pageSizePx * (intrinsic ? 80 : 8)
        : 0;
    let fusionId = null;
    try {
        fusionId = atlas
            ? ledger.reserve(BAKE_MEMORY_KINDS.fusion, fusionBytes, { label: "atlas-fusion" })
            : null;
    } catch (error) {
        if (contributionId != null) ledger.release(contributionId);
        if (proposalId != null) ledger.release(proposalId);
        throw error;
    }
    peakRef.value = peakUsed(ledger, peakRef.value);
    let written;
    try {
        written = writeBakeArtifacts({
            job,
            buffers: job.productBuffers,
            sourceIds,
            currentDescriptor,
            currentAccess,
            worldHash: options.worldHash ?? job.snapshot.worldHash,
            graph,
            scene,
            layout: layoutRef.value,
            reuseFragments: fragmentsByUnit.size
                ? fragmentsByUnit
                : fragmentMapFromManifest(previousManifest),
            captureUnitIds: streamed || (!captureAll && captureUnitIds.length === 0)
                ? []
                : (captureAll ? null : captureUnitIds),
            previousContributions: atlas ? contributionsByUnit : null,
            previousPages,
            rebuildChunkKeys,
            materialProposalSet: proposalSet,
            materialProposalBuffers: resolvedProposalBuffers,
        });
    } finally {
        if (fusionId != null) ledger.release(fusionId);
        if (contributionId != null) ledger.release(contributionId);
        if (proposalId != null) ledger.release(proposalId);
    }
    const pendingUploads = [
        ...(written.uploads ?? []),
        ...(written.contributionUploads ?? []),
    ].filter((entry) => entry?.bytes && entry.use);
    if (uploadClient && pendingUploads.length) {
        for (const upload of pendingUploads) {
            const reservation = ledger.reserve(BAKE_MEMORY_KINDS.encoder, upload.bytes.length);
            peakRef.value = peakUsed(ledger, peakRef.value);
            try {
                await uploadBakeArtifacts(uploadClient, [upload]);
            } finally {
                ledger.release(reservation);
            }
        }
    }
    const reuseReport = normalizeBakeReuseReport({
        ...compared.report,
        uploaded: uploadClient && compared.report.captured.length
            ? compared.report.captured.map((entry) => ({
                unitId: entry.unitId,
                reason: BAKE_REUSE_REASONS.UPLOADED,
            }))
            : [],
        previousManifestHash: previousManifest ? hashBakeReuseManifest(previousManifest) : null,
    });
    return {
        job,
        graph,
        compared: { ...compared, report: reuseReport },
        written,
        reuseManifest: written.reuseManifest,
        reuseReport,
        peakLedgerBytes: peakRef.value,
        uploaded: reuseReport.uploaded,
    };
}
