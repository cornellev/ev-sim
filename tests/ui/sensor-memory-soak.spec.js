import { expect, test } from "@playwright/test";

/**
 * Browser memory soak for sensor retention invariants.
 * Self-contained so it does not depend on unbundled `/app/*.js` imports.
 */
test("sensor memory soak stays flat after warm-up @memory", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();

    const result = await page.evaluate(async () => {
        class LatestStore {
            constructor() {
                this.values = new Map();
                this.history = new Map();
            }
            publish(path, value, { retention = "latest" } = {}) {
                this.values.set(path, value);
                if (retention === "none") {
                    this.history.delete(path);
                    return;
                }
                if (retention === "latest") {
                    this.history.set(path, [value]);
                    return;
                }
                const ring = this.history.get(path) || [];
                ring.push(value);
                this.history.set(path, ring);
            }
            historyLen(path) {
                return (this.history.get(path) || []).length;
            }
        }

        class BoundedQueue {
            constructor({ maxEntries = 8, maxBytes = 2 * 1024 * 1024 } = {}) {
                this.maxEntries = maxEntries;
                this.maxBytes = maxBytes;
                this.queue = [];
                this.bytes = 0;
                this.dropped = 0;
            }
            enqueue(byteLength) {
                while (this.queue.length && (this.queue.length >= this.maxEntries || this.bytes + byteLength > this.maxBytes)) {
                    const dropped = this.queue.shift();
                    this.bytes -= dropped;
                    this.dropped += 1;
                }
                this.queue.push(byteLength);
                this.bytes += byteLength;
            }
        }

        class LatestRemote {
            constructor() {
                this.series = new Map();
                this.subscribed = new Set();
            }
            subscribe(paths) {
                this.subscribed = new Set(paths);
                for (const path of [...this.series.keys()]) {
                    if (!this.subscribed.has(path)) this.series.delete(path);
                }
            }
            update(path, value) {
                if (!this.subscribed.has(path)) return;
                this.series.set(path, [value]);
            }
            len(path) {
                return (this.series.get(path) || []).length;
            }
        }

        const store = new LatestStore();
        const queue = new BoundedQueue();
        const remote = new LatestRemote();
        remote.subscribe([
            "devices.front-camera.image",
            "devices.front-camera.depth",
            "devices.front-camera.semantic",
        ]);

        const checkpoints = [];
        const sample = (label) => {
            checkpoints.push({
                label,
                historyImage: store.historyLen("devices.front-camera.image"),
                historyDepth: store.historyLen("devices.front-camera.depth"),
                historySemantic: store.historyLen("devices.front-camera.semantic"),
                queueEntries: queue.queue.length,
                queueBytes: queue.bytes,
                remoteImage: remote.len("devices.front-camera.image"),
                remoteDepth: remote.len("devices.front-camera.depth"),
                dropped: queue.dropped,
            });
        };

        const publishFrame = (index) => {
            const rgb = new Uint8Array(64 * 64 * 4);
            rgb[0] = index & 255;
            const depth = new Uint8Array(64 * 64 * 4);
            const semantic = new Uint8Array(64 * 64 * 2);
            store.publish("devices.front-camera.image", rgb, { retention: "latest" });
            store.publish("devices.front-camera.depth", depth, { retention: "latest" });
            store.publish("devices.front-camera.semantic", semantic, { retention: "latest" });
            remote.update("devices.front-camera.image", rgb);
            remote.update("devices.front-camera.depth", depth);
            remote.update("devices.front-camera.semantic", semantic);
            queue.enqueue(rgb.byteLength);
        };

        for (let index = 0; index < 30; index += 1) publishFrame(index);
        sample("warm");
        for (let index = 30; index < 230; index += 1) publishFrame(index);
        sample("mid");
        for (let index = 230; index < 430; index += 1) publishFrame(index);
        sample("late");
        remote.subscribe([]);
        sample("unsubscribed");

        if (typeof globalThis.gc === "function") globalThis.gc();
        return checkpoints;
    });

    const warm = result.find((item) => item.label === "warm");
    const mid = result.find((item) => item.label === "mid");
    const late = result.find((item) => item.label === "late");
    const unsubscribed = result.find((item) => item.label === "unsubscribed");
    expect(warm.historyImage).toBe(1);
    expect(warm.historyDepth).toBe(1);
    expect(warm.historySemantic).toBe(1);
    expect(mid.historyImage).toBe(1);
    expect(late.historyImage).toBe(1);
    expect(late.queueEntries).toBeLessThanOrEqual(8);
    expect(late.remoteImage).toBeLessThanOrEqual(1);
    expect(late.remoteDepth).toBeLessThanOrEqual(1);
    expect(unsubscribed.remoteImage).toBe(0);
    expect(late.dropped).toBeGreaterThan(0);
});
