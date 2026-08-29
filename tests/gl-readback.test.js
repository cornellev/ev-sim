import assert from "node:assert/strict";
import test from "node:test";

import { getWebGL2Context, withPixelPackBufferUnbound } from "../app/3d/util/glReadback.js";

test("WebGL2 pixel-pack helpers no-op without a WebGL2 renderer", () => {
    assert.equal(getWebGL2Context(null), null);
    assert.equal(getWebGL2Context({ getContext: () => null }), null);
    assert.equal(withPixelPackBufferUnbound(null, () => 7), 7);
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
