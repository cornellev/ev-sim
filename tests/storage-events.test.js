import assert from "node:assert/strict";
import test from "node:test";

import { StorageEventHub } from "../app/client/storageEvents.js";

class FakeEventSource {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.closed = false;
        FakeEventSource.instances.push(this);
    }

    close() {
        this.closed = true;
    }
}

test("storage event subscribers share one SSE connection", () => {
    FakeEventSource.instances = [];
    const hub = new StorageEventHub("/events", { EventSourceImpl: FakeEventSource });
    const receivedA = [];
    const receivedB = [];

    const unsubscribeA = hub.subscribe((event) => receivedA.push(event));
    const unsubscribeB = hub.subscribe((event) => receivedB.push(event));

    assert.equal(FakeEventSource.instances.length, 1);
    FakeEventSource.instances[0].onmessage({ data: JSON.stringify({ domain: "run-manifest", id: "test" }) });
    assert.deepEqual(receivedA, [{ domain: "run-manifest", id: "test" }]);
    assert.deepEqual(receivedB, [{ domain: "run-manifest", id: "test" }]);

    unsubscribeA();
    assert.equal(FakeEventSource.instances[0].closed, false);
    unsubscribeB();
    assert.equal(FakeEventSource.instances[0].closed, true);
});

test("storage event hub reconnects once for all subscribers", () => {
    FakeEventSource.instances = [];
    const scheduled = [];
    const hub = new StorageEventHub("/events", {
        EventSourceImpl: FakeEventSource,
        setTimeoutImpl: (callback, delay) => {
            scheduled.push({ callback, delay });
            return scheduled.length;
        },
        clearTimeoutImpl: () => {},
    });

    const unsubscribeA = hub.subscribe(() => {});
    const unsubscribeB = hub.subscribe(() => {});
    FakeEventSource.instances[0].onerror();

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 2000);
    scheduled[0].callback();
    assert.equal(FakeEventSource.instances.length, 2);

    unsubscribeA();
    unsubscribeB();
});
