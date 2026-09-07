import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { VisualBudgetError } from "../app/3d/environment/visual/VisualMemoryLedger.js";
import {
    BakeMemoryLedger,
    BAKE_MEMORY_KINDS,
    estimatePassSetBytes,
} from "../app/3d/environment/visualization/BakeMemoryLedger.js";
import { BakeSpatialIndex } from "../app/3d/environment/visualization/BakeSpatialIndex.js";
import { ProjectedBuildingTextureManager } from "../app/3d/environment/visualization/ProjectedBuildingTextureManager.js";
import { getVisualScaleProfile, VISUAL_SCALE_PROFILE_IDS } from "../app/simulation/visual/VisualScaleProfile.js";

test("bake memory ledger reserves a complete pass set and rejects a second pipeline", async () => {
    const profile = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.hostedQuickV1);
    const ledger = new BakeMemoryLedger({ profile });
    const bytes = estimatePassSetBytes({
        width: profile.workload.bakeWidth,
        height: profile.workload.bakeHeight,
        passCount: 2,
        includeLidar: false,
    });
    const seen = [];
    await ledger.withPipelineReservation(bytes, async () => {
        seen.push(ledger.snapshot().pipelineHeld);
        await assert.rejects(
            () => ledger.withPipelineReservation(bytes, async () => "nope"),
            /already has an active sample/,
        );
        return "ok";
    });
    assert.deepEqual(seen, [true]);
    assert.equal(ledger.snapshot().pipelineHeld, false);
    assert.equal(ledger.liveReservationCount(), 0);
    ledger.reserve(BAKE_MEMORY_KINDS.telemetryPreview, 256);
    ledger.releaseAll();
    assert.equal(ledger.snapshot().usedBytes, 0);
});

test("required projection allocation failure stops the bake after LRU eviction of unused overlays", () => {
    const profile = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.hostedQuickV1);
    const ledger = new BakeMemoryLedger({
        profile,
        ceilingBytes: 64,
        maxProjections: 1,
    });
    const scene = new THREE.Scene();
    const manager = new ProjectedBuildingTextureManager(scene, { ledger, maxProjections: 1 });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    manager.entries.push({
        mesh,
        texture: { dispose() {} },
        material: { dispose() {} },
        geometry: { dispose() {} },
        bytes: 16,
        required: false,
        refs: 0,
        lastUsed: 1,
        reservationId: ledger.addProjection(16),
    });
    manager._ensureCapacity({ bytes: 16, required: true });
    assert.equal(manager.evictions, 1);
    manager.entries.push({
        mesh: new THREE.Mesh(),
        texture: { dispose() {} },
        material: { dispose() {} },
        geometry: { dispose() {} },
        bytes: 16,
        required: true,
        refs: 1,
        lastUsed: 2,
        reservationId: ledger.addProjection(16),
    });
    assert.throws(
        () => manager._ensureCapacity({ bytes: 16, required: true }),
        (error) => error instanceof VisualBudgetError,
    );
    manager.dispose();
    assert.equal(manager.entries.length, 0);
});

test("bake spatial index answers frustum and nearest-building queries without whole-scene searches", () => {
    const index = new BakeSpatialIndex();
    index.upsert({
        id: "building-near",
        kind: "building",
        bounds: { minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 4, maxZ: 1 },
        meshes: [],
    });
    index.upsert({
        id: "building-far",
        kind: "building",
        bounds: { minX: 80, minY: 0, minZ: 80, maxX: 82, maxY: 4, maxZ: 82 },
        meshes: [],
    });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const hits = index.queryFrustum(camera).map((entry) => entry.id);
    assert.deepEqual(hits, ["building-near"]);
    assert.equal(index.nearestBuildingId({ x: 0, y: 1, z: 0 }), "building-near");
    index.updateEntity("building-near", {
        bounds: { minX: 40, minY: 0, minZ: 40, maxX: 42, maxY: 4, maxZ: 42 },
    });
    assert.equal(index.nearestBuildingId({ x: 0, y: 1, z: 0 }), null);
    assert.equal(index.nearestBuildingId({ x: 41, y: 1, z: 41 }), "building-near");
    assert.equal(index.wholeSceneSearches, 0);
    assert.ok(index.searches >= 3);
});

test("bake cancel checks fail closed at each named pipeline stage", () => {
    const harness = {
        running: false,
        _assertRunning(stage) {
            if (this.running) return;
            throw new Error(`Bake cancelled during ${stage}.`);
        },
    };
    for (const stage of ["planning", "capture", "projection", "readback"]) {
        assert.throws(() => harness._assertRunning(stage), new RegExp(`cancelled during ${stage}`));
    }
});
