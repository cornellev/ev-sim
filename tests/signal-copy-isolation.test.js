import assert from "node:assert/strict";
import test from "node:test";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";

test("retained signal entries stay isolated from writers, readers, subscribers, and later writes", () => {
    const store = new SignalStore();
    const input = { nested: { x: 1 } };
    const updates = [];
    store.subscribeSignals({ paths: ["test.value"], includeCatalog: false }, (message) => {
        updates.push(message);
        message.entry.value.nested.x = 99;
        message.descriptor.type = "mutated";
        if (message.previous) message.previous.value.nested.x = 98;
    });
    store.set("test.value", input, { type: "json", timeUs: 1, cycle: 1 });
    input.nested.x = 2;
    assert.equal(store.read("test.value").value.nested.x, 1);
    const history = store.history("test.value"); history[0].value.nested.x = 3;
    store.set("test.value", { nested: { x: 4 } }, { type: "json", timeUs: 2, cycle: 2 });
    assert.deepEqual(store.history("test.value").map((entry) => entry.value.nested.x), [1, 4]);
    assert.equal(store.read("test.value").value.nested.x, 4);
    assert.equal(store.descriptor("test.value").type, "json");
    assert.equal(store.revision("test.value"), 2);
    assert.deepEqual(updates.map((message) => [message.timeUs, message.cycle]), [[1, 1], [2, 2]]);
    const token = store.beginTransaction();
    store.write("test.value", { nested: { x: 5 } });
    store.commitTransaction(token);
    assert.deepEqual(store.history("test.value").map((entry) => entry.value.nested.x), [1, 4, 5]);
});
