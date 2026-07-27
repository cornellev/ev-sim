import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_CAPTURE_BUFFER_BYTES,
    rgbaBufferLength,
} from "../app/3d/environment/visualization/BakeCaptureMemory.js";

test("bake camera uses the expected bounded RGBA allocation", () => {
    assert.equal(rgbaBufferLength(1920, 1080), 1920 * 1080 * 4);
});

test("bake camera rejects invalid and unbounded capture dimensions", () => {
    assert.throws(() => rgbaBufferLength(Number.POSITIVE_INFINITY, 1080), /positive integer/);
    assert.throws(() => rgbaBufferLength(1920, 0), /positive integer/);
    assert.throws(
        () => rgbaBufferLength(MAX_CAPTURE_BUFFER_BYTES, 2),
        /editor limit is 256 MiB/,
    );
});
