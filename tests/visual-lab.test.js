import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    VISUAL_LAB_CANDIDATE_KIND,
    VISUAL_LAB_VERSION,
    assertVisualLabCandidateMatchesCase,
    compareVisualLabTargets,
    createExperimentOneBrowserCandidates,
    createExperimentOneCase,
    createExperimentZeroCandidates,
    createExperimentZeroCase,
    defaultVisualLabReview,
    normalizeVisualLabCandidate,
} from "../app/visual-lab/VisualLabDocuments.js";
import { EXPERIMENT_ZERO_MEDIA_HASHES } from "../app/visual-lab/ExperimentZeroMediaManifest.js";
import { EXPERIMENT_ONE_ASSET_MANIFEST } from "../app/visual-lab/ExperimentOneAssetManifest.js";
import { EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST } from "../app/visual-lab/ExperimentOneBrowserMediaManifest.js";
import { EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST } from "../app/visual-lab/ExperimentOneCyclesMediaManifest.js";
import { VisualLabFixtureAdapter } from "../app/visual-lab/VisualLabFixtureAdapter.js";
import { StorageService } from "../server/storage/StorageService.js";

test("Experiment 0 freezes the room, viewpoints, independent paths, and missing metric bindings", () => {
    const caseDocument = createExperimentZeroCase();
    assert.deepEqual(caseDocument.scene.dimensionsMeters, { width: 6, depth: 5, height: 2.8 });
    assert.equal(caseDocument.viewpoints.length, 12);
    assert.deepEqual(caseDocument.paths.map((entry) => entry.samples.length), [25, 25, 25]);
    assert.equal(caseDocument.paths[2].withheld, true);
    assert.equal(caseDocument.viewpoints.filter((entry) => entry.withheld).length, 3);
    assert.deepEqual(caseDocument.paths[0].samples.map((entry) => entry.captureTimeNs), caseDocument.paths[1].samples.map((entry) => entry.captureTimeNs));
    assert.notDeepEqual(
        caseDocument.paths[1].samples.map((entry) => entry.pose),
        [...caseDocument.paths[0].samples].reverse().map((entry) => entry.pose),
        "the return traversal must be captured independently instead of reversing frames",
    );
    assert.equal(caseDocument.measuredCapture.status, "blocked-partial-bindings");
    assert.deepEqual(caseDocument.measuredCapture.missingObjectIds.sort(), ["clutter-books", "fabric", "metal-lamp"]);
});

test("Experiment 1 freezes exact 24 fps schedules, corrected views, and complete metric bindings", () => {
    const caseDocument = createExperimentOneCase();
    assert.deepEqual(caseDocument.scene.dimensionsMeters, { width: 6, depth: 5, height: 2.8 });
    assert.equal(caseDocument.viewpoints.length, 12);
    assert.deepEqual(caseDocument.paths.map((entry) => entry.samples.length), [577, 577, 577]);
    for (const pathDocument of caseDocument.paths) {
        assert.equal(pathDocument.nominalFps, 24);
        assert.equal(pathDocument.samples[0].captureTimeNs, 0);
        assert.equal(pathDocument.samples.at(-1).captureTimeNs, 24_000_000_000);
        pathDocument.samples.forEach((sample, index) => {
            assert.equal(sample.captureTimeNs, Math.round(index * 1_000_000_000 / 24));
        });
    }
    assert.notDeepEqual(
        caseDocument.paths[1].samples.map((entry) => entry.pose),
        [...caseDocument.paths[0].samples].reverse().map((entry) => entry.pose),
        "the Experiment 1 return path must remain an independent capture schedule",
    );
    const recess = caseDocument.viewpoints.find((entry) => entry.id === "window-recess");
    assert.deepEqual(recess.pose.target, [1.2, 1.62, 2.4]);
    assert.equal(caseDocument.measuredCapture.status, "ready-complete-bindings");
    assert.deepEqual(caseDocument.measuredCapture.missingObjectIds, []);
    const objectIds = caseDocument.scene.objects.map((entry) => entry.id).sort();
    const fixtureIds = caseDocument.scene.worldResource.description.staticMetricFixtures.map((entry) => entry.id).sort();
    assert.deepEqual(fixtureIds, objectIds);
    assert.ok(caseDocument.scene.worldResource.description.obstacles.some((entry) => entry.id.startsWith("static-metric-fixture:")));
    assert.deepEqual(caseDocument.editVariants.find((entry) => entry.id === "light-moved").lights, [
        { lightId: "room-key", position: [2.4, 2.5, -1.8] },
    ]);
});

test("Experiment 1 retains prepared Blender assets and measured browser still hashes", async () => {
    assert.deepEqual(EXPERIMENT_ONE_ASSET_MANIFEST.blender, {
        version: "4.5.4 LTS",
        buildHash: "b3efe983cc58",
    });
    assert.deepEqual(EXPERIMENT_ONE_ASSET_MANIFEST.acquisitionProvenance.externalAssets, []);
    assert.match(EXPERIMENT_ONE_ASSET_MANIFEST.rendererDerivations.browser.materials, /metallic-roughness/);
    assert.match(EXPERIMENT_ONE_ASSET_MANIFEST.rendererDerivations.cycles.materials, /same retained/);
    assert.equal(EXPERIMENT_ONE_ASSET_MANIFEST.files.length, 28);
    assert.ok(Object.keys(EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files).length >= 324);
    assert.equal(EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.capturePerformance.sampleCount, Object.keys(EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files).length);
    const b4Base = "/visual-lab/experiment-1/browser/b4-browser/b4-browser-ordinary-environment-base-combined/stills/room-north-west.png";
    const b4Moved = "/visual-lab/experiment-1/browser/b4-browser/b4-browser-ordinary-environment-light-moved-combined/stills/room-north-west.png";
    assert.notEqual(EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files[b4Base], EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files[b4Moved]);
    for (const record of [...EXPERIMENT_ONE_ASSET_MANIFEST.files, ...Object.entries(EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files).map(([url, sha256]) => ({ path: url, sha256 }))]) {
        const bytes = await fs.readFile(path.join(process.cwd(), "public", record.path.replace(/^\//, "")));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256, record.path);
    }
});

test("Experiment 1 comparison proves shared camera and schedules while declaring renderer corrections", () => {
    const caseDocument = createExperimentOneCase();
    const candidates = createExperimentOneBrowserCandidates(caseDocument);
    const b1 = candidates.find((entry) => entry.id === "experiment-1-b1");
    const b4 = candidates.find((entry) => entry.id === "experiment-1-b4-combined");
    const viewpointId = caseDocument.viewpoints[0].id;
    const comparison = compareVisualLabTargets(
        caseDocument,
        b1,
        { outputId: b1.outputs[0].id, viewpointId, pathId: null, sampleIndex: 0 },
        b4,
        { outputId: b4.outputs[0].id, viewpointId, pathId: null, sampleIndex: 0 },
    );
    assert.deepEqual(comparison, {
        matched: true,
        differences: [],
        declaredDifferences: ["controlled-correction", "renderer-revision"],
    });
    assert.equal(b1.outputs[0].provenance.captureContract, "cev-sim.visual-camera-calibration@1");
    assert.equal(b4.outputs[0].provenance.rendererSettings.version, 2);
    const undeclaredBackground = structuredClone(b4);
    undeclaredBackground.outputs[0].provenance.match.backgroundHash = "different-background";
    const rejected = compareVisualLabTargets(
        caseDocument,
        b4,
        { outputId: b4.outputs[0].id, viewpointId, pathId: null, sampleIndex: 0 },
        undeclaredBackground,
        { outputId: undeclaredBackground.outputs[0].id, viewpointId, pathId: null, sampleIndex: 0 },
    );
    assert.equal(rejected.matched, false);
    assert.ok(rejected.differences.includes("metadata:backgroundHash"));
});

test("Experiment 1 retains the bounded pinned Cycles base matrix and linear counterparts", async () => {
    assert.equal(EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.outputs.length, 4);
    assert.equal(Object.keys(EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.files).length, 96);
    assert.equal(EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.renderer.samples, 512);
    assert.equal(EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.renderer.denoising, false);
    for (const output of EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.outputs) {
        assert.equal(output.displayFiles.length, 12);
        assert.equal(output.linearFiles.length, 12);
        assert.ok(output.lightingSettings);
    }
    for (const [url, sha256] of Object.entries(EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.files)) {
        const bytes = await fs.readFile(path.join(process.cwd(), "public", url.replace(/^\//, "")));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, url);
    }
});

test("stage validation prevents generated and preview media from claiming measured capture", () => {
    const caseDocument = createExperimentZeroCase();
    const candidate = createExperimentZeroCandidates(caseDocument)[0];
    const falseMeasured = structuredClone(candidate);
    falseMeasured.id = "false-measured";
    falseMeasured.outputs[0].stage = "measured-camera-capture";
    assert.throws(() => normalizeVisualLabCandidate(falseMeasured), /calibrated sensor capture contract/);

    const generated = structuredClone(candidate);
    generated.id = "generated-without-model";
    generated.outputs[0].stage = "generated-image";
    assert.throws(() => normalizeVisualLabCandidate(generated), /model provenance/);
});

test("candidate registration rejects cameras and samples outside the frozen case", () => {
    const caseDocument = createExperimentZeroCase();
    const candidate = createExperimentZeroCandidates(caseDocument)[0];
    const badCamera = structuredClone(candidate);
    badCamera.id = "bad-camera";
    badCamera.outputs[0].calibrationId = "uncalibrated-camera";
    assert.throws(() => assertVisualLabCandidateMatchesCase(caseDocument, badCamera), /not declared by the case/);

    const badSample = structuredClone(candidate);
    badSample.id = "bad-sample";
    badSample.outputs[1].samples[0].captureTimeNs += 1;
    assert.throws(() => assertVisualLabCandidateMatchesCase(caseDocument, badSample), /frozen path schedule/);
});

test("matched comparisons allow only declared variables and reject schedule drift", () => {
    const caseDocument = createExperimentZeroCase();
    const [left, right] = createExperimentZeroCandidates(caseDocument);
    const review = defaultVisualLabReview(caseDocument, [left, right]);
    assert.deepEqual(compareVisualLabTargets(caseDocument, left, review.comparison.a, right, review.comparison.b), {
        matched: true,
        differences: [],
        declaredDifferences: ["asset-detail"],
    });
    const drifted = { ...review.comparison.b, sampleIndex: 1 };
    assert.equal(compareVisualLabTargets(caseDocument, left, review.comparison.a, right, drifted).matched, false);
});

test("Visual Lab persistence keeps frozen inputs immutable and reopens mutable notes and arrangement", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-visual-lab-"));
    try {
        const service = new StorageService(directory);
        const [caseDocument] = await service.listVisualLabCases();
        const candidates = await service.listVisualLabCandidates(caseDocument.id);
        const review = defaultVisualLabReview(caseDocument, candidates);
        review.defects.push({
            id: "defect-contact",
            target: structuredClone(review.comparison.b),
            objectId: "chair-a",
            rectangle: { x: 0.2, y: 0.55, width: 0.25, height: 0.25 },
            category: "contact-shadows",
            severity: "major",
            status: "open",
            text: "Chair feet appear detached from the floor.",
            createdAt: "2026-09-09T12:00:00.000Z",
            resolvedAt: null,
        });
        review.arrangement = {
            revision: 1,
            transforms: [{ objectId: "chair-a", instanceId: "chair-a", position: [-0.75, 0, -0.15], rotationRadians: [0, 0, 0], uniformScale: 1 }],
        };
        const stored = await service.createVisualLabReview(review);
        assert.equal(stored.revision, 1);
        assert.equal(stored.defects[0].text, "Chair feet appear detached from the floor.");

        const restarted = new StorageService(directory);
        const reopened = await restarted.getVisualLabReview(stored.id);
        assert.deepEqual(reopened.arrangement, review.arrangement);
        assert.equal(reopened.defects.length, 1);
        const pack = await restarted.exportVisualLabReview(stored.id);
        assert.equal(pack.comparison.matched, true);
        assert.match(pack.htmlReport, /Baked-scene render/);
        assert.match(pack.htmlReport, /Chair feet appear detached/);

        await assert.rejects(() => restarted.registerVisualLabCase(caseDocument), /immutable/);
        await assert.rejects(() => restarted.registerVisualLabCandidate(candidates[0]), /immutable/);
        await assert.rejects(() => restarted.putVisualLabReview(stored.id, { review: reopened, expectedRevision: 0 }), /revision conflict/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("the committed PNG sequences match their retained SHA-256 manifest", async () => {
    const entries = Object.entries(EXPERIMENT_ZERO_MEDIA_HASHES);
    assert.equal(entries.length, 174);
    for (const [url, expected] of entries) {
        const bytes = await fs.readFile(path.join(process.cwd(), "public", url.replace(/^\//, "")));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, url);
    }
});

test("candidate document kind remains explicit and versioned", () => {
    assert.equal(VISUAL_LAB_CANDIDATE_KIND, "cev-sim.visual-lab-candidate");
    assert.equal(VISUAL_LAB_VERSION, 1);
});

test("the fixture adapter validates retained scene identity and refuses unbound descriptor loading", async () => {
    const caseDocument = createExperimentZeroCase();
    const candidate = createExperimentZeroCandidates(caseDocument)[1];
    const adapter = new VisualLabFixtureAdapter();
    const fixture = adapter.openBuiltIn({ caseDocument, candidate });
    assert.equal(fixture.objects.has("chair-a"), true);
    fixture.dispose();

    const drifted = structuredClone(candidate);
    drifted.scene.artifactHash = "0".repeat(64);
    assert.throws(() => adapter.openBuiltIn({ caseDocument, candidate: drifted }), /does not match/);
    await assert.rejects(() => adapter.openVisualLayer({ caseDocument, candidate, reference: {} }), /VisualLayerMaterializer/);
});
