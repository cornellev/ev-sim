import assert from "node:assert/strict";
import test from "node:test";

import { VISUAL_PREVIEW_ERROR_CODES } from "../app/simulation/visual/VisualLayer.js";
import { getVisualScaleProfile, VISUAL_SCALE_PROFILE_IDS } from "../app/simulation/visual/VisualScaleProfile.js";
import {
    VisualBudgetError,
    VisualMemoryLedger,
} from "../app/3d/environment/visual/VisualMemoryLedger.js";
import { VisualResourceCache } from "../app/3d/environment/visual/VisualResourceCache.js";
import { VisualWorkQueue } from "../app/3d/environment/visual/VisualWorkQueue.js";

const DIGEST = "a".repeat(64);
const USE = "b".repeat(64);

function bytes(length = 64) {
    return Uint8Array.from({ length }, (_, index) => index % 256);
}

test("visual resource cache deduplicates concurrent loads and evicts zero-ref LRU entries", async () => {
    const profile = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.hostedQuickV1);
    let clock = 1;
    const cache = new VisualResourceCache({ profile, now: () => clock });
    const payload = bytes(128);
    let loads = 0;
    const loader = async () => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return payload;
    };
    const [first, second] = await Promise.all([
        cache.acquireEncoded({ digest: DIGEST, useHash: USE, sizeBytes: payload.byteLength, loader }),
        cache.acquireEncoded({ digest: DIGEST, useHash: USE, sizeBytes: payload.byteLength, loader }),
    ]);
    assert.equal(loads, 1);
    assert.equal(cache.snapshot().entryCount, 1);
    assert.equal(cache.snapshot().liveLeases, 2);
    first.release();
    second.release();
    assert.equal(cache.snapshot().liveLeases, 0);

    const other = bytes(128);
    clock = 2;
    const held = await cache.acquireEncoded({
        digest: "c".repeat(64),
        useHash: "d".repeat(64),
        sizeBytes: other.byteLength,
        loader: async () => other,
    });
    const tight = new VisualResourceCache({
        profile,
        ledger: new VisualMemoryLedger({
            profile,
            ceilings: {
                encodedCpu: 80,
                decodedCpu: profile.ceilings.decodedCpuBytes,
                gpu: profile.ceilings.gpuBytes,
                transient: profile.ceilings.transientBytes,
            },
            unifiedCeiling: null,
        }),
        now: () => clock,
    });
    const a = await tight.acquireEncoded({
        digest: DIGEST,
        useHash: USE,
        sizeBytes: 64,
        loader: async () => bytes(64),
    });
    a.release();
    clock = 3;
    const b = await tight.acquireEncoded({
        digest: "e".repeat(64),
        useHash: "f".repeat(64),
        sizeBytes: 64,
        loader: async () => bytes(64),
    });
    assert.equal(tight.snapshot().evictions, 1);
    assert.equal(tight.snapshot().entryCount, 1);
    b.release();
    held.release();
    cache.dispose();
    tight.dispose();
    assert.equal(cache.snapshot().liveLeases, 0);
});

test("visual resource cache reserves before load, accounts unified memory, and disposes once", async () => {
    const profile = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.hostedQuickV1);
    const ledger = new VisualMemoryLedger({
        profile,
        ceilings: {
            encodedCpu: 256,
            decodedCpu: 256,
            gpu: 256,
            transient: 256,
        },
        unifiedCeiling: 300,
    });
    const cache = new VisualResourceCache({ profile, ledger });
    const encoded = await cache.acquireEncoded({
        digest: DIGEST,
        useHash: USE,
        sizeBytes: 200,
        loader: async () => bytes(200),
    });
    assert.equal(ledger.used.encodedCpu, 200);
    let disposals = 0;
    await assert.rejects(
        () => cache.acquireParsed({
            digest: DIGEST,
            useHash: USE,
            bytes: 120,
            loader: async () => ({
                value: { scene: {} },
                bytes: 120,
                dispose: () => { disposals += 1; },
            }),
        }),
        (error) => error instanceof VisualBudgetError,
    );
    encoded.release();
    cache.evictUntil("encodedCpu", 200);
    const parsed = await cache.acquireParsed({
        digest: DIGEST,
        useHash: USE,
        bytes: 80,
        loader: async () => ({
            value: { scene: {} },
            bytes: 80,
            dispose: () => { disposals += 1; },
        }),
    });
    parsed.release();
    cache.dispose();
    assert.equal(disposals, 1);
    assert.equal(cache.snapshot().disposals, 2);
    assert.equal(ledger.liveReservationCount(), 0);
});

test("visual resource cache revalidates rights, cancels inflight work, and recreates after context loss", async () => {
    const profile = getVisualScaleProfile(VISUAL_SCALE_PROFILE_IDS.hostedQuickV1);
    let allowed = true;
    const cache = new VisualResourceCache({
        profile,
        rightsChecker: async () => {
            if (!allowed) throw new Error("revoked");
        },
    });
    const lease = await cache.acquireEncoded({
        digest: DIGEST,
        useHash: USE,
        sizeBytes: 32,
        loader: async () => bytes(32),
    });
    await cache.revalidateSourceRights([USE]);
    lease.release();
    allowed = false;
    await assert.rejects(() => cache.revalidateSourceRights([USE]), /revoked/);
    assert.equal(cache.snapshot().entryCount, 0);

    const live = new VisualResourceCache({ profile });
    const controller = new AbortController();
    let releaseLoader;
    const gate = new Promise((resolve) => { releaseLoader = resolve; });
    const pending = live.acquireEncoded({
        digest: DIGEST,
        useHash: USE,
        sizeBytes: 32,
        signal: controller.signal,
        loader: async () => {
            await gate;
            return bytes(32);
        },
    });
    controller.abort();
    releaseLoader();
    await assert.rejects(pending, (error) => error.code === VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED);

    const decode = new VisualResourceCache({ profile });
    await assert.rejects(
        () => decode.acquireParsed({
            digest: DIGEST,
            bytes: 16,
            loader: async () => {
                throw new Error("ktx2 failed");
            },
        }),
        (error) => error.code === VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
    );
    assert.equal(decode.ledger.liveReservationCount(), 0);

    const queue = new VisualWorkQueue({ maxConcurrentFetches: 1, maxConcurrentDecodes: 1 });
    const blocked = queue.runFetch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "ok";
    });
    const queued = queue.runFetch(async () => "later");
    queue.rejectAll("dead");
    await assert.rejects(queued, (error) => error.code === VISUAL_PREVIEW_ERROR_CODES.CONTEXT_LOST);
    await blocked.catch(() => null);

    const renderer = { domElement: { addEventListener() {}, removeEventListener() {} } };
    const scoped = new VisualResourceCache({ profile, renderer });
    const next = scoped.recreate({ reason: "context lost" });
    assert.equal(scoped.dead, true);
    assert.equal(next.dead, false);
    assert.equal(next.snapshot().entryCount, 0);
    next.dispose();
});
