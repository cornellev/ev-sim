/**
 * Run a synchronous `readPixels` / `readRenderTargetPixels` while guaranteeing
 * no WebGL2 PIXEL_PACK_BUFFER is bound.
 *
 * Spark's SparkRenderer uses pixel-pack buffers (PBOs) for asynchronous splat
 * sorting/readback and can leave one bound across frames. A bound PIXEL_PACK
 * buffer makes a CPU-side `gl.readPixels` throw:
 *   "INVALID_OPERATION: readPixels: PIXEL_PACK buffer should not be bound".
 * We temporarily unbind it for the readback, then restore the previous binding
 * so Spark's in-flight async read is left untouched.
 *
 * @template T
 * @param {import("three").WebGLRenderer} renderer
 * @param {() => T} readback
 * @returns {T}
 */
export function withPixelPackBufferUnbound(renderer, readback) {
    const gl = renderer?.getContext?.();
    const isWebGL2 =
        typeof WebGL2RenderingContext !== "undefined" &&
        gl instanceof WebGL2RenderingContext;

    if (!isWebGL2) {
        return readback();
    }

    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    if (previous) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    try {
        return readback();
    } finally {
        if (previous) {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
        }
    }
}
