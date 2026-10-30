import assert from "node:assert/strict";
import test from "node:test";
import { AssetRepository } from "../app/3d/editor/assets/AssetRepository.js";

function repository(fetch) { return new AssetRepository({ fetch, visualAssets: {} }); }
function response(value) { return { ok: true, json: async () => value }; }

test("81 asset revision consumers share one request and receive independent cached copies", async () => {
    let calls = 0;
    const repo = repository(async () => { calls += 1; return response({ revision: 7, metric: { enabled: true } }); });
    const values = await Promise.all(Array.from({ length: 81 }, () => repo.getRevision("asset", 7)));
    assert.equal(calls, 1);
    values[0].metric.enabled = false;
    assert.equal(values[1].metric.enabled, true);
    assert.equal((await repo.getRevision("asset", 7)).metric.enabled, true);
    assert.equal(calls, 1);
    await repo.get("asset"); await repo.get("asset");
    assert.equal(calls, 3);
});

test("asset revision cancellation is per consumer; a remaining consumer keeps its request", async () => {
    let resolve;
    let sharedSignal;
    const repo = repository((_url, options) => {
        sharedSignal = options.signal;
        return new Promise((done) => { resolve = done; });
    });
    const controller = new AbortController();
    const first = repo.getRevision("asset", 1, { signal: controller.signal });
    const second = repo.getRevision("asset", 1);
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(sharedSignal.aborted, false);
    resolve(response({ revision: 1 }));
    assert.deepEqual(await second, { revision: 1 });
});

test("abandoned and failed asset revision requests are evicted and retryable", async () => {
    let calls = 0;
    const repo = repository((_url, { signal }) => {
        calls += 1;
        if (calls === 1) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        if (calls === 2) throw new Error("temporary");
        return response({ revision: 1 });
    });
    const controller = new AbortController();
    const pending = repo.getRevision("asset", 1, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
    await assert.rejects(repo.getRevision("asset", 1), /temporary/);
    assert.deepEqual(await repo.getRevision("asset", 1), { revision: 1 });
    assert.equal(calls, 3);
});

test("immutable revision cache is bounded, LRU, and does not fetch for an already cancelled caller", async () => {
    let calls = 0;
    const repo = repository(async () => { calls += 1; return response({}); });
    for (let i = 1; i <= 128; i += 1) await repo.getRevision("asset", i);
    await repo.getRevision("asset", 1);
    await repo.getRevision("asset", 129);
    await repo.getRevision("asset", 1);
    assert.equal(calls, 129);
    await repo.getRevision("asset", 2);
    assert.equal(calls, 130);
    assert.equal(repo.revisions.size, 128);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(repo.getRevision("asset", 1, { signal: controller.signal }));
    assert.equal(calls, 130);
});
