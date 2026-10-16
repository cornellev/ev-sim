import assert from "node:assert/strict";
import test from "node:test";

import { MarketplacePolicyHub } from "../app/marketplace/MarketplaceClient.js";

class FakeEventSource {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.closed = false;
        this.listeners = new Map();
        FakeEventSource.instances.push(this);
    }

    addEventListener(type, handler) {
        this.listeners.set(type, handler);
    }

    dispatch(type, event) {
        this.listeners.get(type)?.(event);
    }

    close() {
        this.closed = true;
    }
}

test("marketplace policy subscribers share one SSE connection", () => {
    FakeEventSource.instances = [];
    const hub = new MarketplacePolicyHub("/api/marketplace/policy/events", {
        EventSourceImpl: FakeEventSource,
    });
    const receivedA = [];
    const receivedB = [];

    const unsubscribeA = hub.subscribe({ onPolicy: (event) => receivedA.push(event) });
    const unsubscribeB = hub.subscribe({ onPolicy: (event) => receivedB.push(event) });

    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.instances[0].url, "/api/marketplace/policy/events");
    FakeEventSource.instances[0].dispatch("policy", {
        data: JSON.stringify({ revision: 4 }),
    });
    assert.deepEqual(receivedA, [{ revision: 4 }]);
    assert.deepEqual(receivedB, [{ revision: 4 }]);

    unsubscribeA();
    assert.equal(FakeEventSource.instances[0].closed, false);
    unsubscribeB();
    assert.equal(FakeEventSource.instances[0].closed, true);
});

test("marketplace policy hub reconnects once for all subscribers", () => {
    FakeEventSource.instances = [];
    const scheduled = [];
    const hub = new MarketplacePolicyHub("/api/marketplace/policy/events", {
        EventSourceImpl: FakeEventSource,
        setTimeoutImpl: (callback, delay) => {
            scheduled.push({ callback, delay });
            return scheduled.length;
        },
        clearTimeoutImpl: () => {},
    });

    const unsubscribeA = hub.subscribe({ onPolicy() {} });
    const unsubscribeB = hub.subscribe({ onPolicy() {} });
    FakeEventSource.instances[0].dispatch("error", {});

    assert.equal(FakeEventSource.instances[0].closed, true);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 2000);
    scheduled[0].callback();
    assert.equal(FakeEventSource.instances.length, 2);

    unsubscribeA();
    unsubscribeB();
});
