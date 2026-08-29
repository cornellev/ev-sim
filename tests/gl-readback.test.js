import assert from "node:assert/strict";
import test from "node:test";

import { getWebGL2Context, withPixelPackBufferUnbound } from "../app/3d/util/glReadback.js";

test("WebGL2 pixel-pack helpers no-op without a WebGL2 renderer", () => {
    assert.equal(getWebGL2Context(null), null);
    assert.equal(getWebGL2Context({ getContext: () => null }), null);
    assert.equal(withPixelPackBufferUnbound(null, () => 7), 7);
});
