import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION,
    INTRINSIC_CHANNEL_BY_NAME,
    normalizeBakeConstruction,
} from "../app/3d/environment/visual/BakeConstructionPolicy.js";
import {
    BAKE_MATERIAL_PROPOSAL_SET_KIND,
    BAKE_MATERIAL_PROPOSAL_SET_VERSION,
    assertBakeMaterialProposalSet,
    bakeMaterialProposalUnitDigests,
    digestProposalFloat32,
    hashBakeMaterialProposalSet,
    materialProposalBufferKey,
    normalizeBakeMaterialProposalSet,
    validateBakeMaterialProposals,
} from "../app/3d/environment/visual/BakeMaterialProposals.js";
import { buildBakeDependencyGraph } from "../app/3d/environment/visual/BakeDependencyGraph.js";
import { runIncrementalBake } from "../app/3d/environment/visual/BakeIncrementalRunner.js";
import { BakeRunCatalog } from "../app/3d/environment/visual/BakeRunCatalog.js";
import { BakeMemoryLedger } from "../app/3d/environment/visualization/BakeMemoryLedger.js";
import {
    decodeBakeAtlasContribution,
    encodeBakeAtlasContribution,
} from "../app/3d/environment/visual/BakeAtlasContribution.js";
import { fuseChunkPages } from "../app/3d/environment/visual/BakeAtlasCore.js";
import { uploadBakeArtifacts, writeBakeArtifacts } from "../app/3d/environment/visual/BakeArtifactWriter.js";
import { bakeCaptureUnitId } from "../app/3d/environment/visual/BakeReuseContracts.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { BakeMaterialProposalStore } from "../server/storage/BakeMaterialProposalStore.js";
import {
    completePersistentJob,
    capturePlane,
    promotionService,
    storeAssetClient,
    tinyPersistentConfig,
    twoSampleConfig,
} from "./helpers/bake-promotion.js";

const SOURCE_IDS = Object.freeze(["owned-lab"]);

function fillValues(channel, pixels, value) {
    const definition = INTRINSIC_CHANNEL_BY_NAME[channel];
    const values = new Float32Array(pixels * definition.components);
    for (let pixel = 0; pixel < pixels; pixel += 1) values.set(value, pixel * definition.components);
    return values;
}

function outputRecord(unitId, sourceId, channel, values, confidence, knownMask, buffers) {
    const definition = INTRINSIC_CHANNEL_BY_NAME[channel];
    buffers.set(materialProposalBufferKey(unitId, sourceId, channel, "values"), values);
    buffers.set(materialProposalBufferKey(unitId, sourceId, channel, "confidence"), confidence);
    buffers.set(materialProposalBufferKey(unitId, sourceId, channel, "knownMask"), knownMask);
    return {
        sourceId,
        channel,
        values: {
            encoding: definition.encoding,
            components: definition.components,
            byteSize: values.byteLength,
            sha256: digestProposalFloat32(values),
        },
        confidence: {
            encoding: "float32-le-scalar",
            components: 1,
            byteSize: confidence.byteLength,
            sha256: digestProposalFloat32(confidence),
        },
        knownMask: {
            encoding: "uint8-scalar",
            components: 1,
            byteSize: knownMask.byteLength,
            sha256: sha256ExactBytes(knownMask),
        },
    };
}

function proposalFixture(job, { suppliedKnown = true, inferredKnown = true } = {}) {
    const buffers = new Map();
    const sources = [
        {
            id: "artist",
            type: "supplied",
            algorithm: { id: "fixture", revision: "1" },
            provider: null,
            model: null,
            weightsDigest: null,
            nondeterminismScope: "none",
            sourceUseHashes: [],
        },
        {
            id: "model-z",
            type: "inferred",
            algorithm: { id: "intrinsic-estimator", revision: "3" },
            provider: { id: "fixture-provider", revision: "2" },
            model: { id: "fixture-model", revision: "2026-09" },
            weightsDigest: "7a".repeat(32),
            nondeterminismScope: "fixture-output-only",
            sourceUseHashes: [],
        },
    ];
    const valuesByChannel = {
        "base-color": { supplied: [0.25, 0.5, 0.75], inferred: [0.8, 0.1, 0.2] },
        normal: { supplied: [0, 0, 1], inferred: [0, 1, 0] },
        roughness: { supplied: [0.35], inferred: [0.8] },
        metalness: { supplied: [0.1], inferred: [0.9] },
        emissive: { supplied: [0, 0, 0], inferred: [0.05, 0.1, 0.15] },
        occlusion: { supplied: [0.9], inferred: [0.6] },
    };
    const units = job.plan.samples.map((sample) => {
        const unitId = bakeCaptureUnitId(sample.pathId, sample.sampleIndex, sample.viewId);
        const view = job.config.views.find((entry) => entry.id === sample.viewId);
        const pixels = view.camera.width * view.camera.height;
        const outputs = [];
        for (const source of sources) {
            const known = source.type === "supplied" ? suppliedKnown : inferredKnown;
            for (const channel of Object.keys(valuesByChannel)) {
                const mask = new Uint8Array(pixels).fill(known ? 1 : 0);
                const confidence = new Float32Array(pixels).fill(known ? (source.type === "supplied" ? 0.2 : 0.95) : 0);
                const values = fillValues(
                    channel,
                    pixels,
                    known ? valuesByChannel[channel][source.type] : new Array(INTRINSIC_CHANNEL_BY_NAME[channel].components).fill(0),
                );
                outputs.push(outputRecord(unitId, source.id, channel, values, confidence, mask, buffers));
            }
        }
        return {
            unitId,
            sampleId: sample.sampleId,
            viewId: sample.viewId,
            width: view.camera.width,
            height: view.camera.height,
            outputs,
        };
    });
    const proposalSet = normalizeBakeMaterialProposalSet({
        kind: BAKE_MATERIAL_PROPOSAL_SET_KIND,
        version: BAKE_MATERIAL_PROPOSAL_SET_VERSION,
        recipeHash: job.recipeHash,
        snapshotHash: job.snapshotHash,
        planHash: job.planHash,
        requestHash: job.requestHash,
        responseHash: job.responseHash,
        sources,
        units,
    });
    return { proposalSet, buffers };
}

async function intrinsicJob() {
    const config = tinyPersistentConfig({
        construction: DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION,
    }).document();
    return completePersistentJob({ config });
}

test("VIS-10b contracts: canonical proposal evidence validates mixed sources and exact buffers", async () => {
    const { job } = await intrinsicJob();
    const fixture = proposalFixture(job);
    assert.equal(assertBakeMaterialProposalSet(fixture.proposalSet), fixture.proposalSet);
    const validated = validateBakeMaterialProposals({
        ...fixture,
        construction: job.config.construction,
        job,
    });
    assert.equal(validated.proposalHash, hashBakeMaterialProposalSet(fixture.proposalSet));
    assert.equal(validated.unitDigests.size, job.plan.samples.length);
    assert.deepEqual(job.config.construction.intrinsicChannels[0].sourcePriority, ["supplied", "inferred"]);
    assert.throws(
        () => normalizeBakeMaterialProposalSet({ ...fixture.proposalSet, unexpected: true }),
        /unknown field/,
    );

    const tampered = structuredClone(fixture.proposalSet);
    tampered.units[0].outputs[0].knownMask.sha256 = "0".repeat(64);
    assert.throws(
        () => validateBakeMaterialProposals({ proposalSet: tampered, buffers: fixture.buffers, construction: job.config.construction, job }),
        (error) => error.code === "BAKE_MATERIAL_PROPOSAL_DIGEST_MISMATCH",
    );
    const first = fixture.proposalSet.units[0].outputs[0];
    const badMask = new Uint8Array(first.knownMask.byteSize).fill(2);
    const badBuffers = new Map(fixture.buffers);
    badBuffers.set(materialProposalBufferKey(fixture.proposalSet.units[0].unitId, first.sourceId, first.channel, "knownMask"), badMask);
    const badSet = structuredClone(fixture.proposalSet);
    badSet.units[0].outputs[0].knownMask.sha256 = sha256ExactBytes(badMask);
    assert.throws(
        () => validateBakeMaterialProposals({ proposalSet: badSet, buffers: badBuffers, construction: job.config.construction, job }),
        /expected 0 or 1/,
    );
    const base = fixture.proposalSet.units[0].outputs.find((entry) => entry.sourceId === "artist" && entry.channel === "base-color");
    const badValues = new Float32Array(base.values.byteSize / 4).fill(2);
    const rangeBuffers = new Map(fixture.buffers);
    rangeBuffers.set(materialProposalBufferKey(fixture.proposalSet.units[0].unitId, base.sourceId, base.channel, "values"), badValues);
    const rangeSet = structuredClone(fixture.proposalSet);
    rangeSet.units[0].outputs.find((entry) => entry.sourceId === base.sourceId && entry.channel === base.channel).values.sha256 = digestProposalFloat32(badValues);
    assert.throws(
        () => validateBakeMaterialProposals({ proposalSet: rangeSet, buffers: rangeBuffers, construction: job.config.construction, job }),
        /known value must be in \[0, 1\]/,
    );

    const normal = fixture.proposalSet.units[0].outputs.find((entry) => entry.sourceId === "artist" && entry.channel === "normal");
    const shortNormals = new Float32Array(normal.values.byteSize / 4);
    for (let offset = 0; offset < shortNormals.length; offset += 3) shortNormals.set([0, 0, 0.5], offset);
    const normalBuffers = new Map(fixture.buffers);
    normalBuffers.set(materialProposalBufferKey(fixture.proposalSet.units[0].unitId, normal.sourceId, normal.channel, "values"), shortNormals);
    const normalSet = structuredClone(fixture.proposalSet);
    normalSet.units[0].outputs.find((entry) => entry.sourceId === normal.sourceId && entry.channel === normal.channel).values.sha256 = digestProposalFloat32(shortNormals);
    assert.throws(
        () => validateBakeMaterialProposals({ proposalSet: normalSet, buffers: normalBuffers, construction: job.config.construction, job }),
        /normal must have unit length/,
    );

    const incomplete = structuredClone(fixture.proposalSet);
    incomplete.units[0].outputs = incomplete.units[0].outputs.filter((entry) => entry.channel !== "occlusion");
    assert.throws(
        () => validateBakeMaterialProposals({ proposalSet: incomplete, buffers: fixture.buffers, construction: job.config.construction, job }),
        /missing required occlusion proposal evidence/,
    );
});

test("G-ATLAS VIS-10b: source priority is per-channel and defaults preserve unknown state", () => {
    const construction = normalizeBakeConstruction({
        ...DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION,
        pageSizePx: 8,
        intrinsicChannels: DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION.intrinsicChannels.map((channel) => (
            channel.name === "roughness"
                ? { ...channel, sourcePriority: ["inferred", "supplied"] }
                : channel
        )),
    });
    const chunk = { pageCount: 1, placements: [] };
    const common = {
        chunkKey: "0,0", pageIndex: 0, texelX: 1, texelY: 1,
        known: true, facing: 1, distance: 1, pixelIndex: 0, triangleIndex: 0, unitId: "unit",
    };
    const contributions = [
        { ...common, channel: "base-color", sourceId: "a", sourceType: "supplied", values: [0.2, 0.3, 0.4], combinedConfidence: 0.1 },
        { ...common, channel: "base-color", sourceId: "b", sourceType: "inferred", values: [0.9, 0.9, 0.9], combinedConfidence: 1 },
        { ...common, channel: "roughness", sourceId: "a", sourceType: "supplied", values: [0.2], combinedConfidence: 1 },
        { ...common, channel: "roughness", sourceId: "b", sourceType: "inferred", values: [0.8], combinedConfidence: 0.1 },
        { ...common, texelX: 2, channel: "metalness", sourceId: "a", sourceType: "supplied", values: [0], known: false, combinedConfidence: 0 },
    ];
    const page = fuseChunkPages({ chunk, contributions: contributions.reverse(), construction })[0];
    const pixel = 1 * 8 + 1;
    assert.deepEqual(
        [...page.intrinsic["base-color"].values.subarray(pixel * 3, pixel * 3 + 3)].map((entry) => Number(entry.toFixed(4))),
        [0.2, 0.3, 0.4],
    );
    assert.ok(Math.abs(page.intrinsic.roughness.values[pixel] - 0.8) < 1e-6);
    const defaultPixel = 1 * 8 + 2;
    assert.equal(page.intrinsic.metalness.values[defaultPixel], 0);
    assert.equal(page.intrinsic.metalness.knownMask[defaultPixel], 0);
    assert.equal(page.intrinsic.metalness.confidence[defaultPixel], 0);
    assert.equal(page.intrinsic.metalness.state, "defaulted");
    assert.equal(page.intrinsic.metalness.defaultAppliedCount, page.intrinsic.metalness.unknownCount);
});

test("VIS-10b contribution v2 is canonical and binds only the affected proposal unit", () => {
    const records = [
        { chunkKey: "0,0", pageIndex: 0, texelX: 2, texelY: 1, channel: "roughness", sourceId: "z", sourceType: "inferred", known: true, values: [0.5], combinedConfidence: 0.8, facing: 0.9, distance: 2, pixelIndex: 4, triangleIndex: 1 },
        { chunkKey: "0,0", pageIndex: 0, texelX: 1, texelY: 1, channel: "base-color", sourceId: "a", sourceType: "supplied", known: true, values: [0.1, 0.2, 0.3], combinedConfidence: 0.4, facing: 1, distance: 1, pixelIndex: 2, triangleIndex: 0 },
    ];
    const options = { version: 2, unitId: "unit-a", constructionHash: "1".repeat(64), proposalUnitHash: "2".repeat(64) };
    const first = encodeBakeAtlasContribution({ ...options, records });
    const second = encodeBakeAtlasContribution({ ...options, records: [...records].reverse() });
    assert.deepEqual(first, second);
    const decoded = decodeBakeAtlasContribution(first);
    assert.equal(decoded.version, 2);
    assert.equal(decoded.proposalUnitHash, options.proposalUnitHash);
    const tampered = new Uint8Array(first);
    tampered[tampered.length - 1] = 1;
    assert.throws(() => decodeBakeAtlasContribution(tampered), /unknown bytes|canonical/);
});

test("G-INCREMENTAL VIS-10b: changing one proposal unit invalidates only that unit key", async () => {
    const config = twoSampleConfig({ construction: DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION }).document();
    const { job, scene } = await completePersistentJob({ config });
    const fixture = proposalFixture(job);
    const changed = structuredClone(fixture.proposalSet);
    changed.units[0].outputs[0].values.sha256 = "f".repeat(64);
    const first = buildBakeDependencyGraph({
        config: job.config,
        snapshot: job.snapshot,
        scene,
        proposalUnitDigests: bakeMaterialProposalUnitDigests(fixture.proposalSet),
    });
    const second = buildBakeDependencyGraph({
        config: job.config,
        snapshot: job.snapshot,
        scene,
        proposalUnitDigests: bakeMaterialProposalUnitDigests(changed),
    });
    const changedUnits = first.units.filter((entry, index) => entry.dependencyKey !== second.units[index].dependencyKey);
    assert.deepEqual(changedUnits.map((entry) => entry.unitId), [changed.units[0].unitId]);
    assert.equal(first.globalKey, second.globalKey);
});

test("VIS-10b artifact integration emits deterministic PBR closure without captured beauty", async () => {
    const { job, scene } = await intrinsicJob();
    const fixture = proposalFixture(job);
    const options = {
        job,
        buffers: job.productBuffers,
        sourceIds: SOURCE_IDS,
        worldHash: job.snapshot.worldHash,
        scene,
        materialProposalSet: fixture.proposalSet,
        materialProposalBuffers: fixture.buffers,
    };
    const first = writeBakeArtifacts(options);
    const second = writeBakeArtifacts(options);
    assert.equal(first.artifactHash, second.artifactHash);
    assert.equal(first.artifactSet.version, 3);
    assert.equal(first.artifactSet.materialProposalHash, hashBakeMaterialProposalSet(fixture.proposalSet));
    assert.equal(first.atlasManifest.version, 2);
    const material = first.descriptor.materials.find((entry) => entry.mode === "metallic-roughness");
    assert.deepEqual(material.textures.map((entry) => entry.slot).sort(), [
        "baseColor", "emissive", "metallicRoughness", "normal", "occlusion",
    ]);
    const pageCount = first.atlasManifest.chunks.reduce((sum, entry) => sum + entry.pages.length, 0);
    assert.equal(first.uploads.filter((entry) => entry.kind === "intrinsic-confidence").length, pageCount * 6);
    assert.equal(first.uploads.filter((entry) => entry.kind === "intrinsic-known-mask").length, pageCount * 6);
    const beautyDigests = new Set(job.response.outputs.filter((entry) => entry.role === "beauty").map((entry) => entry.sha256));
    for (const page of first.atlasManifest.chunks.flatMap((entry) => entry.pages)) {
        assert.equal(page.channels.length, 6);
        for (const channel of page.channels) assert.equal(beautyDigests.has(channel.textureSha256), false);
    }
});

test("G-SCALE VIS-10b: proposal and multi-channel fusion allocations fail through the bake ledger", async () => {
    const worldHash = "4".repeat(64);
    const config = tinyPersistentConfig({ construction: DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION }).document();
    const { job, scene } = await completePersistentJob({ config, worldHash });
    const fixture = proposalFixture(job);
    const ledger = new BakeMemoryLedger({ ceilingBytes: 1024 * 1024 });
    await assert.rejects(
        () => runIncrementalBake({
            host: { catalog: new BakeRunCatalog() },
            options: {
                config,
                sourceScene: scene,
                worldHash,
                generation: 1,
                environmentRevision: 0,
                captureAlignedProducts: capturePlane({ invalidatePixel: { x: 5, y: 5 } }),
                materialProposalSet: fixture.proposalSet,
                materialProposalBuffers: fixture.buffers,
            },
            sourceIds: SOURCE_IDS,
            memoryLedger: ledger,
        }),
        (error) => error.name === "VisualBudgetError" && error.kind === "fusion",
    );
    assert.equal(ledger.snapshot().liveReservations, 0);
});

test("G-PROVENANCE: proposal evidence store verifies canonical bytes and digest", async () => {
    const { job } = await intrinsicJob();
    const { proposalSet } = proposalFixture(job);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-proposals-"));
    const store = new BakeMaterialProposalStore(dir);
    const digest = await store.put(proposalSet);
    assert.equal(digest, hashBakeMaterialProposalSet(proposalSet));
    assert.deepEqual(await store.get(digest), proposalSet);
    assert.match(store.pathFor(digest), /bake-material-proposals\/sha256\/[a-f0-9]{64}\.json$/);
});

test("G-PROVENANCE: promotion atomically verifies and receipts intrinsic proposal evidence", async () => {
    const { dir, service } = await promotionService();
    try {
        const current = await service.getEnvironment("yard");
        const reservation = await service.beginBakePromotion("yard", { expectedRevision: current.revision });
        const config = tinyPersistentConfig({ construction: DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION }).document();
        const prepared = await completePersistentJob({
            config,
            worldHash: reservation.worldHash,
            environmentRevision: reservation.environmentRevision,
            generation: reservation.generation,
            sourceUseHashes: reservation.sourceUseHashes,
        });
        const fixture = proposalFixture(prepared.job);
        const baked = await runIncrementalBake({
            host: { catalog: new BakeRunCatalog() },
            options: {
                config,
                sourceScene: prepared.scene,
                worldHash: reservation.worldHash,
                environmentRevision: reservation.environmentRevision,
                generation: reservation.generation,
                sourceUseHashes: reservation.sourceUseHashes,
                captureAlignedProducts: capturePlane({ invalidatePixel: { x: 5, y: 5 } }),
                materialProposalSet: fixture.proposalSet,
                materialProposalBuffers: fixture.buffers,
            },
            sourceIds: reservation.outputSourceIds,
        });
        const { job, written, reuseManifest, reuseReport } = baked;
        await uploadBakeArtifacts(storeAssetClient(service.visualAssets), [
            ...written.uploads,
            ...written.contributionUploads,
        ]);
        const receipt = await service.commitBakePromotion("yard", reservation.generation, {
            config: job.config,
            snapshot: job.snapshot,
            plan: job.plan,
            request: job.request,
            response: job.response,
            artifactSet: written.artifactSet,
            descriptor: written.descriptor,
            access: written.access,
            materialProposalSet: fixture.proposalSet,
            reuseManifest,
            reuseReport,
        });
        assert.equal(receipt.materialProposalHash, hashBakeMaterialProposalSet(fixture.proposalSet));
        assert.deepEqual(await service._bakeMaterialProposals.get(receipt.materialProposalHash), fixture.proposalSet);
        const promoted = await service.getEnvironment("yard");
        assert.equal(promoted.evidence, null);
        assert.equal("materialProposalHash" in promoted.visualLayer, false);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
