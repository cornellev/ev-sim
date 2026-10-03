import assert from "node:assert/strict";
import test from "node:test";

import { getWebGL2Context, withPixelPackBufferUnbound } from "../app/3d/util/glReadback.js";

test("WebGL2 pixel-pack helpers no-op without a WebGL2 renderer", () => {
    assert.equal(getWebGL2Context(null), null);
    assert.equal(getWebGL2Context({ getContext: () => null }), null);
    assert.equal(withPixelPackBufferUnbound(null, () => 7), 7);
});

test("SwiftShader is not admitted as asynchronous pixel-pack capable", () => {
    class FakeWebGL2 {}
    const previous = globalThis.WebGL2RenderingContext;
    globalThis.WebGL2RenderingContext = FakeWebGL2;
    const debug = { UNMASKED_RENDERER_WEBGL: 0x9246 };
    const gl = Object.assign(Object.create(FakeWebGL2.prototype), {
        fenceSync() {},
        clientWaitSync() {},
        getBufferSubData() {},
        getExtension: () => debug,
        getParameter: () => "ANGLE (Google, Vulkan (SwiftShader Device), SwiftShader driver)",
    });
    try {
        assert.equal(getWebGL2Context({ getContext: () => gl }), null);
    } finally {
        if (previous === undefined) delete globalThis.WebGL2RenderingContext;
        else globalThis.WebGL2RenderingContext = previous;
    }
});

test("PixelPackSlot reports stale fences and resets", async () => {
    const { PixelPackSlot } = await import("../app/3d/util/glReadback.js");
    const deleted = [];
    const gl = {
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        WAIT_FAILED: 0x911d,
        createBuffer: () => ({ id: "pbo" }),
        bindBuffer() {},
        bufferData() {},
        getParameter: () => null,
        pixelStorei() {},
        readPixels() {},
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync: () => 0x911b,
        deleteSync: (sync) => deleted.push(sync),
        deleteBuffer() {},
        getBufferSubData() {},
    };
    const slot = new PixelPackSlot(gl, 64);
    slot.maxPollAttempts = 3;
    slot.begin(0, 0, 4, 4, 0x1908, 0x1401);
    assert.equal(slot.poll(new Uint8Array(64)), false);
    assert.equal(slot.poll(new Uint8Array(64)), false);
    assert.equal(slot.poll(new Uint8Array(64)), false);
    assert.equal(slot.isStale() || slot.sync === null, true);
    slot.reset();
    assert.equal(slot.sync, null);
    assert.ok(deleted.length >= 1);
    slot.dispose();
});

test("PixelPackSlot copies a signaled fence before deleting it and refuses a second write", async () => {
    const { PixelPackSlot } = await import("../app/3d/util/glReadback.js");
    const events = [];
    let readPixelsCalls = 0;
    const gl = {
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        WAIT_FAILED: 0x911d,
        createBuffer: () => ({ id: "pbo" }),
        bindBuffer() {},
        bufferData() {},
        getParameter: () => null,
        pixelStorei() {},
        readPixels() { readPixelsCalls += 1; },
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync: () => 0x9119,
        deleteSync() { events.push("delete"); },
        deleteBuffer() {},
        getBufferSubData(_target, _offset, dest) {
            events.push("read");
            dest.fill(4);
        },
    };
    const slot = new PixelPackSlot(gl, 8);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), false);
    assert.equal(readPixelsCalls, 1);
    const dest = new Uint8Array(8);
    assert.equal(slot.poll(dest), true);
    assert.deepEqual(events, ["read", "delete"]);
    assert.equal(dest[0], 4);
    assert.equal(slot.pending, false);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    assert.equal(readPixelsCalls, 2);
    slot.dispose();
});

test("two pixel-pack slots can be in flight while preserving pixel-pack bindings", async () => {
    const { PixelPackSlot } = await import("../app/3d/util/glReadback.js");
    let queries = 0;
    let reads = 0;
    const gl = {
        PIXEL_PACK_BUFFER: 0x88eb,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        WAIT_FAILED: 0x911d,
        createBuffer: () => ({ id: reads }),
        bindBuffer() {},
        bufferData() {},
        getParameter() { queries += 1; return 4; },
        pixelStorei() {},
        readPixels() { reads += 1; },
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync: () => 0x9119,
        deleteSync() {},
        deleteBuffer() {},
        getBufferSubData(_target, _offset, dest) { dest.fill(1); },
    };
    const first = new PixelPackSlot(gl, 8);
    const second = new PixelPackSlot(gl, 8);
    const afterConstruct = queries;
    assert.equal(first.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    assert.equal(second.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    assert.equal(first.begin(0, 0, 1, 2, 0x1908, 0x1401), false);
    assert.equal(reads, 2);
    assert.equal(queries, afterConstruct + 2);
    assert.equal(first.poll(new Uint8Array(8)), true);
    assert.equal(second.poll(new Uint8Array(8)), true);
    first.dispose();
    second.dispose();
});

test("a fenced slot is replaced before it can be written again", async () => {
    const { PixelPackSlot } = await import("../app/3d/util/glReadback.js");
    const events = [];
    let nextId = 1;
    const gl = {
        PIXEL_PACK_BUFFER: 0x88eb,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        createBuffer: () => ({ id: nextId++ }),
        bindBuffer(_target, buffer) { events.push(["bind", buffer?.id ?? null]); },
        bufferData() { events.push("allocate"); },
        getParameter: () => 4,
        pixelStorei() {},
        readPixels() { events.push("write"); },
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        deleteSync() { events.push("delete-sync"); },
        deleteBuffer(buffer) { events.push(["delete-buffer", buffer.id]); },
        getBufferSubData() {},
    };
    const slot = new PixelPackSlot(gl, 8);
    assert.equal(events.filter((event) => event === "allocate").length, 0);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    const firstBuffer = slot.pbo.id;
    slot.reset();
    assert.equal(slot.pending, false);
    assert.notEqual(slot.pbo.id, firstBuffer);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    const deleteIndex = events.findIndex((event) => Array.isArray(event) && event[0] === "delete-buffer" && event[1] === firstBuffer);
    const writes = events.map((event, index) => event === "write" ? index : -1).filter((index) => index >= 0);
    const allocates = events.map((event, index) => event === "allocate" ? index : -1).filter((index) => index >= 0);
    assert.equal(writes.length, 2);
    assert.equal(allocates.length, 2);
    assert.ok(allocates[0] < writes[0]);
    assert.ok(allocates[1] < writes[1]);
    assert.ok(deleteIndex > writes[0] && deleteIndex < writes[1]);
    slot.dispose();
});

test("PixelPackSlot allocates STREAM_READ storage lazily immediately before readPixels", async () => {
    const { PixelPackSlot } = await import("../app/3d/util/glReadback.js");
    const events = [];
    const gl = {
        PIXEL_PACK_BUFFER: 0x88eb,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        createBuffer: () => ({ id: "pbo" }),
        bindBuffer() {},
        bufferData() { events.push("allocate"); },
        getParameter: () => 4,
        pixelStorei() {},
        readPixels() { events.push("write"); },
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        deleteSync() {},
        deleteBuffer() {},
        getBufferSubData() {},
        clientWaitSync: () => 0x9119,
    };
    const slot = new PixelPackSlot(gl, 8);
    assert.deepEqual(events, []);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    assert.deepEqual(events, ["allocate", "write"]);
    assert.equal(slot.poll(new Uint8Array(8)), true);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    assert.deepEqual(events, ["allocate", "write", "write"]);
    slot.dispose();
});

test("WAIT_FAILED replaces the PBO before the next write", async () => {
    const { PixelPackSlot } = await import("../app/3d/util/glReadback.js");
    let nextId = 1;
    const created = [];
    const gl = {
        PIXEL_PACK_BUFFER: 0x88eb,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        WAIT_FAILED: 0x911d,
        createBuffer: () => {
            const buffer = { id: nextId++ };
            created.push(buffer.id);
            return buffer;
        },
        bindBuffer() {},
        bufferData() {},
        getParameter: () => 4,
        pixelStorei() {},
        readPixels() {},
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync: () => 0x911d,
        deleteSync() {},
        deleteBuffer() {},
        getBufferSubData() {},
    };
    const slot = new PixelPackSlot(gl, 8);
    assert.equal(created.length, 1);
    assert.equal(slot.begin(0, 0, 1, 2, 0x1908, 0x1401), true);
    assert.equal(slot.poll(new Uint8Array(8)), false);
    assert.equal(slot.dropped, true);
    assert.equal(slot.pending, false);
    assert.equal(created.length, 2);
    assert.equal(slot.pbo.id, created[1]);
    assert.equal(slot._needsStorage, true);
    slot.dispose();
});

test("legacy CameraRenderProducts poll completes when fences resolve out of order", async () => {
    const { CameraRenderProducts } = await import("../app/3d/perception/CameraRenderProducts.js");
    class FakeWebGL2 {}
    const previous = globalThis.WebGL2RenderingContext;
    globalThis.WebGL2RenderingContext = FakeWebGL2;
    const signaled = new Map();
    let syncId = 0;
    const gl = Object.assign(Object.create(FakeWebGL2.prototype), {
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        CONDITION_SATISFIED: 0x9119,
        ALREADY_SIGNALED: 0x911c,
        WAIT_FAILED: 0x911d,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        fenceSync() {
            const sync = { id: ++syncId };
            signaled.set(sync.id, false);
            return sync;
        },
        clientWaitSync(sync) {
            return signaled.get(sync.id) ? 0x9119 : 0x911b;
        },
        createBuffer: () => ({ id: "pbo" }),
        bindBuffer() {},
        bufferData() {},
        getParameter: () => 4,
        pixelStorei() {},
        readPixels() {},
        flush() {},
        deleteSync(sync) { signaled.delete(sync.id); },
        deleteBuffer() {},
        getBufferSubData(_target, _offset, dest) { dest.fill(7); },
        getExtension: () => null,
    });
    try {
        const renderer = {
            getContext: () => gl,
            getRenderTarget: () => null,
            setRenderTarget() {},
            getClearColor(color) { color.setRGB(0, 0, 0); },
            getClearAlpha: () => 1,
            setClearColor() {},
            clear() {},
            render() {},
        };
        const products = new CameraRenderProducts({
            renderer,
            scene: { background: null, traverse() {} },
            camera: {},
            width: 2,
            height: 1,
        });
        assert.equal(products.submit({ rgb: true, depth: true }), true);
        const rgbSync = products._slots.rgb.pack.sync.id;
        const depthSync = products._slots.depth.pack.sync.id;
        signaled.set(rgbSync, true);
        assert.equal(products.poll(), null);
        assert.ok(products._inflightDone.has("rgb"));
        assert.equal(products._inflightDone.has("depth"), false);
        signaled.set(depthSync, true);
        const result = products.poll();
        assert.ok(result?.rgb);
        assert.ok(result?.depth);
        assert.equal(products.pending, false);
        products.dispose();
    } finally {
        if (previous === undefined) delete globalThis.WebGL2RenderingContext;
        else globalThis.WebGL2RenderingContext = previous;
    }
});

test("pixel-pack waits use a zero client timeout and yield until the fence signals", async () => {
    const { PixelPackSlot, waitForPixelPack } = await import("../app/3d/util/glReadback.js");
    const timeouts = [];
    let waits = 0;
    const gl = {
        PIXEL_PACK_BUFFER: 0x88eb,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        CONDITION_SATISFIED: 0x9119,
        createBuffer: () => ({ id: "pbo" }),
        bindBuffer() {},
        bufferData() {},
        getParameter: () => 4,
        pixelStorei() {},
        readPixels() {},
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync(_sync, _flags, timeout) {
            timeouts.push(timeout);
            waits += 1;
            return waits < 2 ? 0x911b : 0x9119;
        },
        deleteSync() {},
        deleteBuffer() {},
        getBufferSubData(_target, _offset, dest) { dest.fill(9); },
        isContextLost: () => false,
    };
    const slot = new PixelPackSlot(gl, 4);
    assert.equal(slot.begin(0, 0, 1, 1, 0x1908, 0x1401), true);
    const dest = new Uint8Array(4);
    assert.equal(await waitForPixelPack(slot, dest, { timeoutMs: 200 }), true);
    assert.deepEqual(timeouts, [0, 0]);
    assert.equal(dest[0], 9);
    slot.dispose();
});
