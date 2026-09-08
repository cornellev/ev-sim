import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import express from "express";

import { BakePromotionClient } from "../app/3d/environment/visual/BakePromotionClient.js";
import { VisualAssetClient } from "../app/3d/environment/visual/VisualAssetClient.js";
import { uploadBakeArtifacts, writeBakeArtifacts } from "../app/3d/environment/visual/BakeArtifactWriter.js";
import { createPersistentBakeRunConfig } from "../app/3d/environment/visualization/BakeRunConfig.js";
import { StorageService } from "../server/storage/StorageService.js";
import { BAKE_PROMOTION_ERROR_CODES, ENVIRONMENT_REVISION_CONFLICT } from "../server/storage/StorageErrors.js";
import { durableVisualRootOwner } from "../server/storage/BakePromotionController.js";
import { mountStorageApi } from "../server/routes/storageApi.js";
import {
    beginAndCapture,
    completePersistentJob,
    promotionService,
    writeAndUpload,
} from "./helpers/bake-promotion.js";
import { restrictedGrant } from "./helpers/visual-assets.js";

async function commitWritten(service, reservation, job, written) {
    return service.commitBakePromotion(reservation.environmentId ?? "yard", reservation.generation, {
        config: job.config,
        snapshot: job.snapshot,
        plan: job.plan,
        request: job.request,
        response: job.response,
        artifactSet: written.artifactSet,
        descriptor: written.descriptor,
        access: written.access,
    });
}

test("G-ATOMIC: a newer begin supersedes the older generation and commit is idempotent", async () => {
    const { dir, service } = await promotionService();
    try {
        const first = await beginAndCapture(service);
        const second = await beginAndCapture(service);
        await assert.rejects(
            () => commitWritten(service, first.reservation, first.job, first.written),
            (error) => error.code === BAKE_PROMOTION_ERROR_CODES.STALE,
        );
        const receipt = await commitWritten(service, second.reservation, second.job, second.written);
        const again = await commitWritten(service, second.reservation, second.job, second.written);
        assert.equal(receipt.revision, again.revision);
        assert.equal(receipt.descriptorHash, again.descriptorHash);
        assert.equal(receipt.artifactHash, again.artifactHash);
        const stored = await service.getEnvironment("yard");
        assert.equal(stored.revision, receipt.revision);
        assert.equal(stored.visualLayer.descriptorHash, receipt.descriptorHash);
        assert.equal(stored.evidence, null);
        assert.equal(stored.revision, first.current.revision + 1);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-ATOMIC: stale revision, metric edits, and cancellation never promote a partial layer", async () => {
    const { dir, service } = await promotionService();
    try {
        const current = await service.getEnvironment("yard");
        await assert.rejects(
            () => service.beginBakePromotion("yard", { expectedRevision: current.revision - 1 }),
            (error) => error.code === ENVIRONMENT_REVISION_CONFLICT,
        );
        const started = await beginAndCapture(service);
        await service.putEnvironment("yard", {
            manifest: { ...current, name: "Edited" },
            expectedRevision: current.revision,
        });
        await assert.rejects(
            () => commitWritten(service, started.reservation, started.job, started.written),
            (error) => error.code === ENVIRONMENT_REVISION_CONFLICT || error.code === BAKE_PROMOTION_ERROR_CODES.BINDING_MISMATCH,
        );
        const afterEdit = await service.getEnvironment("yard");
        assert.equal(afterEdit.visualLayer, null);
        assert.equal(afterEdit.name, "Edited");

        const reserved = await service.beginBakePromotion("yard", { expectedRevision: afterEdit.revision });
        await service.cancelBakePromotion("yard", reserved.generation);
        const { job } = await completePersistentJob({
            worldHash: reserved.worldHash,
            environmentRevision: reserved.environmentRevision,
            generation: reserved.generation,
        });
        const written = await writeAndUpload(service, reserved, job);
        await assert.rejects(
            () => commitWritten(service, reserved, job, written),
            (error) => error.code === BAKE_PROMOTION_ERROR_CODES.STALE,
        );
        assert.equal((await service.getEnvironment("yard")).visualLayer, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-ATOMIC: journal faults roll back pre-publish work and complete post-publish work", async () => {
    const phases = ["acquire-temp", "publish-revision", "replace-root", "release-temp", "receipt"];
    for (const phase of phases) {
        const faults = { bakePromotionPhase: phase };
        const { dir, service, created } = await promotionService({ faults });
        try {
            const started = await beginAndCapture(service);
            const before = await service.getEnvironment("yard");
            await assert.rejects(
                () => commitWritten(service, started.reservation, started.job, started.written),
                (error) => error.code === "BAKE_PROMOTION_FAULT" || error.phase === phase,
            );
            const restarted = new StorageService(dir, {
                visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") },
                bakeOutputSourceIds: ["owned-lab"],
            });
            const recovered = await restarted.getEnvironment("yard");
            if (phase === "acquire-temp" || phase === "publish-revision") {
                assert.equal(recovered.visualLayer, null);
                assert.equal(recovered.revision, created.revision);
                assert.equal(recovered.name, before.name);
            } else {
                assert.ok(recovered.visualLayer?.descriptorHash);
                assert.equal(recovered.revision, created.revision + 1);
                const receipt = await restarted.commitBakePromotion(
                    "yard",
                    started.reservation.generation,
                    {
                        config: started.job.config,
                        snapshot: started.job.snapshot,
                        plan: started.job.plan,
                        request: started.job.request,
                        response: started.job.response,
                        artifactSet: started.written.artifactSet,
                        descriptor: started.written.descriptor,
                        access: started.written.access,
                    },
                );
                assert.equal(receipt.revision, recovered.revision);
                assert.equal(receipt.descriptorHash, recovered.visualLayer.descriptorHash);
            }
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }
});

test("G-ATOMIC: new output root is acquired before the durable root is replaced", async () => {
    const { dir, service } = await promotionService();
    try {
        const order = [];
        const store = service.visualAssets;
        const acquireRoot = store.acquireRoot.bind(store);
        const replaceRoot = store.replaceRoot.bind(store);
        const releaseRoot = store.releaseRoot.bind(store);
        store.acquireRoot = async (input) => {
            order.push(`acquire:${input.ownerId}`);
            return acquireRoot(input);
        };
        store.replaceRoot = async (input) => {
            order.push(`replace:${input.ownerId}`);
            return replaceRoot(input);
        };
        store.releaseRoot = async (input) => {
            order.push(`release:${input.ownerId}`);
            return releaseRoot(input);
        };
        const started = await beginAndCapture(service);
        const receipt = await commitWritten(service, started.reservation, started.job, started.written);
        const tempOwner = `environment:yard:bake:${started.reservation.generation}:outputs`;
        const durable = durableVisualRootOwner("yard");
        assert.ok(order.indexOf(`acquire:${tempOwner}`) >= 0);
        assert.ok(order.indexOf(`acquire:${durable}`) >= 0 || order.indexOf(`replace:${durable}`) >= 0);
        assert.ok(order.indexOf(`acquire:${tempOwner}`) < Math.max(
            order.indexOf(`acquire:${durable}`),
            order.indexOf(`replace:${durable}`),
        ));
        assert.ok(order.indexOf(`release:${tempOwner}`) > order.indexOf(`acquire:${tempOwner}`));
        assert.ok(order.indexOf(`release:${tempOwner}`) > Math.max(
            order.indexOf(`acquire:${durable}`),
            order.indexOf(`replace:${durable}`),
        ));
        assert.equal((await service.getEnvironment("yard")).revision, receipt.revision);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-ATOMIC: rejected uploads never report success or attach references", async () => {
    const { dir, service } = await promotionService();
    try {
        const started = await beginAndCapture(service);
        const client = {
            async createUpload() {
                return { useHash: "a".repeat(64), existing: false, id: "bad" };
            },
            async putUploadContent() {
                throw new Error("unreachable");
            },
        };
        await assert.rejects(
            () => uploadBakeArtifacts(client, started.written.uploads),
            (error) => error.code === "BAKE_UPLOAD_MISMATCH",
        );
        assert.equal((await service.getEnvironment("yard")).visualLayer, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-RIGHTS: missing output sources, revoked grants, and invented ownership fail closed", async () => {
    const missing = await promotionService({ bakeOutputSourceIds: [] });
    try {
        await assert.rejects(
            () => serviceBegin(missing.service),
            (error) => error.code === BAKE_PROMOTION_ERROR_CODES.OUTPUT_SOURCE_MISSING,
        );
    } finally {
        await fs.rm(missing.dir, { recursive: true, force: true });
    }

    const denied = await promotionService({
        sources: [restrictedGrant("owned-lab", { permissions: { display: true } })],
    });
    try {
        await assert.rejects(
            () => serviceBegin(denied.service),
            (error) => error.code === BAKE_PROMOTION_ERROR_CODES.RIGHTS_DENIED,
        );
    } finally {
        await fs.rm(denied.dir, { recursive: true, force: true });
    }

    const { dir, service } = await promotionService();
    try {
        const current = await service.getEnvironment("yard");
        const reservation = await service.beginBakePromotion("yard", { expectedRevision: current.revision });
        const { job } = await completePersistentJob({
            worldHash: reservation.worldHash,
            environmentRevision: reservation.environmentRevision,
            generation: reservation.generation,
        });
        await assert.rejects(
            () => writeAndUpload(service, { ...reservation, outputSourceIds: ["forged-lab"] }, job),
            (error) => error.code === "BAKE_OUTPUT_SOURCE_MISSING"
                || error.code === BAKE_PROMOTION_ERROR_CODES.RIGHTS_DENIED
                || error.code === "VISUAL_ASSET_RIGHTS_DENIED"
                || error.message?.includes("source"),
        );
        assert.equal((await service.getEnvironment("yard")).visualLayer, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

async function serviceBegin(service, expectedRevision) {
    const current = await service.getEnvironment("yard");
    return service.beginBakePromotion("yard", {
        expectedRevision: expectedRevision ?? current.revision,
    });
}

test("G-LIFECYCLE: restart invalidates unfinished generations and cancellation is idempotent", async () => {
    const { dir, service } = await promotionService();
    try {
        const reserved = await service.beginBakePromotion("yard", {
            expectedRevision: (await service.getEnvironment("yard")).revision,
        });
        const restarted = new StorageService(dir, {
            visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") },
            bakeOutputSourceIds: ["owned-lab"],
        });
        await restarted.getEnvironment("yard");
        const { job } = await completePersistentJob({
            worldHash: reserved.worldHash,
            environmentRevision: reserved.environmentRevision,
            generation: reserved.generation,
        });
        const written = await writeAndUpload(restarted, reserved, job);
        await assert.rejects(
            () => commitWritten(restarted, reserved, job, written),
            (error) => error.code === BAKE_PROMOTION_ERROR_CODES.STALE,
        );
        const firstCancel = await restarted.cancelBakePromotion("yard", reserved.generation);
        const secondCancel = await restarted.cancelBakePromotion("yard", reserved.generation);
        assert.equal(firstCancel.cancelled, true);
        assert.equal(secondCancel.cancelled, true);
        assert.equal((await restarted.getEnvironment("yard")).visualLayer, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("HTTP promotion client begins, commits, and returns the stored environment", async () => {
    const { dir, service } = await promotionService();
    const app = express();
    mountStorageApi(app, service);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = new BakePromotionClient({ baseUrl: `${origin}/api/storage/environments` });
    const assets = new VisualAssetClient({ baseUrl: `${origin}/api/storage/visual-assets` });
    try {
        const current = await service.getEnvironment("yard");
        const reservation = await client.begin("yard", { expectedRevision: current.revision });
        const { job } = await completePersistentJob({
            worldHash: reservation.worldHash,
            environmentRevision: reservation.environmentRevision,
            generation: reservation.generation,
        });
        const written = writeBakeArtifacts({
            job,
            buffers: job.productBuffers,
            sourceIds: reservation.outputSourceIds,
            worldHash: reservation.worldHash,
            scene: job.sceneHandle?.scene ?? null,
        });
        await uploadBakeArtifacts(assets, [
            ...written.uploads,
            ...(written.contributionUploads ?? []),
        ]);
        const receipt = await client.commit("yard", reservation.generation, {
            config: job.config,
            snapshot: job.snapshot,
            plan: job.plan,
            request: job.request,
            response: job.response,
            artifactSet: written.artifactSet,
            descriptor: written.descriptor,
            access: written.access,
        });
        assert.equal(receipt.revision, current.revision + 1);
        assert.equal(receipt.manifest.visualLayer.descriptorHash, receipt.descriptorHash);
        const cancel = await client.cancel("yard", reservation.generation);
        assert.equal(cancel.committed, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("legacy model configs cannot promote through VIS-08", async () => {
    const harnessSource = await fs.readFile(
        new URL("../app/3d/environment/visualization/BakeHarness.js", import.meta.url),
        "utf8",
    );
    const sceneSource = await fs.readFile(new URL("../app/3d/Scene.js", import.meta.url), "utf8");
    assert.match(harnessSource, /Legacy model baking cannot promote through VIS-08/);
    assert.match(sceneSource, /isLegacyModelBakeConfig/);
    assert.match(sceneSource, /harness\.start/);
    assert.equal(createPersistentBakeRunConfig({ environmentId: "yard" }).roundTrip.useModel, false);
});
