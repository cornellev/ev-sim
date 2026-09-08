import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { bakeCaptureUnitId } from "../app/3d/environment/visual/BakeReuseContracts.js";
import {
    BakeProviderRegistry,
    BakeRunCatalog,
    CAPTURED_APPEARANCE_PROVIDER,
    createDefaultBakeProviderRegistry,
} from "../app/3d/environment/visual/BakeRunCatalog.js";
import { BakeMemoryLedger } from "../app/3d/environment/visualization/BakeMemoryLedger.js";
import {
    addTestBuilding,
    runReuseBake,
    semanticBakeIdentity,
    twoPoleScene,
    twoSampleConfig,
    unitIds,
    WORLD_A,
    WORLD_B,
    WIDTH,
    HEIGHT,
    chunkManagerForScene,
    capturePlane,
} from "./helpers/bake-promotion.js";

const VIEW = "bake/view/main";
const NEAR = bakeCaptureUnitId("path-0", 0, VIEW);
const FAR = bakeCaptureUnitId("path-0", 1, VIEW);

function reasonsByUnit(entries) {
    return Object.fromEntries(entries.map((entry) => [entry.unitId, entry.reason]));
}

async function baseline(options = {}) {
    const scene = options.scene ?? twoPoleScene();
    const first = await runReuseBake({ scene, ...options });
    assert.equal(first.reuseReport.mode, "promote");
    assert.deepEqual(unitIds(first.reuseReport.captured).sort(), [FAR, NEAR].sort());
    return { scene, first };
}

test("G-INCREMENTAL: no-op reuse captures nothing and complete rebuilds agree", async () => {
    const { scene, first } = await baseline();
    const again = await runReuseBake({
        scene,
        previousManifest: first.reuseManifest,
        previousGraph: first.graph,
        previousWritten: first.written,
    });
    assert.equal(again.reuseReport.mode, "noop");
    assert.deepEqual(unitIds(again.reuseReport.reused).sort(), [FAR, NEAR].sort());
    assert.deepEqual(again.reuseReport.captured, []);
    assert.equal(again.written, null);
    const complete = await runReuseBake({ scene, reuseDisabled: true });
    assert.deepEqual(semanticBakeIdentity(complete.written), semanticBakeIdentity(first.written));
});

test("G-INCREMENTAL: insertion, deletion, and residency-only edits", async () => {
    const { scene, first } = await baseline();
    addTestBuilding(scene, "gamma", { x: 0, z: -4, color: 0x00ff00 });
    const inserted = await runReuseBake({
        scene,
        previousManifest: first.reuseManifest,
        previousGraph: first.graph,
        previousWritten: first.written,
    });
    assert.equal(inserted.reuseReport.mode, "promote");
    assert.deepEqual(unitIds(inserted.reuseReport.reused), [FAR]);
    assert.deepEqual(unitIds(inserted.reuseReport.invalidated), [NEAR]);
    assert.equal(reasonsByUnit(inserted.reuseReport.invalidated)[NEAR], "key-mismatch");

    const gamma = scene.getObjectByName("gamma");
    scene.remove(gamma);
    const deleted = await runReuseBake({
        scene,
        previousManifest: inserted.reuseManifest,
        previousGraph: inserted.graph,
        previousWritten: inserted.written,
    });
    assert.deepEqual(unitIds(deleted.reuseReport.reused), [FAR]);
    assert.deepEqual(unitIds(deleted.reuseReport.invalidated), [NEAR]);

    const complete = await runReuseBake({ scene, reuseDisabled: true });
    assert.deepEqual(semanticBakeIdentity(deleted.written), semanticBakeIdentity(complete.written));

    const chunkManager = chunkManagerForScene(scene);
    const withChunks = await runReuseBake({ scene, chunkManager });
    chunkManager.setChunkLoaded("0,-1", false);
    chunkManager.setChunkPrefetch("4,-1", true);
    chunkManager.setChunkEviction("4,-1", true);
    const residency = await runReuseBake({
        scene,
        chunkManager,
        previousManifest: withChunks.reuseManifest,
        previousGraph: withChunks.graph,
        previousWritten: withChunks.written,
    });
    assert.equal(residency.reuseReport.mode, "noop");
});

test("G-INCREMENTAL: material, move, distant occluder, and unbounded shadow", async () => {
    const { scene, first } = await baseline();
    const alpha = scene.getObjectByName("alpha");
    alpha.material.color.setHex(0x0000ff);
    const material = await runReuseBake({
        scene,
        previousManifest: first.reuseManifest,
        previousGraph: first.graph,
        previousWritten: first.written,
    });
    assert.deepEqual(unitIds(material.reuseReport.reused), [FAR]);
    assert.deepEqual(unitIds(material.reuseReport.invalidated), [NEAR]);

    alpha.position.x = 2;
    alpha.updateMatrixWorld(true);
    const moved = await runReuseBake({
        scene,
        previousManifest: material.reuseManifest,
        previousGraph: material.graph,
        previousWritten: material.written,
    });
    assert.deepEqual(unitIds(moved.reuseReport.reused), [FAR]);
    assert.deepEqual(unitIds(moved.reuseReport.invalidated), [NEAR]);

    addTestBuilding(scene, "occluder", { x: 0, z: -8, entityId: "occluder-1", color: 0x111111 });
    const occluded = await runReuseBake({
        scene,
        previousManifest: moved.reuseManifest,
        previousGraph: moved.graph,
        previousWritten: moved.written,
    });
    assert.deepEqual(unitIds(occluded.reuseReport.reused), [FAR]);
    assert.deepEqual(unitIds(occluded.reuseReport.invalidated), [NEAR]);

    const caster = addTestBuilding(scene, "shadow", { x: 40, z: 40, castShadow: true, color: 0x222222 });
    caster.castShadow = true;
    const shadowed = await runReuseBake({
        scene,
        previousManifest: occluded.reuseManifest,
        previousGraph: occluded.graph,
        previousWritten: occluded.written,
    });
    assert.deepEqual(unitIds(shadowed.reuseReport.reused), []);
    assert.deepEqual(unitIds(shadowed.reuseReport.invalidated).sort(), [FAR, NEAR].sort());
    assert.ok(shadowed.reuseReport.globalReasons.includes("unbounded-shadow"));
    const complete = await runReuseBake({ scene, reuseDisabled: true });
    assert.deepEqual(semanticBakeIdentity(shadowed.written), semanticBakeIdentity(complete.written));
});

test("G-INCREMENTAL: global sky/IBL, seed, calibration, world rebind, and VIS-08 rebuild", async () => {
    const { scene, first } = await baseline();
    scene.background = new THREE.Color(0x112233);
    const sky = await runReuseBake({
        scene,
        previousManifest: first.reuseManifest,
        previousGraph: first.graph,
        previousWritten: first.written,
    });
    assert.deepEqual(unitIds(sky.reuseReport.reused), []);
    assert.ok(sky.reuseReport.globalReasons.includes("global-sky-ibl"));

    const seeded = await runReuseBake({
        scene,
        config: twoSampleConfig({ seed: 99 }).document(),
        previousManifest: sky.reuseManifest,
        previousGraph: sky.graph,
        previousWritten: sky.written,
    });
    assert.deepEqual(unitIds(seeded.reuseReport.reused), []);
    assert.ok(seeded.reuseReport.globalReasons.includes("algorithm"));

    const calibrated = await runReuseBake({
        scene,
        config: twoSampleConfig({
            views: [{
                id: VIEW,
                position: { x: 0, y: 1.5, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                camera: { width: WIDTH, height: HEIGHT, fov: 50, near: 0.1, far: 40 },
            }],
        }).document(),
        previousManifest: first.reuseManifest,
        previousGraph: first.graph,
        previousWritten: first.written,
    });
    assert.deepEqual(unitIds(calibrated.reuseReport.reused), []);

    scene.background = null;
    const rebound = await runReuseBake({
        scene,
        worldHash: WORLD_B,
        previousManifest: first.reuseManifest,
        previousGraph: first.graph,
        previousWritten: first.written,
    });
    assert.equal(rebound.reuseReport.mode, "promote");
    assert.deepEqual(unitIds(rebound.reuseReport.reused).sort(), [FAR, NEAR].sort());
    assert.deepEqual(rebound.reuseReport.captured, []);
    assert.equal(rebound.written.descriptor.sourceWorldHash, WORLD_B);
    const completeB = await runReuseBake({ scene, worldHash: WORLD_B, reuseDisabled: true });
    const reboundId = semanticBakeIdentity(rebound.written);
    const completeId = semanticBakeIdentity(completeB.written);
    assert.equal(reboundId.descriptorHash, completeId.descriptorHash);
    assert.equal(reboundId.accessHash, completeId.accessHash);
    assert.deepEqual(reboundId.ids, completeId.ids);
    assert.deepEqual(reboundId.assets, completeId.assets);
    assert.deepEqual(reboundId.uses, completeId.uses);
    assert.notEqual(reboundId.descriptorHash, semanticBakeIdentity(first.written).descriptorHash);

    const leftoverId = `bake-${"ee".repeat(32)}`;
    const legacy = await runReuseBake({
        scene,
        currentDescriptor: {
            ...first.written.descriptor,
            materials: [
                ...first.written.descriptor.materials,
                {
                    id: leftoverId,
                    mode: "unlit-captured-radiance",
                    alphaMode: "MASK",
                    alphaCutoff: 0.5,
                    doubleSided: true,
                    parameters: first.written.descriptor.materials[0].parameters,
                    textures: [],
                    extensions: ["KHR_materials_unlit"],
                },
            ],
        },
        currentAccess: first.written.access,
    });
    assert.ok(legacy.reuseReport.globalReasons.includes("missing-provenance"));
    assert.equal(legacy.written.descriptor.materials.some((entry) => entry.id === leftoverId), false);
    assert.equal(first.written.descriptor.sourceWorldHash, WORLD_A);
});

test("G-INCREMENTAL: streaming bounds peak ledger and cancel releases reservations", async () => {
    const scene = twoPoleScene();
    const config = twoSampleConfig({
        paths: [{
            id: "path-0",
            vertices: Array.from({ length: 6 }, (_, index) => ({
                position: { x: index * 16, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            })),
        }],
        sampling: { deltaDistance: 16, includeEndpoints: true, captureTimeNs: 5 },
    }).document();
    const retained = await runReuseBake({ scene, config });
    const ledger = new BakeMemoryLedger({ ceilingBytes: 32 * 1024 * 1024 });
    const streamed = await runReuseBake({
        scene,
        config,
        streamUnits: true,
        memoryLedger: ledger,
        reuseDisabled: true,
    });
    assert.equal(ledger.liveReservationCount(), 0);
    assert.ok(streamed.peakLedgerBytes > 0);
    assert.ok(streamed.peakLedgerBytes < 8 * 1024 * 1024);
    assert.deepEqual(semanticBakeIdentity(streamed.written), semanticBakeIdentity(retained.written));

    const cancelLedger = new BakeMemoryLedger({ ceilingBytes: 32 * 1024 * 1024 });
    const controller = new AbortController();
    let captures = 0;
    const capture = capturePlane();
    await assert.rejects(
        () => runReuseBake({
            scene,
            config,
            streamUnits: true,
            memoryLedger: cancelLedger,
            reuseDisabled: true,
            signal: controller.signal,
            captureAlignedProducts: async (view, args) => {
                captures += 1;
                if (captures >= 2) controller.abort(new Error("Bake job cancelled."));
                return capture(view, args);
            },
        }),
        /cancel/i,
    );
    assert.equal(cancelLedger.liveReservationCount(), 0);
});

test("G-SCALE: atlas fusion fails closed when the bake memory ceiling is exceeded", async () => {
    const ledger = new BakeMemoryLedger({ ceilingBytes: 64 * 1024 });
    await assert.rejects(
        () => runReuseBake({
            scene: twoPoleScene(),
            memoryLedger: ledger,
            reuseDisabled: true,
        }),
        (error) => error.code === "VISUAL_PREVIEW_BUDGET_EXCEEDED",
    );
    assert.equal(ledger.liveReservationCount(), 0);
});

test("incremental capability validation rejects providers without bounded streaming", async () => {
    const listed = createDefaultBakeProviderRegistry();
    const adapter = listed.get(CAPTURED_APPEARANCE_PROVIDER);
    const registry = new BakeProviderRegistry([{ ...adapter, supportsBoundedStreaming: false }]);
    const catalog = new BakeRunCatalog({ providers: registry });
    assert.deepEqual(
        registry.list().map((entry) => entry.supportsBoundedStreaming),
        [false],
    );
    assert.equal(
        createDefaultBakeProviderRegistry().list().find((entry) => (
            entry.id === CAPTURED_APPEARANCE_PROVIDER.id
        )).supportsBoundedStreaming,
        true,
    );
    await assert.rejects(
        () => runReuseBake({ catalog }),
        (error) => error.code === "BAKE_PROVIDER_UNAVAILABLE",
    );
    const allowed = await runReuseBake({ catalog, reuseDisabled: true });
    assert.equal(allowed.reuseReport.mode, "promote");
});

test("G-INCREMENTAL: v1 reuse candidates force a conservative atlas rebuild", async () => {
    const scene = twoPoleScene();
    const projected = await runReuseBake({
        scene,
        config: twoSampleConfig({ version: 1 }).document(),
    });
    assert.equal(projected.written.artifactSet.version, 1);
    const migrated = await runReuseBake({
        scene,
        previousManifest: projected.reuseManifest,
        previousGraph: projected.graph,
        previousWritten: projected.written,
    });
    assert.ok(migrated.reuseReport.globalReasons.includes("legacy-rebuild"));
    assert.deepEqual(unitIds(migrated.reuseReport.reused), []);
    assert.deepEqual(unitIds(migrated.reuseReport.captured).sort(), [FAR, NEAR].sort());
    assert.equal(migrated.written.artifactSet.version, 2);
    const complete = await runReuseBake({ scene, reuseDisabled: true });
    assert.deepEqual(semanticBakeIdentity(migrated.written), semanticBakeIdentity(complete.written));
});

test("G-INCREMENTAL: dirty chunks rebuild while reused contribution digests stay exact", async () => {
    const { scene, first } = await baseline();
    const nearContribution = first.written.reuseManifest.units.find((entry) => entry.unitId === FAR);
    addTestBuilding(scene, "gamma", { x: 0, z: -4, color: 0x00ff00 });
    const inserted = await runReuseBake({
        scene,
        previousManifest: first.reuseManifest,
        previousGraph: first.graph,
        previousWritten: first.written,
    });
    const reusedFar = inserted.written.reuseManifest.units.find((entry) => entry.unitId === FAR);
    assert.equal(reusedFar.contribution.sha256, nearContribution.contribution.sha256);
    assert.equal(reusedFar.contribution.useHash, nearContribution.contribution.useHash);
    const dirty = new Set(inserted.written.chunkOutputs
        .filter((entry) => !first.written.chunkOutputs.some((prior) => (
            prior.chunkKey === entry.chunkKey && prior.outputHash === entry.outputHash
        )))
        .map((entry) => entry.chunkKey));
    assert.ok(dirty.size >= 1);
    const unchanged = first.written.chunkOutputs.filter((entry) => (
        inserted.written.chunkOutputs.some((next) => (
            next.chunkKey === entry.chunkKey && next.outputHash === entry.outputHash
        ))
    ));
    assert.ok(unchanged.length >= 1);
    const complete = await runReuseBake({ scene, reuseDisabled: true });
    assert.deepEqual(semanticBakeIdentity(inserted.written), semanticBakeIdentity(complete.written));
});
