import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { uploadBakeArtifacts } from "../app/3d/environment/visual/BakeArtifactWriter.js";
import { StorageService } from "../server/storage/StorageService.js";
import { BAKE_PROMOTION_ERROR_CODES, VISUAL_LAYER_ERROR_CODES } from "../server/storage/StorageErrors.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { durableBakeReuseRootOwner, durableVisualRootOwner } from "../server/storage/BakePromotionController.js";
import {
    beginAndCapture,
    promotionService,
    runReuseBake,
    storeAssetClient,
    twoPoleScene,
} from "./helpers/bake-promotion.js";

async function commitWithReuse(service, reservation, job, written, extras = {}) {
    return service.commitBakePromotion(reservation.environmentId ?? "yard", reservation.generation, {
        mode: extras.mode ?? "promote",
        config: job.config,
        snapshot: job.snapshot,
        plan: job.plan,
        request: job.request,
        response: job.response,
        artifactSet: written?.artifactSet,
        descriptor: written?.descriptor,
        access: written?.access,
        reuseManifest: extras.reuseManifest ?? written?.reuseManifest,
        reuseReport: extras.reuseReport,
    });
}

test("G-INCREMENTAL: promotion no-op does not bump revision and unauthorized reuse fails closed", async () => {
    const { dir, service } = await promotionService();
    try {
        const scene = twoPoleScene();
        const current = await service.getEnvironment("yard");
        const reservation = await service.beginBakePromotion("yard", { expectedRevision: current.revision });
        const baked = await runReuseBake({
            scene,
            worldHash: reservation.worldHash,
            generation: reservation.generation,
            environmentRevision: reservation.environmentRevision,
        });
        await uploadBakeArtifacts(storeAssetClient(service.visualAssets), [
            ...baked.written.uploads,
            ...(baked.written.contributionUploads ?? []),
        ]);
        const receipt = await commitWithReuse(
            service,
            reservation,
            baked.job,
            baked.written,
            { reuseReport: baked.reuseReport, reuseManifest: baked.written.reuseManifest },
        );
        assert.equal(receipt.mode, "promote");
        assert.ok(receipt.bakeReuseManifestHash);
        const stored = await service.getEnvironment("yard");
        assert.equal(stored.visualLayer.bakeReuseManifestHash, receipt.bakeReuseManifestHash);
        assert.equal(stored.revision, receipt.revision);

        const againEnv = await service.getEnvironment("yard");
        const againReservation = await service.beginBakePromotion("yard", { expectedRevision: againEnv.revision });
        assert.equal(againReservation.reuseCandidate?.trusted, true);
        const noop = await runReuseBake({
            scene,
            worldHash: againReservation.worldHash,
            generation: againReservation.generation,
            environmentRevision: againReservation.environmentRevision,
            previousManifest: againReservation.reuseCandidate.manifest,
        });
        assert.equal(noop.reuseReport.mode, "noop");
        const noopReceipt = await service.commitBakePromotion("yard", againReservation.generation, {
            mode: "noop",
            reuseManifest: noop.reuseManifest,
            reuseReport: noop.reuseReport,
        });
        assert.equal(noopReceipt.mode, "noop");
        assert.equal(noopReceipt.revision, stored.revision);
        const afterNoop = await service.getEnvironment("yard");
        assert.equal(afterNoop.revision, stored.revision);
        assert.equal(afterNoop.visualLayer.descriptorHash, stored.visualLayer.descriptorHash);

        const tamper = await service.beginBakePromotion("yard", { expectedRevision: afterNoop.revision });
        const tamperBake = await runReuseBake({
            scene,
            worldHash: tamper.worldHash,
            generation: tamper.generation,
            environmentRevision: tamper.environmentRevision,
            reuseDisabled: true,
        });
        await uploadBakeArtifacts(storeAssetClient(service.visualAssets), [
            ...tamperBake.written.uploads,
            ...(tamperBake.written.contributionUploads ?? []),
        ]);
        await assert.rejects(
            () => commitWithReuse(service, tamper, tamperBake.job, tamperBake.written, {
                reuseManifest: {
                    ...tamperBake.written.reuseManifest,
                    descriptorHash: "ff".repeat(32),
                },
                reuseReport: tamperBake.reuseReport,
            }),
            (error) => error.code === BAKE_PROMOTION_ERROR_CODES.REUSE_UNAUTHORIZED,
        );
        const afterTamper = await service.getEnvironment("yard");
        assert.equal(afterTamper.visualLayer.descriptorHash, stored.visualLayer.descriptorHash);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-INCREMENTAL: detachStaleVisual retains reuse evidence and fail-closed writes keep the layer", async () => {
    const { dir, service } = await promotionService();
    try {
        const scene = twoPoleScene();
        const current = await service.getEnvironment("yard");
        const reservation = await service.beginBakePromotion("yard", { expectedRevision: current.revision });
        const baked = await runReuseBake({
            scene,
            worldHash: reservation.worldHash,
            generation: reservation.generation,
            environmentRevision: reservation.environmentRevision,
        });
        await uploadBakeArtifacts(storeAssetClient(service.visualAssets), [
            ...baked.written.uploads,
            ...(baked.written.contributionUploads ?? []),
        ]);
        await commitWithReuse(service, reservation, baked.job, baked.written, {
            reuseReport: baked.reuseReport,
            reuseManifest: baked.written.reuseManifest,
        });
        const published = await service.getEnvironment("yard");
        const beforeHash = createWorldResource(published).hash;
        const edited = {
            ...published,
            buildingsAuthored: true,
            document: {
                ...(published.document ?? {}),
                buildingsAuthored: true,
                buildings: [{
                    buildingId: "metric-edit",
                    footprint: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }],
                    height: 8,
                }],
            },
        };
        await assert.rejects(
            () => service.putEnvironment("yard", {
                manifest: edited,
                expectedRevision: published.revision,
            }),
            (error) => error.code === VISUAL_LAYER_ERROR_CODES.WORLD_MISMATCH,
        );
        const blocked = await service.getEnvironment("yard");
        assert.equal(blocked.visualLayer.descriptorHash, published.visualLayer.descriptorHash);
        assert.equal(createWorldResource(blocked).hash, beforeHash);

        await service.putEnvironment("yard", {
            manifest: edited,
            expectedRevision: published.revision,
            detachStaleVisual: true,
        });
        const detached = await service.getEnvironment("yard");
        assert.equal(detached.visualLayer, null);
        assert.notEqual(createWorldResource(detached).hash, beforeHash);

        const next = await service.beginBakePromotion("yard", { expectedRevision: detached.revision });
        assert.equal(next.reuseCandidate?.trusted, true);
        assert.ok(next.reuseCandidate.manifest);
        assert.equal(next.visualDescriptorHash, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-INCREMENTAL: journal recovery restores bakeReuseManifestHash", async () => {
    const { dir, service, created } = await promotionService({
        faults: { bakePromotionPhase: "replace-root" },
    });
    try {
        const scene = twoPoleScene();
        const current = await service.getEnvironment("yard");
        const reservation = await service.beginBakePromotion("yard", { expectedRevision: current.revision });
        const baked = await runReuseBake({
            scene,
            worldHash: reservation.worldHash,
            generation: reservation.generation,
            environmentRevision: reservation.environmentRevision,
        });
        await uploadBakeArtifacts(storeAssetClient(service.visualAssets), [
            ...baked.written.uploads,
            ...(baked.written.contributionUploads ?? []),
        ]);
        await assert.rejects(
            () => commitWithReuse(service, reservation, baked.job, baked.written, {
                reuseReport: baked.reuseReport,
                reuseManifest: baked.written.reuseManifest,
            }),
            (error) => error.code === "BAKE_PROMOTION_FAULT",
        );
        const restarted = new StorageService(dir, {
            visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") },
            bakeOutputSourceIds: ["owned-lab"],
        });
        const recovered = await restarted.getEnvironment("yard");
        assert.ok(recovered.visualLayer?.descriptorHash);
        assert.ok(recovered.visualLayer?.bakeReuseManifestHash);
        assert.equal(recovered.revision, created.revision + 1);
        assert.equal(recovered.visualLayer.descriptorHash, baked.written.artifactSet.descriptorHash);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("VIS-08 commits without reuse documents remain valid", async () => {
    const { dir, service } = await promotionService();
    try {
        const started = await beginAndCapture(service);
        const receipt = await service.commitBakePromotion("yard", started.reservation.generation, {
            config: started.job.config,
            snapshot: started.job.snapshot,
            plan: started.job.plan,
            request: started.job.request,
            response: started.job.response,
            artifactSet: started.written.artifactSet,
            descriptor: started.written.descriptor,
            access: started.written.access,
        });
        assert.equal(receipt.mode, "promote");
        assert.ok(!receipt.bakeReuseManifestHash);
        const stored = await service.getEnvironment("yard");
        assert.equal(stored.visualLayer.descriptorHash, receipt.descriptorHash);
        assert.ok(!stored.visualLayer.bakeReuseManifestHash);
        assert.equal(service.visualAssets._roots?.roots?.[durableBakeReuseRootOwner("yard")], undefined);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-INCREMENTAL: bake-reuse root replaces contributions and cancel leaves it intact", async () => {
    const { dir, service } = await promotionService();
    try {
        const scene = twoPoleScene();
        const current = await service.getEnvironment("yard");
        const reservation = await service.beginBakePromotion("yard", { expectedRevision: current.revision });
        const baked = await runReuseBake({
            scene,
            worldHash: reservation.worldHash,
            generation: reservation.generation,
            environmentRevision: reservation.environmentRevision,
        });
        await uploadBakeArtifacts(storeAssetClient(service.visualAssets), [
            ...baked.written.uploads,
            ...(baked.written.contributionUploads ?? []),
        ]);
        await commitWithReuse(service, reservation, baked.job, baked.written, {
            reuseReport: baked.reuseReport,
            reuseManifest: baked.written.reuseManifest,
        });
        const reuseOwner = durableBakeReuseRootOwner("yard");
        const visualOwner = durableVisualRootOwner("yard");
        const reuseRoot = service.visualAssets._roots.roots[reuseOwner];
        const visualRoot = service.visualAssets._roots.roots[visualOwner];
        const contributionHashes = baked.written.reuseManifest.units.map((entry) => entry.contribution.useHash).sort();
        assert.deepEqual([...reuseRoot.useHashes].sort(), contributionHashes);
        for (const hash of contributionHashes) {
            assert.equal(visualRoot.useHashes.includes(hash), false);
        }

        const next = await service.beginBakePromotion("yard", {
            expectedRevision: (await service.getEnvironment("yard")).revision,
        });
        await service.cancelBakePromotion("yard", next.generation);
        assert.deepEqual(
            [...service.visualAssets._roots.roots[reuseOwner].useHashes].sort(),
            contributionHashes,
        );

        const recovered = await promotionService({
            faults: { bakePromotionPhase: "replace-reuse-root" },
        });
        try {
            const env = await recovered.service.getEnvironment("yard");
            const reservation2 = await recovered.service.beginBakePromotion("yard", { expectedRevision: env.revision });
            const baked2 = await runReuseBake({
                scene: twoPoleScene(),
                worldHash: reservation2.worldHash,
                generation: reservation2.generation,
                environmentRevision: reservation2.environmentRevision,
            });
            await uploadBakeArtifacts(storeAssetClient(recovered.service.visualAssets), [
                ...baked2.written.uploads,
                ...(baked2.written.contributionUploads ?? []),
            ]);
            await assert.rejects(
                () => commitWithReuse(recovered.service, reservation2, baked2.job, baked2.written, {
                    reuseReport: baked2.reuseReport,
                    reuseManifest: baked2.written.reuseManifest,
                }),
                (error) => error.code === "BAKE_PROMOTION_FAULT",
            );
            const restarted = new StorageService(recovered.dir, {
                visualAssets: { registryPath: path.join(recovered.dir, "visual-source-registry.json") },
                bakeOutputSourceIds: ["owned-lab"],
            });
            await restarted.getEnvironment("yard");
            const restored = restarted.visualAssets._roots.roots[durableBakeReuseRootOwner("yard")];
            assert.ok(restored);
            assert.deepEqual(
                [...restored.useHashes].sort(),
                baked2.written.reuseManifest.units.map((entry) => entry.contribution.useHash).sort(),
            );
        } finally {
            await fs.rm(recovered.dir, { recursive: true, force: true });
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
