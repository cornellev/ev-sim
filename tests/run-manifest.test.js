import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    RUN_BUNDLE_KIND,
    createDefaultRunManifest,
    normalizeRunManifest,
    validateRunManifest,
} from "../app/simulation/RunManifest.js";
import { StorageService } from "../server/storage/StorageService.js";

async function temporaryService() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-run-manifest-"));
    return { dir, service: new StorageService(dir) };
}

test("run manifest normalization supplies deterministic professional defaults", () => {
    const manifest = createDefaultRunManifest();
    assert.equal(manifest.kind, "cev-sim.run-manifest");
    assert.equal(manifest.version, 10);
    assert.equal(manifest.scenario, null);
    assert.equal(manifest.clock.stepNs, 16_666_667);
    assert.equal(manifest.clock.pacing, "realtime");
    assert.equal(manifest.seed, "42");
    assert.deepEqual(manifest.provenance.candidateModels, []);
    assert.deepEqual(manifest.sensorRig.sensors.map((sensor) => sensor.id), [
        "front-camera",
        "front-lidar",
        "imu",
        "gnss",
        "wheel-odometry",
    ]);
    assert.equal(validateRunManifest(manifest).ok, true);
});

test("run manifest v4 migrates v1-v3 and rejects future versions and duplicate stable ids", () => {
    const migrated = normalizeRunManifest({
        ...createDefaultRunManifest(),
        version: 1,
    });
    assert.equal(migrated.version, 10);
    assert.ok(migrated.autonomyCatalog?.hash);
    assert.equal(migrated.scenario, null);
    assert.ok(migrated.controls);
    assert.equal(migrated.controls.stalePolicy, "stop");
    assert.deepEqual(migrated.provenance.candidateModels, []);
    assert.throws(() => normalizeRunManifest({ kind: "cev-sim.run-manifest", version: 11 }), /version 11/);
    const manifest = createDefaultRunManifest();
    manifest.topics.push({ ...manifest.topics[0] });
    const validation = validateRunManifest(manifest);
    assert.equal(validation.ok, false);
    assert.match(validation.issues.map((issue) => issue.message).join(" "), /Duplicate id/);
});

test("run manifest migrates /ackdrive to /controls/command and validates controls block", () => {
    const migrated = normalizeRunManifest({
        kind: "cev-sim.run-manifest",
        version: 8,
        id: "legacy-ack",
        name: "Legacy Ack",
        topics: [{
            id: "ackdrive",
            name: "/ackdrive",
            direction: "input",
            type: "sensor_fusion_msgs/AckermannDrive",
            required: true,
        }],
        initialState: { vehicles: [{ id: "ego", type: "big-car" }] },
    });
    assert.equal(migrated.version, 10);
    assert.equal(migrated.topics[0].name, "/controls/command");
    assert.equal(migrated.topics[0].contractId, "controls-command");
    assert.equal(migrated.controls.targetVehicleId, "ego");
    assert.equal(validateRunManifest(migrated).ok, true);

    const bad = createDefaultRunManifest();
    bad.controls.stalePolicy = "fallback";
    bad.controls.fallbackCommand = null;
    assert.equal(validateRunManifest(bad).ok, false);
});

test("run manifest v9 migrates to v10 provenance and candidate models change full hashes only", async () => {
    const digest = "a".repeat(64);
    const migrated = normalizeRunManifest({
        ...createDefaultRunManifest(),
        version: 9,
    });
    assert.equal(migrated.version, 10);
    assert.deepEqual(migrated.provenance.candidateModels, []);

    const invalid = createDefaultRunManifest({
        provenance: {
            candidateModels: [{ role: "planning", modelId: "planner", digest: "short" }],
        },
    });
    assert.equal(validateRunManifest(invalid).ok, false);

    const { dir, service } = await temporaryService();
    try {
        await service.listRunManifests();
        const before = await service.resolveRunManifest("igvc-default");
        const stored = await service.getRunManifest("igvc-default");
        await service.putRunManifest("igvc-default", {
            manifest: {
                ...stored,
                provenance: {
                    candidateModels: [{
                        role: "planning",
                        modelId: "planner-v3",
                        version: "1.0.0",
                        digest,
                    }],
                },
            },
            expectedRevision: stored.revision,
        });
        const after = await service.resolveRunManifest("igvc-default");
        assert.equal(after.manifest.provenance.candidateModels[0].digest, digest);
        assert.notEqual(after.definitionHash, before.definitionHash);
        assert.notEqual(after.resolvedHash, before.resolvedHash);
        assert.equal(after.simulationSemanticHash, before.simulationSemanticHash);

        const bundle = await service.exportRunManifest("igvc-default");
        assert.equal(bundle.resolved.manifest.provenance.candidateModels[0].modelId, "planner-v3");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("run manifest storage creates a default catalog and enforces optimistic revisions", async () => {
    const { dir, service } = await temporaryService();
    try {
        const catalog = await service.listRunManifests();
        assert.deepEqual(catalog.map((entry) => entry.id), ["igvc-default"]);
        const stored = await service.getRunManifest("igvc-default");
        assert.equal(stored.revision, 1);
        assert.equal(stored.definitionHash.length, 64);

        const updated = await service.putRunManifest("igvc-default", {
            manifest: { ...stored, description: "Updated" },
            expectedRevision: 1,
        });
        assert.equal(updated.revision, 2);
        assert.equal((await service.resolveRunManifest("igvc-default", {})).manifest.description, "Updated");
        await assert.rejects(
            service.putRunManifest("igvc-default", { manifest: stored, expectedRevision: 1 }),
            /revision conflict/,
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("run manifests resolve dependencies and portable bundles round-trip", async () => {
    const left = await temporaryService();
    const right = await temporaryService();
    try {
        await left.service.listRunManifests();
        const resolved = await left.service.resolveRunManifest("igvc-default");
        assert.equal(resolved.resolvedHash.length, 64);
        assert.equal(resolved.simulationSemanticHash.length, 64);
        assert.equal(resolved.environment.manifest.environmentId, "igvc");
        assert.ok(resolved.schemas["sensor_msgs/Image"].includes("uint8[] data"));
        assert.ok(resolved.schemas["sensor_fusion_msgs/StampedAckermannDrive"]);
        assert.equal(resolved.autonomyCatalog.kind, "cev-sim.autonomy-contract-catalog");

        const bundle = await left.service.exportRunManifest("igvc-default");
        assert.equal(bundle.kind, RUN_BUNDLE_KIND);
        assert.equal(bundle.resolvedHash, resolved.resolvedHash);
        assert.equal(bundle.simulationSemanticHash, resolved.simulationSemanticHash);

        const imported = await right.service.importRunBundle(bundle);
        const importedResolved = await right.service.resolveRunManifest(imported.id);
        assert.equal(importedResolved.environment.hash, resolved.environment.hash);
        assert.equal(importedResolved.definitionHash, resolved.definitionHash);
    } finally {
        await fs.rm(left.dir, { recursive: true, force: true });
        await fs.rm(right.dir, { recursive: true, force: true });
    }
});

test("logging changes preserve simulation semantic identity", async () => {
    const { dir, service } = await temporaryService();
    try {
        await service.listRunManifests();
        const before = await service.resolveRunManifest("igvc-default");
        const stored = await service.getRunManifest("igvc-default");
        await service.putRunManifest("igvc-default", {
            manifest: {
                ...stored,
                logging: {
                    ...stored.logging,
                    policy: stored.logging.policy === "disabled" ? "required" : "disabled",
                },
            },
            expectedRevision: stored.revision,
        });
        const after = await service.resolveRunManifest("igvc-default");
        assert.notEqual(after.resolvedHash, before.resolvedHash);
        assert.equal(after.simulationSemanticHash, before.simulationSemanticHash);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("run manifests combine global and selected bindings and infer their script artifacts", async () => {
    const { dir, service } = await temporaryService();
    try {
        await service.listRunManifests();
        await service.putScript({ id: "global-script", latestValidArtifact: { kind: "compiled-test", version: 1, value: "global" } });
        await service.putScript({ id: "selected-script", latestValidArtifact: { kind: "compiled-test", version: 1, value: "selected" } });
        await service.putBindings({
            kind: "cev-sim.script-bindings",
            version: 2,
            folders: [],
            bindings: [
                { id: "global", scope: "global", scriptId: "global-script", trigger: { kind: "fixed-update" } },
                { id: "selected", scope: "selected", scriptId: "selected-script", trigger: { kind: "fixed-update" } },
            ],
        });

        const defaultResolved = await service.resolveRunManifest("igvc-default");
        assert.deepEqual(defaultResolved.bindings.entries.map((binding) => binding.id), ["global"]);
        assert.deepEqual(defaultResolved.scripts.map((script) => script.scriptId), ["global-script"]);

        const base = await service.getRunManifest("igvc-default");
        const selectedManifest = await service.createRunManifest({
            ...base,
            id: "selected-run",
            name: "Selected Run",
            scripts: { ...base.scripts, artifacts: [], bindingIds: ["selected"] },
        });
        const selectedResolved = await service.resolveRunManifest(selectedManifest.id);
        assert.deepEqual(selectedResolved.bindings.entries.map((binding) => binding.id), ["global", "selected"]);
        assert.deepEqual(selectedResolved.scripts.map((script) => script.scriptId), ["global-script", "selected-script"]);
        const duplicate = await service.duplicateRunManifest(selectedManifest.id, { id: "selected-run-copy" });
        assert.deepEqual(duplicate.scripts.bindingIds, ["selected"]);

        const frozen = await service.createRunManifest({
            ...base,
            id: "frozen-run",
            name: "Frozen Run",
            scripts: {
                ...base.scripts,
                artifacts: [],
                bindingIds: [],
                embeddedBindings: [{ id: "selected", scriptId: "selected-script", trigger: { kind: "fixed-update" } }],
            },
        });
        const frozenResolved = await service.resolveRunManifest(frozen.id);
        assert.deepEqual(frozenResolved.bindings.entries.map((binding) => binding.id), ["selected"]);
        assert.deepEqual(frozenResolved.scripts.map((script) => script.scriptId), ["selected-script"]);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("dependency hashes prevent silent environment drift", async () => {
    const { dir, service } = await temporaryService();
    try {
        await service.createEnvironment({ id: "yard", name: "Yard" });
        const manifest = createDefaultRunManifest({
            id: "yard-run",
            name: "Yard Run",
            environment: { id: "yard", expectedHash: "deadbeef" },
        });
        await service.createRunManifest(manifest);
        await assert.rejects(service.resolveRunManifest("yard-run"), /Environment "yard" changed/);
        const validation = await service.validateRunManifest("yard-run");
        assert.equal(validation.ok, false);
        assert.equal(validation.issues[0].path, "dependencies");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("portable imports suffix conflicting dependencies and remap binding script references", async () => {
    const source = await temporaryService();
    const target = await temporaryService();
    try {
        await source.service.createEnvironment({ id: "yard", name: "Source Yard" });
        await source.service.putScript({ id: "controller", latestValidArtifact: { kind: "compiled-test", version: 1, value: "source" } });
        await source.service.putBindings({ bindings: [{ id: "drive", enabled: true, scriptId: "controller", trigger: { kind: "fixed-update", everyN: 1 }, inputs: [], outputs: [] }] });
        await source.service.createRunManifest(createDefaultRunManifest({
            id: "portable",
            environment: { id: "yard", expectedHash: null },
            scripts: { enabled: true, artifacts: [{ scriptId: "controller", expectedHash: null }], bindingIds: ["drive"], expectedBindingsHash: null, embeddedBindings: [] },
        }));
        const bundle = await source.service.exportRunManifest("portable");

        await target.service.createEnvironment({ id: "yard", name: "Different Yard" });
        await target.service.putScript({ id: "controller", latestValidArtifact: { kind: "compiled-test", version: 1, value: "different" } });
        const imported = await target.service.importRunBundle(bundle);
        assert.match(imported.environment.id, /^yard-[a-f0-9]{8}$/);
        assert.match(imported.scripts.artifacts[0].scriptId, /^controller-[a-f0-9]{8}$/);
        assert.equal(imported.scripts.embeddedBindings[0].scriptId, imported.scripts.artifacts[0].scriptId);
        const resolved = await target.service.resolveRunManifest(imported.id);
        assert.equal(resolved.bindings.entries[0].scriptId, imported.scripts.artifacts[0].scriptId);
    } finally {
        await fs.rm(source.dir, { recursive: true, force: true });
        await fs.rm(target.dir, { recursive: true, force: true });
    }
});
