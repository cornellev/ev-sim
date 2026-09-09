import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION } from "../app/3d/environment/visual/BakeConstructionPolicy.js";
import {
    createIntrinsicMaterialModelProvider,
    createMemoryBakeModelTransport,
} from "../app/3d/environment/visual/BakeIntrinsicMaterialAdapter.js";
import {
    FAKE_INTRINSIC_MATERIAL_OPTIONS,
    FAKE_INTRINSIC_WEIGHTS_DIGEST,
    INTRINSIC_MATERIAL_MODEL_PROVIDER,
    float32LittleEndianBytes,
    inferFakeIntrinsicChannels,
    isIntrinsicMaterialModelProvider,
    normalizeIntrinsicMaterialOptions,
    runFakeIntrinsicInference,
} from "../app/3d/environment/visual/BakeModelOutput.js";
import { runIncrementalBake } from "../app/3d/environment/visual/BakeIncrementalRunner.js";
import { runVersion1BakeJob } from "../app/3d/environment/visual/BakeJobRunner.js";
import {
    BakeRunCatalog,
    createDefaultBakeProviderRegistry,
    hashBakeRunConfig,
    normalizeBakeRunConfig,
} from "../app/3d/environment/visual/BakeRunCatalog.js";
import { hashBakeMaterialProposalSet } from "../app/3d/environment/visual/BakeMaterialProposals.js";
import { createPersistentBakeRunConfig } from "../app/3d/environment/visualization/BakeRunConfig.js";
import {
    capturePlane,
    completePersistentJob,
    sourceScene,
    SOURCE_IDS,
    tinyPersistentConfig,
} from "./helpers/bake-promotion.js";

const FIXTURE_PATH = new URL("./fixtures/bake/intrinsic-material-model.v1.json", import.meta.url);

function modelConfig(overrides = {}) {
    return createPersistentBakeRunConfig({
        environmentId: "yard",
        seed: 11,
        construction: DEFAULT_INTRINSIC_PROPOSAL_CONSTRUCTION,
        provider: INTRINSIC_MATERIAL_MODEL_PROVIDER,
        providerOptions: FAKE_INTRINSIC_MATERIAL_OPTIONS,
        cachePolicy: { mode: "none" },
        paths: [{
            id: "path-0",
            vertices: [{
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            }],
        }],
        views: [{
            id: "bake/view/main",
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            camera: { width: 20, height: 20, fov: 75, near: 0.1, far: 50 },
        }],
        sampling: { deltaDistance: 2, includeEndpoints: true, captureTimeNs: 5 },
        ...overrides,
    }).document();
}

function modelCatalog(transport) {
    const registry = createDefaultBakeProviderRegistry();
    registry.register(createIntrinsicMaterialModelProvider({ transport }));
    return new BakeRunCatalog({ providers: registry });
}

async function runModelJob(options = {}) {
    const transport = options.transport ?? createMemoryBakeModelTransport();
    const catalog = options.catalog ?? modelCatalog(transport);
    const config = options.config ?? modelConfig(options.configOverrides);
    const scene = options.sourceScene ?? sourceScene();
    const job = await runVersion1BakeJob({ catalog }, {
        config,
        sourceScene: scene,
        worldHash: options.worldHash ?? "a".repeat(64),
        authorizeSourceUse: options.authorizeSourceUse,
        sourceUseHashes: options.sourceUseHashes ?? [],
        captureAlignedProducts: options.captureAlignedProducts ?? capturePlane(),
        signal: options.signal,
        materialProposalSet: options.materialProposalSet,
        materialProposalBuffers: options.materialProposalBuffers,
    });
    return { job, catalog, transport, scene, config };
}

test("intrinsic-material-model options are recipe-hashed and operational limits are not", () => {
    const base = hashBakeRunConfig(modelConfig());
    const steps = hashBakeRunConfig(modelConfig({
        providerOptions: {
            ...FAKE_INTRINSIC_MATERIAL_OPTIONS,
            inference: { ...FAKE_INTRINSIC_MATERIAL_OPTIONS.inference, steps: 8 },
        },
    }));
    const timeout = hashBakeRunConfig(modelConfig({
        operational: {
            host: "http://example.test:9",
            roundTrip: { timeoutMs: 9, pollIntervalMs: 3, maxUploadBytes: 1024 },
        },
    }));
    assert.notEqual(base, steps);
    assert.equal(base, timeout);
    assert.throws(
        () => normalizeIntrinsicMaterialOptions({}),
        /pinned model/,
    );
    assert.throws(
        () => normalizeIntrinsicMaterialOptions({ transform: "identity" }),
        /unknown field/,
    );
    assert.throws(
        () => normalizeIntrinsicMaterialOptions({
            ...FAKE_INTRINSIC_MATERIAL_OPTIONS,
            extra: true,
        }),
        /unknown field/,
    );
    const restored = normalizeBakeRunConfig(JSON.parse(JSON.stringify(modelConfig())));
    assert.equal(hashBakeRunConfig(restored), base);
    assert.equal(restored.providerOptions.weightsDigest, FAKE_INTRINSIC_WEIGHTS_DIGEST);
    assert.equal(isIntrinsicMaterialModelProvider(INTRINSIC_MATERIAL_MODEL_PROVIDER), true);
});

test("default registry lists the adapter lazily and captured-appearance jobs make zero network calls", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        throw new Error(`unexpected fetch ${url}`);
    };
    try {
        const registry = createDefaultBakeProviderRegistry();
        const listed = registry.list();
        assert.equal(listed.some((entry) => entry.id === "captured-appearance"), true);
        assert.equal(listed.some((entry) => (
            entry.id === INTRINSIC_MATERIAL_MODEL_PROVIDER.id && entry.requiresModel === true
        )), true);
        assert.equal(registry.has(INTRINSIC_MATERIAL_MODEL_PROVIDER), true);
        const { job } = await completePersistentJob();
        assert.equal(job.response.runtimeStack.kind, "local-no-model");
        assert.equal(calls.length, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("capability and rights failures reject before capture", async () => {
    let captures = 0;
    const capture = async (...args) => {
        captures += 1;
        return capturePlane()(...args);
    };
    await assert.rejects(
        () => runModelJob({
            transport: createMemoryBakeModelTransport({ failCapability: true }),
            captureAlignedProducts: capture,
        }),
        (error) => error.code === "BAKE_PROVIDER_CAPABILITY_MISMATCH",
    );
    assert.equal(captures, 0);

    await assert.rejects(
        () => runModelJob({
            config: tinyPersistentConfig({
                provider: INTRINSIC_MATERIAL_MODEL_PROVIDER,
                providerOptions: FAKE_INTRINSIC_MATERIAL_OPTIONS,
            }).document(),
            captureAlignedProducts: capture,
        }),
        (error) => error.code === "BAKE_PROVIDER_CAPABILITY_MISMATCH",
    );

    const denied = async ({ operations }) => {
        if (operations.includes("ml")) {
            const error = new Error("ml denied");
            error.code = "BAKE_RIGHTS_DENIED";
            throw error;
        }
    };
    await assert.rejects(
        () => runModelJob({
            authorizeSourceUse: denied,
            sourceUseHashes: ["b".repeat(64)],
            captureAlignedProducts: capture,
        }),
        (error) => error.code === "BAKE_RIGHTS_DENIED",
    );
    assert.equal(captures, 0);
});

test("model adapter emits six-channel proposals without beauty-to-PBR fallback", async () => {
    const { job } = await runModelJob();
    assert.equal(job.response.runtimeStack.kind, "fake-intrinsic-material");
    assert.equal(job.response.outputs.every((entry) => [
        "beauty", "world-position", "geometric-normal", "confidence", "validity",
    ].includes(entry.role)), true);
    assert.equal(job.materialProposalSet.sources[0].type, "inferred");
    assert.equal(job.materialProposalSet.units[0].outputs.length, 6);
    const channels = job.materialProposalSet.units[0].outputs.map((entry) => entry.channel).sort();
    assert.deepEqual(channels, ["base-color", "emissive", "metalness", "normal", "occlusion", "roughness"]);
    const beauty = job.response.outputs.find((entry) => entry.role === "beauty");
    for (const output of job.materialProposalSet.units[0].outputs) {
        assert.notEqual(output.values.sha256, beauty.sha256);
    }
    assert.equal(job.modelOutputSet.samples[0].outputs.length, 8);
    assert.equal(job.config.construction.appearanceMode, "intrinsic-pbr-proposed");
    assert.equal(job.response.runtimeStack.kind.includes("no-model"), false);
});

test("malformed, cancelled, timed-out, retried, and stale model results fail closed", async () => {
    const incomplete = createMemoryBakeModelTransport({ incompleteChannels: ["normal"] });
    await assert.rejects(
        () => runModelJob({ transport: incomplete }),
        (error) => error.code === "BAKE_MODEL_INCOMPLETE",
    );

    const controller = new AbortController();
    controller.abort(Object.assign(new Error("cancelled by test"), { code: "BAKE_MODEL_CANCELLED" }));
    await assert.rejects(
        () => runModelJob({ signal: controller.signal }),
        (error) => error.code === "BAKE_MODEL_CANCELLED" || /cancel/i.test(error.message),
    );

    const delayed = createMemoryBakeModelTransport({ delayMs: 80 });
    const timeout = new AbortController();
    setTimeout(() => timeout.abort(Object.assign(new Error("timed out"), { code: "BAKE_MODEL_TIMEOUT" })), 5);
    await assert.rejects(
        () => runModelJob({ transport: delayed, signal: timeout.signal }),
        (error) => error.code === "BAKE_MODEL_CANCELLED" || error.code === "BAKE_MODEL_TIMEOUT" || /cancel|timed/i.test(error.message),
    );

    let submits = 0;
    const retrying = createMemoryBakeModelTransport();
    const originalSubmit = retrying.submit.bind(retrying);
    retrying.submit = async (args) => {
        submits += 1;
        if (submits === 1) throw Object.assign(new Error("transient"), { code: "BAKE_MODEL_INCOMPLETE" });
        return originalSubmit(args);
    };
    await assert.rejects(() => runModelJob({ transport: retrying }), /transient|INCOMPLETE/);
    const recovered = await runModelJob({ transport: retrying });
    assert.equal(recovered.job.status.state, "completed");
    assert.ok(submits >= 2);

    const { job, catalog } = await runModelJob();
    assert.throws(
        () => catalog.attachResponse(job.jobId, job.response, { generation: job.generation + 9 }),
        (error) => error.code === "BAKE_JOB_TERMINAL" || error.code === "BAKE_GENERATION_MISMATCH",
    );
});

test("caller-supplied proposals cannot mix with model generation", async () => {
    await assert.rejects(
        () => runIncrementalBake({
            host: { catalog: modelCatalog(createMemoryBakeModelTransport()) },
            options: {
                config: modelConfig(),
                sourceScene: sourceScene(),
                materialProposalSet: { kind: "cev-sim.bake-material-proposal-set", version: 1 },
                materialProposalBuffers: new Map(),
                captureAlignedProducts: capturePlane(),
            },
        }),
        (error) => error.code === "BAKE_MATERIAL_PROPOSAL_CONFLICT",
    );
});

test("fresh and cached fake outputs produce identical proposal and artifact hashes", async () => {
    const cache = new Map();
    const transport = createMemoryBakeModelTransport({ cache });
    const config = modelConfig({ cachePolicy: { mode: "reuse-request" } });
    const scene = sourceScene();
    const first = await runIncrementalBake({
        host: { catalog: modelCatalog(transport) },
        options: {
            config,
            sourceScene: scene,
            worldHash: "a".repeat(64),
            captureAlignedProducts: capturePlane(),
            sourceIds: SOURCE_IDS,
        },
        sourceIds: SOURCE_IDS,
        reuseDisabled: true,
    });
    const second = await runIncrementalBake({
        host: { catalog: modelCatalog(transport) },
        options: {
            config,
            sourceScene: scene,
            worldHash: "a".repeat(64),
            captureAlignedProducts: capturePlane(),
            sourceIds: SOURCE_IDS,
        },
        sourceIds: SOURCE_IDS,
        reuseDisabled: true,
    });
    assert.equal(hashBakeMaterialProposalSet(first.job.materialProposalSet), hashBakeMaterialProposalSet(second.job.materialProposalSet));
    assert.equal(first.written.artifactHash, second.written.artifactHash);
    assert.equal(first.written.descriptorHash, second.written.descriptorHash);
    assert.equal(first.written.accessHash, second.written.accessHash);
    const firstContrib = [...(first.written.contributionPayloads ?? [])].map(([, bytes]) => createHash("sha256").update(bytes).digest("hex"));
    const secondContrib = [...(second.written.contributionPayloads ?? [])].map(([, bytes]) => createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(firstContrib, secondContrib);
});

test("shared VIS-11 fixtures cover request, response, model-output, and raw buffers", async () => {
    const beauty = new Uint8Array([255, 32, 64, 255, 16, 8, 4, 255]);
    const validity = new Uint8Array([1, 1]);
    const inferred = runFakeIntrinsicInference({
        beauty,
        validity,
        sourceDimensions: { width: 2, height: 1 },
        resizePolicy: { mode: "identity" },
        seed: 11,
    });
    const channels = inferFakeIntrinsicChannels({
        beauty,
        validity,
        width: 2,
        height: 1,
        seed: 11,
    });
    assert.equal(inferred.effectiveDimensions.width, 2);
    assert.equal(channels.normal[2], 1);
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
    assert.equal(fixture.kind, "cev-sim.bake-intrinsic-material-fixture");
    assert.equal(fixture.providerOptions.weightsDigest, FAKE_INTRINSIC_WEIGHTS_DIGEST);
    assert.equal(fixture.rawBuffers.beauty, Buffer.from(beauty).toString("hex"));
    assert.equal(fixture.rawBuffers.validity, Buffer.from(validity).toString("hex"));
    assert.equal(
        fixture.rawBuffers["base-color"],
        Buffer.from(float32LittleEndianBytes(channels["base-color"])).toString("hex"),
    );
});
